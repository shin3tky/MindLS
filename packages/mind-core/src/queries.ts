/**
 * Language Server が使う問い合わせ。すべて純関数で、エディタには依存しない。
 *
 * Mind では**照合キーが正規形**なので、`反応し` の上でジャンプしても
 * `反応する` の定義に飛ぶ。この畳み込みがここの要。
 */

import type { Definition, ParseResult } from './parser.ts';
import type { SymbolEntry, SymbolTable } from './symbols.ts';
import type { Position, Range, Token } from './types.ts';

// --- 位置の比較 --------------------------------------------------------------

export function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

export function containsPosition(range: Range, p: Position): boolean {
  return comparePosition(range.start, p) <= 0 && comparePosition(p, range.end) < 0;
}

/** 範囲の終端を含めて判定する（単語の末尾にカーソルがある場合を拾う） */
function touchesPosition(range: Range, p: Position): boolean {
  return comparePosition(range.start, p) <= 0 && comparePosition(p, range.end) <= 0;
}

/** inner が outer の中に収まっているか */
function containsRange(outer: Range, inner: Range): boolean {
  return comparePosition(outer.start, inner.start) <= 0 && comparePosition(inner.end, outer.end) <= 0;
}

// --- 位置から引く ------------------------------------------------------------

/** その位置にある単語トークン。コメントや文字列の中なら null */
export function wordAt(result: ParseResult, position: Position): Token | null {
  for (const t of result.tokens) {
    if (t.kind !== 'word' && t.kind !== 'number') continue;
    if (touchesPosition(t.range, position)) return t;
  }
  return null;
}

/** その位置を含む定義 */
export function enclosingDefinition(result: ParseResult, position: Position): Definition | null {
  let best: Definition | null = null;
  for (const d of result.definitions) {
    if (!touchesPosition(d.range, position)) continue;
    // 入れ子があれば内側を優先する
    if (best === null || comparePosition(d.range.start, best.range.start) > 0) best = d;
  }
  return best;
}

// --- 定義ジャンプ ------------------------------------------------------------

export interface DefinitionResult {
  readonly entry: SymbolEntry;
  readonly ranges: readonly Range[];
  /** 等価定義をたどった先。無ければ null */
  readonly equivalent: SymbolEntry | null;
}

export function findDefinition(
  result: ParseResult,
  table: SymbolTable,
  position: Position,
): DefinitionResult | null {
  const token = wordAt(result, position);
  if (token === null || token.normalized.length === 0) return null;

  const owner = enclosingDefinition(result, position);
  const entry = lookup(table, token.normalized, owner?.name.normalized);
  if (entry === undefined) return null;

  const equivalent =
    entry.equivalentTo === null ? null : (table.globals.get(entry.equivalentTo) ?? null);

  // 等価定義は、宣言そのものと参照先の両方を候補にする
  const ranges = equivalent === null ? entry.locations : [...entry.locations, ...equivalent.locations];
  return { entry, ranges, equivalent };
}

function lookup(
  table: SymbolTable,
  normalized: string,
  insideDefinition: string | undefined,
): SymbolEntry | undefined {
  if (insideDefinition !== undefined) {
    const hit = table.locals.get(insideDefinition)?.get(normalized);
    if (hit !== undefined) return hit;
  }
  return table.globals.get(normalized);
}

// --- 参照検索 ----------------------------------------------------------------

export interface ReferenceOptions {
  /** 定義そのものを結果に含めるか */
  readonly includeDeclaration?: boolean;
}

export function findReferences(
  result: ParseResult,
  table: SymbolTable,
  position: Position,
  options: ReferenceOptions = {},
): readonly Range[] {
  const token = wordAt(result, position);
  if (token === null || token.normalized.length === 0) return [];

  const owner = enclosingDefinition(result, position);
  const entry = lookup(table, token.normalized, owner?.name.normalized);
  if (entry === undefined) return [];

  // 局所シンボルは、それを持つ定義の中だけを探す
  const scopeRange =
    entry.owner === null
      ? null
      : (result.definitions.find((d) => d.name.normalized === entry.owner)?.range ?? null);

  const declarationRanges = new Set(entry.locations.map(rangeKey));
  const out: Range[] = [];

  for (const t of result.tokens) {
    if (t.kind !== 'word') continue;
    if (t.normalized !== entry.normalized) continue;
    if (scopeRange !== null && !containsRange(scopeRange, t.range)) continue;

    const isDeclaration = declarationRanges.has(rangeKey(nameRangeOf(t)));
    if (isDeclaration && options.includeDeclaration !== true) continue;
    out.push(nameRangeOf(t));
  }

  if (options.includeDeclaration === true) {
    for (const r of entry.locations) {
      if (!out.some((x) => rangeKey(x) === rangeKey(r))) out.push(r);
    }
    out.sort((a, b) => comparePosition(a.start, b.start));
  }
  return out;
}

