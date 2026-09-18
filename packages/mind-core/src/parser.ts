/**
 * Mind のパーサ。
 *
 * 木を作り込むことはせず、Language Server が必要とするものだけ取り出す。
 *   ・定義と宣言（名前・種別・スタック仕様・位置）
 *   ・定義ごとの局所変数と局所処理単語
 *   ・制御構文ブロックの対応（ならば↔つぎに など）と、その不整合の診断
 *
 * Mind は「単語は使用前に定義されていなければならない」ので、単一パスの
 * トップダウン走査でスコープが確定する。これは LSP にとって都合が良い。
 */

import {
  ARRAY_SUFFIX,
  ATTRIBUTE_WORDS,
  blockRoleOf,
  DECLARATION_KEYWORDS,
  DEFINITION_KEYWORDS,
  STRUCT_KEYWORDS,
  TEMPLATE_KIND,
  TEMPLATE_MEMBER_KIND,
  VISIBILITY_GLOBAL,
  VISIBILITY_LOCAL,
} from './keywords.ts';
import { normalize } from './normalizer.ts';
import { lex } from './lexer.ts';
import type { LexDiagnostic } from './lexer.ts';
import type { Position, Range, Token } from './types.ts';

export type Visibility = 'global' | 'local';

export interface WordRef {
  readonly raw: string;
  readonly normalized: string;
  readonly range: Range;
}

export interface Declaration {
  readonly name: WordRef;
  /** `変数` `文字列` `定数` など */
  readonly kind: string;
  readonly visibility: Visibility;
  /** `○○は △△と 等価。` の △△。等価定義以外では null */
  readonly equivalentTo: WordRef | null;
  readonly range: Range;
}

export interface Definition {
  readonly name: WordRef;
  /** `処理単語` `関数` `仮定義` `本定義` */
  readonly kind: string;
  /** スタック仕様コメント `（単価、個数 → ・）` の中身 */
  readonly stackSpec: string | null;
  /** `処理単語` `関数` に続く属性（`.S` `NN` など） */
  readonly attrs: readonly string[];
  readonly visibility: Visibility;
  /** 定義の冒頭で宣言された局所変数 */
  readonly locals: readonly Declaration[];
  /**
   * 局所処理単語（この定義の中だけに見える下位の処理単語）。
   * `本体とは` より前に並ぶ。親から見えるだけで、外からは見えない。
   */
  readonly localWords: readonly Definition[];
  /** 局所処理単語の場合、それを含む定義の正規形 */
  readonly owner: string | null;
  readonly range: Range;
}

export type ParseDiagnosticCode =
  | 'unclosed-block'
  | 'unexpected-block-close'
  | 'mismatched-block-close'
  | 'missing-case-default'
  | 'unterminated-definition'
  | 'local-declaration-terminated';

export interface ParseDiagnostic {
  readonly message: string;
  readonly range: Range;
  readonly severity: 'error' | 'warning' | 'hint';
  readonly code: ParseDiagnosticCode | LexDiagnostic['code'];
}

/** `"x.src"を　コンパイル。` で取り込まれるソース */
export interface IncludeRef {
  /** 引用符を外したままの、書かれているとおりのパス */
  readonly path: string;
  /** 文字列定数の範囲（引用符を含む） */
  readonly range: Range;
}

