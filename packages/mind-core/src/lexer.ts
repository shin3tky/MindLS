/**
 * Mind のレキサ。
 *
 * 分かち書きの規則は普通の言語とかなり違う。区切りは
 *   TAB / 空白（半角・全角）/ カンマ（半角・全角）/ 読点
 * だけで、**それ以外はすべて単語の一部**。`赤い色で表示する` は 1 単語になる。
 *
 * このレキサが扱う難所は 3 つ。
 *   1. `（ … ）` は両端に空白があるときだけコメント。無ければ配列添字や演算の括弧
 *   2. `。` は区切り文字ではないが、文の終端として単語を切る
 *   3. トップレベルの `終り。` 以降はコンパイルされない
 */

import { analyzeWord, isSeparator, splitParticle } from './normalizer.ts';
import type { Position, Range, Token, TokenKind } from './types.ts';

export interface LexResult {
  readonly tokens: readonly Token[];
  /** トップレベルの `終り。` の直後。それ以降はコンパイル対象外 */
  readonly endOfCompilation: Position | null;
  readonly diagnostics: readonly LexDiagnostic[];
}

export interface LexDiagnostic {
  readonly message: string;
  readonly range: Range;
  readonly severity: 'error' | 'warning';
  readonly code: LexDiagnosticCode;
}

export type LexDiagnosticCode =
  | 'unterminated-string'
  | 'unterminated-comment'
  | 'string-too-long'
  | 'comment-paren-needs-space';

/** 文字列定数の上限（`続` で継続しない場合） */
const MAX_STRING_LENGTH = 158;

const LINE_COMMENT = '※';
const SUPPRESS_BEGIN = 'コンパイル抑止。';
const SUPPRESS_END = 'コンパイル抑止終り。';
const END_OF_COMPILATION = '終り';

const STRING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
  ['“', '”'],
];

const CHAR_QUOTES = new Set(["'", '’', '＇']);

/**
 * 数式表現の角括弧。マニュアル 6「数式表現」によれば、角括弧・丸括弧・句点の 3 種だけは
 * 例外的に単語と密着して書いてよい。したがって `［1.2` は 1 単語ではなく `［` と `1.2` になる。
 */
const OPEN_BRACKETS = new Set(['［', '[']);
const CLOSE_BRACKETS = new Set(['］', ']']);

/**
 * 数式表現の演算子（全角・半角どちらも可）。マニュアル 6「数式表現」。
 * 演算子は単語と密着して書けないので、丸ごと一致したときだけ演算子とみなす。
 */
const FORMULA_OPERATORS: ReadonlySet<string> = new Set([
  '：＝', ':=',
  '＋', '+',
  '−', '-', 'ー',
  '＝', '=',
  '≠', '＜＞', '<>',
  '＜', '<',
  '≦', '＜＝', '<=',
  '＞', '>',
  '≧', '＞＝', '>=',
  '×', '＊', '*',
  '÷', '／', '/',
  '％', '%', 'ｍｏｄ', 'mod',
]);

const OPEN_PARENS = new Set(['（', '(']);
const CLOSE_PARENS = new Set(['）', ')']);

function isDigit(ch: string): boolean {
  return /[0-9０-９]/.test(ch);
}

// Node の型ストリッピング（--experimental-strip-types 相当）で動かせるよう、
// パラメータプロパティや enum は使わない。tools/ が node で直接実行できるのが利点。
class Cursor {
  line = 0;
  character = 0;
  private readonly lines: readonly string[];

  constructor(lines: readonly string[]) {
    this.lines = lines;
  }

  get atEnd(): boolean {
    return this.line >= this.lines.length;
  }

  get currentLine(): string {
    return this.lines[this.line] ?? '';
  }

  /** 現在位置の 1 文字。行末なら null */
  peek(offset = 0): string | null {
    const l = this.currentLine;
    const i = this.character + offset;
    return i < l.length ? (l[i] ?? null) : null;
  }

