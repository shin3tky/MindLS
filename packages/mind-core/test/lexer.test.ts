import { describe, expect, it } from 'vitest';
import { lex, splitNumericLiteral } from '../src/lexer.ts';
import type { Token } from '../src/types.ts';

const words = (src: string): Token[] => lex(src).tokens;
const raws = (src: string): string[] => words(src).map((t) => t.raw);

describe('分かち書き', () => {
  it('区切りは TAB / 空白 / カンマ / 読点 だけ', () => {
    expect(raws('あ い\tう　え,お、か')).toEqual(['あ', 'い', 'う', 'え', 'お', 'か']);
  });

  it('区切らなければ 1 単語', () => {
    expect(raws('赤い色で表示する')).toEqual(['赤い色で表示する']);
    expect(words('赤い色で表示する')[0]!.normalized).toBe('赤色表示');
  });

  it('。 は区切りではないが文を終える', () => {
    expect(raws('　表示すること。')).toEqual(['表示すること', '。']);
  });
});

describe('コメント', () => {
  it('※ から行末まで', () => {
    const t = words('　表示し　※ここはコメント');
    expect(t.at(-1)!.kind).toBe('comment');
    expect(t.at(-1)!.raw).toBe('※ここはコメント');
  });

  it('両端に空白のある （ ） はコメント', () => {
    const t = words('　　（ここから初期化）');
    expect(t[0]!.kind).toBe('comment');
  });

  it('空白の無い （ ） は添字であってコメントではない', () => {
    const t = words('　起動引数（１）を　入れ');
    expect(t[0]!.kind).toBe('word');
    expect(t[0]!.normalized).toBe('起動引数');
    expect(t[0]!.index).toBe('（１）');
    expect(t[0]!.particle).toBe('を');
  });

  it('コンパイル抑止ブロックは丸ごとコメント', () => {
    const r = lex(['コンパイル抑止。', '　「文字列」も　ただの文字', 'コンパイル抑止終り。', '　表示し'].join('\n'));
    expect(r.tokens.filter((t) => t.kind === 'string')).toHaveLength(0);
    expect(r.tokens.at(-1)!.raw).toBe('表示し');
  });

  it('閉じられていないコメントを報告する', () => {
    const r = lex('　　（閉じていない');
    expect(r.diagnostics.map((d) => d.code)).toContain('unterminated-comment');
  });
});

describe('リテラル', () => {
  it('「」と "" の文字列', () => {
    expect(words('　「こんにちは」を')[0]).toMatchObject({ kind: 'string', raw: '「こんにちは」' });
    expect(words('　"dir /w"を')[0]).toMatchObject({ kind: 'string' });
  });

  it('閉じられていない文字列を報告する', () => {
    expect(lex('　「閉じていない').diagnostics.map((d) => d.code)).toContain('unterminated-string');
  });

  it('文字定数', () => {
    expect(words("　'A'を　表示し")[0]).toMatchObject({ kind: 'char', raw: "'A'" });
  });

  it.each([
    ['１０', '10', null],
    ['５６０円', '560', '円'],
    ['−１２３', '-123', null],
    ['３．１４', '3.14', null],
    ['0xaf64de89', '0xaf64de89', null],
    ['6800h', '6800h', null],
    ['8x644', '8x644', null],
  ])('数値 %s → %s (助数詞 %s)', (input, digits, counter) => {
    const got = splitNumericLiteral(input);
    expect(got).toEqual({ digits, counter });
  });

  it('助数詞と助詞が付いていても数値として読む', () => {
    const t = words('　１０行を　行数に　入れ')[0]!;
    expect(t).toMatchObject({ kind: 'number', normalized: '10', counter: '行', particle: 'を' });
  });

  it('数字で始まらない語は数値ではない', () => {
    expect(splitNumericLiteral('表示用エンコード０')).toBeNull();
    expect(words('　表示用エンコード０し')[0]!.kind).toBe('word');
  });
});

describe('終り。 以降はコンパイルされない', () => {
  it('打ち切り位置を返す', () => {
    const r = lex(['メインとは', '　表示すること。', '終り。', '◎◎とは', '　これは解析されない。'].join('\n'));
    expect(r.endOfCompilation).toEqual({ line: 2, character: 3 });
    expect(r.tokens.some((t) => t.raw.includes('これは解析されない'))).toBe(false);
  });

  it('行頭でない 終り は打ち切らない', () => {
    const r = lex(['メインとは', '　実行終り。', '　表示し。'].join('\n'));
    expect(r.endOfCompilation).toBeNull();
  });
});

describe('位置情報', () => {
  it('UTF-16 の行・桁を返す', () => {
    const t = words('メインとは\n　　表示し')[1]!;
    expect(t.range.start).toEqual({ line: 1, character: 2 });
    expect(t.range.end).toEqual({ line: 1, character: 5 });
  });
});
