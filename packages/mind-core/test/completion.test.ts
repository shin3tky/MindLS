import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { completionsAt, currentWordPrefix } from '../src/completion.ts';
import { parse } from '../src/parser.ts';
import { createStdlibIndex } from '../src/stdlib.ts';
import { buildSymbolTable } from '../src/symbols.ts';
import type { StdlibDocument } from '../src/stdlib.ts';

const stdlib = createStdlibIndex(
  createRequire(import.meta.url)('../data/stdlib.json') as StdlibDocument,
);

const complete = (src: string, line: number, character: number) => {
  const parsed = parse(src);
  const lines = src.split('\n');
  return completionsAt({
    parsed,
    symbols: buildSymbolTable(parsed),
    stdlib,
    lineText: lines[line] ?? '',
    position: { line, character },
  });
};

describe('入力途中の単語', () => {
  it('分かち書きの区切りまで戻る', () => {
    expect(currentWordPrefix('　　作業を　表示', 8)).toEqual({ text: '表示', start: 6 });
    expect(currentWordPrefix('メインとは', 3)).toEqual({ text: 'メイン', start: 0 });
  });

  it('。 と ※ でも切れる', () => {
    expect(currentWordPrefix('　表示すること。表', 9).text).toBe('表');
    expect(currentWordPrefix('　表示し※注釈', 7).text).toBe('注釈');
  });
});

describe('完了条件: 「表」と打って表示系が出る', () => {
  const items = complete('メインとは\n　　表', 1, 3);
  const labels = items.map((i) => i.label);

  it.each(['表示', '一行表示', '数値表示'])('%s が候補にある', (word) => {
    expect(labels).toContain(word);
  });

  it('標準ライブラリから来ている', () => {
    const item = items.find((i) => i.label === '一行表示')!;
    expect(item.source).toBe('stdlib');
    expect(item.detail).toContain('処理単語');
  });
});

describe('候補の出どころ', () => {
  const SRC = [
    '売り上げ計上とは　（単価、個数　→　・）　処理単語　NN',
    '　　掛けること。',
    'メインとは',
    '　　作業は　変数',
    '　　名前は　文字列',
    '　　',
  ].join('\n');

  it('局所変数を最優先で出す', () => {
    const items = complete(SRC, 5, 2);
    expect(items.filter((i) => i.source === 'local').map((i) => i.label)).toEqual(['作業', '名前']);
    expect(items[0]!.source).toBe('local');
  });

  it('入力中で定義が閉じていなくても局所変数が見える', () => {
    // `。` を打つ前が普通の状態。ここで局所が消えると補完が使い物にならない
    const items = complete('メインとは\n　　作業は　変数\n　　作', 2, 3);
    expect(items.filter((i) => i.source === 'local').map((i) => i.label)).toEqual(['作業']);
  });

  it('このファイルの定義を標準単語より前に出す', () => {
    const items = complete(SRC, 5, 2);
    const mine = items.findIndex((i) => i.label === '売り上げ計上');
    const std = items.findIndex((i) => i.source === 'stdlib');
    expect(mine).toBeLessThan(std);
  });

  it('制御構文とスニペットを含む', () => {
    const items = complete(SRC, 5, 2);
    expect(items.filter((i) => i.source === 'keyword').map((i) => i.label)).toContain('つぎ');
    expect(items.filter((i) => i.source === 'snippet').map((i) => i.label)).toContain('ここから');
  });
});

describe('フィルタと挿入', () => {
  it('filterText に正規形も入れる（表記ゆれで引けるように）', () => {
    const item = complete('売り上げ計上とは\n　　掛けること。\nメインとは\n　　売', 3, 3)
      .find((i) => i.label === '売り上げ計上')!;
    expect(item.filterText).toBe('売り上げ計上 売上計上');
  });

  it('置き換え範囲は入力途中の単語ぶん', () => {
    const item = complete('メインとは\n　　表示', 1, 4)[0]!;
    expect(item.range).toEqual({
      start: { line: 1, character: 2 },
      end: { line: 1, character: 4 },
    });
  });

  it('スニペットは閉じ語まで入れる', () => {
    const snippet = complete('メインとは\n　　', 1, 2)
      .find((i) => i.label === '事例をとる')!;
    expect(snippet.isSnippet).toBe(true);
    expect(snippet.insertText).toContain('例外なら');
    expect(snippet.insertText).toContain('事例終り');
  });
});

describe('出さない場合', () => {
  it('同名を自分で定義していれば標準単語のほうは出さない', () => {
    const items = complete('表示とは\n　　出力すること。\nメインとは\n　　表', 3, 3);
    const 表示 = items.filter((i) => i.label === '表示');
    expect(表示).toHaveLength(1);
    expect(表示[0]!.source).toBe('document');
  });

  it('終り。 以降では候補を出さない', () => {
    const items = complete('メインとは\n　　表示すること。\n終り。\nここは', 3, 3);
    expect(items).toEqual([]);
  });
});