export interface ParseResult {
  readonly definitions: readonly Definition[];
  readonly declarations: readonly Declaration[];
  /** `"x.src"を　コンパイル。` の取り込み。書かれた順に並ぶ */
  readonly includes: readonly IncludeRef[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly tokens: readonly Token[];
  /** トップレベルの `終り。` の位置。以降はコンパイル対象外 */
  readonly endOfCompilation: Position | null;
}

interface OpenBlock {
  readonly specIndex: number;
  readonly token: Token;
  sawCaseDefault: boolean;
}

/**
 * 定義名として使う参照。助詞は名前に含めないので取り除き、範囲もその分縮める。
 * `二乗とは` の名前は `二乗` であって `二乗とは` ではない。
 */
const toRef = (t: Token): WordRef => {
  const cut = t.particle === null ? 0 : t.particle.length;
  return {
    raw: cut === 0 ? t.raw : t.raw.slice(0, t.raw.length - cut),
    normalized: t.normalized,
    range: {
      start: t.range.start,
      end: { line: t.range.end.line, character: t.range.end.character - cut },
    },
  };
};

export function parse(source: string): ParseResult {
  const lexed = lex(source);
  const tokens = lexed.tokens;
  const diagnostics: ParseDiagnostic[] = lexed.diagnostics.map((d) => ({
    message: d.message,
    range: d.range,
    severity: d.severity,
    code: d.code,
  }));

  const definitions: Definition[] = [];
  const declarations: Declaration[] = [];

  let visibility: Visibility = 'global';
  let current: { def: Definition; locals: Declaration[]; localWords: Definition[] } | null = null;
  /** 開いている局所処理単語。`。` は付かず、次の `○○とは` か `本体とは` で閉じる */
  let nested: Definition | null = null;
  const blocks: OpenBlock[] = [];

  /** その行で最初の（コメントでない）トークンか */
  const isFirstOnLine = (index: number): boolean => {
    const line = tokens[index]!.range.start.line;
    for (let k = index - 1; k >= 0; k--) {
      const t = tokens[k]!;
      if (t.range.start.line !== line) return true;
      if (t.kind !== 'comment') return false;
    }
    return true;
  };

  /** 同じ行の続きのトークン（コメントを含む） */
  const restOfLine = (from: number): Token[] => {
    const line = tokens[from]!.range.start.line;
    const out: Token[] = [];
    for (let i = from + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.range.start.line !== line) break;
      out.push(t);
    }
    return out;
  };

  const closeNestedWord = (end: Position): void => {
    if (nested === null || current === null) return;
    current.localWords.push({ ...nested, range: { start: nested.range.start, end } });
    nested = null;
  };

  const closeDefinition = (end: Position): void => {
    if (current === null) return;
    closeNestedWord(end);
    definitions.push({
      ...current.def,
      locals: current.locals,
      localWords: current.localWords,
      range: { start: current.def.range.start, end },
    });
    current = null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'comment') continue;

    // --- 可視性の切り替え ---
    if (t.kind === 'word' && (t.normalized === VISIBILITY_LOCAL || t.normalized === VISIBILITY_GLOBAL)) {
      const next = tokens[i + 1];
      if (next?.kind === 'terminator') {
        visibility = t.normalized === VISIBILITY_LOCAL ? 'local' : 'global';
        i += 1;
        continue;
      }
    }

    // --- 行頭の定義・宣言 ---
    if (
      t.kind === 'word' &&
      t.range.start.character === 0 &&
      (t.particle === 'とは' || t.particle === 'は')
    ) {
      closeDefinitionIfDangling(t, i);
      const header = restOfLine(i);
      const parsed = readHeader(t, header, visibility);

      if (parsed.type === 'declaration') {
        declarations.push(parsed.declaration);
      } else if (parsed.definition.kind === '仮定義') {
        // 仮定義は前方参照のための宣言で、本体を持たない。`。` を待たない。
        // 配布物には `○○とは　仮定義　（・ → ・）` と `。` を省いた書き方もある。
        definitions.push(parsed.definition);
      } else {
        current = { def: parsed.definition, locals: [], localWords: [] };
      }
      continue;
    }

    // --- 型紙の要素 ---
    //
    // `ファイルヘッダ型は　型紙` … `。` の中に `＄＄○○は　ワード変数` が並ぶ。
    // 要素は `管理テーブルの　＄＄ＥＯＦ` のように外から引用するので大域に置く。
    if (
      current !== null &&
      current.def.kind === TEMPLATE_KIND &&
      t.kind === 'word' &&
      t.particle === 'は' &&
      isFirstOnLine(i)
    ) {
      const header = restOfLine(i);
      const kindToken = header.find((h) => h.kind === 'word') ?? null;
      declarations.push({
        name: toRef(t),
        kind: TEMPLATE_MEMBER_KIND,
        visibility: 'global',
        equivalentTo: null,
        range: { start: t.range.start, end: (kindToken ?? t).range.end },
      });
      continue;
    }