  position(): Position {
    return { line: this.line, character: this.character };
  }

  advance(n = 1): void {
    this.character += n;
  }

  nextLine(): void {
    this.line += 1;
    this.character = 0;
  }

  get atLineEnd(): boolean {
    return this.character >= this.currentLine.length;
  }
}

export function lex(source: string): LexResult {
  const lines = source.split(/\r?\n/);
  const cur = new Cursor(lines);
  const tokens: Token[] = [];
  const diagnostics: LexDiagnostic[] = [];
  let endOfCompilation: Position | null = null;

  const push = (kind: TokenKind, raw: string, range: Range): void => {
    if (kind !== 'word') {
      tokens.push({ kind, raw, normalized: '', particle: null, index: null, counter: null, range });
      return;
    }
    // `配列（１）を` のような添字は、シンボル照合の前に取り除く。
    // 分かち書きの規則では 1 単語だが、参照先は `配列` の定義になるため。
    const indexMatch = raw.match(/[（(][^）)]*[）)]/);
    const withoutIndex = indexMatch === null ? raw : raw.replace(indexMatch[0], '');
    const { stem, particle } = splitParticle(withoutIndex);

    // 数字で始まる語は数値リテラル。続く非数字は助数詞として脇に置く。
    const numeric = splitNumericLiteral(stem);
    if (numeric !== null) {
      tokens.push({
        kind: 'number',
        raw,
        normalized: numeric.digits,
        particle,
        index: indexMatch?.[0] ?? null,
        counter: numeric.counter,
        range,
      });
      return;
    }

    tokens.push({
      kind,
      raw,
      normalized: analyzeWord(stem).normalized,
      particle,
      index: indexMatch?.[0] ?? null,
      counter: null,
      range,
    });
  };

  while (!cur.atEnd && endOfCompilation === null) {
    if (cur.atLineEnd) {
      cur.nextLine();
      continue;
    }

    const ch = cur.peek();
    if (ch === null) {
      cur.nextLine();
      continue;
    }

    if (isSeparator(ch)) {
      cur.advance();
      continue;
    }

    // --- コンパイル抑止ブロック ---
    if (cur.currentLine.startsWith(SUPPRESS_BEGIN, cur.character)) {
      const start = cur.position();
      const end = skipSuppressed(cur);
      if (end === null) {
        diagnostics.push({
          message: '`コンパイル抑止。` に対応する `コンパイル抑止終り。` がありません',
          range: { start, end: cur.position() },
          severity: 'error',
          code: 'unterminated-comment',
        });
        break;
      }
      push('comment', SUPPRESS_BEGIN, { start, end });
      continue;
    }

    // --- 行コメント ---
    if (ch === LINE_COMMENT) {
      const start = cur.position();
      const raw = cur.currentLine.slice(cur.character);
      cur.advance(raw.length);
      push('comment', raw, { start, end: cur.position() });
      continue;
    }

    // --- 括弧コメント（両端に空白が必要） ---
    if (OPEN_PARENS.has(ch) && isCommentParen(cur)) {
      const start = cur.position();
      const raw = readParenComment(cur, diagnostics, start);
      push('comment', raw, { start, end: cur.position() });
      continue;
    }

    // --- 文字列 ---
    const pair = STRING_PAIRS.find(([open]) => open === ch);
    if (pair !== undefined) {
      const start = cur.position();
      const raw = readString(cur, pair[0], pair[1], diagnostics);
      push('string', raw, { start, end: cur.position() });
      continue;
    }

    // --- 文字定数 ---
    if (CHAR_QUOTES.has(ch)) {
      const closing = cur.peek(2);
      if (closing !== null && CHAR_QUOTES.has(closing)) {
        const start = cur.position();
        const raw = cur.currentLine.slice(cur.character, cur.character + 3);
        cur.advance(3);
        push('char', raw, { start, end: cur.position() });
        continue;
      }
      // 閉じていなければ普通の単語として扱う
    }

    // --- 終端 ---
    if (ch === '。') {
      const start = cur.position();
      cur.advance();
      push('terminator', '。', { start, end: cur.position() });
      continue;
    }

    // --- 単語 / 数値 ---
    const start = cur.position();
    const raw = readWord(cur);
    if (raw.length === 0) {
      cur.advance();
      continue;
    }
    const range: Range = { start, end: cur.position() };
    const isOperator =
      OPEN_BRACKETS.has(raw) || CLOSE_BRACKETS.has(raw[0]!) || FORMULA_OPERATORS.has(raw);
    push(isOperator ? 'operator' : 'word', raw, range);

    // トップレベルの `終り。` でコンパイルは打ち切られる
    if (start.character === 0 && raw === END_OF_COMPILATION) {
      if (cur.peek() === '。') {
        const tStart = cur.position();
        cur.advance();
        push('terminator', '。', { start: tStart, end: cur.position() });
        endOfCompilation = cur.position();
      }
    }
  }

  return { tokens, endOfCompilation, diagnostics };
}

