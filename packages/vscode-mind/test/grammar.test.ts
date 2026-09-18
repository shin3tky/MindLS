import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasScope, scopesOf, tokenize } from './helpers/tokenize.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = readFileSync(join(REPO, 'fixtures', 'syntax.src'), 'utf8');

/** 最後（いちばん内側）のスコープ */
const inner = (scopes: readonly string[]): string => scopes[scopes.length - 1]!;

describe('コメント', () => {
  it('※ から行末まで', async () => {
    expect(await hasScope('※これはコメント', 'これはコメント', 'comment.line')).toBe(true);
  });

  it('文字列の中の ※ はコメントにならない', async () => {
    const toks = await tokenize('　「※これは文字列」を　表示する。');
    const t = toks.find((x) => x.text.includes('※'))!;
    expect(inner(t.scopes)).toContain('string.quoted');
  });

  it('両端に空白のある （ ） はコメント', async () => {
    expect(await hasScope('　　（ここから初期化）', 'ここから初期化', 'comment.block')).toBe(true);
  });

  it('空白の無い （ ） は配列添字であってコメントではない', async () => {
    const toks = await tokenize('　　配列（１）を　作業に　入れ');
    const paren = toks.find((t) => t.text === '（')!;
    expect(paren.scopes.some((s) => s.startsWith('comment'))).toBe(false);
    expect(await hasScope('　　配列（１）を', '１', 'constant.numeric')).toBe(true);
  });

  it('コンパイル抑止 〜 コンパイル抑止終り はブロックコメント', async () => {
    const src = ['コンパイル抑止。', '　「これは文字列ではない」', 'コンパイル抑止終り。'].join('\n');
    const toks = await tokenize(src);
    const t = toks.find((x) => x.text.includes('これは文字列ではない'))!;
    expect(inner(t.scopes)).toContain('comment.block.suppressed');
  });
});

describe('リテラル', () => {
  it('「」の文字列', async () => {
    expect(await hasScope('　「こんにちは」を　表示する。', 'こんにちは', 'string.quoted.japanese')).toBe(true);
  });

  it('"" の文字列', async () => {
    expect(await hasScope('起動コマンドは　文字列定数　"dir /w"。', 'dir /w', 'string.quoted.double')).toBe(true);
  });

  it.each([
    ['『』', '　『こんにちは』を　表示する。', 'こんにちは', 'string.quoted.japanese'],
    ['“”', '　“こんにちは”を　表示する。', 'こんにちは', 'string.quoted.double'],
    ['”” (Shift_JIS)', '　”b: 実行”続', 'b: 実行', 'string.quoted.double'],
  ])('%s の文字列', async (_label, src, text, scope) => {
    expect(await hasScope(src, text, scope)).toBe(true);
  });

  it('文字定数', async () => {
    expect(await hasScope("　'A'を　一文字表示し", "'A'", 'constant.character')).toBe(true);
  });

  it.each([
    ['全角数字', '　２５０を　入れ', '２５０'],
    ['負数', '　−１２３を　入れ', '−１２３'],
    ['小数', '　3.14を　入れ', '3.14'],
    ['16 進 (0x)', '　0xaf64de89を　入れ', '0xaf64de89'],
    ['16 進 (h 接尾)', '　6800hを　入れ', '6800h'],
    ['基数指定', '　8x644を　入れ', '8x644'],
  ])('数値: %s', async (_label, line, text) => {
    expect(await hasScope(line, text, 'constant.numeric')).toBe(true);
  });

  it('識別子の中の数字は数値にしない', async () => {
    const toks = await tokenize('　表示用エンコード０し');
    expect(toks.some((t) => t.scopes.some((s) => s.startsWith('constant.numeric')))).toBe(false);
  });
});

