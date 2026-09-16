import { describe, expect, it } from 'vitest';

import { parse } from '../src/parser.ts';
import { buildSymbolTable } from '../src/symbols.ts';
import {
  documentSymbols,
  enclosingDefinition,
  findDefinition,
  findReferences,
  searchSymbols,
  wordAt,
} from '../src/queries.ts';
import type { Position } from '../src/types.ts';

const SOURCE = [
  '外部変数は　変数。',                       // 0
  '別名表示は　表示と　等価。',               // 1
  '',                                         // 2
  '表示とは　（文字列　→　・）　処理単語　.S', // 3
  '　　出力すること。',                       // 4
  '',                                         // 5
  'メインとは',                               // 6
  '　　作業は　変数',                         // 7
  '　　外部変数を　作業に　入れ',             // 8
  '　　作業を　表示し',                       // 9
  '　　表示すること。',                       // 10
  '',                                         // 11
  '別の処理とは',                             // 12
  '　　表示すること。',                       // 13
].join('\n');

const lines = SOURCE.split('\n');
const at = (line: number, needle: string): Position => ({
  line,
  character: lines[line]!.indexOf(needle) + 1,
});

const analyze = (src: string = SOURCE) => {
  const parsed = parse(src);
  return { parsed, table: buildSymbolTable(parsed) };
};

describe('位置から引く', () => {
  it('単語トークンを返す', () => {
    const { parsed } = analyze();
    expect(wordAt(parsed, at(9, '表示し'))?.raw).toBe('表示し');
  });

  it('コメントや文字列の中では null', () => {
    const parsed = parse('　　※　ここはコメント\n　　「文字列」を　表示する。');
    expect(wordAt(parsed, { line: 0, character: 5 })).toBeNull();
    expect(wordAt(parsed, { line: 1, character: 4 })).toBeNull();
  });

  it('その位置を含む定義を返す', () => {
    const { parsed } = analyze();
    expect(enclosingDefinition(parsed, at(9, '表示し'))?.name.raw).toBe('メイン');
    expect(enclosingDefinition(parsed, at(0, '外部変数'))).toBeNull();
  });
});

describe('定義ジャンプ', () => {
  it('使用箇所から定義へ飛ぶ', () => {
    const { parsed, table } = analyze();
    const found = findDefinition(parsed, table, at(9, '表示し'));
    expect(found?.entry.normalized).toBe('表示');
    expect(found?.ranges[0]!.start.line).toBe(3);
  });

  it('送り仮名が違っても同じ定義へ飛ぶ', () => {
    const { parsed, table } = analyze();
    expect(findDefinition(parsed, table, at(10, '表示すること'))?.ranges[0]!.start.line).toBe(3);
  });

  it('局所変数は自分の定義の中で解決する', () => {
    const { parsed, table } = analyze();
    const found = findDefinition(parsed, table, at(9, '作業を'));
    expect(found?.entry.owner).toBe('メイン');
    expect(found?.ranges[0]!.start.line).toBe(7);
  });

  it('等価定義は参照先も候補にする', () => {
    const { parsed, table } = analyze();
    const found = findDefinition(parsed, table, at(1, '別名表示'));
    expect(found?.equivalent?.normalized).toBe('表示');
    expect(found?.ranges.map((r) => r.start.line)).toEqual([1, 3]);
  });

  it('未定義の語では null', () => {
    const { parsed, table } = analyze();
    expect(findDefinition(parsed, table, at(8, '入れ'))).toBeNull();
  });
});

describe('参照検索', () => {
  it('大域シンボルはファイル全体から集める', () => {
    const { parsed, table } = analyze();
    const refs = findReferences(parsed, table, at(3, '表示とは'), { includeDeclaration: false });
    // 1 行目の `別名表示は　表示と　等価。` も `表示` の参照
    expect(refs.map((r) => r.start.line)).toEqual([1, 9, 10, 13]);
  });

  it('定義を含めることもできる', () => {
    const { parsed, table } = analyze();
    const refs = findReferences(parsed, table, at(3, '表示とは'), { includeDeclaration: true });
    expect(refs.map((r) => r.start.line)).toEqual([1, 3, 9, 10, 13]);
  });

  it('局所変数はその定義の中に閉じる', () => {
    const { parsed, table } = analyze();
    const refs = findReferences(parsed, table, at(7, '作業は'), { includeDeclaration: true });
    expect(refs.map((r) => r.start.line)).toEqual([7, 8, 9]);
  });

  it('助詞は参照範囲に含めない', () => {
    const { parsed, table } = analyze();
    const refs = findReferences(parsed, table, at(9, '作業を'));
    const r = refs.find((x) => x.start.line === 8)!;
    expect(lines[8]!.slice(r.start.character, r.end.character)).toBe('作業');
  });
});

describe('DocumentSymbol', () => {
  it('定義と宣言を並べ、局所変数を子にする', () => {
    const { parsed } = analyze();
    const symbols = documentSymbols(parsed);
    expect(symbols.map((s) => s.name)).toEqual([
      '外部変数', '別名表示', '表示', 'メイン', '別の処理',
    ]);
    expect(symbols.find((s) => s.name === 'メイン')!.children.map((c) => c.name)).toEqual(['作業']);
  });

  it('スタック仕様と属性を detail に出す', () => {
    const { parsed } = analyze();
    expect(documentSymbols(parsed).find((s) => s.name === '表示')!.detail)
      .toBe('処理単語 （文字列 → ・） .S');
  });

  it('等価定義は参照先を detail に出す', () => {
    const { parsed } = analyze();
    expect(documentSymbols(parsed).find((s) => s.name === '別名表示')!.detail).toBe('等価 → 表示');
  });
});

describe('横断検索', () => {
  it('前方一致を完全一致の次に置く', () => {
    const { table } = analyze();
    const hits = searchSymbols(table, '表示').map((m) => m.entry.normalized);
    expect(hits[0]).toBe('表示');
    expect(hits).toContain('別名表示');
  });

  it('生表記でも引ける', () => {
    const parsed = parse('売り上げ計上とは\n　　掛けること。');
    const table = buildSymbolTable(parsed);
    expect(searchSymbols(table, '売り上げ').map((m) => m.entry.normalized)).toContain('売上計上');
    expect(searchSymbols(table, '売上').map((m) => m.entry.normalized)).toContain('売上計上');
  });

  it('同名でも大域を局所より先に出す', () => {
    // 大域と局所で同じ名前が使われている（局所が大域を隠す）状況
    const parsed = parse('作業は　変数。\nメインとは\n　　作業は　変数\n　　表示すること。');
    const table = buildSymbolTable(parsed);
    const hits = searchSymbols(table, '作業');
    expect(hits).toHaveLength(2);
    expect(hits[0]!.entry.owner).toBeNull();
    expect(hits[1]!.entry.owner).toBe('メイン');
  });

  it('空の問い合わせは何も返さない', () => {
    const { table } = analyze();
    expect(searchSymbols(table, '  ')).toEqual([]);
  });
});