/** `（` が行頭か空白の直後にあり、対応する `）` の後ろが空白か行末ならコメント */
function isCommentParen(cur: Cursor): boolean {
  const line = cur.currentLine;
  const before = cur.character === 0 ? null : (line[cur.character - 1] ?? null);
  if (before !== null && !isSeparator(before)) return false;

  // 同じ行の中で対応する閉じ括弧を探す（複数行にまたがる場合は readParenComment 側で処理）。
  // 入れ子になっていることがある: `（文字列　→　変換結果、合否(1/0)）`
  let depth = 1;
  for (let i = cur.character + 1; i < line.length; i++) {
    const c = line[i]!;
    if (OPEN_PARENS.has(c)) depth += 1;
    else if (CLOSE_PARENS.has(c)) {
      depth -= 1;
      if (depth > 0) continue;
      const after = line[i + 1] ?? null;
      return after === null || isSeparator(after);
    }
  }
  // この行で閉じていない = 複数行コメントの可能性
  return true;
}

function readParenComment(
  cur: Cursor,
  diagnostics: LexDiagnostic[],
  start: Position,
): string {
  const parts: string[] = [];
  let depth = 0;

  while (!cur.atEnd) {
    if (cur.atLineEnd) {
      parts.push('\n');
      cur.nextLine();
      if (cur.atEnd) break;
      continue;
    }
    const c = cur.peek()!;
    parts.push(c);
    cur.advance();
    if (OPEN_PARENS.has(c)) depth += 1;
    else if (CLOSE_PARENS.has(c)) {
      depth -= 1;
      if (depth === 0) return parts.join('');
    }
  }

  diagnostics.push({
    message: '`（` に対応する `）` がありません',
    range: { start, end: cur.position() },
    severity: 'error',
    code: 'unterminated-comment',
  });
  return parts.join('');
}

function readString(
  cur: Cursor,
  open: string,
  close: string,
  diagnostics: LexDiagnostic[],
): string {
  const start = cur.position();
  const parts: string[] = [open];
  cur.advance();

  while (!cur.atLineEnd) {
    const c = cur.peek()!;
    parts.push(c);
    cur.advance();
    if (c === close) {
      const raw = parts.join('');
      // 開閉の文字数を除いた中身の長さ
      if (raw.length - 2 > MAX_STRING_LENGTH) {
        diagnostics.push({
          message: `文字列定数が ${String(MAX_STRING_LENGTH)} 文字を超えています（行を継続するには末尾に \`続\` を置きます）`,
          range: { start, end: cur.position() },
          severity: 'warning',
          code: 'string-too-long',
        });
      }
      return raw;
    }
  }

  diagnostics.push({
    message: `文字列が ${close} で閉じられていません`,
    range: { start, end: cur.position() },
    severity: 'error',
    code: 'unterminated-string',
  });
  return parts.join('');
}

