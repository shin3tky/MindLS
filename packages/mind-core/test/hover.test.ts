import { describe, expect, it } from 'vitest';

import { hoverAt } from '../src/hover.ts';
import { parse } from '../src/parser.ts';
import { buildSymbolTable } from '../src/symbols.ts';
import { loadStdlib } from './helpers/stdlib.ts';

const stdlib = loadStdlib();

const hover = (src: string, line: number, character: number) => {
  const parsed = parse(src);
  return hoverAt({
    parsed,
    symbols: buildSymbolTable(parsed),
    stdlib,
    lines: src.split('\n'),
    position: { line, character },
  });
};

const USER = [
  '売り上げ計上とは　（単価、個数　→　・）　処理単語　NN',
  '　　掛けること。',
  '別名計上は　売り上げ計上と　等価。',
  'メインとは',
  '　　作業は　変数',
  '　　作業を　売り上げを計上すること。',
].join('\n');

describe('自分で定義した単語', () => {
  const info = hover(USER, 5, 8)!;

  it('種別を出す', () => {
    expect(info.contents).toContain('**売り上げ計上**');
    expect(info.contents).toContain('*処理単語*');
  });

  it('スタック仕様を出す（引数と戻りを知る唯一の手がかり）', () => {
    expect(info.contents).toContain('単価、個数 → ・');
  });

  it('定義行の抜粋と行番号を出す', () => {
    expect(info.contents).toContain('売り上げ計上とは　（単価、個数　→　・）');
    expect(info.contents).toContain('1 行目で定義');
  });

  it('送り仮名の違う使用箇所からでも、定義側の表記で出る', () => {
    // カーソルは `売り上げを計上すること` の上。見出しは定義の表記になる
    expect(info.contents).toContain('**売り上げ計上**');
  });

  it('仮定義と本定義で表記が違えば、表記ゆれとして並べる', () => {
    const src = ['二乗とは　仮定義。', '二乗するとは　本定義', '　　掛けること。'].join('\n');
    const parsed = parse(src);
    const shown = hoverAt({
      parsed,
      symbols: buildSymbolTable(parsed),
      stdlib,
      lines: src.split('\n'),
      position: { line: 0, character: 1 },
    })!;
    expect(shown.contents).toContain('表記ゆれ');
    expect(shown.contents).toContain('二乗する');
  });
});

describe('局所変数', () => {
  it('どの定義の局所かを示す', () => {
    const info = hover(USER, 5, 3)!;
    expect(info.contents).toContain('**作業**');
    expect(info.contents).toContain('*変数*');
    expect(info.contents).toContain('`メイン` の局所');
  });
});

describe('等価定義', () => {
  it('参照先を示す', () => {
    const info = hover(USER, 2, 2)!;
    expect(info.contents).toContain('**別名計上**');
    expect(info.contents).toContain('`売上計上` と等価');
  });
});

describe('標準単語', () => {
  const info = hover('メインとは\n　　「あ」を　表示し　改行すること。', 1, 8)!;

  it('種別と属性を出す', () => {
    expect(info.contents).toContain('**表示**');
    expect(info.contents).toContain('*処理単語*');
    expect(info.contents).toContain('`.S`');
  });

  it('スタック仕様を出す', () => {
    expect(info.contents).toContain('文字列 → ・');
  });

  it('出典を示す', () => {
    expect(info.contents).toContain('標準ライブラリ file');
    expect(info.contents).toContain('coutput.src:126');
  });
});

describe('出さない場合', () => {
  it('コメントや文字列の上では出さない', () => {
    expect(hover('　　※　これはコメント', 0, 6)).toBeNull();
    expect(hover('　　「文字列」を　表示する。', 0, 4)).toBeNull();
  });

  it('知らない単語では出さない', () => {
    expect(hover('メインとは\n　　まったく知らない単語し', 1, 6)).toBeNull();
  });
});
