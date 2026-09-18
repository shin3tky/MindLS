/**
 * 予約語の表。
 *
 * Mind には、辞書に載らない単語がある。
 *
 *   ・変数や文字列実体などに副作用を与える語（`入れる` `クリア` `一つ増加` …）
 *     宣言された型に応じてコンパイラが用意するもので、ライブラリのソースにも
 *     カーネル単語表 `c_words*.wrd` にも出てこない。
 *   ・`ファイル情報` のような、宣言に書く型名
 *   ・`コンパイル` `条件コンパイル` のようなコンパイラ指示
 *
 * これらを未定義として扱うと、ごく普通のプログラムが真っ赤になる。
 * 出典はマニュアル（`pmind/doc/*.html`）で、章を各項目に控えてある。
 */

import { normalize } from './normalizer.ts';

export type ReservedKind = '予約語' | '型名' | 'コンパイラ指示';

export interface ReservedWord {
  /** 代表表記 */
  readonly name: string;
  readonly kind: ReservedKind;
  /** スタック仕様（分かるものだけ） */
  readonly stack: string | null;
  /** ホバーに出す一行説明 */
  readonly doc: string;
  /** マニュアルの出典 */
  readonly source: string;
}

const VARIABLE_EFFECTS: readonly ReservedWord[] = [
  { name: '入れる', kind: '予約語', stack: '値、＜対象＞に → ・', doc: '対象に代入する。助詞は `に` または `へ`。配列全体・構造体全体・ファイルにも代入できる', source: 'マニュアル 6 数値演算' },
  { name: 'クリア', kind: '予約語', stack: '＜対象＞を → ・', doc: '対象に０を入れる。数値変数に限らず、文字列変数・配列・構造体もクリアできる', source: 'マニュアル 6 数値演算' },
  { name: 'セット', kind: '予約語', stack: '＜変数＞を → ・', doc: '整数変数に１（真）を入れる', source: 'マニュアル 6 数値演算' },
  { name: '一つ増加', kind: '予約語', stack: '＜変数＞を → ・', doc: '変数の内容を１だけ増やす', source: 'マニュアル 6 数値演算' },
  { name: '一つ減少', kind: '予約語', stack: '＜変数＞を → ・', doc: '変数の内容を１だけ減らす', source: 'マニュアル 6 数値演算' },
  { name: '増加', kind: '予約語', stack: '値だけ ＜変数＞を → ・', doc: '指定した値だけ変数の内容を増やす', source: 'マニュアル 6 数値演算' },
  { name: '減少', kind: '予約語', stack: '値だけ ＜変数＞を → ・', doc: '指定した値だけ変数の内容を減らす', source: 'マニュアル 6 数値演算' },
  { name: '要素数', kind: '予約語', stack: '＜配列＞の → 個数', doc: '配列（定数配列・文字列定数配列を含む）の要素数。コンパイル時にその数値に置き換わる。`売り上げの　要素数を　回数指定し`', source: 'マニュアル 5 配列' },
  { name: '長さ', kind: '予約語', stack: null, doc: '文字列実体や配列の長さ。宣言では `文字列実体　長さ　２５６` のように大きさの指定にも使う', source: 'マニュアル 4 データ型と変数 / 7 文字列操作' },
];

const CONNECTIVES: readonly ReservedWord[] = [
  { name: 'かつ', kind: '予約語', stack: null, doc: '条件を連ねる（論理積）', source: 'マニュアル 3 制御構文' },
  { name: 'か', kind: '予約語', stack: null, doc: "候補を並べる。`'-'か　'－'の　どちらかに等しい`", source: 'マニュアル 3 制御構文' },
  { name: 'または', kind: '予約語', stack: null, doc: '条件を連ねる（論理和）', source: 'マニュアル 3 制御構文' },
  { name: '続', kind: '予約語', stack: null, doc: '文字列定数を次の行へ続ける。`「…」続` と書き、次の文字列と連結される', source: 'マニュアル 2 プログラムの表記' },
  { name: '返す', kind: '予約語', stack: null, doc: '値をスタックに返して処理単語を抜ける', source: 'マニュアル 2 プログラムの表記' },
];

const TYPE_NAMES: readonly ReservedWord[] = [
  { name: 'ファイル', kind: '型名', stack: null, doc: '論理ファイルの宣言。`入力ファイルは　ファイル。`', source: 'マニュアル 9 ファイル操作' },
  { name: 'ファイル情報', kind: '型名', stack: null, doc: 'ファイル管理テーブルを受け取る局所変数の型', source: '標準ライブラリ file' },
  { name: '文字列実体情報', kind: '型名', stack: null, doc: '文字列実体のヘッダを受け取る局所変数の型', source: '標準ライブラリ file' },
  { name: '構造体情報', kind: '型名', stack: null, doc: '構造体を受け取る局所変数の型', source: 'マニュアル 10 構造体' },
  { name: '実数変数', kind: '型名', stack: null, doc: '小数変数の別名', source: '標準ライブラリ asmequ.src' },
  { name: '倍精度変数', kind: '型名', stack: null, doc: '６４ビット整数の変数', source: 'マニュアル 4 データ型と変数' },
  { name: '配列', kind: '型名', stack: null, doc: '配列の宣言', source: 'マニュアル 5 配列' },
  { name: '型紙', kind: '型名', stack: null, doc: '構造体の型を定義する', source: 'マニュアル 10 構造体' },
  { name: '構造体', kind: '型名', stack: null, doc: '型紙から実体を作る', source: 'マニュアル 10 構造体' },
  { name: '暗黙の構造体', kind: '型名', stack: null, doc: '要素名を `○○の` なしで引用できる構造体', source: 'マニュアル 10 構造体' },
];

