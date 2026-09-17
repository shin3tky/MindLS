/**
 * Semantic Tokens。
 *
 * tmLanguage は正規表現しか見ないので、`売り上げ計上し` が
 * 「自分で定義した処理単語」なのか「標準ライブラリの単語」なのか
 * 「そんな単語は無い」のかを区別できない。Mind では送り仮名が自由に揺れるぶん
 * この区別がとくに効く。シンボルテーブルを持っているこちら側で塗り分ける。
 *
 * LSP の標準の型・修飾子だけを使う。独自の型を足すと、利用者のテーマが
 * 対応していないかぎり無色になってしまう。
 *
 * コメント・文字列・数値は塗らない。tmLanguage で足りているうえ、
 * 複数行にまたがるトークンは LSP の表現（1 トークン 1 行）に収まらないため。
 * ここで出すのは必ず 1 行に収まるトークンだけにしてある。
 */

import { blockRoleOf, DECLARATION_KEYWORDS, DEFINITION_KEYWORDS } from './keywords.ts';
import type { Declaration, Definition, ParseResult } from './parser.ts';
import { comparePosition } from './queries.ts';
import { RESERVED_BY_NORMALIZED } from './reserved.ts';
import type { StdlibIndex } from './stdlib.ts';
import type { SymbolEntry, SymbolTable } from './symbols.ts';
import type { Position, Range, Token } from './types.ts';

/** 使う型。配列の順番がそのまま LSP の tokenTypes になる */
export const TOKEN_TYPES = [
  'function',
  'variable',
  'property',
  'type',
  'keyword',
  'macro',
  'operator',
] as const;

/** 使う修飾子。配列の位置がビット位置になる */
export const TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'defaultLibrary',
  'static',
] as const;

export type SemanticTokenType = (typeof TOKEN_TYPES)[number];
export type SemanticTokenModifier = (typeof TOKEN_MODIFIERS)[number];

export interface SemanticToken {
  readonly range: Range;
  readonly type: SemanticTokenType;
  readonly modifiers: readonly SemanticTokenModifier[];
}

export interface SemanticContext {
  readonly parsed: ParseResult;
  readonly symbols: SymbolTable;
  readonly stdlib?: StdlibIndex;
}

/** Mind の種別を LSP のトークン型に対応づける */
function typeOfKind(kind: string): SemanticTokenType {
  switch (kind) {
    case '処理単語':
    case '関数':
    case '仮定義':
    case '本定義':
    case '等価':
    case '等価な関数':
    case '等価な関数２':
      return 'function';
    case '型紙要素':
      return 'property';
    case '型紙':
      return 'type';
    case '定数':
    case '数値':
    case '文字列定数':
      return 'variable';
    default:
      return 'variable';
  }
}

/** 値が固定で、書き換えられないもの */
function isReadonlyKind(kind: string): boolean {
  return kind === '定数' || kind === '数値' || kind === '文字列定数' || kind === '文字列実体定数';
}

/** 助詞を除いた、単語そのものの範囲 */
function nameRange(t: Token): Range {
  const cut = t.particle === null ? 0 : t.particle.length;
  if (cut === 0) return t.range;
  return {
    start: t.range.start,
    end: { line: t.range.end.line, character: t.range.end.character - cut },
  };
}

const rangeKey = (r: Range): string =>
  `${String(r.start.line)}:${String(r.start.character)}:${String(r.end.character)}`;

/** 定義・宣言が置かれている位置。ここは `declaration` 修飾子を付ける */
function declarationSites(parsed: ParseResult): Map<string, 'declaration' | 'definition'> {
  const out = new Map<string, 'declaration' | 'definition'>();
  const add = (d: Declaration | Definition, role: 'declaration' | 'definition'): void => {
    out.set(rangeKey(d.name.range), role);
  };
  for (const d of parsed.declarations) add(d, 'declaration');
  for (const def of parsed.definitions) {
    add(def, 'definition');
    for (const l of def.locals) add(l, 'declaration');
    for (const w of def.localWords) add(w, 'definition');
  }
  return out;
}

/** その位置を含む定義の正規形。局所シンボルを引くのに使う */
function ownerAt(parsed: ParseResult, position: Position): string | undefined {
  let best: string | undefined;
  let start: Position | null = null;
  for (const d of parsed.definitions) {
    if (comparePosition(d.range.start, position) > 0) continue;
    if (comparePosition(position, d.range.end) > 0) continue;
    if (start === null || comparePosition(d.range.start, start) > 0) {
      best = d.name.normalized;
      start = d.range.start;
    }
  }
  return best;
}

