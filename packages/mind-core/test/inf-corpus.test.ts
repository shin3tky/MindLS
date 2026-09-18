import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyze } from '../src/diagnostics.ts';
import { parse } from '../src/parser.ts';
import { buildSymbolTable } from '../src/symbols.ts';
import { loadStdlib } from './helpers/stdlib.ts';

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

// 実コンパイラ（Mind 8 for Linux の Docker）で集めた結果なので、辞書も同じ配布物のもの
const stdlib = loadStdlib('linux-8');

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
  const parsed = parse(source);
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
    });
  });
});
