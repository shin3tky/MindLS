/**
 * 解析結果のキャッシュと、LSP の型への変換。
 *
 * ここから上（server.ts）は LSP の作法、ここから下（@mindls/core）は
 * エディタ非依存の解析。境界をこのファイルに閉じ込める。
 */

import {
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  MarkupKind,
  SymbolKind,
  type CompletionItem,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Range as LspRange,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { createRequire } from 'node:module';

import {
  analyze as analyzeSemantics,
  buildSymbolTable,
  createStdlibIndex,
  documentSymbols,
  EMPTY_STDLIB,
  parse,
} from '@mindls/core';
import type {
  AnalyzeOptions,
  CompletionItem as CoreCompletionItem,
  DocumentSymbolNode,
  HoverInfo,
  ParseResult,
  Range,
  StdlibDocument,
  StdlibIndex,
  SymbolTable,
} from '@mindls/core';

export interface Analysis {
  readonly version: number;
  readonly parsed: ParseResult;
  readonly symbols: SymbolTable;
}

const cache = new Map<string, Analysis>();

export function analyze(doc: TextDocument): Analysis {
  const hit = cache.get(doc.uri);
  if (hit !== undefined && hit.version === doc.version) return hit;

  const parsed = parse(doc.getText());
  const analysis: Analysis = { version: doc.version, parsed, symbols: buildSymbolTable(parsed) };
  cache.set(doc.uri, analysis);
  return analysis;
}

export function forget(uri: string): void {
  cache.delete(uri);
}

export function analyzedUris(): string[] {
  return [...cache.keys()];
}

export function cachedAnalysis(uri: string): Analysis | undefined {
  return cache.get(uri);
}

// --- 変換 --------------------------------------------------------------------

export const toLspRange = (r: Range): LspRange => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
});

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  hint: DiagnosticSeverity.Hint,
} as const;

export function toDiagnostics(
  parsed: ParseResult,
  symbols?: SymbolTable,
  options: AnalyzeOptions = {},
): Diagnostic[] {
  const out: Diagnostic[] = parsed.diagnostics.map((d) => ({
    range: toLspRange(d.range),
    severity: SEVERITY[d.severity],
    source: 'mind',
    code: d.code,
    message: d.message,
  }));

  // シンボルを見ないと分からない診断（未定義単語・前方参照など）
  if (symbols !== undefined) {
    for (const d of analyzeSemantics(parsed, symbols, options)) {
      out.push({
        range: toLspRange(d.range),
        severity: SEVERITY[d.severity],
        source: 'mind',
        code: d.code,
        message: d.message,
      });
    }
  }

  // `終り。` 以降はコンパイルされない。灰色表示のためのヒントを出す
  if (parsed.endOfCompilation !== null) {
    out.push({
      range: {
        start: parsed.endOfCompilation,
        end: { line: parsed.endOfCompilation.line + 1_000_000, character: 0 },
      },
      severity: DiagnosticSeverity.Hint,
      source: 'mind',
      code: 'not-compiled',
      message: 'トップレベルの `終り。` 以降はコンパイルされません',
      tags: [1], // DiagnosticTag.Unnecessary
    });
  }
  return out;
}

/** Mind の種別を LSP の SymbolKind に対応づける */
export function toSymbolKind(kind: string): SymbolKind {
  switch (kind) {
    case '処理単語':
    case '本定義':
    case '仮定義':
      return SymbolKind.Function;
    case '関数':
    case '等価な関数':
      return SymbolKind.Method;
    case '等価':
      return SymbolKind.Interface;
    case '定数':
    case '文字列定数':
    case '数値':
      return SymbolKind.Constant;
    case '文字列':
    case '文字列実体':
      return SymbolKind.String;
    case '変数':
    case '小数変数':
    case 'ワード変数':
    case 'バイト変数':
      return SymbolKind.Variable;
    default:
      return SymbolKind.Object;
  }
}

function toDocumentSymbol(node: DocumentSymbolNode): DocumentSymbol {
  return {
    name: node.name,
    detail: node.detail,
    kind: toSymbolKind(node.kind),
    range: toLspRange(node.range),
    selectionRange: toLspRange(node.selectionRange),
    children: node.children.map(toDocumentSymbol),
  };
}

export function toDocumentSymbols(parsed: ParseResult): DocumentSymbol[] {
  return documentSymbols(parsed).map(toDocumentSymbol);
}

// --- 標準単語辞書 ------------------------------------------------------------

/**
 * 標準単語辞書を読み込む。配布物から生成してコミットしてあるものなので、
 * Mind の配布物も Docker も要らない。
 */
function loadStdlib(): StdlibIndex {
  try {
    const require = createRequire(import.meta.url);
    const doc = require('@mindls/core/stdlib') as StdlibDocument;
    return createStdlibIndex(doc);
  } catch {
    return EMPTY_STDLIB;
  }
}

let stdlibCache: StdlibIndex | undefined;

export function stdlib(): StdlibIndex {
  stdlibCache ??= loadStdlib();
  return stdlibCache;
}

// --- 補完・ホバーの変換 ------------------------------------------------------

const COMPLETION_KIND: Record<string, CompletionItemKind> = {
  local: CompletionItemKind.Variable,
  document: CompletionItemKind.Function,
  keyword: CompletionItemKind.Keyword,
  snippet: CompletionItemKind.Snippet,
  stdlib: CompletionItemKind.Function,
};

export function toCompletionItems(items: readonly CoreCompletionItem[]): CompletionItem[] {
  return items.map((i) => ({
    label: i.label,
    kind: COMPLETION_KIND[i.source] ?? CompletionItemKind.Text,
    detail: i.detail,
    documentation: i.documentation ?? undefined,
    filterText: i.filterText,
    sortText: i.sortText,
    insertTextFormat: i.isSnippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    textEdit: { range: toLspRange(i.range), newText: i.insertText },
  }));
}

export function toHover(info: HoverInfo): Hover {
  return {
    contents: { kind: MarkupKind.Markdown, value: info.contents },
    range: toLspRange(info.range),
  };
}
