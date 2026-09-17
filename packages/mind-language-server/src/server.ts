/**
 * Mind の Language Server（LSP / stdio）。
 *
 * 解析は @mindls/core が持ち、ここは LSP の配線だけを受け持つ。
 * 実コンパイラ連携（@mindls/compiler）は M5 でここに足す。
 */

import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  ResponseError,
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type Diagnostic,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type SymbolInformation,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { fileURLToPath } from 'node:url';

import {
  completionsAt,
  encodeSemanticTokens,
  findDefinition,
  findReferences,
  hoverAt,
  prepareRename,
  renameEdits,
  searchSymbols,
  semanticTokens,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
  normalize,
} from '@mindls/core';
import type { ParseResult } from '@mindls/core';

/** プログラムの入口。正規形で持っておく */
const MAIN = normalize('メイン');

import { DockerCompiler, NullCompiler } from '@mindls/compiler';
import type { CompileDiagnostic, MindCompiler } from '@mindls/compiler';

import {
  analyze,
  analyzedUris,
  cachedAnalysis,
  forget,
  toDiagnostics,
  stdlib,
  toCompletionItems,
  toDocumentSymbols,
  toHover,
  toLspRange,
  toSymbolKind,
} from './analysis.ts';
import { EMPTY_IMPORTS, WorkspaceIndex } from './workspace.ts';
import type { ImportedSymbols } from './workspace.ts';

/**
 * 診断の設定。既定値はここが唯一の出どころで、拡張の package.json とそろえてある。
 *
 * `undefinedWords` だけ既定 false。`"x.src"を　コンパイル。` で取り込まれる
 * 他ファイルの単語をまだ追えないので、複数ファイルのプログラムでは誤検出になる。
 */
interface DiagnosticSettings {
  undefinedWords: boolean;
  forwardReferences: boolean;
  negativeForms: boolean;
  commentParens: boolean;
}

/**
 * 実コンパイラ連携の設定。
 *
 * 既定は無効。拡張の利用者に Docker を要求しないため。有効にしても
 * **保存したときだけ**走らせる。打鍵のたびに叩くには重すぎる
 * （Apple Silicon では 32bit x86 のエミュレーションになる）。
 */
interface CompilerSettings {
  enabled: boolean;
  image: string;
  library: string;
}

const DEFAULT_COMPILER: CompilerSettings = {
  enabled: false,
  image: 'mind-docker:8.0.08',
  library: 'file',
};

const DEFAULT_DIAGNOSTICS: DiagnosticSettings = {
  undefinedWords: true,
  forwardReferences: true,
  negativeForms: true,
  commentParens: true,
};

