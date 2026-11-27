/**
 * リネーム。
 *
 * Mind は照合の前に送り仮名を落とす。定義には入力された名前を使い、
 * 呼び出しでは元の表記から分かる活用形を新しい名前で再現する。
 *
 * 置き換えてよいのは、このファイルで定義・宣言されたシンボルだけ。
 * 標準単語・予約語・制御構文はソースに実体が無いので断る。
 */

import { blockRoleOf, DECLARATION_KEYWORDS, DEFINITION_KEYWORDS } from './keywords.ts';
import { isHiragana, isSeparator, normalize } from './normalizer.ts';
import type { ParseResult } from './parser.ts';
import { enclosingDefinition, findReferences, wordAt } from './queries.ts';
import { isReserved } from './reserved.ts';
import type { SymbolEntry, SymbolTable } from './symbols.ts';
import type { Position, Range, Token } from './types.ts';

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

interface Spelling {
  readonly stem: string;
  readonly okurigana: string;
}

/**
 * 語を「名前の部分」と「末尾の送り仮名」に分ける。
 *
 * 末尾から続くひらがなが送り仮名。ただし語全体がひらがなのときは分けない
 * （`つぎに` のような語を壊さないため。そもそもリネーム対象にはしない）。
 */
export function splitOkurigana(text: string): Spelling {
  const chars = [...text];
  if (chars.every(isHiragana)) return { stem: text, okurigana: '' };
  let i = chars.length;
  while (i > 0 && isHiragana(chars[i - 1]!)) i--;
  return { stem: chars.slice(0, i).join(''), okurigana: chars.slice(i).join('') };
}

const FORMS = ['terminal', 'continuative', 'te', 'past'] as const;
type Form = (typeof FORMS)[number];
type Inflection = Readonly<Record<Form, string>>;

const GODAN: ReadonlyMap<string, readonly [continuative: string, te: string]> = new Map([
  ['う', ['い', 'って']], ['く', ['き', 'いて']], ['ぐ', ['ぎ', 'いで']],
  ['す', ['し', 'して']], ['つ', ['ち', 'って']], ['ぬ', ['に', 'んで']],
  ['ぶ', ['び', 'んで']], ['む', ['み', 'んで']], ['る', ['り', 'って']],
]);

// 漢字の直後が「る」の動詞は読みが分からない。よく使う語は表記で判定する。
const ICHIDAN_RU = /[見着似煮射鋳得経寝出来]る$/;
const GODAN_RU = /(?:[走入帰切知要減練照散蹴滑喋握参限焦遮茂捻弄有在過送取撮採売作造創戻乗登上下降折割掘彫塗振踊座去繰祈齧囓]る|[混交]じる)$/;
const I_E_BEFORE_RU = /[いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ]る$/;

function inflections({ stem, okurigana }: Spelling): readonly Inflection[] {
  const terminal = okurigana || 'する';
  if (terminal.endsWith('する')) {
    const prefix = terminal.slice(0, -2);
    return [{ terminal, continuative: prefix + 'し', te: prefix + 'して', past: prefix + 'した' }];
  }

  const ending = terminal.slice(-1);
  const godan = GODAN.get(ending);
  if (godan === undefined) return [];
  const prefix = terminal.slice(0, -1);
  const word = stem + terminal;
  const ichidan = { terminal, continuative: prefix, te: prefix + 'て', past: prefix + 'た' };
  const possiblyIchidan = ending === 'る' && !GODAN_RU.test(word);
  if (possiblyIchidan && (ICHIDAN_RU.test(word) || I_E_BEFORE_RU.test(terminal))) return [ichidan];

  const [continuative, regularTe] = godan;
  const te = /[行逝]く$/.test(word) ? 'って' : /[問請乞]う$/.test(word) ? 'うて' : regularTe;
  const past = te.slice(0, -1) + (te.endsWith('で') ? 'だ' : 'た');
  const regular = { terminal, continuative: prefix + continuative, te: prefix + te, past: prefix + past };
  // 判定できない「〜る」は両方を候補にし、変換先で形が一致する場合にだけ使う。
  return terminal === 'る' && possiblyIchidan ? [ichidan, regular] : [regular];
}

function suffixFor(forms: readonly Inflection[], form: Form): string | undefined {
  const suffix = forms[0]?.[form];
  return forms.every((candidate) => candidate[form] === suffix) ? suffix : undefined;
}

function isCallable(entry: SymbolEntry): boolean {
  return entry.kind === '処理単語' || entry.kind === '関数' ||
    entry.kind === '等価' || entry.kind === '等価な関数';
}

const positionKey = (p: Position): string => `${p.line}:${p.character}`;

function definitionSpelling(parsed: ParseResult, entry: SymbolEntry): Spelling {
  const locations = new Set(entry.locations.map((range) => positionKey(range.start)));
  const definition = parsed.definitions
    .flatMap((def) => [def, ...def.localWords])
    .find((def) => def.kind !== '仮定義' && locations.has(positionKey(def.name.range.start)));
  return splitOkurigana(definition?.name.raw ?? entry.aliases[0] ?? '');
}

