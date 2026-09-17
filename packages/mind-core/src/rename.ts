/**
 * リネーム。
 *
 * Mind は照合の前に送り仮名を落とすので、同じ単語がソース上では
 * `売り上げ計上し` `売り上げ計上する` `売り上げ計上とは` と揺れて現れる。
 * 名前だけを差し替えて、**末尾の送り仮名と助詞はその場のものを残す**。
 *
 *   売り上げ計上し    → 記帳し
 *   売り上げ計上する  → 記帳する
 *   売り上げ計上とは  → 記帳とは
 *
 * 置き換えてよいのは、このファイルで定義・宣言されたシンボルだけ。
 * 標準単語・予約語・制御構文はソースに実体が無いので断る。
 */

import { blockRoleOf, DECLARATION_KEYWORDS, DEFINITION_KEYWORDS } from './keywords.ts';
import { isSeparator, normalize } from './normalizer.ts';
import type { ParseResult } from './parser.ts';
import { enclosingDefinition, findReferences, wordAt } from './queries.ts';
import { isReserved } from './reserved.ts';
import type { SymbolEntry, SymbolTable } from './symbols.ts';
import type { Position, Range } from './types.ts';

export interface RenameTarget {
  readonly entry: SymbolEntry;
  /** 置き換える範囲（助詞を含まない、いまの名前そのもの） */
  readonly range: Range;
  /** いまの名前 */
  readonly text: string;
}

export interface RenameEdit {
  readonly range: Range;
  readonly newText: string;
}

export type RenameError =
  | { readonly code: 'not-a-symbol'; readonly message: string }
  | { readonly code: 'not-renameable'; readonly message: string }
  | { readonly code: 'invalid-name'; readonly message: string }
  | { readonly code: 'name-taken'; readonly message: string };

/** ひらがなか（送り仮名の判定に使う） */
function isHiraganaChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x3041 && c <= 0x309f) || ch === 'ー';
}

/**
 * 語を「名前の部分」と「末尾の送り仮名」に分ける。
 *
 * 末尾から続くひらがなが送り仮名。ただし語全体がひらがなのときは分けない
 * （`つぎに` のような語を壊さないため。そもそもリネーム対象にはしない）。
 */
export function splitOkurigana(text: string): { stem: string; okurigana: string } {
  const chars = [...text];
  if (chars.every(isHiraganaChar)) return { stem: text, okurigana: '' };
  let i = chars.length;
  while (i > 0 && isHiraganaChar(chars[i - 1]!)) i--;
  return { stem: chars.slice(0, i).join(''), okurigana: chars.slice(i).join('') };
}

/** 助詞を除いた、単語そのものの範囲とテキスト */
function nameOf(raw: string, particle: string | null, range: Range): { text: string; range: Range } {
  const cut = particle === null ? 0 : particle.length;
  if (cut === 0) return { text: raw, range };
  return {
    text: raw.slice(0, raw.length - cut),
    range: {
      start: range.start,
      end: { line: range.end.line, character: range.end.character - cut },
    },
  };
}

/**
 * その位置がリネームできるか調べ、置き換える範囲を返す。
 * LSP の `textDocument/prepareRename` に対応する。
 */
export function prepareRename(
  parsed: ParseResult,
  symbols: SymbolTable,
  position: Position,
): RenameTarget | RenameError {
  const token = wordAt(parsed, position);
  if (token === null || token.kind !== 'word' || token.normalized.length === 0) {
    return { code: 'not-a-symbol', message: 'ここには単語がありません' };
  }

  if (
    blockRoleOf(token.normalized, token.raw) !== null ||
    DECLARATION_KEYWORDS.has(token.normalized) ||
    DEFINITION_KEYWORDS.has(token.normalized)
  ) {
    return { code: 'not-renameable', message: `\`${token.raw}\` は Mind の構文語なので変更できません` };
  }
  if (isReserved(token.normalized)) {
    return { code: 'not-renameable', message: `\`${token.raw}\` は予約語なので変更できません` };
  }

  const owner = enclosingDefinition(parsed, position);
  const entry =
    (owner === null
      ? undefined
      : symbols.locals.get(owner.name.normalized)?.get(token.normalized)) ??
    symbols.globals.get(token.normalized);

  if (entry === undefined) {
    return {
      code: 'not-renameable',
      message: `\`${token.raw}\` はこのファイルで定義されていません（標準単語や他のファイルの単語は変更できません）`,
    };
  }

  const name = nameOf(token.raw, token.particle, token.range);
  return { entry, range: name.range, text: name.text };
}

/** 新しい名前として書けるか。Mind の分かち書きを壊すものを弾く */
export function validateName(newName: string): RenameError | null {
  if (newName.length === 0) return { code: 'invalid-name', message: '名前が空です' };
  if ([...newName].some(isSeparator)) {
    return {
      code: 'invalid-name',
      message: '単語の区切り（空白・タブ・カンマ・読点）は名前に使えません',
    };
  }
  if (newName.includes('。')) {
    return { code: 'invalid-name', message: '`。` は文の終わりなので名前に使えません' };
  }
  if (newName.includes('※')) {
    return { code: 'invalid-name', message: '`※` から先はコメントになるので名前に使えません' };
  }
  if (/^[「『"“'’＇]/.test(newName)) {
    return { code: 'invalid-name', message: '引用符では始められません（文字列と区別できません）' };
  }
  if ([...newName].every(isHiraganaChar)) {
    return {
      code: 'invalid-name',
      message: 'ひらがなだけの名前は、送り仮名と区別できないので避けてください',
    };
  }
  return null;
}

export interface RenameOptions {
  /** 同じ正規形の単語がすでにあるときも通す */
  readonly allowShadowing?: boolean;
}

/**
 * 全出現を書き換える編集を作る。
 *
 * それぞれの出現から末尾の送り仮名を取り出し、新しい名前のうしろに戻す。
 * 助詞は範囲の外なので触らない。
 */
export function renameEdits(
  parsed: ParseResult,
  symbols: SymbolTable,
  position: Position,
  newName: string,
  options: RenameOptions = {},
): RenameEdit[] | RenameError {
  const target = prepareRename(parsed, symbols, position);
  if ('code' in target) return target;

  const invalid = validateName(newName);
  if (invalid !== null) return invalid;

  const newAnalysis = splitOkurigana(newName);

  if (options.allowShadowing !== true) {
    const taken = symbols.globals.get(normalize(newName));
    if (taken !== undefined && taken.normalized !== target.entry.normalized) {
      return {
        code: 'name-taken',
        message: `\`${taken.aliases[0] ?? newName}\` はすでに使われています`,
      };
    }
  }

  const ranges = findReferences(parsed, symbols, position, { includeDeclaration: true });
  const edits: RenameEdit[] = [];

  for (const range of ranges) {
    const text = textOf(parsed, range);
    if (text === null) continue;
    const { okurigana } = splitOkurigana(text);
    // 新しい名前がすでに送り仮名で終わっているなら、そのぶんは足さない
    const suffix = newAnalysis.okurigana.length > 0 ? '' : okurigana;
    edits.push({ range, newText: newAnalysis.stem + newAnalysis.okurigana + suffix });
  }

  return edits;
}

/** 範囲に対応する生テキストをトークンから拾う */
function textOf(parsed: ParseResult, range: Range): string | null {
  for (const t of parsed.tokens) {
    if (t.range.start.line !== range.start.line) continue;
    if (t.range.start.character !== range.start.character) continue;
    const cut = t.range.end.character - range.end.character;
    return cut > 0 ? t.raw.slice(0, t.raw.length - cut) : t.raw;
  }
  return null;
}
