import { describe, expect, it } from 'vitest';

import { parse } from '../src/parser.ts';
import { prepareRename, renameEdits, splitOkurigana, validateName } from '../src/rename.ts';
import type { RenameEdit } from '../src/rename.ts';
import { buildSymbolTable } from '../src/symbols.ts';

const SRC = [
  '売り上げは　変数。',
  '',
  '売り上げ計上とは　（金額　→　・）',
  '　金額は　変数',
  '　金額に　入れ',
  '　金額だけ　売り上げを　増加すること。',
  '',
  'メインとは',
  '　１２０円を　売り上げ計上し',
  '　２５０円を　売り上げ計上する。',
].join('\n');

const at = (needle: string, inner: string) => {
  const lines = SRC.split('\n');
  const line = lines.findIndex((l) => l.includes(needle));
  return { line, character: lines[line]!.indexOf(inner) + 1 };
};

const rename = (src: string, position: { line: number; character: number }, newName: string) => {
  const parsed = parse(src);
  return renameEdits(parsed, buildSymbolTable(parsed), position, newName);
};

describe('送り仮名の切り出し', () => {
  it.each([
    ['売り上げ計上し', '売り上げ計上', 'し'],
    ['売り上げ計上する', '売り上げ計上', 'する'],
    ['繰り返し', '繰り返', 'し'],
    ['メイン', 'メイン', ''],
    ['カウンター', 'カウンター', ''],
    ['つぎに', 'つぎに', ''], // ひらがなだけの語は分けない
  ])('%s → %s + %s', (raw, stem, okurigana) => {
    expect(splitOkurigana(raw)).toEqual({ stem, okurigana });
  });
});

describe('リネームできるか', () => {
  const parsed = parse(SRC);
  const symbols = buildSymbolTable(parsed);

  it('このファイルの単語なら置き換える範囲を返す（助詞は含まない）', () => {
    const target = prepareRename(parsed, symbols, at('１２０円を　売り上げ計上し', '売り上げ計上'));
    expect(target).toMatchObject({ text: '売り上げ計上し' });
  });

  it('制御構文は断る', () => {
    const r = parse('メインとは\n　ここから\n　繰り返すこと。');
    const t = prepareRename(r, buildSymbolTable(r), { line: 1, character: 2 });
    expect(t).toMatchObject({ code: 'not-renameable' });
  });

  it('予約語は断る', () => {
    const r = parse('メインとは\n　値を　クリアすること。');
    const t = prepareRename(r, buildSymbolTable(r), { line: 1, character: 5 });
    expect(t).toMatchObject({ code: 'not-renameable' });
  });

  it('このファイルに定義の無い単語は断る', () => {
    const r = parse('メインとは\n　一行表示すること。');
    const t = prepareRename(r, buildSymbolTable(r), { line: 1, character: 2 });
    expect(t).toMatchObject({ code: 'not-renameable' });
  });
});

describe('新しい名前の検査', () => {
  it.each([
    ['', '名前が空です'],
    ['売り 上げ', '区切り'],
    ['売上。', '`。`'],
    ['売上※', '`※`'],
    ['「売上」', '引用符'],
    ['うりあげ', 'ひらがなだけ'],
  ])('%s を断る', (name, hint) => {
    expect(validateName(name)?.message).toContain(hint);
  });

  it('ふつうの名前は通す', () => {
    expect(validateName('記帳')).toBeNull();
    expect(validateName('＿作業１')).toBeNull();
  });
});