export function semanticTokens(ctx: SemanticContext): SemanticToken[] {
  const { parsed, symbols } = ctx;
  const sites = declarationSites(parsed);
  const out: SemanticToken[] = [];
  const end = parsed.endOfCompilation;

  for (const token of parsed.tokens) {
    // `終り。` 以降は塗らない。診断で灰色になる領域と揃える
    if (end !== null && comparePosition(token.range.start, end) >= 0) break;

    if (token.kind === 'operator') {
      out.push({ range: token.range, type: 'operator', modifiers: [] });
      continue;
    }
    if (token.kind !== 'word') continue;

    if (token.normalized.length === 0) continue;
    const range = nameRange(token);

    // 制御構文・宣言語・定義語はキーワード
    if (
      blockRoleOf(token.normalized, token.raw) !== null ||
      DECLARATION_KEYWORDS.has(token.normalized) ||
      DEFINITION_KEYWORDS.has(token.normalized)
    ) {
      out.push({ range, type: 'keyword', modifiers: [] });
      continue;
    }

    // このファイルで定義・宣言されたもの
    const owner = ownerAt(parsed, token.range.start);
    const local = owner === undefined ? undefined : symbols.locals.get(owner)?.get(token.normalized);
    const entry: SymbolEntry | undefined = local ?? symbols.globals.get(token.normalized);
    if (entry !== undefined) {
      const modifiers: SemanticTokenModifier[] = [];
      const site = sites.get(rangeKey(range));
      if (site !== undefined) modifiers.push(site === 'definition' ? 'definition' : 'declaration');
      if (isReadonlyKind(entry.kind)) modifiers.push('readonly');
      // 局所処理単語は親からしか見えない。static で「外に出ない」ことを示す
      if (local !== undefined && entry.kind === '処理単語') modifiers.push('static');
      out.push({ range, type: typeOfKind(entry.kind), modifiers });
      continue;
    }

    // 予約語（コンパイラが用意する語）
    const reserved = RESERVED_BY_NORMALIZED.get(token.normalized);
    if (reserved !== undefined) {
      const type: SemanticTokenType =
        reserved.kind === 'コンパイラ指示' ? 'macro' : reserved.kind === '型名' ? 'type' : 'function';
      out.push({
        range,
        type,
        modifiers: type === 'macro' ? [] : ['defaultLibrary'],
      });
      continue;
    }

    // 標準ライブラリ / カーネルの単語
    const std = ctx.stdlib?.byNormalized.get(token.normalized);
    if (std !== undefined) {
      const modifiers: SemanticTokenModifier[] = ['defaultLibrary'];
      if (isReadonlyKind(std.kind)) modifiers.push('readonly');
      out.push({ range, type: typeOfKind(std.kind), modifiers });
      continue;
    }

    // どこにも無い語は塗らない。tmLanguage の色のままにして、診断に任せる
  }

  return out;
}

/**
 * LSP の `SemanticTokens.data`（5 個 1 組の相対表現）に畳む。
 *
 * 1 組は [行の差分, 文字の差分, 長さ, 型の番号, 修飾子のビット]。
 * 文字の差分は同じ行のときだけ前のトークンからの相対になる。
 */
export function encodeSemanticTokens(tokens: readonly SemanticToken[]): number[] {
  const typeIndex = new Map<string, number>(TOKEN_TYPES.map((t, i) => [t, i]));
  const modifierBit = new Map<string, number>(TOKEN_MODIFIERS.map((m, i) => [m, 1 << i]));

  const sorted = [...tokens].sort((a, b) => comparePosition(a.range.start, b.range.start));
  const data: number[] = [];
  let lastLine = 0;
  let lastChar = 0;

  for (const t of sorted) {
    const line = t.range.start.line;
    // 1 行に収まらないトークンは出さない（semanticTokens 側で出していない）
    if (t.range.end.line !== line) continue;
    const length = t.range.end.character - t.range.start.character;
    if (length <= 0) continue;

    const deltaLine = line - lastLine;
    const deltaChar = deltaLine === 0 ? t.range.start.character - lastChar : t.range.start.character;
    data.push(
      deltaLine,
      deltaChar,
      length,
      typeIndex.get(t.type) ?? 0,
      t.modifiers.reduce((bits, m) => bits | (modifierBit.get(m) ?? 0), 0),
    );
    lastLine = line;
    lastChar = t.range.start.character;
  }
  return data;
}
