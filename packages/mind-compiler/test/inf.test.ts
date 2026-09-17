import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseInf, toDiagnostics } from '../src/inf.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORPUS = join(REPO, 'fixtures', 'inf-corpus');
const COLLECTED = join(CORPUS, 'collected');

/** 実物から起こした見本。コーパスが無い環境でもこれだけは走る */
const UNDEFINED_WORD = [
  'undefined-word.src 3 行目でエラー。行内容は、',
  '\tまったく存在しない単語し',
  '      要因１："まったく存在しない単語"は未定義の単語です。',
  '',
  '1 個のエラーが有ります。',
  '',
].join('\n');

describe('.inf の解析', () => {
  it('行番号・行内容・要因を取り出す', () => {
    const report = parseInf(UNDEFINED_WORD);
    expect(report.total).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      file: 'undefined-word.src',
      line: 2, // .inf は 1 始まり、こちらは 0 始まり
      text: '\tまったく存在しない単語し',
    });
    expect(report.entries[0]!.causes).toEqual([
      {
        message: '"まったく存在しない単語"は未定義の単語です。',
        word: 'まったく存在しない単語',
      },
    ]);
  });

  it('1 つの行に要因が複数付くことがある', () => {
    const text = [
      'a.src 6 行目でエラー。行内容は、',
      '\t\t１なら',
      '      要因１：比較値が誤りです。',
      '      要因２：小数の比較値は指定できません([数値範囲事例]を使ってください)。',
      '',
      '2 個のエラーが有ります。',
    ].join('\n');
    const report = parseInf(text);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.causes.map((c) => c.word)).toEqual([null, null]);
    expect(report.total).toBe(2); // 総数は「要因の数」であって、行ブロックの数ではない
  });

  it('引用の無い要因は word が null', () => {
    const report = parseInf(
      [
        'a.src 4 行目でエラー。行内容は、',
        '\t\tならば',
        '      要因１：条件分岐や繰り返し文をアンバランスに使っています。',
        '',
        '1 個のエラーが有ります。',
      ].join('\n'),
    );
    expect(report.entries[0]!.causes[0]).toMatchObject({ word: null });
  });

  it('壊れた行は読み飛ばす', () => {
    const report = parseInf('まったく関係のない行\nもう一行\n');
    expect(report).toEqual({ entries: [], total: null });
  });
});

describe('位置の割り出し', () => {
  /** .inf が指す行番号の位置に `line` を置いたソースを組み立てて解析させる */
  const locate = (line: string, inf: string) => {
    const report = parseInf(inf);
    const at = report.entries[0]!.line;
    const lines = Array.from({ length: at + 1 }, (_, i) => (i === at ? line : ''));
    return toDiagnostics(report, lines, 'a.src')[0]!;
  };

  it('引用された語を行の中から探して桁を決める', () => {
    const line = '\tまったく存在しない単語し';
    const d = locate(line, UNDEFINED_WORD.replace('undefined-word.src', 'a.src'));
    expect(line.slice(d.character!, d.endCharacter!)).toBe('まったく存在しない単語し');
  });

  it('末尾の送り仮名まで範囲を伸ばす（.inf は語幹しか出さない）', () => {
    const line = '\t存在しない単語ひとつめし';
    const inf = [
      'a.src 1 行目でエラー。行内容は、',
      line,
      '      要因１："存在しない単語"は未定義の単語です。',
      '',
      '1 個のエラーが有ります。',
    ].join('\n');
    const d = locate(line, inf);
    expect(line.slice(d.character!, d.endCharacter!)).toBe('存在しない単語ひとつめし');
  });

  it('引用が無ければ行全体（前後の空白を除く）を指す', () => {
    const line = '\t\tならば　「はい」を　一行表示する。';
    const inf = [
      'a.src 1 行目でエラー。行内容は、',
      line,
      '      要因１：条件分岐や繰り返し文をアンバランスに使っています。',
      '',
      '1 個のエラーが有ります。',
    ].join('\n');
    const d = locate(line, inf);
    expect(line.slice(d.character!, d.endCharacter!)).toBe('ならば　「はい」を　一行表示する。');
  });

  it('行が食い違っていたら桁を諦める', () => {
    const inf = UNDEFINED_WORD.replace('undefined-word.src', 'a.src');
    const d = toDiagnostics(parseInf(inf), ['まったく別の行'], 'a.src')[0]!;
    expect(d.character).toBeNull();
    expect(d.endCharacter).toBeNull();
    expect(d.line).toBe(2);
  });
});

