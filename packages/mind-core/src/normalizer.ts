/**
 * Mind の単語正規化。
 *
 * Mind のコンパイラはソース上の文字列をそのまま識別子として扱わず、
 * 一定の変換を施してからシンボルテーブルを引く。本モジュールはその変換を実装する。
 * ハイライト・補完・定義ジャンプ・参照検索のすべてがこの関数の正しさに乗る。
 *
 * 根拠: Mind プログラミングマニュアル（基礎編）「2 プログラム表記の基本」
 *   https://www.scripts-lab.co.jp/mind/ver9/doc/02-Program-Hyoki.html
 *
 * NFKC は使わない。`〜` `～` `ー` などに意図しない変換がかかるため、
 * 幅と大小の畳み込みは自前のテーブルでおこなう。
 */

/** 分かち書きの区切り文字。これ以外はすべて単語の一部。 */
export const SEPARATORS = new Set([
  '\t',       // タブ
  ' ',        // 半角空白
  '　',   // 全角空白
  ',',        // 半角カンマ
  '，',   // 全角カンマ
  '、',   // 読点
]);

export function isSeparator(ch: string): boolean {
  return SEPARATORS.has(ch);
}

/** 構文判定に使う助詞。長いものから順に照合する。 */
export const PARTICLES = [
  'とは', 'から', 'まで', 'より',
  'は', 'が', 'を', 'に', 'へ', 'と', 'で', 'の',
] as const;

/** ひらがなのみの単語で、末尾から落とす助詞。 */
const TRAILING_KANA_PARTICLES = [
  'から', 'まで', 'より',
  'は', 'が', 'を', 'に', 'へ', 'と', 'で', 'の', 'も', 'ば',
];

// --- 半角カナ → 全角カナ -----------------------------------------------------

const HANKAKU_KANA =
  '｡｢｣､･ｦｧｨｩｪｫｬｭｮｯ' +
  'ｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾ' +
  'ｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍ' +
  'ﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const ZENKAKU_KANA =
  '。「」、・ヲァィゥェォャュョッ' +
  'ーアイウエオカキクケコサシスセソ' +
  'タチツテトナニヌネノハヒフヘホ' +
  'マミムメモヤユヨラリルレロワン';

const HANKAKU_TO_ZENKAKU = new Map<string, string>();
for (let i = 0; i < HANKAKU_KANA.length; i++) {
  HANKAKU_TO_ZENKAKU.set(HANKAKU_KANA[i]!, ZENKAKU_KANA[i]!);
}

const VOICED = new Map<string, string>(Object.entries({
  カ: 'ガ', キ: 'ギ', ク: 'グ', ケ: 'ゲ', コ: 'ゴ',
  サ: 'ザ', シ: 'ジ', ス: 'ズ', セ: 'ゼ', ソ: 'ゾ',
  タ: 'ダ', チ: 'ヂ', ツ: 'ヅ', テ: 'デ', ト: 'ド',
  ハ: 'バ', ヒ: 'ビ', フ: 'ブ', ヘ: 'ベ', ホ: 'ボ',
  ウ: 'ヴ',
}));
const SEMI_VOICED = new Map<string, string>(Object.entries({
  ハ: 'パ', ヒ: 'ピ', フ: 'プ', ヘ: 'ペ', ホ: 'ポ',
}));

const HANKAKU_VOICED_MARK = 'ﾞ';      // ﾞ
const HANKAKU_SEMI_VOICED_MARK = 'ﾟ'; // ﾟ

export interface WordNormalizationOptions {
  /** 半角カナを全角へ変換する。既定 true。Mind 8 for Linux では false。 */
  readonly foldHalfwidthKana?: boolean;
}

/**
 * 幅と大小を畳み込む。
 *   ・設定に応じて半角カナ → 全角カナ（濁点・半濁点は合成する）
 *   ・全角英数記号 → 半角
 *   ・英大文字 → 小文字
 */
