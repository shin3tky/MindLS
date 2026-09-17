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
  type InitializeResult,
  type Location,
  type SymbolInformation,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

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
} from '@mindls/core';

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

const DEFAULT_DIAGNOSTICS: DiagnosticSettings = {
  undefinedWords: false,
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

export function startServer(connection: Connection = createConnection(ProposedFeatures.all)): void {
  const documents = new TextDocuments(TextDocument);
  let diagnosticSettings = DEFAULT_DIAGNOSTICS;

  connection.onInitialize((params): InitializeResult => {
    const options = params.initializationOptions as { diagnostics?: unknown } | undefined;
    diagnosticSettings = readDiagnosticSettings(options?.diagnostics);
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
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

  const publish = (doc: TextDocument): void => {
    const { parsed, symbols } = analyze(doc);
    void connection.sendDiagnostics({
      uri: doc.uri,
      version: doc.version,
      diagnostics: toDiagnostics(parsed, symbols, {
        stdlib: stdlib(),
        undefinedWords: diagnosticSettings.undefinedWords,
        forwardReferences: diagnosticSettings.forwardReferences,
        negativeForms: diagnosticSettings.negativeForms,
        commentParens: diagnosticSettings.commentParens,
      }),
    });
  };

  connection.onDidChangeConfiguration((change) => {
    const settings = (change.settings as { mind?: { diagnostics?: unknown } } | undefined)?.mind;
    diagnosticSettings = readDiagnosticSettings(settings?.diagnostics);
    for (const doc of documents.all()) publish(doc);
  });

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

  documents.listen(connection);
  connection.listen();
}