describe('定義と宣言', () => {
  it('行頭の定義名を拾う', async () => {
    expect(await hasScope('メインとは', 'メイン', 'entity.name.function')).toBe(true);
    expect(await hasScope('売り上げ計上とは　（単価　→　・）', '売り上げ計上', 'entity.name.function')).toBe(true);
    expect(await hasScope('係数は　小数変数。', '係数', 'entity.name.function')).toBe(true);
  });

  it('名前の中に助詞があっても切れない', async () => {
    expect(await hasScope('使い方を表示とは　（・　→　・）', '使い方を表示', 'entity.name.function')).toBe(true);
  });

  it('字下げされた行は定義ではない', async () => {
    const toks = await tokenize('　　作業は　変数');
    expect(toks.some((t) => t.scopes.some((s) => s.startsWith('entity.name.function')))).toBe(false);
  });

  it.each([
    ['変数', '索引は　変数。'],
    ['小数変数', '係数は　小数変数。'],
    ['ワード変数', '索引は　ワード変数。'],
    ['バイト変数', '旗は　バイト変数。'],
    ['文字列', '見出しは　文字列。'],
    ['文字列実体', '行バッファは　文字列実体　長さ　１００桁。'],
    ['定数', '上限は　定数　２５０度。'],
    ['文字列定数', '起動は　文字列定数　"x"。'],
    ['等価', '別名表示は　表示と　等価。'],
    ['仮定義', '二乗とは　仮定義。'],
    ['本定義', '二乗とは　本定義'],
    ['処理単語', '売上とは　処理単語　NN'],
    ['関数', '面積とは　関数　整数入力　整数出力'],
  ])('宣言語: %s', async (word, line) => {
    expect(await hasScope(line, word, 'storage.type')).toBe(true);
  });

  it('可視性の切り替え', async () => {
    expect(await hasScope('\tローカル。', 'ローカル', 'storage.modifier')).toBe(true);
    expect(await hasScope('\tグローバル。', 'グローバル', 'storage.modifier')).toBe(true);
  });
});

describe('制御構文', () => {
  it.each([
    'ならば', 'さもなければ', 'でなければ', 'つぎに',
    'ここから', '繰り返し', '打ち切り', 'もう一度',
    '回数指定し', '選択する', '選択終り', '事例をとる', '例外なら', '事例終り',
    '無処理', 'または', 'かつ', '実行終り',
  ])('キーワード: %s', async (kw) => {
    expect(await hasScope(`　　${kw}　`, kw, 'keyword.control')).toBe(true);
  });

  it('似ているだけの語はキーワードにしない', async () => {
    const toks = await tokenize('　　終り処理し');
    expect(toks.some((t) => t.scopes.some((s) => s.startsWith('keyword.control')))).toBe(false);
  });
});

describe('助詞', () => {
  it('語末の助詞を別スコープにする', async () => {
    expect(await hasScope('　　オプションに　入れ', 'に', 'keyword.other.particle')).toBe(true);
    expect(await hasScope('　　合否が　偽？', 'が', 'keyword.other.particle')).toBe(true);
  });

  it('送り仮名の「と」を助詞と誤判定しない', async () => {
    const toks = await tokenize('　一行表示すること。');
    expect(toks.some((t) => t.scopes.some((s) => s.startsWith('keyword.other.particle')))).toBe(false);
  });
});

describe('フィクスチャ全体', () => {
  it('着色が崩れていない（未着色の行が過半にならない）', async () => {
    const toks = await tokenize(FIXTURE);
    const scoped = toks.filter((t) => t.scopes.length > 1).length;
    expect(toks.length).toBeGreaterThan(80);
    expect(scoped / toks.length).toBeGreaterThan(0.4);
  });

  it('スコープのスナップショット', async () => {
    const toks = await tokenize(FIXTURE);
    const kinds = new Set(toks.map((t) => inner(t.scopes)));
    expect([...kinds].sort()).toMatchInlineSnapshot(`
      [
        "comment.block.mind",
        "comment.block.suppressed.mind",
        "comment.line.reference-mark.mind",
        "constant.character.mind",
        "constant.numeric.mind",
        "entity.name.function.mind",
        "keyword.control.mind",
        "keyword.other.particle.definition.mind",
        "keyword.other.particle.mind",
        "punctuation.terminator.mind",
        "source.mind",
        "storage.modifier.mind",
        "storage.type.mind",
        "string.quoted.double.mind",
        "string.quoted.japanese.mind",
      ]
    `);
  });
});