    // --- 局所処理単語（ネストした定義） ---
    //
    // 定義の中に、字下げして `下位処理とは` … と並べる書き方。マニュアル 02「局所処理単語」。
    // 末尾に `。` は付けず、次の `○○とは` が来たところで暗黙に閉じる。
    // 最後に `本体とは` というダミー宣言を置き、そこから先が親の本体になる。
    // `引数エラーは　（・　→　・）` のように `は` とスタック仕様だけの行も局所処理単語
    // （Mind 9 の tool/mreplace.src）。局所変数の宣言とは、種別の語が無いことで見分ける。
    if (
      current !== null &&
      t.kind === 'word' &&
      (t.particle === 'とは' ||
        (t.particle === 'は' && (t.normalized === BODY_MARKER || isStackSpecOnly(restOfLine(i))))) &&
      t.range.start.character > 0
    ) {
      closeNestedWord(t.range.start);
      if (t.normalized === BODY_MARKER) {
        // `本体とは` は語の定義ではなく、親の本体がここから始まるという目印
        continue;
      }
      const header = restOfLine(i);
      const parsed = readHeader(t, header, 'local');
      if (parsed.type === 'definition') {
        nested = { ...parsed.definition, owner: current.def.name.normalized };
        continue;
      }
    }

    // --- 定義の中の局所宣言 ---
    if (
      current !== null &&
      t.kind === 'word' &&
      t.particle === 'は' &&
      t.range.start.character > 0
    ) {
      const header = restOfLine(i);
      const kindToken = localDeclarationKind(t, header, isFirstOnLine(i));
      if (kindToken !== null) {
        current.locals.push({
          name: toRef(t),
          kind: DECLARATION_KEYWORDS.get(kindToken.normalized) ?? kindToken.raw,
          visibility: 'local',
          equivalentTo: null,
          range: { start: t.range.start, end: kindToken.range.end },
        });
        // 局所変数の宣言に `。` を付けると、そこで定義が終わったと誤認される
        const terminator = header.find((h) => h.kind === 'terminator');
        if (terminator !== undefined) {
          diagnostics.push({
            message: '局所変数の宣言に `。` を付けると、そこで処理単語の定義が終わったと解釈されます',
            range: terminator.range,
            severity: 'warning',
            code: 'local-declaration-terminated',
          });
        }
        continue;
      }
    }

    // --- 制御構文ブロック ---
    if (t.kind === 'word') {
      const role = blockRoleOf(t.normalized, t.raw);
      if (role !== null) {
        const specIndex = BLOCK_INDEX.get(role.spec)!;
        if (role.role === 'open') {
          blocks.push({ specIndex, token: t, sawCaseDefault: false });
        } else if (role.role === 'middle') {
          const top = blocks[blocks.length - 1];
          if (top !== undefined && top.specIndex === specIndex && role.spec.kind === 'case') {
            top.sawCaseDefault = true;
          }
        } else {
          const top = blocks.pop();
          if (top === undefined) {
            diagnostics.push({
              message: `\`${t.raw}\` に対応する \`${role.spec.label}\` がありません`,
              range: t.range,
              severity: 'error',
              code: 'unexpected-block-close',
            });
          } else if (top.specIndex !== specIndex) {
            const openSpec = SPECS[top.specIndex]!;
            diagnostics.push({
              message: `\`${openSpec.label}\` が \`${openSpec.closeLabel}\` で閉じられていません（\`${t.raw}\` が来ました）`,
              range: t.range,
              severity: 'error',
              code: 'mismatched-block-close',
            });
          } else if (role.spec.kind === 'case' && !top.sawCaseDefault) {
            diagnostics.push({
              message: '`事例をとる` には `例外なら` が必要です',
              range: t.range,
              severity: 'error',
              code: 'missing-case-default',
            });
          }
        }
        continue;
      }
    }