function readDiagnosticSettings(raw: unknown): DiagnosticSettings {
  const out = { ...DEFAULT_DIAGNOSTICS };
  if (typeof raw !== 'object' || raw === null) return out;
  for (const key of Object.keys(out) as (keyof DiagnosticSettings)[]) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** リネームを断ったときに返すコード。LSP の予約範囲外を使う */
const RENAME_REFUSED = -32_803;

function readCompilerSettings(raw: unknown, fallbackLibrary: unknown): CompilerSettings {
  const out = { ...DEFAULT_COMPILER };
  if (typeof fallbackLibrary === 'string' && fallbackLibrary !== '') out.library = fallbackLibrary;
  if (typeof raw !== 'object' || raw === null) return out;
  const record = raw as Record<string, unknown>;
  if (typeof record['enabled'] === 'boolean') out.enabled = record['enabled'];
  const docker = record['docker'];
  if (typeof docker === 'object' && docker !== null) {
    const image = (docker as Record<string, unknown>)['image'];
    if (typeof image === 'string') out.image = image;
  }
  return out;
}

export function startServer(connection: Connection = createConnection(ProposedFeatures.all)): void {
  const documents = new TextDocuments(TextDocument);
  let diagnosticSettings = DEFAULT_DIAGNOSTICS;
  let compilerSettings = DEFAULT_COMPILER;
  let workspaceRoot: string | null = null;
  let compiler: MindCompiler = new NullCompiler();
  let workspace: WorkspaceIndex | null = null;

  connection.onInitialize((params): InitializeResult => {
    const options = params.initializationOptions as
      | { diagnostics?: unknown; compiler?: unknown; library?: unknown }
      | undefined;
    diagnosticSettings = readDiagnosticSettings(options?.diagnostics);
    compilerSettings = readCompilerSettings(options?.compiler, options?.library);
    workspaceRoot = rootOf(params);
    workspace = workspaceRoot === null ? null : new WorkspaceIndex(workspaceRoot);
    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Incremental,
          // 実コンパイラ連携は保存時に走らせるので、保存の通知が要る
          save: { includeText: false },
        },
        documentSymbolProvider: true,
        definitionProvider: true,
        hoverProvider: true,
        completionProvider: { resolveProvider: false, triggerCharacters: [] },
        referencesProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        semanticTokensProvider: {
          legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] },
          full: true,
        },
      },
      serverInfo: { name: 'mind-language-server' },
    };
  });

  connection.onInitialized(() => {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  });

  /**
   * その文書と同じプログラムに属するファイルの大域シンボル。
   *
   * 取り込み先が 1 つでも見つからなければ「全部は見えていない」ので、
   * 未定義単語の診断は諦める。見えていないものを未定義と呼ぶのは誤検出でしかない。
   */
  const importsFor = (doc: TextDocument): ImportedSymbols => {
    const path = pathOf(doc.uri);
    if (workspace === null || path === null) return EMPTY_IMPORTS;
    try {
      return workspace.importsFor(path);
    } catch {
      return { ...EMPTY_IMPORTS, incomplete: true };
    }
  };

  const analyzeOptions = (doc: TextDocument) => {
    const imports = importsFor(doc);
    const { parsed } = analyze(doc);
    return {
      stdlib: stdlib(),
      imported: imports.globals,
      undefinedWords:
        diagnosticSettings.undefinedWords &&
        // 取り込み先が 1 つでも欠けていれば、語彙を把握しきれていない
        !imports.incomplete &&
        // 標準ライブラリが `file` 以外だと、その語彙の辞書を持っていない
        compilerSettings.library === 'file' &&
        // 取り込みで他のファイルとつながっているか、単体で完結したプログラムか。
        // どちらでもないファイル（取り込まれる側のライブラリ断片など）は、
        // 見えていない語彙があるとみなして黙る
        (imports.files.length > 1 || hasEntryPoint(parsed)),
      forwardReferences: diagnosticSettings.forwardReferences,
      negativeForms: diagnosticSettings.negativeForms,
      commentParens: diagnosticSettings.commentParens,
    };
  };

  const publish = (doc: TextDocument): void => {
    const { parsed, symbols } = analyze(doc);
    void connection.sendDiagnostics({
      uri: doc.uri,
      version: doc.version,
      diagnostics: toDiagnostics(parsed, symbols, analyzeOptions(doc)),
    });
  };

  connection.onDidChangeConfiguration((change) => {
    const settings = (
      change.settings as
        | { mind?: { diagnostics?: unknown; compiler?: unknown; library?: unknown } }
        | undefined
    )?.mind;
    diagnosticSettings = readDiagnosticSettings(settings?.diagnostics);
    const next = readCompilerSettings(settings?.compiler, settings?.library);
    // 設定が変わったらコンテナは作り直す
    if (JSON.stringify(next) !== JSON.stringify(compilerSettings)) {
      compilerSettings = next;
      void compiler.dispose();
      compiler = new NullCompiler();
    }
    for (const doc of documents.all()) publish(doc);
  });

  /**
   * 保存されたら、実コンパイラにも通す。
   *
   * 自前解析の診断は打鍵のたびに出しているので、ここではそれに**足す**。
   * コンパイラが動かない・イメージが無いといった事情は、その旨を警告として出す
   * （黙って何も起きないと、設定したのに効いていないのか分からない）。
   */
  documents.onDidSave((e) => {
    // 保存されたら索引を取り直す。取り込み先が増減しているかもしれない
    workspace?.invalidate();
    if (!compilerSettings.enabled) return;
    void runCompiler(e.document);
  });

  const runCompiler = async (doc: TextDocument): Promise<void> => {
    const path = pathOf(doc.uri);
    if (path === null || workspaceRoot === null) return;

    if (compiler instanceof NullCompiler) {
      compiler = new DockerCompiler({
        image: compilerSettings.image,
        workspace: workspaceRoot,
      });
    }

    const result = await compiler.check({ path, library: compilerSettings.library });
    const { parsed, symbols } = analyze(doc);
    void connection.sendDiagnostics({
      uri: doc.uri,
      diagnostics: [
        ...toDiagnostics(parsed, symbols, analyzeOptions(doc)),
        ...result.diagnostics.map(toCompilerDiagnostic),
      ],
    });
  };

  documents.onDidOpen((e) => { publish(e.document); });
  documents.onDidChangeContent((e) => { publish(e.document); });
  documents.onDidClose((e) => {
    forget(e.document.uri);
    void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  });

  connection.onDocumentSymbol(({ textDocument }) => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return [];
    return toDocumentSymbols(analyze(doc).parsed);
  });

  connection.onDefinition(({ textDocument, position }): Location[] => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return [];
    const { parsed, symbols } = analyze(doc);
    const found = findDefinition(parsed, symbols, position);
    if (found === null) return [];
    return found.ranges.map((r) => ({ uri: doc.uri, range: toLspRange(r) }));
  });

  connection.onReferences(({ textDocument, position, context }): Location[] => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return [];
    const { parsed, symbols } = analyze(doc);
    return findReferences(parsed, symbols, position, {
      includeDeclaration: context.includeDeclaration,
    }).map((r) => ({ uri: doc.uri, range: toLspRange(r) }));
  });

  connection.onCompletion(({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return [];
    const { parsed, symbols } = analyze(doc);
    const lineText = doc.getText({
      start: { line: position.line, character: 0 },
      end: { line: position.line + 1, character: 0 },
    }).replace(/\r?\n$/, '');

    return toCompletionItems(
      completionsAt({ parsed, symbols, stdlib: stdlib(), lineText, position }),
    );
  });

  connection.onHover(({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return null;
    const { parsed, symbols } = analyze(doc);
    const info = hoverAt({
      parsed,
      symbols,
      stdlib: stdlib(),
      lines: doc.getText().split(/\r?\n/),
      position,
    });
    return info === null ? null : toHover(info);
  });

  connection.onPrepareRename(({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return null;
    const { parsed, symbols } = analyze(doc);
    const target = prepareRename(parsed, symbols, position);
    // エラーを返すと、VS Code がその文言をそのまま出してくれる
    if ('code' in target) return new ResponseError(RENAME_REFUSED, target.message);
    return { range: toLspRange(target.range), placeholder: target.text };
  });

  connection.onRenameRequest(({ textDocument, position, newName }) => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return null;
    const { parsed, symbols } = analyze(doc);
    const result = renameEdits(parsed, symbols, position, newName);
    if (!Array.isArray(result)) return new ResponseError(RENAME_REFUSED, result.message);
    const edit: WorkspaceEdit = {
      changes: {
        [doc.uri]: result.map((e) => ({ range: toLspRange(e.range), newText: e.newText })),
      },
    };
    return edit;
  });

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const doc = documents.get(textDocument.uri);
    if (doc === undefined) return { data: [] };
    const { parsed, symbols } = analyze(doc);
    return { data: encodeSemanticTokens(semanticTokens({ parsed, symbols, stdlib: stdlib() })) };
  });

  connection.onWorkspaceSymbol(({ query }): SymbolInformation[] => {
    const out: SymbolInformation[] = [];
    for (const uri of analyzedUris()) {
      const analysis = cachedAnalysis(uri);
      if (analysis === undefined) continue;
      for (const m of searchSymbols(analysis.symbols, query).slice(0, 50)) {
        const first = m.entry.locations[0];
        if (first === undefined) continue;
        out.push({
          name: m.entry.aliases[0] ?? m.entry.normalized,
          kind: toSymbolKind(m.entry.kind),
          containerName: m.entry.owner ?? undefined,
          location: { uri, range: toLspRange(first) },
        });
      }
    }
    return out.slice(0, 200);
  });

  connection.onShutdown(() => {
    void compiler.dispose();
  });

  documents.listen(connection);
  connection.listen();
}