/** 助詞を除いた、単語そのものの範囲 */
function nameRangeOf(t: Token): Range {
  const cut = t.particle === null ? 0 : t.particle.length;
  if (cut === 0) return t.range;
  return {
    start: t.range.start,
    end: { line: t.range.end.line, character: t.range.end.character - cut },
  };
}

const rangeKey = (r: Range): string =>
  `${String(r.start.line)}:${String(r.start.character)}-${String(r.end.line)}:${String(r.end.character)}`;

// --- DocumentSymbol ----------------------------------------------------------

export interface DocumentSymbolNode {
  readonly name: string;
  readonly detail: string;
  /** `処理単語` `変数` など。LSP の SymbolKind への対応は Language Server 側で行う */
  readonly kind: string;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children: readonly DocumentSymbolNode[];
}

export function documentSymbols(result: ParseResult): DocumentSymbolNode[] {
  const out: DocumentSymbolNode[] = [];

  for (const d of result.declarations) {
    out.push({
      name: d.name.raw,
      detail: d.equivalentTo === null ? d.kind : `${d.kind} → ${d.equivalentTo.raw}`,
      kind: d.kind,
      range: d.range,
      selectionRange: d.name.range,
      children: [],
    });
  }

  for (const def of result.definitions) {
    out.push({
      name: def.name.raw,
      detail: [def.kind, def.stackSpec === null ? null : `（${def.stackSpec}）`, ...def.attrs]
        .filter((x) => x !== null && x !== '')
        .join(' '),
      kind: def.kind,
      range: def.range,
      selectionRange: def.name.range,
      children: [
        ...def.locals.map((l) => ({
          name: l.name.raw,
          detail: l.kind,
          kind: l.kind,
          range: l.range,
          selectionRange: l.name.range,
          children: [] as DocumentSymbolNode[],
        })),
        ...def.localWords.map((w) => ({
          name: w.name.raw,
          detail: [w.kind, w.stackSpec === null ? null : `（${w.stackSpec}）`]
            .filter((x) => x !== null && x !== '')
            .join(' '),
          kind: w.kind,
          range: w.range,
          selectionRange: w.name.range,
          children: [] as DocumentSymbolNode[],
        })),
      ].sort((a, b) => comparePosition(a.range.start, b.range.start)),
    });
  }

  out.sort((a, b) => comparePosition(a.range.start, b.range.start));
  return out;
}

// --- 横断検索（workspace/symbol） --------------------------------------------

export interface SymbolMatch {
  readonly entry: SymbolEntry;
  /** 小さいほど良い一致 */
  readonly score: number;
}

/**
 * 問い合わせ文字列でシンボルを探す。正規形と生表記の両方を見る。
 *
 * 注意: `ひょうじ` で `表示` を引くには読み仮名の辞書が要る。
 * 形態素解析器を持ち込まずに読みを得る手段が無いため、ここでは未対応。
 * 標準単語辞書に読みを持たせる案は M4 で検討する。
 */
export function searchSymbols(table: SymbolTable, query: string): SymbolMatch[] {
  if (query.trim().length === 0) return [];
  const q = query.trim().toLowerCase();

  const candidates: SymbolEntry[] = [...table.globals.values()];
  for (const own of table.locals.values()) candidates.push(...own.values());

  const matches: SymbolMatch[] = [];
  for (const entry of candidates) {
    const score = scoreOf(entry, q);
    if (score !== null) matches.push({ entry, score });
  }
  matches.sort((a, b) => a.score - b.score || a.entry.normalized.localeCompare(b.entry.normalized));
  return matches;
}

function scoreOf(entry: SymbolEntry, q: string): number | null {
  const haystacks = [entry.normalized, ...entry.aliases];
  let best: number | null = null;

  for (const h of haystacks) {
    const lower = h.toLowerCase();
    let score: number | null = null;
    if (lower === q) score = 0;
    else if (lower.startsWith(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (isSubsequence(q, lower)) score = 3;
    if (score !== null && (best === null || score < best)) best = score;
  }
  // 局所シンボルは後ろに回す
  if (best !== null && entry.owner !== null) best += 10;
  return best;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const c of haystack) {
    if (c === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}
