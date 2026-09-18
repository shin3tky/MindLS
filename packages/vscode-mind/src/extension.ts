/**
 * VS Code 拡張の入口。
 *
 * 言語登録・文法・言語設定に加えて、Language Server を別プロセスで起動する。
 * 解析そのものは @mindls/core、LSP の受け口は @mindls/language-server が持つ。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/**
 * Language Server の実体を探す。
 *
 * 開発中は npm workspaces のリンク越しに `@mindls/language-server` が引ける。
 * 配布する .vsix にはリンクが無いかわりに、束ねた `dist/server.js` が同梱してある。
 * リンクを先に見るのは、開発中に古いバンドルを掴まないため。
 */
function resolveServerModule(context: vscode.ExtensionContext): string {
  try {
    return require.resolve('@mindls/language-server/dist/cli.js');
  } catch {
    /* 配布物では解決できない。同梱のバンドルを使う */
  }
  const bundled = context.asAbsolutePath(path.join('dist', 'server.js'));
  if (fs.existsSync(bundled)) return bundled;
  return context.asAbsolutePath(path.join('..', 'mind-language-server', 'dist', 'cli.js'));
}

async function startLanguageServer(context: vscode.ExtensionContext): Promise<void> {
  const module = resolveServerModule(context);
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.stdio },
    debug: {
      module,
      transport: TransportKind.stdio,
      options: { execArgv: ['--nolazy', '--inspect=6019'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'mind' }],
    // 起動直後の解析にも設定を効かせたいので、初回分は initializationOptions で渡す。
    // 以降の変更は workspace/didChangeConfiguration で届く。
    initializationOptions: {
      diagnostics: diagnosticSettings(),
      compiler: compilerSettings(),
      library: vscode.workspace.getConfiguration('mind').get<string>('library'),
      distribution: vscode.workspace.getConfiguration('mind').get<string>('distribution'),
    },
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{src,mnd}'),
    },
  };

  client = new LanguageClient('mind', 'Mind Language Server', serverOptions, clientOptions);
  await client.start();
}

/** `mind.diagnostics.*` を Language Server に渡す形にまとめる */
function diagnosticSettings(): Record<string, boolean> {
  const config = vscode.workspace.getConfiguration('mind');
  return {
    undefinedWords: config.get<boolean>('diagnostics.undefinedWords') ?? true,
    forwardReferences: config.get<boolean>('diagnostics.forwardReferences') ?? true,
    negativeForms: config.get<boolean>('diagnostics.negativeForms') ?? true,
    commentParens: config.get<boolean>('diagnostics.commentParens') ?? true,
  };
}

/** `mind.compiler.*` を Language Server に渡す形にまとめる */
function compilerSettings(): { enabled: boolean; docker: { image: string } } {
  const config = vscode.workspace.getConfiguration('mind');
  return {
    enabled: config.get<boolean>('compiler.enabled') ?? false,
    docker: {
      image: config.get<string>('compiler.docker.image') ?? 'mind-docker:8.0.08',
    },
  };
}

async function stopLanguageServer(): Promise<void> {
  const running = client;
  client = undefined;
  if (running !== undefined) await running.stop();
}

const SHIFT_JIS = { id: 'shiftjis', label: 'Shift_JIS（Windows 版 Mind）' };
const EUC_JP = { id: 'eucjp', label: 'EUC-JP（Linux 版 Mind）' };

/**
 * Mind のソースが取りうる文字コード。`mind.distribution` で決まる
 * （Windows 版 Mind は Shift_JIS、Linux 版は EUC-JP）。
 * 配布物の ID と別名は packages/mind-core/data/distributions.json にある。
 */
function encodingForDistribution(): { id: string; label: string } {
  const value = (vscode.workspace.getConfiguration('mind').get<string>('distribution') ?? '')
    .trim()
    .toLowerCase();
  if (value.startsWith('linux') || value === 'mind8' || value === '8') return EUC_JP;
  return SHIFT_JIS;
}

/**
 * ワークスペース設定に Mind 用の文字コードと関連付けを書き込む。
 *
 * VS Code の既定は UTF-8 だが、Mind のコンパイラは UTF-8 のソースを解釈しない。
 * ここを直さないと、日本語の単語が化けてまったく通らない。
 */
async function configureWorkspace(): Promise<void> {
  if (vscode.workspace.workspaceFolders === undefined) {
    void vscode.window.showWarningMessage(
      'フォルダーを開いてから実行してください（ワークスペース設定に書き込みます）。',
    );
    return;
  }

  const encoding = encodingForDistribution();
  const others = [SHIFT_JIS, EUC_JP].filter((e) => e.id !== encoding.id);
  const picked = await vscode.window.showQuickPick(
    [
      { label: encoding.label, id: encoding.id, description: 'mind.distribution に合わせた既定' },
      ...others.map((e) => ({ label: e.label, id: e.id })),
      { label: 'UTF-8 のまま（ラッパーで変換する構成）', id: 'utf8' },
    ],
    { title: 'Mind のソースの文字コード', placeHolder: encoding.label },
  );
  if (picked === undefined) return;

  // 言語スコープ付きで書き込む（第 4 引数が overrideInLanguage）
  await vscode.workspace
    .getConfiguration('files', { languageId: 'mind' })
    .update('encoding', picked.id, vscode.ConfigurationTarget.Workspace, true);

  // `.src` は他言語とも衝突するため、このワークスペースでは明示的に関連付ける
  const files = vscode.workspace.getConfiguration('files');
  const associations = { ...(files.get<Record<string, string>>('associations') ?? {}) };
  associations['*.src'] = 'mind';
  await files.update('associations', associations, vscode.ConfigurationTarget.Workspace);

  void vscode.window.showInformationMessage(
    `Mind のソースを ${picked.label} として扱うように設定しました。`,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mind.configureWorkspace', () => {
      void configureWorkspace();
    }),
    vscode.commands.registerCommand('mind.restartServer', () => {
      void (async () => {
        await stopLanguageServer();
        await startLanguageServer(context);
        void vscode.window.showInformationMessage('Mind Language Server を再起動しました。');
      })();
    }),
  );

  void startLanguageServer(context).catch((error: unknown) => {
    void vscode.window.showErrorMessage(
      `Mind Language Server を起動できませんでした: ${String(error)}`,
    );
  });
}

export function deactivate(): Thenable<void> {
  return stopLanguageServer();
}