    // --- 定義の中の条件コンパイル ---
    // 指示の `。` を定義の終端と取り違えないよう、同じ行の `。` まで読み飛ばす
    if (current !== null && t.kind === 'word' && CONDITIONAL_DIRECTIVES.has(t.normalized)) {
      const rest = restOfLine(i);
      const end = rest.findIndex((r) => r.kind === 'terminator');
      if (end >= 0) i += end + 1;
      continue;
    }

    // --- 定義の終端 ---
    if (t.kind === 'terminator' && current !== null && blocks.length === 0) {
      closeDefinition(t.range.end);
    }
  }

  // 閉じられていないブロック・定義
  for (const b of blocks) {
    const spec = SPECS[b.specIndex]!;
    diagnostics.push({
      message: `\`${b.token.raw}\` が \`${spec.closeLabel}\` で閉じられていません`,
      range: b.token.range,
      severity: 'error',
      code: 'unclosed-block',
    });
  }
  if (current !== null) {
    // ファイル末尾での閉じ忘れは **報告しない**。
    // 実コンパイラは EOF で定義が閉じたものとして受け付ける
    // （`fixtures/inf-corpus/unterminated.src` は終了コード 0）。
    // 入力中はこの状態が普通なので、報告すると打鍵のたびに騒がしくなる。
    // 次の定義が始まってしまう場合は別で、あちらは実コンパイラもエラーにする
    // （`b2-unterminated-next-def.src`）。
    //
    // 入力中の定義は `。` がまだ無いのが普通。範囲をソース末尾まで伸ばしておかないと、
    // 「いまどの定義の中にいるか」が取れず、局所変数の補完が効かなくなる。
    // 末尾トークンではなくソースの末尾まで伸ばす（空白だけの行にカーソルがある場合のため）。
    const sourceLines = source.split(/\r?\n/);
    closeDefinition({
      line: sourceLines.length - 1,
      character: (sourceLines[sourceLines.length - 1] ?? '').length,
    });
  }

  return {
    definitions,
    declarations,
    includes: findIncludes(tokens),
    diagnostics,
    tokens,
    endOfCompilation: lexed.endOfCompilation,
  };

  /**
   * 定義の見出しのあとに、本体らしいものがまだ何も無いか。
   *
   * 条件コンパイルで見出しだけを書き分けることがある（Mind 9 の samplew/subsource-open-childwin.src）。
   *
   *   　　未定義条件コンパイル　子ウィンドウのボタンテキスト。
   *   ラベルを持つ子ウィンドウを開いて描画とは　（・　→　・）
   *   　　条件コンパイル終り
   *   　　定義済条件コンパイル　子ウィンドウのボタンテキスト。
   *   ラベルとボタンを持つ子ウィンドウを開いて描画とは　（・　→　・）
   *   　　条件コンパイル終り
   *   　　　　（本体）
   *
   * 実際に有効になる見出しは 1 つだけなので、本体の無い見出しに続く見出しは閉じ忘れではない。
   */
  function headerOnly(headerLine: number, nextIndex: number): boolean {
    // 見出しの行より後ろ、次の見出しより前のトークン
    let from = nextIndex;
    while (from > 0 && tokens[from - 1]!.range.start.line > headerLine) from--;
    const body = tokens.slice(from, nextIndex).filter((t) => t.kind !== 'comment');
    const directiveLines = new Set(
      body
        .filter((t) => t.kind === 'word' && CONDITIONAL_DIRECTIVES.has(t.normalized))
        .map((t) => t.range.start.line),
    );
    return body.every((t) => directiveLines.has(t.range.start.line));
  }

  function closeDefinitionIfDangling(next: Token, nextIndex: number): void {
    if (current === null) return;
    if (headerOnly(current.def.range.start.line, nextIndex)) {
      // 条件コンパイルで書き分けた見出しの片方。名前は他から引用されうるので定義としては残す
      closeDefinition(next.range.start);
      blocks.length = 0;
      return;
    }
    diagnostics.push({
      message: `\`${current.def.name.raw}\` の定義が \`。\` で閉じられていません`,
      range: current.def.name.range,
      severity: 'error',
      code: 'unterminated-definition',
    });
    closeDefinition(next.range.start);
    blocks.length = 0;
  }
}

