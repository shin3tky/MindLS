/**
 * 自前解析による診断。
 *
 * レキサとパーサが出す構文レベルの診断（未終端の文字列、閉じ忘れたブロックなど）とは別に、
 * シンボルを見てはじめて分かることを調べる。
 *
 * 実コンパイラを呼ぶ診断（`@mindls/compiler`）とは役割が違う。こちらは
 * 「保存しなくても、Docker が無くても、入力中でも出る」ことを優先する。
 * したがって **誤検出しないこと**を確度より優先し、確信の持てないものは既定で無効にする。
 */

import { ATTRIBUTE_WORDS, blockRoleOf, DECLARATION_KEYWORDS, DEFINITION_KEYWORDS } from './keywords.ts';
import { isNegativeForm, normalize, PARTICLES } from './normalizer.ts';
import type { ParseResult } from './parser.ts';
import { isReserved } from './reserved.ts';
import type { StdlibIndex } from './stdlib.ts';
import { comparePosition, containsPosition } from './queries.ts';
import type { SymbolTable } from './symbols.ts';
import type { Position, Range, Token } from './types.ts';

export type AnalysisDiagnosticCode =
  | 'undefined-word'
  | 'forward-reference'
  | 'negative-form'
  | 'comment-paren-needs-space';

export interface AnalysisDiagnostic {
  readonly message: string;
  readonly range: Range;
  readonly severity: 'error' | 'warning' | 'hint';
  readonly code: AnalysisDiagnosticCode;
}

export interface AnalyzeOptions {
  /** 標準単語辞書。無ければ標準単語は未定義とみなさない（= 未定義単語の検査を諦める） */
  readonly stdlib?: StdlibIndex;
  /**
   * `"x.src"を　コンパイル。` で取り込まれる他ファイルの大域シンボル（正規形）。
   * これが無いと取り込み先の単語が未定義に見えるので、既定では未定義検査を切ってある。
   */
  readonly imported?: ReadonlySet<string>;
  /** 未定義単語を報告する。既定 false */
  readonly undefinedWords?: boolean;
  /** 定義より前での参照を報告する。既定 true */
  readonly forwardReferences?: boolean;
  /** 否定形の送り仮名を報告する。既定 true */
  readonly negativeForms?: boolean;
  /** `（ ）` コメントの空白不足を報告する。既定 true */
  readonly commentParens?: boolean;
}

/** 制御構文・宣言・定義・属性に使われる語（正規形） */
const SYNTAX_WORDS: ReadonlySet<string> = new Set([
  ...DECLARATION_KEYWORDS.keys(),
  ...DEFINITION_KEYWORDS.keys(),
  ...ATTRIBUTE_WORDS,
  ...PARTICLES,
]);

/**
 * ヘッダ行のトークン位置。
 *
 * `○○とは　処理単語　整数入力` の `処理単語` `整数入力` は単語の引用ではないので、
 * 未定義検査から外す。宣言の型名（`ファイル情報` など）も同じ。
 */
function headerLines(result: ParseResult): ReadonlySet<number> {
  const lines = new Set<number>();
  const add = (r: Range): void => {
    for (let l = r.start.line; l <= r.end.line; l++) lines.add(l);
  };
  for (const d of result.declarations) add(d.name.range);
  for (const def of result.definitions) {
    add(def.name.range);
    for (const l of def.locals) add(l.range);
    for (const w of def.localWords) add(w.name.range);
  }
  return lines;
}

/** 参照として数えるトークンか */
function isReference(t: Token, headers: ReadonlySet<number>): boolean {
  if (t.kind !== 'word') return false;
  if (t.normalized.length === 0) return false;
  if (headers.has(t.range.start.line)) return false;
  if (blockRoleOf(t.normalized, t.raw) !== null) return false;
  if (SYNTAX_WORDS.has(t.normalized)) return false;
  // 括弧が密着した語は解決できない。添字（`配列（１）`）、関数呼び出し（`pow(5.0`）、
  // それに空白不足で壊れたコメントの破片（`金額）し`）も含めて、開き閉じ両方を見る
  if (/[（()）]/.test(t.raw)) return false;
  // 記号だけの語は単語ではない（`→` `≧` など、壊れたコメントの中身が残ったもの）
  if (!/[ぁ-ゖァ-ヺ一-龯a-zA-Z0-9ａ-ｚＡ-Ｚ０-９]/.test(t.normalized)) return false;
  return true;
}

/** その位置を含む定義の正規形（局所シンボルを引くのに要る） */
function ownerAt(result: ParseResult, position: Position): string | undefined {
  let best: string | undefined;
  let bestStart: Position | null = null;
  for (const d of result.definitions) {
    if (!containsPosition(d.range, position)) continue;
    if (bestStart === null || comparePosition(d.range.start, bestStart) > 0) {
      best = d.name.normalized;
      bestStart = d.range.start;
    }
  }
  return best;
}