function occurrenceOf(
  token: Token,
  forms: readonly Inflection[],
): { text: string; range: Range; koto: boolean } {
  const { raw, range } = token;
  const okurigana = token.particle === 'と' || token.particle === 'で'
    ? splitOkurigana(raw).okurigana
    : '';
  const terminal = suffixFor(forms, 'terminal');
  // 字句解析では「こと」の「と」や、て形の「で」が助詞に分かれることがある。
  const koto = token.particle === 'と' && terminal !== undefined && okurigana === terminal + 'こと';
  const te = token.particle === 'で' && forms.some((candidate) => candidate.te === okurigana);
  const particleLength = te ? 0 : (token.particle?.length ?? 0);
  const name = raw.slice(0, raw.length - particleLength);
  const indexLength = token.index !== null && name.endsWith(token.index) ? token.index.length : 0;
  const cut = koto ? 'こと'.length : particleLength + indexLength;
  return {
    text: raw.slice(0, raw.length - cut),
    range: cut === 0 ? range : {
      start: range.start,
      end: { line: range.end.line, character: range.end.character - cut },
    },
    koto,
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

  const forms = isCallable(entry) && (token.particle === 'と' || token.particle === 'で')
    ? inflections(definitionSpelling(parsed, entry))
    : [];
  const name = occurrenceOf(token, forms);
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
  if ([...newName].every((ch) => isHiragana(ch) || ch === 'ー')) {
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
 * 定義と呼び出しの表記を照合し、対応が分かる活用形だけを付け替える。
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

  if (options.allowShadowing !== true) {
    const taken = symbols.globals.get(normalize(newName, parsed.wordNormalization));
    if (taken !== undefined && taken.normalized !== target.entry.normalized) {
      return {
        code: 'name-taken',
        message: `\`${taken.aliases[0] ?? newName}\` はすでに使われています`,
      };
    }
  }

  const ranges = findReferences(parsed, symbols, position, { includeDeclaration: true });
  const tokens = new Map(parsed.tokens.filter((token) => token.kind === 'word')
    .map((token) => [positionKey(token.range.start), token]));
  const declarations = new Set(target.entry.locations.map((range) => positionKey(range.start)));
  const old = definitionSpelling(parsed, target.entry);
  const replacement = splitOkurigana(newName);
  const oldForms = isCallable(target.entry) ? inflections(old) : [];
  // 語幹を延ばすリネーム（かごに入 → 買い物かごに入）では元の活用を使う。
  // 最後の一字だけが同じ名前（かごに入 → 商品記入）には引き継がない。
  const oldStemEnding = [...old.stem].slice(-2);
  const inheritOkurigana = replacement.okurigana === '' && old.okurigana !== '' && oldForms.length > 0 &&
    (old.stem === replacement.stem ||
      (oldStemEnding.length === 2 && replacement.stem.endsWith(oldStemEnding.join(''))));
  const declarationName = inheritOkurigana ? newName + old.okurigana : newName;
  const inheritForms = inheritOkurigana ||
    (replacement.okurigana === '' && suffixFor(oldForms, 'terminal') === 'する');
  let newForms: readonly Inflection[] = [];
  if (inheritForms) {
    newForms = oldForms;
  } else if (replacement.okurigana !== '' && oldForms.length > 0) {
    newForms = inflections(replacement);
  }
  // 活用が同じなら、「しながら」のように活用表にない語尾も引き継げる。
  const keepOkurigana = inheritForms || (oldForms.length === 1 && newForms.length === 1 &&
    FORMS.every((form) => oldForms[0]?.[form] === newForms[0]?.[form]));
  const edits: RenameEdit[] = [];

  for (const range of ranges) {
    const key = positionKey(range.start);
    const token = tokens.get(key);
    if (token === undefined) continue;
    const declaration = declarations.has(key);
    const occurrence = occurrenceOf(token, declaration ? [] : oldForms);
    if (declaration) {
      edits.push({ range: occurrence.range, newText: declarationName });
      continue;
    }

    const { okurigana } = splitOkurigana(occurrence.text);
    const form = FORMS.find((candidate) => oldForms.some((inflection) => inflection[candidate] === okurigana));
    // 「る」の活用が曖昧な場合は、送り仮名のない出現をその連用形とはみなさない。
    const suffix = form === undefined || (okurigana === '' && oldForms.length > 1)
      ? undefined
      : suffixFor(newForms, form);
    const newOkurigana = suffix ?? (keepOkurigana && okurigana !== '' ? okurigana : replacement.okurigana);
    const dropKoto = occurrence.koto && newForms.length === 0;
    edits.push({
      range: dropKoto ? token.range : occurrence.range,
      newText: replacement.stem + newOkurigana,
    });
  }

  return edits;
}