/**
 * 実物に対する検証。
 *
 * `tools/collect-inf.sh` を Docker の中で流すと集まる。コミットしてあるので
 * 手元に Docker が無くても走る。ここが通らなくなったら、コンパイラの版が変わって
 * `.inf` の書式が動いたということ。
 */
const collected = existsSync(COLLECTED)
  ? readdirSync(COLLECTED, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(COLLECTED, e.name, 'report.txt')))
      .map((e) => e.name)
      .sort()
  : [];

describe.skipIf(collected.length === 0)('実物の .inf', () => {
  it.each(collected)('%s を解析できる', (name) => {
    const report = parseInf(readFileSync(join(COLLECTED, name, 'report.txt'), 'utf8'));

    expect(report.entries.length).toBeGreaterThan(0);
    expect(report.total).not.toBeNull();
    // 末尾の「N 個のエラー」は要因の総数と一致する
    const causes = report.entries.reduce((n, e) => n + e.causes.length, 0);
    expect(causes).toBe(report.total);

    // 行番号は元のソースの範囲に収まっている
    const source = readFileSync(join(CORPUS, `${name}.src`), 'utf8').split('\n');
    for (const entry of report.entries) {
      expect(entry.line).toBeGreaterThanOrEqual(0);
      expect(entry.line).toBeLessThan(source.length);
      // echo された行の内容が、元のソースのその行と一致する
      expect(entry.text).toBe(source[entry.line]);
    }
  });

  it.each(collected)('%s の桁を割り出せる', (name) => {
    const report = parseInf(readFileSync(join(COLLECTED, name, 'report.txt'), 'utf8'));
    const source = readFileSync(join(CORPUS, `${name}.src`), 'utf8').split('\n');
    const diagnostics = toDiagnostics(report, source, `${name}.src`);

    expect(diagnostics.length).toBe(report.total);
    for (const d of diagnostics) {
      // echo された行と一致している以上、桁は必ず求まる
      expect(d.character, d.message).not.toBeNull();
      expect(d.endCharacter!).toBeGreaterThan(d.character!);
      expect(d.endCharacter!).toBeLessThanOrEqual(source[d.line]!.length);
    }
  });

  it('未定義単語の桁が、その単語のところを指している', () => {
    const name = 'undefined-word';
    if (!collected.includes(name)) return;
    const report = parseInf(readFileSync(join(COLLECTED, name, 'report.txt'), 'utf8'));
    const source = readFileSync(join(CORPUS, `${name}.src`), 'utf8').split('\n');
    const [d] = toDiagnostics(report, source, `${name}.src`);
    expect(source[d!.line]!.slice(d!.character!, d!.endCharacter!)).toBe('まったく存在しない単語し');
  });

  it('桁は文字数（UTF-16）であって、バイト数ではない', () => {
    // offset.src は、全角・半角・記号を混ぜた行の末尾に未定義の語を置いてある。
    // 36 なら文字数、68 なら EUC-JP のバイト数、100 なら UTF-8 のバイト数。
    if (!collected.includes('offset')) return;
    const report = parseInf(readFileSync(join(COLLECTED, 'offset', 'report.txt'), 'utf8'));
    const source = readFileSync(join(CORPUS, 'offset.src'), 'utf8').split('\n');
    const [d] = toDiagnostics(report, source, 'offset.src');
    expect(d!.character).toBe(36);
    expect(source[d!.line]!.slice(d!.character!, d!.endCharacter!)).toBe('この語は存在しないし');
  });
});
