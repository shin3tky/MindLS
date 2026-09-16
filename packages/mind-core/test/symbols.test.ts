import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser.ts';
import { buildSymbolTable, resolve, visibleSymbols } from '../src/symbols.ts';

const build = (src: string) => buildSymbolTable(parse(src));

describe('シンボルテーブル', () => {
  it('正規形をキーに、表記ゆれを別名として束ねる', () => {
    const t = build('売り上げ計上とは\n　掛けること。\n呼び出しとは\n　売り上げを計上すること。');
    const e = t.globals.get('売上計上')!;
    expect(e.normalized).toBe('売上計上');
    expect(e.aliases).toContain('売り上げ計上');
  });

  it('仮定義と本定義を 1 語にまとめる', () => {
    const t = build('二乗とは　仮定義。\n二乗とは　本定義\n　複写し、掛けること。');
    const e = t.globals.get('二乗')!;
    expect(e.kind).toBe('処理単語');
    expect(e.locations).toHaveLength(2);
  });

  it('スタック仕様を持つ', () => {
    const t = build('表示とは　（文字列　→　・）　処理単語　.S\n　出力すること。');
    expect(t.globals.get('表示')!.stackSpec).toBe('文字列 → ・');
  });

  it('等価定義の参照先を持つ', () => {
    const t = build('表示とは\n　出力すること。\n別名表示は　表示と　等価。');
    expect(t.globals.get('別名表示')!.equivalentTo).toBe('表示');
  });
});

describe('スコープ', () => {
  const src = [
    '外部変数は　変数。',
    'メインとは',
    '　作業は　変数',
    '　表示すること。',
    '別の処理とは',
    '　表示すること。',
  ].join('\n');

  it('局所変数はその定義の中だけで解決できる', () => {
    const t = build(src);
    expect(resolve(t, '作業', 'メイン')?.kind).toBe('変数');
    expect(resolve(t, '作業')).toBeUndefined();
    expect(resolve(t, '作業', '別の処理')).toBeUndefined();
  });

  it('大域はどこからでも解決できる', () => {
    const t = build(src);
    expect(resolve(t, '外部変数')?.kind).toBe('変数');
    expect(resolve(t, '外部変数', 'メイン')?.kind).toBe('変数');
  });

  it('可視シンボルは局所 + 大域', () => {
    const t = build(src);
    const inMain = visibleSymbols(t, 'メイン').map((e) => e.normalized);
    expect(inMain).toContain('作業');
    expect(inMain).toContain('外部変数');
    expect(visibleSymbols(t, '別の処理').map((e) => e.normalized)).not.toContain('作業');
  });

  it('送り仮名が違っても同じ語として解決できる', () => {
    const t = build('反応するとは\n　表示すること。');
    expect(resolve(t, '反応')?.kind).toBe('処理単語');
  });
});
