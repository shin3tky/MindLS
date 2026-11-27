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
