/**
 * 制御構文キーワードの表。
 *
 * **キーは正規形**であることに注意。Mind は送り仮名を落としてから照合するので、
 * `繰り返す` も `繰り返し` も `繰返` になる。生テキストで照合すると表記ゆれで取りこぼす。
 * 同じ理由で `ならば` は `なら`、`ここから` は `ここ` になる（末尾の助詞が落ちる）。
 */

import { normalize } from './normalizer.ts';

export type BlockKind = 'conditional' | 'loop' | 'select' | 'case';

export interface BlockSpec {
  readonly kind: BlockKind;
  /** ブロックを開く語（正規形） */
  readonly open: readonly string[];
  /** 途中に現れてよい語（正規形） */
  readonly middle: readonly string[];
  /** ブロックを閉じる語（正規形） */
  readonly close: readonly string[];
  /** 閉じ忘れたときのメッセージに使う代表的な表記 */
  readonly label: string;
  readonly closeLabel: string;
}

const n = normalize;

export const BLOCK_SPECS: readonly BlockSpec[] = [
  {
    kind: 'conditional',
    open: [n('ならば'), n('でなければ')],
    middle: [n('さもなければ')],
    close: [n('つぎに')],
    label: 'ならば',
    closeLabel: 'つぎに',
  },
  {
    kind: 'loop',
    open: [n('ここから'), n('回数指定')],
    middle: [n('打ち切り'), n('もう一度')],
    close: [n('繰り返す')],
    label: 'ここから / 回数指定',
    closeLabel: '繰り返す',
  },
  {
    kind: 'select',
    open: [n('選択する')],
    middle: [],
    close: [n('選択終り')],
    label: '選択する',
    closeLabel: '選択終り',
  },
  {
    kind: 'case',
    open: [n('事例をとる'), n('文字列事例をとる'), n('範囲事例をとる')],
    middle: [n('例外なら'), n('範囲外なら')],
    close: [n('事例終り')],
    label: '事例をとる',
    closeLabel: '事例終り',
  },
];

/** 宣言に使われる語（正規形 → 種別） */
export const DECLARATION_KEYWORDS = new Map<string, string>([
  [n('変数'), '変数'],
  [n('小数変数'), '小数変数'],
  [n('ワード変数'), 'ワード変数'],
  [n('バイト変数'), 'バイト変数'],
  [n('文字列実体'), '文字列実体'],
  [n('文字列定数'), '文字列定数'],
  [n('文字列'), '文字列'],
  [n('定数'), '定数'],
  [n('数値'), '数値'],
  [n('等価な関数'), '等価な関数'],
  [n('等価'), '等価'],
  // カーネル単語表 c_words*.wrd の宣言形。`複写は　アセンブラ定義の処理単語。`
  [n('アセンブラ定義の処理単語'), '処理単語'],
]);

/** 定義に使われる語（正規形 → 種別） */
export const DEFINITION_KEYWORDS = new Map<string, string>([
  [n('処理単語'), '処理単語'],
  [n('関数'), '関数'],
  [n('仮定義'), '仮定義'],
  [n('本定義'), '本定義'],
  // 型紙は処理単語ではないが、`○○は　型紙` … `。` という
  // 本体を持つブロックなので、定義と同じ扱いにしておく
  [n('型紙'), '型紙'],
]);

/** 型紙ブロックの中の `△△は` は、その型の要素（大域に見える） */
export const TEMPLATE_KIND = '型紙';
export const TEMPLATE_MEMBER_KIND = '型紙要素';

/**
 * `○○とは　処理単語　整数入力　整数出力` のように種別のうしろに並ぶ属性語（正規形）。
 * マニュアル 02-Program-Hyoki「処理単語の属性を指定する」。
 * 配布物のライブラリでは `.N` `SQ` `NN` のような短い記号形も使われる。
 */
export const ATTRIBUTE_WORDS: ReadonlySet<string> = new Set([
  n('整数入力'),
  n('小数入力'),
  n('整数出力'),
  n('小数出力'),
  n('実数入力'),
  n('実数出力'),
  n('逆転抑制'),
]);

export const VISIBILITY_LOCAL = n('ローカル');
export const VISIBILITY_GLOBAL = n('グローバル');

const CASE_SPEC = BLOCK_SPECS.find((s) => s.kind === 'case')!;
const CONDITIONAL_SPEC = BLOCK_SPECS.find((s) => s.kind === 'conditional')!;

/**
 * その語が何らかのブロック境界なら、その仕様と役割を返す。
 *
 * `ならば`（条件）と `なら`（事例のラベル `'e'なら`）は正規化するとどちらも `なら` になり、
 * 区別できない。生テキストの末尾が `ば` かどうかで見分ける。
 * Mind のコンパイラは文脈で判断しているが、静的解析では表記のほうが確実に効く。
 */
export function blockRoleOf(
  normalized: string,
  raw?: string,
): { spec: BlockSpec; role: 'open' | 'middle' | 'close' } | null {
  if (normalized === CONDITIONAL_SPEC.open[0] && raw !== undefined && !raw.endsWith('ば')) {
    return { spec: CASE_SPEC, role: 'middle' };
  }
  for (const spec of BLOCK_SPECS) {
    if (spec.open.includes(normalized)) return { spec, role: 'open' };
    if (spec.close.includes(normalized)) return { spec, role: 'close' };
    if (spec.middle.includes(normalized)) return { spec, role: 'middle' };
  }
  return null;
}
