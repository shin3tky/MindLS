/**
 * VS Code 拡張の入口。
 *
 * M1 の時点では言語登録・文法・言語設定と、文字コードを整えるコマンドだけ。
 * Language Server の起動（別プロセス / stdio）は M3 以降でここに足す。
 */

import * as vscode from 'vscode';

/** Mind のソースが取りうる文字コード。プラットフォームで決まる。 */
function encodingForPlatform(): { id: string; label: string } {
  // Windows 版 Mind は Shift_JIS、Linux 版は EUC-JP
  return process.platform === 'win32'
    ? { id: 'shiftjis', label: 'Shift_JIS（Windows 版 Mind）' }
    : { id: 'eucjp', label: 'EUC-JP（Linux 版 Mind）' };
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

  const encoding = encodingForPlatform();
  const picked = await vscode.window.showQuickPick(
    [
      { label: encoding.label, id: encoding.id },
      { label: 'EUC-JP（Linux 版 Mind）', id: 'eucjp' },
      { label: 'Shift_JIS（Windows 版 Mind）', id: 'shiftjis' },
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
  );
}

export function deactivate(): void {
  // Language Server を起動するようになったらここで停止させる
}