import { BLOCK_SPECS } from './keywords.ts';
const SPECS = BLOCK_SPECS;

/** 取り込みの指示語（正規形）。`条件コンパイル` は別の語なので当たらない */
const COMPILE = normalize('コンパイル');
const QUOTES = /^[「『"“]|[」』"”]$/g;

/**
 * `"x.src"を　コンパイル。` を拾う。
 *
 * レキサに通すと 文字列 → `を` → `コンパイル` → `。` の並びになる。
 * `条件コンパイル` は正規形が違うので巻き込まない。
 */
function findIncludes(tokens: readonly Token[]): IncludeRef[] {
  const out: IncludeRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'string') continue;

    for (let k = i + 1; k < tokens.length; k++) {
      const next = tokens[k]!;
      if (next.kind === 'comment') continue;
      if (next.kind === 'terminator' || next.kind === 'string') break;
      if (next.kind !== 'word') break;
      if (next.normalized !== COMPILE) continue;
      const path = t.raw.replace(QUOTES, '');
      if (path !== '') out.push({ path, range: t.range });
      break;
    }
  }
  return out;
}
/** 局所処理単語の並びを終え、親の本体が始まることを示すダミー宣言 */
const BODY_MARKER = normalize('本体');

/**
 * 条件コンパイルの指示語（正規形）。定義の中に書かれることがあり、その `。` は
 * 指示の終わりであって定義の終わりではない（Mind 9 の tool/mhead.src など）。
 *
 *   一つのファイルを処理とは　（ファイル名、標準入力、行数　→　・）
 *   　　…
 *   　　条件コンパイル　ｔａｉｌ動作。      ← ここで定義を閉じてはいけない
 *   　　…
 *   　　条件コンパイル終り。
 *   　　…
 *   　　。
 */
const CONDITIONAL_DIRECTIVES = new Set(
  ['条件コンパイル', '定義済条件コンパイル', '未定義条件コンパイル', '条件コンパイル終り'].map(normalize),
);
const BLOCK_INDEX = new Map(SPECS.map((s, i) => [s, i] as const));

/**
 * 定義の中の `○○は　△△` を局所宣言とみなすか判定し、型の語を返す。
 *
 * `△△` がキーワード（`変数` `文字列` など）ならそれで確定する。
 * キーワードでなくても、型はユーザ定義でありうる。
 *
 *   管理テーブルは　ファイル情報          ← `ファイル情報` は型紙由来の型名
 *
 * これを拾わないと標準ライブラリの局所変数がごっそり未定義語に見える。
 * ただし本文の普通の行を宣言と誤認しないよう、行頭で始まり、
 * うしろに語が 1 つだけ続き、助詞が付いていない場合に限る。
 */
