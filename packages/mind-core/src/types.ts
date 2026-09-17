/** LSP と同じ 0 始まり・UTF-16 コードユニット基準の位置 */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export type TokenKind =
  | 'word'         // 単語（識別子・キーワード・宣言語すべて）
  | 'number'       // 数値リテラル
  | 'string'       // 「…」 "…"
  | 'char'         // 'A'
  | 'comment'      // ※行コメント / （ … ） / コンパイル抑止
  | 'terminator'   // 。
  | 'operator';    // 数式表現 ［ … ］ の括弧と演算子（単語ではない）

export interface Token {
  readonly kind: TokenKind;
  /** ソース上の生テキスト。位置合わせとリネームに使う */
  readonly raw: string;
  /**
   * シンボル照合用の正規形。`kind === 'word'` のときだけ意味がある。
   * 助詞は切り出したあとの語幹を正規化したもの。
   */
  readonly normalized: string;
  /** 切り出した助詞（`とは` `は` `を` …）。無ければ null */
  readonly particle: string | null;
  /** 添字部分 `配列（１）` の `（１）`。無ければ null */
  readonly index: string | null;
  /**
   * 助数詞。`５６０円` の `円`、`１０行を` の `行`。
   * マニュアルは「数字に続いて数字でないものが現れたら、その部分を無視」とする。
   * 捨てずに持っておき、実コンパイラとの差分テストで解釈を確定させる。
   */
  readonly counter: string | null;
  readonly range: Range;
}