export function foldWidthAndCase(input: string, options?: WordNormalizationOptions): string {
  const out: string[] = [];
  const chars = [...input];
  const foldHalfwidthKana = options?.foldHalfwidthKana !== false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;

    // 半角カナ
    const zen = foldHalfwidthKana ? HANKAKU_TO_ZENKAKU.get(ch) : undefined;
    if (zen !== undefined) {
      const next = chars[i + 1];
      if (next === HANKAKU_VOICED_MARK) {
        const v = VOICED.get(zen);
        if (v !== undefined) { out.push(v); i++; continue; }
      } else if (next === HANKAKU_SEMI_VOICED_MARK) {
        const v = SEMI_VOICED.get(zen);
        if (v !== undefined) { out.push(v); i++; continue; }
      }
      out.push(zen);
      continue;
    }

    const code = ch.codePointAt(0)!;

    // 全角英数記号 (！ .. ～) → 半角
    if (code >= 0xFF01 && code <= 0xFF5E) {
      out.push(String.fromCodePoint(code - 0xFEE0));
      continue;
    }

    out.push(ch);
  }

  // 英字の大小を畳む（日本語には影響しない）
  return out.join('').replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// --- ひらがな判定 ------------------------------------------------------------

/** ひらがな（ぁ〜ゖ、ゝゞ）。長音符 ー は含めない。 */
export function isHiragana(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x3041 && c <= 0x3096) || c === 0x309D || c === 0x309E;
}

function isAllHiragana(s: string): boolean {
  return s.length > 0 && [...s].every(isHiragana);
}

// --- 正規化 ------------------------------------------------------------------

export interface WordAnalysis {
  /** ソース上の生テキスト */
  raw: string;
  /** シンボル照合に使う正規形 */
  normalized: string;
  /** 保持された先頭のひらがな（無ければ空文字列） */
  leadingKana: string;
  /** 送り仮名として落とされたひらがな */
  droppedKana: string;
  /** 語全体がひらがなだったか */
  allHiragana: boolean;
}

/**
 * 単語を解析して正規形を得る。
 *
 *   ・漢字などに続くひらがな（送り仮名）は落とす
 *   ・ただし先頭のひらがなは保持する（`ご案内する` は `案内` と別語）
 *   ・語全体がひらがなの場合は、末尾の助詞と思われるものだけ落とす
 *   ・幅の変換後、全角の中点を無視する
 *   ・英字の大小と英数記号の全半角は等価に畳む
 */
export function analyzeWord(raw: string, options?: WordNormalizationOptions): WordAnalysis {
  const withoutNakaguro = foldWidthAndCase(raw, options).replaceAll('・', '');

  if (isAllHiragana(withoutNakaguro)) {
    const { stem, dropped } = stripTrailingKanaParticle(withoutNakaguro);
    return {
      raw,
      normalized: stem,
      leadingKana: stem,
      droppedKana: dropped,
      allHiragana: true,
    };
  }

  const chars = [...withoutNakaguro];

  // 先頭の連続したひらがなは保持する
  let lead = 0;
  while (lead < chars.length && isHiragana(chars[lead]!)) lead++;
  const leadingKana = chars.slice(0, lead).join('');

  const kept: string[] = [];
  const dropped: string[] = [];
  for (let i = lead; i < chars.length; i++) {
    const ch = chars[i]!;
    if (isHiragana(ch)) dropped.push(ch);
    else kept.push(ch);
  }

  return {
    raw,
    normalized: leadingKana + kept.join(''),
    leadingKana,
    droppedKana: dropped.join(''),
    allHiragana: false,
  };
}

/** 単語の正規形だけが欲しいときの薄い入口。 */
export function normalize(raw: string, options?: WordNormalizationOptions): string {
  return analyzeWord(raw, options).normalized;
}

function stripTrailingKanaParticle(s: string): { stem: string; dropped: string } {
  for (const p of TRAILING_KANA_PARTICLES) {
    if (s.length > p.length && s.endsWith(p)) {
      return { stem: s.slice(0, s.length - p.length), dropped: p };
    }
  }
  return { stem: s, dropped: '' };
}

// --- 助詞の切り出し（構文判定用） -------------------------------------------

export interface ParticleSplit {
  /** 助詞を除いた部分 */
  stem: string;
  /** 切り出した助詞。無ければ null */
  particle: string | null;
}

/**
 * 構文判定のために、生テキストの末尾から助詞を切り出す。
 *
 * `とは` `は` を送り仮名として消してしまうと定義が検出できなくなるため、
 * 正規化の前にこの関数で助詞を分離しておく。
 */
export function splitParticle(raw: string): ParticleSplit {
  // 語そのものが助詞の場合は切り出さない（`とは` を `と` + `は` に割らない）
  if ((PARTICLES as readonly string[]).includes(raw)) {
    return { stem: raw, particle: null };
  }
  for (const p of PARTICLES) {
    if (raw.length > p.length && raw.endsWith(p)) {
      return { stem: raw.slice(0, raw.length - p.length), particle: p };
    }
  }
  return { stem: raw, particle: null };
}