export function analyze(
  result: ParseResult,
  table: SymbolTable,
  options: AnalyzeOptions = {},
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const headers = headerLines(result);
  const end = result.endOfCompilation;

  for (const t of result.tokens) {
    if (end !== null && comparePosition(t.range.start, end) >= 0) break;

    if (options.commentParens !== false && t.kind === 'word') {
      const paren = looksLikeIntendedComment(t.raw) ?? parenOnAction(t.raw, table, options.stdlib);
      if (paren !== null) {
        out.push({
          message: `\`${paren}\` はコメントになりません。\`（\` の前と \`）\` の後ろに空白を置いてください（Mind は「かっこ表記に誤りが有ります」とエラーにします）`,
          range: t.range,
          severity: 'warning',
          code: 'comment-paren-needs-space',
        });
      }
    }

    if (!isReference(t, headers)) continue;

    if (options.negativeForms !== false && isNegativeForm(t.raw)) {
      out.push({
        message: `\`${t.raw}\` の否定は Mind に伝わりません。送り仮名は照合前に落とされるので、肯定形と同じ単語になります`,
        range: t.range,
        severity: 'warning',
        code: 'negative-form',
      });
    }

    const owner = ownerAt(result, t.range.start);
    const local = owner === undefined ? undefined : table.locals.get(owner)?.get(t.normalized);
    const entry = local ?? table.globals.get(t.normalized);

    if (entry !== undefined) {
      if (options.forwardReferences !== false) {
        const first = entry.locations.reduce<Position | null>(
          (min, r) => (min === null || comparePosition(r.start, min) < 0 ? r.start : min),
          null,
        );
        if (first !== null && comparePosition(t.range.start, first) < 0) {
          out.push({
            message: `\`${t.raw}\` はこの位置より後ろで定義されています。Mind は前方参照できないので、先に \`仮定義\` を置いてください`,
            range: t.range,
            severity: 'warning',
            code: 'forward-reference',
          });
        }
      }
      continue;
    }

    if (options.undefinedWords !== true) continue;
    if (options.stdlib?.byNormalized.has(t.normalized) === true) continue;
    if (options.imported?.has(t.normalized) === true) continue;
    if (isReserved(t.normalized)) continue;

    out.push({
      message: `\`${t.raw}\` は定義されていません`,
      range: t.range,
      severity: 'warning',
      code: 'undefined-word',
    });
  }

  return out;
}

/**
 * コメントのつもりで書かれたが、空白が足りずに単語の一部になっている `（ … ）`。
 *
 * `（` の前に空白が無いとコメントにならず、`（` は単語の一部になる。さらにその中に
 * 空白があると、そこで単語が切れて括弧が閉じないまま残る。
 *
 *   合計（単価　→　金額）し      → `合計（単価` `→` `金額）し`
 *
 * つまり「閉じていない `（` を含む単語」が目印になる。
 * 添字（`配列（１）`）は括弧が閉じているので対象にならない。
 * `pow(5.0` のような関数呼び出しは別物なので、英数字だけの語は外す。
 */
function looksLikeIntendedComment(raw: string): string | null {
  let depth = 0;
  for (const c of raw) {
    if (c === '（' || c === '(') depth += 1;
    else if (c === '）' || c === ')') depth -= 1;
  }
  if (depth <= 0) return null;
  const head = raw.slice(0, Math.max(raw.indexOf('（'), raw.indexOf('(')) + 1);
  if (/^[\w.]*[（(]$/.test(head)) return null;
  return raw;
}

/**
 * 処理単語のうしろに括弧が密着している形。
 *
 *   「あ」を　表示（ここはコメントのつもり）し
 *
 * 括弧の中に空白が無いので単語は切れず、`looksLikeIntendedComment` では拾えない。
 * それでも実コンパイラは「かっこ表記に誤りが有ります」とエラーにする
 * （`fixtures/inf-corpus/b2-paren-comment.src`）。
 *
 * 添字や関数呼び出しと見分けるため、次をすべて満たすときだけ拾う。
 *   ・括弧の前が **処理単語** として解決する。関数は `小数関数(2.1)` という
 *     呼び出し表記が正しい（マニュアル 6「初等関数」）ので対象外
 *   ・括弧の中に仮名か漢字がある（`pow(5.0)` のような数値の並びは対象外）
 */
function parenOnAction(
  raw: string,
  table: SymbolTable,
  stdlib: StdlibIndex | undefined,
): string | null {
  const m = /^(?<stem>[^（(]+)[（(](?<body>[^）)]*)[）)]/.exec(raw);
  if (m?.groups === undefined) return null;
  const body = m.groups['body']!;
  if (!/[ぁ-ゖァ-ヺ一-龯]/.test(body)) return null;

  const stem = normalize(m.groups['stem']!);
  const kind = table.globals.get(stem)?.kind ?? stdlib?.byNormalized.get(stem)?.kind;
  if (kind !== '処理単語') return null;
  return m[0];
}
