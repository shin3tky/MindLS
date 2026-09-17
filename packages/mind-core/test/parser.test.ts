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

  it('ファイル末尾では報告しない（実コンパイラが通すため）', () => {
    // `fixtures/inf-corpus/unterminated.src` は本物の mind が終了コード 0 で通す。
    // EOF が定義を閉じる。入力中はこの状態が普通でもあるので、黙っている。
    expect(codes('メインとは\n　表示し')).toEqual([]);
  });

  it('それでも定義としては拾えている（補完のために範囲はソース末尾まで伸ばす）', () => {
    const r = parse('メインとは\n　作業は　変数\n　表示し');
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]!.locals.map((l) => l.name.raw)).toEqual(['作業']);
    expect(r.definitions[0]!.range.end.line).toBe(2);
  });
});

describe('局所処理単語', () => {
  // マニュアル 02-Program-Hyoki「局所処理単語」の構文。
  // 字下げして `○○とは` を並べ、`。` は付けない。`本体とは` から先が親の本体。
  const src = [
    '処理１とは',
    '\t作業は　変数',
    '\t下位処理１とは　（金額　→　・）',
    '\t\t作業に　入れ',
    '\t下位処理２とは',
    '\t\t作業を　表示し',
    '\t本体とは',
    '\t\t下位処理１し　下位処理２すること。',
  ].join('\n');

  it('親の定義は 1 つだけで、局所処理単語はその中に入る', () => {
    const r = parse(src);
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]!.name.raw).toBe('処理１');
    expect(r.definitions[0]!.localWords.map((w) => w.name.raw)).toEqual(['下位処理１', '下位処理２']);
  });

  it('局所処理単語のスタック仕様と所属を拾う', () => {
    const w = parse(src).definitions[0]!.localWords[0]!;
    expect(w).toMatchObject({ kind: '処理単語', stackSpec: '金額 → ・', visibility: 'local' });
    expect(w.owner).toBe('処理1'); // owner は正規形（全角数字は半角に畳まれる）
  });

  it('局所処理単語は次の とは で閉じ、本体 は語にならない', () => {
    const r = parse(src);
    const [first, second] = r.definitions[0]!.localWords;
    expect(first!.range.end.line).toBe(4); // 下位処理２とは の行まで
    expect(second!.range.end.line).toBe(6); // 本体とは の行まで
    expect(r.definitions[0]!.localWords.some((w) => w.name.raw === '本体')).toBe(false);
  });

  it('閉じ忘れとは報告しない', () => {
    expect(codes(src)).toEqual([]);
  });

  it('局所変数の宣言は親に付く（局所処理単語からも見えるため）', () => {
    expect(parse(src).definitions[0]!.locals.map((l) => l.name.raw)).toEqual(['作業']);
  });
});

describe('属性とユーザ定義型', () => {
  it('日本語の属性語を拾う', () => {
    const r = parse('差を表示とは　（数値１、数値２　→　・）　処理単語　整数入力　整数入力\n　引くこと。');
    expect(r.definitions[0]!.attrs).toEqual(['整数入力', '整数入力']);
  });

  it('関数の入出力型も属性として並ぶ', () => {
    const r = parse('二乗とは　関数　小数入力　小数出力\n　掛けること。');
    expect(r.definitions[0]).toMatchObject({ kind: '関数', attrs: ['小数入力', '小数出力'] });
  });

  it('キーワードでない型名による局所宣言を拾う', () => {
    // `ファイル情報` はライブラリ由来の型名。これを拾わないと局所変数が未定義語に見える
    const r = parse('先頭行とは\n\t管理テーブルは　ファイル情報\n\t管理テーブルに　入れること。');
    expect(r.definitions[0]!.locals).toEqual([
      expect.objectContaining({ kind: 'ファイル情報', visibility: 'local' }),
    ]);
  });

  it('制御構文の語は局所宣言にしない', () => {
    // `例外は　＿処理` は 事例をとる の既定ラベル。宣言ではない
    const r = parse('メインとは\n\t値で\n\t事例をとる\n\t\t１なら　表示し\n\t\t例外は　＿処理\n\t事例終り。');
    expect(r.definitions[0]!.locals).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('型紙の要素は大域の宣言になる', () => {
    const src = [
      'ファイルヘッダ型は　型紙',
      '\t＄＄ＥＯＦは　　ワード変数',
      '\t＄＄ストリームは　変数',
      '\t全体は',
      '\t\t＄＄ＥＯＦと　＄＄ストリーム。',
    ].join('\n');
    const r = parse(src);
    expect(r.definitions[0]).toMatchObject({ kind: '型紙' });
    expect(r.declarations.map((d) => d.name.raw)).toEqual(['＄＄ＥＯＦ', '＄＄ストリーム', '全体']);
    expect(r.declarations.every((d) => d.visibility === 'global' && d.kind === '型紙要素')).toBe(true);
  });
});