describe('置き換え', () => {
  /** 編集を当てた結果のソース */
  const apply = (src: string, edits: readonly RenameEdit[]): string => {
    const lines = src.split('\n');
    const sorted = [...edits].sort(
      (a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
    );
    for (const e of sorted) {
      const l = e.range.start.line;
      lines[l] =
        lines[l]!.slice(0, e.range.start.character) + e.newText + lines[l]!.slice(e.range.end.character);
    }
    return lines.join('\n');
  };

  it('出現ごとの送り仮名と助詞を残す', () => {
    const edits = rename(SRC, at('１２０円を　売り上げ計上し', '売り上げ計上'), '記帳');
    expect(Array.isArray(edits)).toBe(true);
    const after = apply(SRC, edits as never);
    expect(after).toContain('記帳とは　（金額　→　・）');
    expect(after).toContain('１２０円を　記帳し');
    expect(after).toContain('２５０円を　記帳する。');
    // 触っていないものは元のまま
    expect(after).toContain('売り上げは　変数。');
  });

  it('入力された名前を定義に使い、呼び出しには対応する活用形を使う', () => {
    const after = apply(SRC, rename(SRC, at('１２０円を　売り上げ計上し', '売り上げ計上'), '記帳する') as never);
    expect(after).toContain('記帳するとは');
    expect(after).toContain('１２０円を　記帳し\n');
    expect(after).toContain('２５０円を　記帳する。');
  });

  const shopping = (definition: string, continuative: string, terminal: string, koto: string) => [
    `${definition}とは`,
    '　０円を　捨てること。',
    'メインとは',
    `　１２０円を　${continuative}、`,
    `　２５０円を　${terminal}。`,
    '副処理とは',
    `　３００円を　${koto}。`,
  ].join('\n');

  it.each([
    ['カートに追加', 'カートに追加', 'カートに追加', 'カートに追加', 'カートに追加'],
    ['カートに追加する', 'カートに追加する', 'カートに追加し', 'カートに追加する', 'カートに追加すること'],
    ['買う', '買う', '買い', '買う', '買うこと'],
    ['買い物かごに入', '買い物かごに入れる', '買い物かごに入れ', '買い物かごに入れる', '買い物かごに入れること'],
    ['商品記入', '商品記入', '商品記入', '商品記入', '商品記入'],
    ['見る', '見る', '見', '見る', '見ること'],
    ['走る', '走る', '走り', '走る', '走ること'],
    ['送る', '送る', '送り', '送る', '送ること'],
    ['雲る', '雲る', '雲る', '雲る', '雲ること'],
  ])('買い物の処理単語を「%s」に変更する', (name, definition, continuative, terminal, koto) => {
    const src = shopping('かごに入れる', 'かごに入れ', 'かごに入れる', 'かごに入れること');
    const result = rename(src, { line: 3, character: 10 }, name);
    expect(Array.isArray(result) && apply(src, result)).toBe(shopping(definition, continuative, terminal, koto));
  });

  it.each([
    ['税込みにする', '税込みにし', '消費税を加える', '消費税を加え'],
    ['見せる', '見せ', '来る', '来'],
    ['見る', '見', '買う', '買い'],
    ['買う', '買い', '帰る', '帰り'],
  ])('%s をリネームしたとき %s の活用形を引き継ぐ', (old, oldCall, name, newCall) => {
    const src = `${old}とは\n　０円を　捨てること。\nメインとは\n　${oldCall}、　${old}。`;
    const result = rename(src, { line: 0, character: 1 }, name);
    expect(Array.isArray(result) && apply(src, result)).toBe(
      `${name}とは\n　０円を　捨てること。\nメインとは\n　${newCall}、　${name}。`,
    );
  });

  it('て形とた形を変換し、後ろの助詞を保つ', () => {
    const src = '川を泳ぐとは\n　０円を　捨てること。\nメインとは\n　川を泳いでから　川を泳いだ、　川を泳いで。';
    const result = rename(src, { line: 0, character: 1 }, '海に行く');
    expect(Array.isArray(result) && apply(src, result)).toBe(
      '海に行くとは\n　０円を　捨てること。\nメインとは\n　海に行ってから　海に行った、　海に行って。',
    );
  });

  it('仮定義と本定義に同じ新名を書き、本定義を活用の手掛かりにする', () => {
    const src = 'かごに入とは　仮定義。\nメインとは\n　かごに入れ、　かごに入れる。\nかごに入れるとは　本定義\n　０円を　捨てること。';
    const result = rename(src, { line: 0, character: 1 }, '買う');
    expect(Array.isArray(result) && apply(src, result)).toBe(
      '買うとは　仮定義。\nメインとは\n　買い、　買う。\n買うとは　本定義\n　０円を　捨てること。',
    );
  });

  it('変数の表記を活用させず、通常の助詞「と」や添字を保つ', () => {
    const src = '売り上げは　数値配列。\n別名は　売り上げと　等価。\nメインとは\n　売り上げ（１）を　表示すること。';
    const result = rename(src, { line: 0, character: 1 }, '売上高');
    expect(Array.isArray(result) && apply(src, result)).toBe(
      '売上高は　数値配列。\n別名は　売上高と　等価。\nメインとは\n　売上高（１）を　表示すること。',
    );
  });

  it('局所変数はその定義の中だけを書き換える', () => {
    const src = [
      '処理１とは',
      '　作業は　変数',
      '　作業に　入れること。',
      '処理２とは',
      '　作業は　変数',
      '　作業を　表示すること。',
    ].join('\n');
    const after = apply(src, rename(src, { line: 1, character: 2 }, '一時値') as never);
    expect(after.split('\n').slice(0, 3).join('\n')).toBe(
      '処理１とは\n　一時値は　変数\n　一時値に　入れること。',
    );
    expect(after.split('\n').slice(3).join('\n')).toContain('作業は　変数');
  });

  it('すでに使われている名前は断る', () => {
    expect(rename(SRC, at('１２０円を　売り上げ計上し', '売り上げ計上'), '売り上げ')).toMatchObject({
      code: 'name-taken',
    });
  });

  it('表記ゆれだけを直すリネームもできる', () => {
    // 正規形は同じままなので `name-taken` にはしない
    const after = apply(SRC, rename(SRC, at('１２０円を　売り上げ計上し', '売り上げ計上'), '売上計上') as never);
    expect(after).toContain('売上計上とは');
    expect(after).toContain('１２０円を　売上計上し');
  });

  it('使えない名前は断る', () => {
    expect(rename(SRC, at('１２０円を　売り上げ計上し', '売り上げ計上'), '記 帳')).toMatchObject({
      code: 'invalid-name',
    });
  });
});
