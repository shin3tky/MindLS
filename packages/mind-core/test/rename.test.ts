import { describe, expect, it } from 'vitest';

import { parse } from '../src/parser.ts';
import { prepareRename, renameEdits, splitOkurigana, validateName } from '../src/rename.ts';
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
  const apply = (src: string, edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]): string => {
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

  it('新しい名前が送り仮名で終わるなら、元の送り仮名は足さない', () => {
    const after = apply(SRC, rename(SRC, at('１２０円を　売り上げ計上し', '売り上げ計上'), '記帳する') as never);
    expect(after).toContain('１２０円を　記帳する');
    expect(after).not.toContain('記帳するし');
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
