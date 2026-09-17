import { describe, expect, it } from 'vitest';

import { parse } from '../src/parser.ts';
import {
  encodeSemanticTokens,
  semanticTokens,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
} from '../src/semantic.ts';
import { createStdlibIndex } from '../src/stdlib.ts';
import type { StdlibDocument } from '../src/stdlib.ts';
import { buildSymbolTable } from '../src/symbols.ts';

const stdlib = createStdlibIndex({
  source: { distribution: 'test', library: 'test' },
  words: [
    {
      name: '一行表示',
      normalized: '一行表示',
      kind: '処理単語',
      stack: '文字列 → ・',
      attrs: [],
      scope: 'global',
      source: 'file',
      file: 'coutput.src',
      line: 1,
    },
  ],
} satisfies StdlibDocument);

const tokensOf = (src: string) => {
  const parsed = parse(src);
  return semanticTokens({ parsed, symbols: buildSymbolTable(parsed), stdlib });
};

/** 行とテキストから、その語に付いたトークンを引く */
const find = (src: string, needle: string) => {
  const lines = src.split('\n');
  const line = lines.findIndex((l) => l.includes(needle));
  const character = lines[line]!.indexOf(needle);
  return tokensOf(src).find(
    (t) => t.range.start.line === line && t.range.start.character === character,
  );
};

const SRC = [
  '売り上げは　変数。',
  '上限は　定数　１０００円。',
  'ファイル型は　型紙',
  '　＄＄状態は　変数。',
  '売り上げ計上とは　（金額　→　・）',
  '　金額は　変数',
  '　金額に　入れ',
  '　金額だけ　売り上げを　増加し',
  '　「毎度」を　一行表示すること。',
  '親とは',
  '　子とは',
  '　　表示し',
  '　本体とは',
  '　　子し　売り上げ計上すること。',
].join('\n');

describe('Semantic Tokens', () => {
  it('このファイルで定義した処理単語と、標準ライブラリの単語を区別する', () => {
    const own = find(SRC, '売り上げ計上すること');
    expect(own).toMatchObject({ type: 'function' });
    expect(own?.modifiers).not.toContain('defaultLibrary');

    expect(find(SRC, '一行表示すること')).toMatchObject({
      type: 'function',
      modifiers: ['defaultLibrary'],
    });
  });

  it('定義・宣言の位置に declaration / definition を付ける', () => {
    expect(find(SRC, '売り上げは')).toMatchObject({ type: 'variable', modifiers: ['declaration'] });
    expect(find(SRC, '売り上げ計上とは')).toMatchObject({
      type: 'function',
      modifiers: ['definition'],
    });
  });

  it('定数は readonly になる', () => {
    expect(find(SRC, '上限は')?.modifiers).toContain('readonly');
  });

  it('型紙は type、その要素は property', () => {
    expect(find(SRC, 'ファイル型は')).toMatchObject({ type: 'type' });
    expect(find(SRC, '＄＄状態は')).toMatchObject({ type: 'property' });
  });

  it('局所処理単語は static を付けて外から見えないことを示す', () => {
    expect(find(SRC, '子とは')?.modifiers).toEqual(
      expect.arrayContaining(['definition', 'static']),
    );
  });

  it('予約語は種類ごとに塗り分ける', () => {
    const src = '入力は　ファイル。\nメインとは\n　値を　クリアし\n　"x.src"を　コンパイルすること。';
    expect(find(src, 'クリアし')).toMatchObject({ type: 'function', modifiers: ['defaultLibrary'] });
    expect(find(src, 'コンパイルすること')).toMatchObject({ type: 'macro', modifiers: [] });
    expect(find(src, 'ファイル。')).toMatchObject({ type: 'type', modifiers: ['defaultLibrary'] });
  });

  it('制御構文はキーワード', () => {
    const src = 'メインとは\n　ここから\n　　打ち切り\n　繰り返すこと。';
    expect(find(src, 'ここから')).toMatchObject({ type: 'keyword' });
    expect(find(src, '繰り返すこと')).toMatchObject({ type: 'keyword' });
  });

  it('知らない語は塗らない（tmLanguage の色に任せる）', () => {
    expect(find('メインとは\n　まったく知らない語すること。', 'まったく知らない語すること')).toBeUndefined();
  });

  it('数式表現の演算子を塗る', () => {
    expect(find('メインとは\n　［１　＋　２］を　捨てること。', '＋')).toMatchObject({
      type: 'operator',
    });
  });

  it('終り。 以降は塗らない', () => {
    const src = '売り上げは　変数。\n終り。\n売り上げを　表示し';
    // `終り` 自身は塗るが、その先の行には何も出さない
    expect(tokensOf(src).every((t) => t.range.start.line <= 1)).toBe(true);
  });
});

describe('LSP 形式への符号化', () => {
  it('5 個 1 組の相対表現になる', () => {
    const data = encodeSemanticTokens([
      { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, type: 'function', modifiers: [] },
      { range: { start: { line: 2, character: 10 }, end: { line: 2, character: 12 } }, type: 'variable', modifiers: ['readonly'] },
      { range: { start: { line: 5, character: 1 }, end: { line: 5, character: 3 } }, type: 'keyword', modifiers: [] },
    ]);
    expect(data).toEqual([
      2, 4, 4, TOKEN_TYPES.indexOf('function'), 0,
      0, 6, 2, TOKEN_TYPES.indexOf('variable'), 1 << TOKEN_MODIFIERS.indexOf('readonly'),
      3, 1, 2, TOKEN_TYPES.indexOf('keyword'), 0,
    ]);
  });

  it('位置の順に並べ替える', () => {
    const data = encodeSemanticTokens([
      { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 2 } }, type: 'keyword', modifiers: [] },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, type: 'keyword', modifiers: [] },
    ]);
    expect(data.slice(0, 2)).toEqual([1, 0]);
    expect(data.slice(5, 7)).toEqual([2, 0]);
  });
});