/**
 * 単体で完結したプログラムか。
 *
 * マニュアル 02 のとおり、`メイン` はプログラムの最上位の単語。
 * ライブラリとして書かれたソースには意図的に置かれない。
 * 取り込みの関係がまったく無いファイルは、`メイン` があるときだけ
 * 「これで全部」とみなす。
 */
function hasEntryPoint(parsed: ParseResult): boolean {
  return parsed.definitions.some((d) => d.name.normalized === MAIN);
}

/** `file:` の URI をパスに直す。ほかのスキームは扱わない */
function pathOf(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** ワークスペースのルート。コンテナに見せる範囲になる */
function rootOf(params: InitializeParams): string | null {
  const folder = params.workspaceFolders?.[0]?.uri;
  if (folder !== undefined) return pathOf(folder);
  if (params.rootUri !== null && params.rootUri !== undefined) return pathOf(params.rootUri);
  return null;
}

/** 実コンパイラの診断を LSP の形に直す */
function toCompilerDiagnostic(d: CompileDiagnostic): Diagnostic {
  const character = d.character ?? 0;
  const end = d.endCharacter ?? character;
  return {
    range: {
      start: { line: d.line, character },
      // 桁が取れなかったときは行末まで
      end: { line: d.line, character: d.endCharacter === null ? Number.MAX_SAFE_INTEGER : end },
    },
    severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 4,
    source: 'mind (コンパイラ)',
    message: d.message,
  };
}
