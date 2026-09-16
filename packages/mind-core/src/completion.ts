/**
 * 補完候補の生成。
 *
 * VS Code の既定のフィルタは日本語の部分一致が弱い。`filterText` に生表記と正規形の
 * 両方を入れ、`sortText` で「近いスコープほど上」に並べる。
 */

import { BLOCK_SPECS } from './keywords.ts';
import { isSeparator } from './normalizer.ts';
import { enclosingDefinition } from './queries.ts';
import type { ParseResult } from './parser.ts';
import type { StdlibIndex } from './stdlib.ts';
import type { SymbolTable } from './symbols.ts';
import type { Position, Range } from './types.ts';

export type CompletionSource = 'local' | 'document' | 'keyword' | 'snippet' | 'stdlib';

export interface CompletionItem {
  readonly label: string;
  readonly source: CompletionSource;
  readonly kind: string;
  readonly detail: string;
  readonly documentation: string | null;
  /** 挿入する文字列。スニペットなら LSP のスニペット記法 */
  readonly insertText: string;
  readonly isSnippet: boolean;
  /** 絞り込み用。生表記と正規形の両方を含める */
  readonly filterText: string;
  readonly sortText: string;
  /** 置き換える範囲（入力途中の単語） */
  readonly range: Range;
}

export interface CompletionContext {
  readonly parsed: ParseResult;
  readonly symbols: SymbolTable;
  readonly stdlib?: StdlibIndex;
  /** 対象の行のテキスト */
  readonly lineText: string;
  readonly position: Position;
}

/** 分かち書きの区切りまで戻って、入力途中の単語を得る */
export function currentWordPrefix(
  lineText: string,
  character: number,
): { text: string; start: number } {
  let start = Math.min(character, lineText.length);
  while (start > 0) {
    const ch = lineText[start - 1]!;
    if (isSeparator(ch) || ch === '。' || ch === '※') break;
    start -= 1;
  }
  return { text: lineText.slice(start, character), start };
}

const SORT_PREFIX: Record<CompletionSource, string> = {
  local: '0',
  document: '1',
  keyword: '2',
  snippet: '3',
  stdlib: '4',
};

const filterTextOf = (label: string, normalized: string): string =>
  normalized === '' || normalized === label ? label : `${label} ${normalized}`;

export function completionsAt(ctx: CompletionContext): CompletionItem[] {
  const { parsed, symbols, position, lineText } = ctx;
  const prefix = currentWordPrefix(lineText, position.character);
  const range: Range = {
    start: { line: position.line, character: prefix.start },
    end: position,
  };

  // `終り。` 以降はコンパイルされないので候補を出さない
  if (parsed.endOfCompilation !== null && position.line > parsed.endOfCompilation.line) {
    return [];
  }

  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  const add = (
    label: string,
    normalized: string,
    source: CompletionSource,
    kind: string,
    detail: string,
    documentation: string | null,
    insert?: { text: string; snippet: boolean },
  ): void => {
    const key = source + '/' + label;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      label,
      source,
      kind,
      detail,
      documentation,
      insertText: insert?.text ?? label,
      isSnippet: insert?.snippet ?? false,
      filterText: filterTextOf(label, normalized),
      sortText: SORT_PREFIX[source] + label,
      range,
    });
  };

  // 1. いまいる定義の局所変数
  const owner = enclosingDefinition(parsed, position);
  if (owner !== null) {
    for (const e of symbols.locals.get(owner.name.normalized)?.values() ?? []) {
      add(e.aliases[0] ?? e.normalized, e.normalized, 'local', e.kind, e.kind + '（局所）', null);
    }
  }

  // 2. このファイルの大域シンボル
  const documentNames = new Set<string>();
  for (const e of symbols.globals.values()) {
    documentNames.add(e.normalized);
    const detail = e.stackSpec === null ? e.kind : e.kind + '　（' + e.stackSpec + '）';
    add(e.aliases[0] ?? e.normalized, e.normalized, 'document', e.kind, detail, null);
  }

  // 3. 制御構文
  for (const spec of BLOCK_SPECS) {
    for (const word of [...spec.open, ...spec.middle, ...spec.close]) {
      add(word, word, 'keyword', '制御構文', '制御構文', null);
    }
  }

  // 4. スニペット
  for (const s of SNIPPETS) {
    add(s.label, s.label, 'snippet', 'スニペット', s.detail, s.documentation, {
      text: s.body,
      snippet: true,
    });
  }

  // 5. 標準単語（このファイルで同名が定義されていれば、そちらを優先して出さない）
  for (const w of ctx.stdlib?.words ?? []) {
    if (documentNames.has(w.normalized)) continue;
    const detail = w.stack === null ? w.kind : w.kind + '　（' + w.stack + '）';
    add(w.name, w.normalized, 'stdlib', w.kind, detail, (ctx.stdlib?.library ?? '') + ' / ' + w.file);
  }

  return items;
}

interface Snippet {
  readonly label: string;
  readonly detail: string;
  readonly documentation: string;
  readonly body: string;
}

/** 対応を取り違えやすいブロックは、閉じ語まで入れてしまう */
export const SNIPPETS: readonly Snippet[] = [
  {
    label: 'ならば',
    detail: '条件分岐',
    documentation: 'ならば … つぎに',
    body: 'ならば\t${1:処理}\n\tつぎに$0',
  },
  {
    label: 'ならば さもなければ',
    detail: '条件分岐（二分岐）',
    documentation: 'ならば … さもなければ … つぎに',
    body: 'ならば\t${1:処理}\n\tさもなければ\t${2:処理}\n\tつぎに$0',
  },
  {
    label: 'ここから',
    detail: '繰り返し',
    documentation: 'ここから … 繰り返す',
    body: 'ここから\n\t${1:処理}\n繰り返す$0',
  },
  {
    label: '回数指定',
    detail: '回数を指定した繰り返し',
    documentation: '回数指定し … 繰り返す',
    body: '${1:回数}を　回数指定し\n\t${2:処理}\n繰り返す$0',
  },
  {
    label: '事例をとる',
    detail: '事例分岐',
    documentation: '事例をとる … 例外なら … 事例終り',
    body: '事例をとる\n\t${1:値}なら\t${2:処理}\n\t例外なら\t${3:処理}\n事例終り$0',
  },
  {
    label: '選択する',
    detail: '選択',
    documentation: '選択する … 選択終り',
    body: '選択する\n\t${1:処理}\n選択終り$0',
  },
  {
    label: 'メインとは',
    detail: 'エントリポイント',
    documentation: 'プログラムの入口',
    body: 'メインとは\n\t${1:処理}すること。$0',
  },
];
