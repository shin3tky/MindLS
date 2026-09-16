import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser.ts';

const codes = (src: string): string[] => parse(src).diagnostics.map((d) => d.code);

describe('定義と宣言', () => {
  it('行頭の定義を拾い、助詞は名前に含めない', () => {
    const r = parse('メインとは\n　表示すること。');
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]).toMatchObject({ kind: '処理単語' });
    expect(r.definitions[0]!.name.raw).toBe('メイン');
  });

  it('スタック仕様と属性を拾う', () => {
    const r = parse('売り上げ計上とは　（単価、個数　→　・）　処理単語　NN\n　掛けること。');
    expect(r.definitions[0]).toMatchObject({
      kind: '処理単語',
      stackSpec: '単価、個数 → ・',
      attrs: ['NN'],
    });
    expect(r.definitions[0]!.name.normalized).toBe('売上計上');
  });

  it.each([
    ['索引は　変数。', '変数'],
    ['係数は　小数変数。', '小数変数'],
    ['見出しは　文字列。', '文字列'],
    ['行は　文字列実体　長さ　１００桁。', '文字列実体'],
    ['上限は　定数　２５０度。', '定数'],
    ['起動は　文字列定数　"x"。', '文字列定数'],
  ])('宣言を拾う: %s', (src, kind) => {
    expect(parse(src).declarations[0]).toMatchObject({ kind });
  });

  it('等価定義の参照先を拾う', () => {
    const r = parse('別名表示は　表示と　等価。');
    expect(r.declarations[0]!.kind).toBe('等価');
    expect(r.declarations[0]!.equivalentTo?.normalized).toBe('表示');
  });

  it('可視性を追跡する', () => {
    const r = parse('\tローカル。\n内部は　変数。\n\tグローバル。\n外部は　変数。');
    expect(r.declarations.map((d) => [d.name.raw, d.visibility])).toEqual([
      ['内部', 'local'],
      ['外部', 'global'],
    ]);
  });

  it('定義の冒頭の局所変数を拾う', () => {
    const r = parse('メインとは\n　作業は　変数\n　名前は　文字列\n　表示すること。');
    expect(r.definitions[0]!.locals.map((l) => [l.name.raw, l.kind])).toEqual([
      ['作業', '変数'],
      ['名前', '文字列'],
    ]);
  });

  it('局所変数に 。 を付けたら警告する', () => {
    expect(codes('メインとは\n　作業は　変数。\n　表示すること。')).toContain('local-declaration-terminated');
  });
});

describe('制御構文の対応', () => {
  it('対応が取れていれば診断は出ない', () => {
    const src = [
      'メインとは',
      '　旗　ならば　「あり」を　表示し',
      '　さもなければ　無処理',
      '　つぎに',
      '　ここから',
      '　　　旗　ならば　打ち切り　つぎに',
      '　繰り返し',
      '　実行終り。',
    ].join('\n');
    expect(parse(src).diagnostics).toEqual([]);
  });

  it('閉じ忘れを検出する', () => {
    expect(codes('メインとは\n　旗　ならば　「あり」を　表示し。')).toContain('unclosed-block');
    expect(codes('メインとは\n　ここから\n　　表示し。')).toContain('unclosed-block');
  });

  it('対応しない閉じ語を検出する', () => {
    expect(codes('メインとは\n　旗　ならば　表示し\n　繰り返し。')).toContain('mismatched-block-close');
  });

  it('開いていないのに閉じたら検出する', () => {
    expect(codes('メインとは\n　つぎに。')).toContain('unexpected-block-close');
  });

  it('事例をとる に 例外なら が無ければ検出する', () => {
    const ok = parse('メインとは\n　作業を　事例をとる\n　例外なら　表示し\n　事例終り。');
    expect(ok.diagnostics).toEqual([]);
    expect(codes('メインとは\n　作業を　事例をとる\n　１と　表示し\n　事例終り。')).toContain('missing-case-default');
  });

  it('送り仮名の違いを吸収する（繰り返す / 繰り返し）', () => {
    expect(parse('メインとは\n　ここから\n　　表示し\n　繰り返す。').diagnostics).toEqual([]);
    expect(parse('メインとは\n　ここから\n　　表示し\n　繰り返し。').diagnostics).toEqual([]);
  });

  it('回数指定 も 繰り返す で閉じる', () => {
    expect(parse('メインとは\n　１０回　回数指定し\n　　表示し\n　繰り返し。').diagnostics).toEqual([]);
  });
});

describe('定義の閉じ忘れ', () => {
  it('次の定義が始まったら報告する', () => {
    expect(codes('メインとは\n　表示し\n次とは\n　表示すること。')).toContain('unterminated-definition');
  });

  it('ファイル末尾でも報告する', () => {
    expect(codes('メインとは\n　表示し')).toContain('unterminated-definition');
  });
});