/** 区切り・終端・コメント開始まで読む */
function readWord(cur: Cursor): string {
  const line = cur.currentLine;
  const start = cur.character;

  // `［` は次の単語の先頭に密着できるので、それ 1 文字で切る
  if (OPEN_BRACKETS.has(line[start]!)) {
    cur.advance(1);
    return line[start]!;
  }
  // `］` は逆に、直後の助詞を伴って `］を` のように書かれる。まとめて 1 つにする
  const startsWithClose = CLOSE_BRACKETS.has(line[start]!);

  let i = start;
  while (i < line.length) {
    const c = line[i]!;
    if (isSeparator(c) || c === '。' || c === LINE_COMMENT) break;
    if (i > start && (OPEN_BRACKETS.has(c) || CLOSE_BRACKETS.has(c))) break;
    if (i > start && startsWithClose && CLOSE_BRACKETS.has(c)) break;
    i += 1;
  }

  cur.advance(i - start);
  return line.slice(start, i);
}

/**
 * 数値リテラルか。
 *
 * 助数詞（`５６０円` の `円`）の扱いはマニュアルの記述が曖昧で、
 * 識別子にも適用すると `８ビット表示` が `8` に潰れてしまう。
 * ここでは**数字だけで構成される語**と、明示的な基数表記だけを数値とみなす。
 * 最終的な判断は実コンパイラとの差分テストでおこなう（docs/COMPILER-BACKEND.md）。
 */
export interface NumericLiteral {
  /** 半角に畳んだ数字部分 */
  readonly digits: string;
  /** 数字に続く非数字（助数詞）。無ければ null */
  readonly counter: string | null;
}

/**
 * 数字で始まる語を、数値部分と助数詞に割る。数値でなければ null。
 *
 *   `５６０円`   → { digits: '560',  counter: '円' }
 *   `１０`       → { digits: '10',   counter: null }
 *   `0xaf64de89` → { digits: '0xaf64de89', counter: null }
 */
export function splitNumericLiteral(stem: string): NumericLiteral | null {
  if (stem.length === 0) return null;

  const toHalf = (s: string): string =>
    s.replace(/[０-９]/g, (c) => String.fromCodePoint(c.codePointAt(0)! - 0xFEE0))
     .replace(/[−－]/g, '-')
     .replace(/[＋]/g, '+')
     .replace(/[．]/g, '.');

  // 基数表記はそのまま数値
  if (isNumberLiteral(stem)) return { digits: toHalf(stem), counter: null };

  const m = stem.match(/^([-−－+＋]?[0-9０-９]+(?:[.．][0-9０-９]+)?)(.*)$/);
  if (m === null) return null;
  const digits = toHalf(m[1]!);
  const rest = m[2] ?? '';
  if (rest.length === 0) return { digits, counter: null };
  // 続きが数字を含むなら助数詞ではない（`8x644` などは上で判定済み）
  if (/[0-9０-９]/.test(rest)) return null;
  return { digits, counter: rest };
}

export function isNumberLiteral(raw: string): boolean {
  if (raw.length === 0) return false;
  if (/^0[xX][0-9a-fA-F]+$/.test(raw)) return true;          // 0xaf64de89
  if (/^[0-9a-fA-F]+[hH]$/.test(raw) && /[0-9]/.test(raw)) return true; // 6800h
  if (/^[0-9]+[xX][0-9a-fA-F]+$/.test(raw)) return true;      // 8x644
  return /^[-−－+＋]?[0-9０-９]+(?:[.．][0-9０-９]+)?(?:[eE][-+－＋]?[0-9０-９]+)?$/.test(raw);
}

function skipSuppressed(cur: Cursor): Position | null {
  cur.advance(SUPPRESS_BEGIN.length);
  while (!cur.atEnd) {
    const idx = cur.currentLine.indexOf(SUPPRESS_END, cur.character);
    if (idx >= 0) {
      cur.advance(idx - cur.character + SUPPRESS_END.length);
      return cur.position();
    }
    cur.nextLine();
  }
  return null;
}