const COMPILER_DIRECTIVES: readonly ReservedWord[] = [
  { name: 'コンパイル', kind: 'コンパイラ指示', stack: null, doc: '別のソースを取り込む。`"fhead.src"を　コンパイル。`', source: '標準ライブラリ file.src' },
  { name: '条件コンパイル', kind: 'コンパイラ指示', stack: null, doc: '条件が真のときだけ以降をコンパイルする。`条件コンパイル終り` で閉じる', source: '標準ライブラリ file.src' },
  { name: '条件コンパイル終り', kind: 'コンパイラ指示', stack: null, doc: '`条件コンパイル` を閉じる', source: '標準ライブラリ file.src' },
  { name: '定義済条件コンパイル', kind: 'コンパイラ指示', stack: null, doc: 'その単語が定義済みのときだけコンパイルする', source: '標準ライブラリ file.src' },
  { name: '未定義条件コンパイル', kind: 'コンパイラ指示', stack: null, doc: 'その単語が未定義のときだけコンパイルする', source: '標準ライブラリ file.src' },
  { name: 'グローバル', kind: 'コンパイラ指示', stack: null, doc: 'これ以降の定義を大域にする', source: 'マニュアル 2 プログラムの表記' },
  { name: 'ローカル', kind: 'コンパイラ指示', stack: null, doc: 'これ以降の定義をこのモジュールの中だけに閉じる', source: 'マニュアル 2 プログラムの表記' },
  { name: '本体', kind: 'コンパイラ指示', stack: null, doc: '局所処理単語の並びを終え、親の処理単語の本体が始まることを示す', source: 'マニュアル 2 プログラムの表記' },
  { name: '終り', kind: 'コンパイラ指示', stack: null, doc: 'トップレベルに書くとコンパイルを打ち切る。定義の中では処理単語を抜ける', source: 'マニュアル 2 プログラムの表記' },
];

/** 初等関数。数式表現の中でも Mind 流の表記でも引用できる */
const ELEMENTARY_FUNCTIONS: readonly ReservedWord[] = [
  { name: 'acos', kind: '予約語', stack: '小数 → 小数', doc: '逆余弦。`acos(0.5)` とも `0.5の acosをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'asin', kind: '予約語', stack: '小数 → 小数', doc: '逆正弦。`asin(0.5)` とも `0.5の asinをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'atan', kind: '予約語', stack: '小数 → 小数', doc: '逆正接。`atan(0.5)` とも `0.5の atanをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'cos', kind: '予約語', stack: '小数 → 小数', doc: '余弦。`cos(0.5)` とも `0.5の cosをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'sin', kind: '予約語', stack: '小数 → 小数', doc: '正弦。`sin(0.5)` とも `0.5の sinをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'tan', kind: '予約語', stack: '小数 → 小数', doc: '正接。`tan(0.5)` とも `0.5の tanをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'cosh', kind: '予約語', stack: '小数 → 小数', doc: '双曲線余弦。`cosh(0.5)` とも `0.5の coshをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'sinh', kind: '予約語', stack: '小数 → 小数', doc: '双曲線正弦。`sinh(0.5)` とも `0.5の sinhをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'tanh', kind: '予約語', stack: '小数 → 小数', doc: '双曲線正接。`tanh(0.5)` とも `0.5の tanhをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'exp', kind: '予約語', stack: '小数 → 小数', doc: '指数関数（e の x 乗）。`exp(0.5)` とも `0.5の expをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'log', kind: '予約語', stack: '小数 → 小数', doc: '自然対数。`log(0.5)` とも `0.5の logをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'log10', kind: '予約語', stack: '小数 → 小数', doc: '常用対数。`log10(0.5)` とも `0.5の log10をとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'pow', kind: '予約語', stack: '小数 → 小数', doc: 'べき乗（x の y 乗）。`pow(0.5)` とも `0.5の powをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'sqrt', kind: '予約語', stack: '小数 → 小数', doc: '平方根。`sqrt(0.5)` とも `0.5の sqrtをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'fabs', kind: '予約語', stack: '小数 → 小数', doc: '絶対値。`fabs(0.5)` とも `0.5の fabsをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'radian', kind: '予約語', stack: '小数 → 小数', doc: '角度（度）をラジアンに変換。`radian(0.5)` とも `0.5の radianをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
  { name: 'degree', kind: '予約語', stack: '小数 → 小数', doc: '角度（ラジアン）を度に変換。`degree(0.5)` とも `0.5の degreeをとり` とも書ける', source: 'マニュアル 6 数値演算（初等関数）' },
];

export const RESERVED_WORDS: readonly ReservedWord[] = [
  ...VARIABLE_EFFECTS,
  ...CONNECTIVES,
  ...ELEMENTARY_FUNCTIONS,
  ...TYPE_NAMES,
  ...COMPILER_DIRECTIVES,
];


/**
 * 正規形 → 予約語。
 *
 * 正規化すると `一つ増加` は `一増加`、`入れる` は `入` になる。
 * 表に書いた代表表記から引くのではなく、必ずこの索引で照合すること。
 */
export const RESERVED_BY_NORMALIZED: ReadonlyMap<string, ReservedWord> = new Map(
  RESERVED_WORDS.map((w) => [normalize(w.name), w] as const),
);

export function isReserved(normalized: string): boolean {
  return RESERVED_BY_NORMALIZED.has(normalized);
}
