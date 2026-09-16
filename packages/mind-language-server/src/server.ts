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
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type InitializeResult,
  type Location,
  type SymbolInformation,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { findDefinition, findReferences, searchSymbols } from '@mindls/core';

import {
  analyze,
  analyzedUris,
  cachedAnalysis,
  forget,
  toDiagnostics,
  toDocumentSymbols,
  toLspRange,
  toSymbolKind,
} from './analysis.ts';

export function startServer(connection: Connection = createConnection(ProposedFeatures.all)): void {
  const documents = new TextDocuments(TextDocument);

  connection.onInitialize((): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      workspaceSymbolProvider: true,
    },
    serverInfo: { name: 'mind-language-server' },
  }));

  connection.onInitialized(() => {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  });

  const publish = (doc: TextDocument): void => {
    const { parsed } = analyze(doc);
    void connection.sendDiagnostics({
      uri: doc.uri,
      version: doc.version,
      diagnostics: toDiagnostics(parsed),
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
