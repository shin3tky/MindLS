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

import { blockRoleOf, DECLARATION_KEYWORDS, DEFINITION_KEYWORDS, VISIBILITY_GLOBAL, VISIBILITY_LOCAL } from './keywords.ts';
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

export interface ParseResult {
  readonly definitions: readonly Definition[];
  readonly declarations: readonly Declaration[];
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
  let current: { def: Definition; locals: Declaration[] } | null = null;
  const blocks: OpenBlock[] = [];

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

  const closeDefinition = (end: Position): void => {
    if (current === null) return;
    definitions.push({
      ...current.def,
      locals: current.locals,
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
      closeDefinitionIfDangling(t);
      const header = restOfLine(i);
      const parsed = readHeader(t, header, visibility);

      if (parsed.type === 'declaration') {
        declarations.push(parsed.declaration);
      } else if (parsed.definition.kind === '仮定義') {
        // 仮定義は前方参照のための宣言で、本体を持たない。`。` を待たない。
        // 配布物には `○○とは　仮定義　（・ → ・）` と `。` を省いた書き方もある。
        definitions.push(parsed.definition);
      } else {
        current = { def: parsed.definition, locals: [] };
      }
      continue;
    }

    // --- 定義の中の局所宣言 ---
    if (
      current !== null &&
      t.kind === 'word' &&
      t.particle === 'は' &&
      t.range.start.character > 0
    ) {
      const header = restOfLine(i);
      const kindToken = header.find(
        (h) => h.kind === 'word' && DECLARATION_KEYWORDS.has(h.normalized),
      );
      if (kindToken !== undefined) {
        current.locals.push({
          name: toRef(t),
          kind: DECLARATION_KEYWORDS.get(kindToken.normalized)!,
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
    diagnostics.push({
      message: `\`${current.def.name.raw}\` の定義が \`。\` で閉じられていません`,
      range: current.def.name.range,
      severity: 'error',
      code: 'unterminated-definition',
    });
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
    diagnostics,
    tokens,
    endOfCompilation: lexed.endOfCompilation,
  };

  function closeDefinitionIfDangling(next: Token): void {
    if (current === null) return;
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
const BLOCK_INDEX = new Map(SPECS.map((s, i) => [s, i] as const));

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

  // 属性は `処理単語` `関数` のあとに並ぶ英数記号のトークン
  const attrs: string[] = [];
  if (defKindToken !== undefined) {
    let seen = false;
    for (const w of words) {
      if (w === defKindToken) {
        seen = true;
        continue;
      }
      if (!seen) continue;
      if (/^[.A-Za-z0-9]+$/.test(w.raw)) attrs.push(w.raw);
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

  if (defKindToken === undefined && head.particle === 'は' && terminatedHere && lastWord !== undefined) {
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
      range: { start: head.range.start, end: head.range.end },
    },
  };
}
