import { describe, expect, it } from 'vitest';

import { analyze } from '../src/diagnostics.ts';
import type { AnalyzeOptions } from '../src/diagnostics.ts';
import { parse } from '../src/parser.ts';
import { createStdlibIndex } from '../src/stdlib.ts';
import type { StdlibDocument } from '../src/stdlib.ts';
import { buildSymbolTable } from '../src/symbols.ts';

const run = (src: string, options: AnalyzeOptions = {}) => {
  const r = parse(src);
  return analyze(r, buildSymbolTable(r), options);
};
const codes = (src: string, options: AnalyzeOptions = {}) => run(src, options).map((d) => d.code);

const stdlib = createStdlibIndex({
  source: { distribution: 'test', library: 'test' },
  words: [
    {
      name: '表示',
      normalized: '表示',
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

describe('未定義単語', () => {
  it('既定では報告しない（取り込み先を追えないため）', () => {
    expect(codes('メインとは\n　知らない単語し　表示すること。')).toEqual([]);
  });

  it('有効にすると報告する', () => {
    expect(codes('メインとは\n　知らない単語し　表示すること。', { undefinedWords: true, stdlib })).toEqual(
      ['undefined-word'],
    );
  });

  it('辞書・予約語・自分のシンボルは報告しない', () => {
    const src = [
      '売り上げは　変数。',
      'メインとは',
      '　１００円を　売り上げに　入れ',
      '　売り上げを　表示すること。',
    ].join('\n');
    expect(codes(src, { undefinedWords: true, stdlib })).toEqual([]);
  });

  it('取り込み先のシンボルを渡せば報告しない', () => {
    const src = 'メインとは\n　簡易小数表示すること。';
    expect(codes(src, { undefinedWords: true, stdlib })).toEqual(['undefined-word']);
    expect(
      codes(src, { undefinedWords: true, stdlib, imported: new Set(['簡易小数表示']) }),
    ).toEqual([]);
  });

  it('宣言や定義のヘッダ行は参照として数えない', () => {
    // `処理単語` `整数入力` `ファイル情報` は引用ではない
    const src = [
      '入力ファイルは　ファイル。',
      '差を表示とは　処理単語　整数入力　整数入力',
      '　管理表は　ファイル情報',
      '　表示すること。',
    ].join('\n');
    expect(codes(src, { undefinedWords: true, stdlib })).toEqual([]);
  });

  it('終り。 より後ろは見ない', () => {
    expect(codes('終り。\n知らない単語し', { undefinedWords: true, stdlib })).toEqual([]);
  });
});

describe('定義より前での参照', () => {
  it('後ろで定義された単語の引用を報告する', () => {
    const src = ['メインとは\n　二乗し　表示すること。', '二乗とは\n　掛けること。'].join('\n');
    expect(codes(src)).toEqual(['forward-reference']);
  });

  it('仮定義が先にあれば報告しない', () => {
    const src = [
      '二乗とは　仮定義。',
      'メインとは\n　二乗し　表示すること。',
      '二乗とは　本定義\n　掛けること。',
    ].join('\n');
    expect(codes(src)).toEqual([]);
  });

  it('前で定義されていれば報告しない', () => {
    expect(codes('二乗とは\n　掛けること。\nメインとは\n　二乗すること。')).toEqual([]);
  });

  it('同じ名前の定義が条件コンパイルで複数あっても報告しない', () => {
    // あとの定義で局所シンボルを上書きすると、前の定義の中が前方参照に見えてしまう
    const src = [
      '変換とは',
      '　作業は　変数',
      '　作業に　入れること。',
      '変換とは',
      '　作業は　変数',
      '　作業に　入れること。',
    ].join('\n');
    expect(codes(src)).toEqual([]);
  });

  it('切れる', () => {
    const src = ['メインとは\n　二乗し　表示すること。', '二乗とは\n　掛けること。'].join('\n');
    expect(codes(src, { forwardReferences: false })).toEqual([]);
  });
});

describe('否定形の送り仮名', () => {
  it('否定は照合前に落ちるので報告する', () => {
    const [d] = run('メインとは\n　表示しないこと。');
    expect(d?.code).toBe('negative-form');
    expect(d?.message).toContain('否定');
  });

  it('肯定形は報告しない', () => {
    expect(codes('メインとは\n　表示すること。')).toEqual([]);
  });

  it('ひらがなだけの語は対象外', () => {
    expect(codes('メインとは\n　つぎに　しない。')).not.toContain('negative-form');
  });
});

describe('（ ）コメントの空白', () => {
  it('空白が足りないコメントを報告する', () => {
    const [d] = run('メインとは\n　合計（単価　→　金額）し　表示すること。');
    expect(d?.code).toBe('comment-paren-needs-space');
  });

  it('配列の添字は報告しない', () => {
    expect(codes('メインとは\n　配列（１）を　表示すること。')).toEqual([]);
  });

  it('正しく空白のあるコメントは報告しない', () => {
    expect(codes('メインとは\n　（ 単価　→　金額 ）　表示すること。')).toEqual([]);
  });
});

describe('実コンパイラに合わせた振る舞い', () => {
  // 以下はすべて fixtures/inf-corpus/ の見本で実物を確かめてある。

  it('文字列の上限は 32767 文字（半角換算）。170 文字の全角は通る', () => {
    const long = 'あ'.repeat(170);
    expect(codes(`メインとは\n　「${long}」を　一行表示すること。`)).toEqual([]);
  });

  it('処理単語に密着した括弧を拾う（空白が無いとコメントにならない）', () => {
    const src = 'メインとは\n　「あ」を　表示（ここはコメントのつもり）し\n　改行すること。';
    expect(codes(src, { stdlib })).toEqual(['comment-paren-needs-space']);
  });

  it('関数の呼び出し表記は拾わない', () => {
    // マニュアル 6「初等関数」: 関数は func(X) と書ける
    const src = '二乗とは　関数　小数入力　小数出力\n　複写し　ｆ掛けること。\nメインとは\n　二乗(2.1)を　捨てること。';
    expect(codes(src, { stdlib })).toEqual([]);
  });

  it('配列の添字は拾わない', () => {
    const src = '棚は　文字列定数配列\n　"あ",\n　"い"。\nメインとは\n　位置は　変数\n　棚（位置）を　表示すること。';
    expect(codes(src, { stdlib })).toEqual([]);
  });
});

describe('壊れた括弧の巻き添え', () => {
  it('コメントが成立していない行で、破片を未定義単語にしない', () => {
    // `合計（単価　→　金額）し` は `合計（単価` `→` `金額）し` に割れる。
    // 割れたことを 1 回言えば足りる。破片ごとに「未定義です」と重ねない
    // このテストの辞書には `表示` しか入れていないので、それだけで書く
    const src = 'メインとは\n　合計（単価　→　金額）し\n　表示すること。\n合計とは\n　表示すること。';
    expect(codes(src, { stdlib, undefinedWords: true })).toEqual(['comment-paren-needs-space']);
  });

  it('記号だけの語は単語として数えない', () => {
    expect(codes('メインとは\n　［１　＋　２］を　表示すること。', { stdlib, undefinedWords: true })).toEqual([]);
  });
});