/** 行の残りがスタック仕様のコメント `（・　→　・）` だけか */
function isStackSpecOnly(rest: readonly Token[]): boolean {
  return (
    rest.length > 0 &&
    rest.every((t) => t.kind === 'comment') &&
    rest.some((t) => /→|->/.test(t.raw) && /^[（(]/.test(t.raw))
  );
}

function localDeclarationKind(
  head: Token,
  rest: readonly Token[],
  firstOnLine: boolean,
): Token | null {
  const words = rest.filter((t) => t.kind === 'word');
  const keyword = words.find((w) => DECLARATION_KEYWORDS.has(w.normalized));
  if (keyword !== undefined) return keyword;

  if (!firstOnLine) return null;
  // `例外は　＿任意進処理` のように、制御構文の語は宣言ではない
  if (blockRoleOf(head.normalized, head.raw) !== null) return null;
  // `日時１は　構造体　日時型`（Mind 9 の tool/stamp.src など）
  const [first, second] = words;
  if (
    words.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    STRUCT_KEYWORDS.has(first.normalized) &&
    second.particle === null &&
    !rest.some((t) => t.kind === 'terminator')
  ) {
    return first;
  }
  if (words.length !== 1) return null;
  const only = words[0]!;
  if (only.particle !== null) return null;
  if (rest.some((t) => t.kind === 'terminator')) return null;
  if (blockRoleOf(only.normalized, only.raw) !== null) return null;
  return only;
}

type HeaderResult =
  | { type: 'declaration'; declaration: Declaration }
  | { type: 'definition'; definition: Definition };

function readHeader(head: Token, rest: readonly Token[], visibility: Visibility): HeaderResult {
  const words = rest.filter((t) => t.kind === 'word');

  const defKindToken = words.find((w) => DEFINITION_KEYWORDS.has(w.normalized));
  const declKindToken = words.find((w) => DECLARATION_KEYWORDS.has(w.normalized));

  // スタック仕様は `→` を含む括弧コメント
  const stackToken = rest.find(
    (t) => t.kind === 'comment' && /→|->/.test(t.raw) && /^[（(]/.test(t.raw),
  );
  const stackSpec =
    stackToken === undefined
      ? null
      : stackToken.raw.replace(/^[（(]|[）)]$/g, '').replace(/[\s　]+/g, ' ').trim();

  if (declKindToken !== undefined && defKindToken === undefined) {
    const kind = DECLARATION_KEYWORDS.get(declKindToken.normalized)!;
    // `○○は △△と 等価。` の △△ は、`等価` の直前にある `と` を伴う語
    let equivalentTo: WordRef | null = null;
    if (kind === '等価' || kind === '等価な関数') {
      const idx = words.indexOf(declKindToken);
      for (let k = idx - 1; k >= 0; k--) {
        const w = words[k]!;
        if (w.particle === 'と') {
          equivalentTo = toRef(w);
          break;
        }
      }
    }
    return {
      type: 'declaration',
      declaration: {
        name: toRef(head),
        kind,
        visibility,
        equivalentTo,
        range: { start: head.range.start, end: declKindToken.range.end },
      },
    };
  }

  // 属性は `処理単語` `関数` のあとに並ぶ。`.N` `NN` のような記号形と、
  // `整数入力` `小数出力` `逆転抑制` のような日本語の属性語がある。
  const attrs: string[] = [];
  if (defKindToken !== undefined) {
    let seen = false;
    for (const w of words) {
      if (w === defKindToken) {
        seen = true;
        continue;
      }
      if (!seen) continue;
      if (/^[.A-Za-z0-9]+$/.test(w.raw) || ATTRIBUTE_WORDS.has(w.normalized)) attrs.push(w.raw);
      else break;
    }
  }

  // 種別キーワードが無いときの判断。
  //   `○○とは …` は処理単語（`とは` は `は` でも可）
  //   `○○は　△△。` のように同じ行が `。` で閉じていれば、△△ 型の変数宣言
  //     （`入力ファイルは　ファイル。` の `ファイル` はライブラリ定義の型）
  const terminatedHere = rest.some((t) => t.kind === 'terminator');
  const lastWord = words.at(-1);

  const kind =
    defKindToken !== undefined
      ? DEFINITION_KEYWORDS.get(defKindToken.normalized)!
      : head.particle === 'とは'
        ? '処理単語'
        : terminatedHere && lastWord !== undefined
          ? lastWord.raw
          : '処理単語';

  // 配列は要素の並びが数行続いてから `。` で終わる。その行に `。` が無くても宣言
  const isArray =
    defKindToken === undefined &&
    head.particle === 'は' &&
    lastWord !== undefined &&
    lastWord.normalized.endsWith(ARRAY_SUFFIX);

  if (defKindToken === undefined && head.particle === 'は' && (terminatedHere || isArray) && lastWord !== undefined) {
    return {
      type: 'declaration',
      declaration: {
        name: toRef(head),
        kind: lastWord.raw,
        visibility,
        equivalentTo: null,
        range: { start: head.range.start, end: lastWord.range.end },
      },
    };
  }

  return {
    type: 'definition',
    definition: {
      name: toRef(head),
      kind,
      stackSpec,
      attrs,
      visibility,
      locals: [],
      localWords: [],
      owner: null,
      range: { start: head.range.start, end: head.range.end },
    },
  };
}
