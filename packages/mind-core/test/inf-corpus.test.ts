import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyze } from '../src/diagnostics.ts';
import { parse } from '../src/parser.ts';
import { buildSymbolTable } from '../src/symbols.ts';
import { loadStdlib, manifest } from './helpers/stdlib.ts';

/**
 * 実コンパイラとの答え合わせ。
 *
 * `fixtures/inf-corpus/` の見本を Docker の中の本物の `mind` に通した結果
 * （終了コード）がコミットしてある。ここで守りたいのは一方向だけ。
 *
 *   **実コンパイラが通すものを、我々がエラーにしてはいけない。**
 *
 * 逆は成り立たない。我々はコンパイラではないので、コンパイラがエラーにするものを
 * 見逃すことはある（未定義単語の診断は既定で切ってあるし、型の検査もしていない）。
 * 赤くしすぎないことだけを機械的に守る。
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORPUS = join(REPO, 'fixtures', 'inf-corpus');
const COLLECTED = join(CORPUS, 'collected');

// 辞書と単語の正規化規則は、記録を集めた Mind 8 for Linux に合わせる。
const stdlib = loadStdlib('linux-8');
const wordNormalization = manifest.distributions['linux-8']!.wordNormalization;

interface Sample {
  readonly name: string;
  readonly status: number;
}

const samples: Sample[] = existsSync(COLLECTED)
  ? readdirSync(COLLECTED, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(COLLECTED, e.name, 'status')))
      .map((e) => ({
        name: e.name,
        status: Number(readFileSync(join(COLLECTED, e.name, 'status'), 'utf8').trim()),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  : [];

const errorsOf = (name: string): string[] => {
  const source = readFileSync(join(CORPUS, `${name}.src`), 'utf8');
  const parsed = parse(source, wordNormalization);
  const table = buildSymbolTable(parsed);
  return [...parsed.diagnostics, ...analyze(parsed, table, { stdlib })]
    .filter((d) => d.severity === 'error')
    .map((d) => `L${String(d.range.start.line + 1)} [${d.code}] ${d.message}`);
};

const accepted = samples.filter((s) => s.status === 0);
const rejected = samples.filter((s) => s.status !== 0);

describe.skipIf(accepted.length === 0)('実コンパイラが通したもの', () => {
  it.each(accepted.map((s) => s.name))('%s をエラーにしない', (name) => {
    expect(errorsOf(name)).toEqual([]);
  });
});

describe.skipIf(rejected.length === 0)('実コンパイラが弾いたもの', () => {
  // こちらは「見逃してもよい」ので、何を拾えているかを記録するだけにする。
  // 拾えた件数が減ったら気づけるよう、拾えるものは一覧で固定しておく。
  it('いま拾えているものの一覧', () => {
    const caught = Object.fromEntries(
      rejected.map((s) => [s.name, errorsOf(s.name).length]),
    );
    expect(caught).toMatchObject({
      // 実コンパイラと同じくエラーにするもの
      'b2-paren-comment': 0, // 警告では拾うが、エラーにはしない
      'b2-unterminated-next-def': 1,
      'case-no-default': 1,
      'local-decl-dot': 0, // 警告で拾う（宣言の `。` を直接指す）
      'unclosed-block': 1,
      // 自前解析では原理的に拾えないもの（単語の有無・型・助詞）
      'forward-ref': 0,
      'missing-particle': 0,
      'multi-error': 0,
      offset: 0,
      'undefined-word': 0,
      // 未定義単語は警告として個別に検証する。
      'hankaku-kana': 0,
      'hankaku-nakaguro': 0,
      // 送り仮名が「ない」「ず」で終わる否定は、実コンパイラと同じくエラーにする（下の「否定の送り仮名」）
      'negative-end-nai': 1,
      'negative-end-zu': 1,
      'negative-user-word': 1,
      'negative-hiragana': 1,
      'negative-probe': 57,
    });
  });
});

describe('半角カナ（Mind 8 for Linux）', () => {
  const undefinedWordsOf = (name: string): string[] => {
    const source = readFileSync(join(CORPUS, `${name}.src`), 'utf8');
    const parsed = parse(source, wordNormalization);
    return analyze(parsed, buildSymbolTable(parsed), { stdlib, undefinedWords: true })
      .filter((d) => d.code === 'undefined-word')
      .map((d) => `L${String(d.range.start.line + 1)} ${d.message}`);
  };

  it('全角で定義した変数を半角で引くと、実コンパイラと同じ行で未定義になる', () => {
    expect(undefinedWordsOf('hankaku-kana')).toEqual(['L5 `ｶｳﾝﾄに` は定義されていません']);
  });

  it('半角の中点を省いた参照は未定義になる', () => {
    expect(undefinedWordsOf('hankaku-nakaguro')).toEqual(['L4 `ﾄｰﾀﾙｶｳﾝﾄに` は定義されていません']);
  });

  it('半角で定義して半角で引けば通る（送り仮名も落ちる）', () => {
    expect(accepted).toContainEqual({ name: 'hankaku-kana-same', status: 0 });
    expect(undefinedWordsOf('hankaku-kana-same')).toEqual([]);
  });
});

describe('否定の送り仮名', () => {
  const negativesOf = (name: string): Array<{ line: number; severity: string }> => {
    const source = readFileSync(join(CORPUS, `${name}.src`), 'utf8');
    const parsed = parse(source, wordNormalization);
    return analyze(parsed, buildSymbolTable(parsed), { stdlib })
      .filter((d) => d.code === 'negative-form')
      .map((d) => ({ line: d.range.start.line + 1, severity: d.severity }));
  };
  /** `.inf` のうち「否定の送り仮名が付いています」が出た行番号 */
  const rejectedLinesOf = (report: string): number[] =>
    report
      .split(/\n\n/)
      .filter((block) => block.includes('否定の送り仮名が付いています'))
      .map((block) => Number(/(\d+) 行目でエラー/.exec(block)?.[1]))
      .sort((a, b) => a - b);

  it.each([
    ['Mind 8 for Linux', join(COLLECTED, 'negative-probe', 'report.txt')],
    ['Mind 9 for Windows', join(CORPUS, 'windows-9', 'negative-probe.report.txt')],
  ])('「ない」「ず」の直前の仮名 144 通りで、エラーにする行が %s と一致する', (_, path) => {
    const expected = rejectedLinesOf(readFileSync(path, 'utf8'));
    expect(expected).toHaveLength(57);
    const errors = negativesOf('negative-probe').filter((d) => d.severity === 'error').map((d) => d.line);
    expect(errors).toEqual(expected);
  });

  it('総当たりで実コンパイラが通した行のうち、否定なのに見逃されるものだけを警告する', () => {
    // 実コンパイラの表には `ぎ` `へ` が無く、「ず」の前の `で` も無い。どれも否定なのでエラーにはならず、
    // 意味だけが落ちる。それ以外の通った行（`一行表示くない` など）には何も出さない
    const lines = readFileSync(join(CORPUS, 'negative-probe.src'), 'utf8').split('\n');
    const warned = negativesOf('negative-probe')
      .filter((d) => d.severity === 'warning')
      .map((d) => /一行表示(\S+)/.exec(lines[d.line - 1] ?? '')?.[1]);
    expect(warned).toEqual(['ぎない', 'ぎず', 'でず', 'へない', 'へず']);
  });

  it.each([
    ['negative-zuni', '`一行表示せずに`'],
    ['negative-nakatta', '`一行表示しなかった`'],
    ['negative-masen', '`一行表示しません`'],
  ])('%s はコンパイルが通るが、否定の意味が落ちるので警告する', (name) => {
    expect(accepted.map((s) => s.name)).toContain(name);
    expect(negativesOf(name)).toEqual([{ line: 3, severity: 'warning' }]);
  });

  it.each(['negative-adjective', 'negative-kunai'])('%s（`少ない` `少なくない`）は否定ではないので黙る', (name) => {
    expect(accepted.map((s) => s.name)).toContain(name);
    expect(negativesOf(name)).toEqual([]);
  });

  it('ひらがなだけの名前 `おかず` は、実コンパイラと同じくエラーにする', () => {
    expect(rejected.map((s) => s.name)).toContain('negative-hiragana');
    expect(negativesOf('negative-hiragana')).toEqual([{ line: 5, severity: 'error' }]);
  });
});