// --- 否定形の検出 ------------------------------------------------------------

/**
 * 「ない」「ず」の直前にあると、実コンパイラが否定の送り仮名とみなす仮名。
 *
 * Mind 8 for Linux（8.07）と Mind 9 for Windows（9.05）で、直前の仮名 72 通りを総当たりした結果
 * （`fixtures/inf-corpus/negprobe.src`）。両方の版で完全に同じだった。動詞の未然形の語尾にあたる
 * あ段・い段・え段の仮名が並ぶが、`ぎ` `へ` `ぺ` などは含まれない。「ず」の前では `で` も含まれない。
 */
const REJECTED_BEFORE_NAI = new Set([...'いえかきけがげさしせじぜたちてでなにねばびべまみめらりれわ']);
const REJECTED_BEFORE_ZU = new Set([...'いえかきけがげさしせじぜたちてなにねばびべまみめらりれわ']);

/**
 * 末尾以外に否定があるかを見るときに、否定の語尾の直前とみなす仮名。
 * 実コンパイラの表に `ぎ` `へ` を足したもの（`過ぎない` `経ない` も否定なのに、エラーにならない）。
 */
const NEGATIVE_STEM = new Set([...REJECTED_BEFORE_NAI, 'ぎ', 'へ']);
const NEGATIVE_ENDINGS = ['ない', 'なかっ', 'なく', 'なけれ', 'ず', 'ぬ', 'ねば'];

/**
 * 否定の送り仮名の扱い。
 *   ・`rejected` … 実コンパイラが「否定の送り仮名が付いています」とエラーにする
 *   ・`ignored`  … コンパイルは通るが、否定の意味が送り仮名と一緒に落ちる
 */
export type NegativeForm = 'rejected' | 'ignored';

/**
 * 実コンパイラと同じ切り方で、語の送り仮名を取り出す。
 * ひらがなだけの語は、先頭の 1 字を名前、残りを送り仮名とみなす（`おかず` は `お` ＋ `かず`）。
 */
function compilerOkurigana(chars: readonly string[]): string {
  if (chars.every(isHiragana)) return chars.slice(1).join('');
  let i = chars.length;
  while (i > 0 && isHiragana(chars[i - 1]!)) i--;
  return chars.slice(i).join('');
}

/**
 * 否定の送り仮名かどうか。
 *
 * 実コンパイラがエラーにするのは、送り仮名が「ない」か「ず」で**終わり**、その直前の仮名が
 * 未然形の語尾にあたるときだけ（`表示しない` `残さず` `数えない`）。後ろに何か続くと
 * （`表示しないこと` `表示せずに` `表示しなかった`）コンパイルは通り、送り仮名と一緒に否定も落ちて、
 * 肯定形と同じ単語になる。`少ない` `少なくない` のように直前が未然形でなければ否定ではない。
 *
 * `raw` は助詞を含む生の表記を渡す（実コンパイラも助詞を切り出す前の語尾を見ている）。
 */
export function negativeFormOf(raw: string, options?: WordNormalizationOptions): NegativeForm | null {
  const chars = [...foldWidthAndCase(raw, options)];
  const okurigana = [...compilerOkurigana(chars)];
  const before = (suffixLength: number): string | undefined => okurigana[okurigana.length - suffixLength - 1];
  const text = okurigana.join('');

  if (text.endsWith('ない') && REJECTED_BEFORE_NAI.has(before(2) ?? '')) return 'rejected';
  if (text.endsWith('ず') && REJECTED_BEFORE_ZU.has(before(1) ?? '')) return 'rejected';

  // ひらがなだけの語は、名前と送り仮名の境目が分からないので、エラーになる形だけを見る
  if (chars.every(isHiragana)) return null;
  if (text.includes('ません')) return 'ignored';
  for (let i = 1; i < okurigana.length; i++) {
    if (!NEGATIVE_STEM.has(okurigana[i - 1]!)) continue;
    const rest = okurigana.slice(i).join('');
    if (NEGATIVE_ENDINGS.some((ending) => rest.startsWith(ending))) return 'ignored';
  }
  return null;
}

/** 否定の送り仮名が付いているか（エラーになるものも、意味が落ちるだけのものも含む） */
export function isNegativeForm(raw: string, options?: WordNormalizationOptions): boolean {
  return negativeFormOf(raw, options) !== null;
}
