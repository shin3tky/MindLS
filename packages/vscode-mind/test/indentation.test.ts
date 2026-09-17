import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { blockRoleOf, lex } from '@mindls/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

const config = JSON.parse(
  readFileSync(join(HERE, '..', 'language-configuration.json'), 'utf8'),
) as {
  indentationRules: { increaseIndentPattern: string; decreaseIndentPattern: string };
};

const increase = new RegExp(config.indentationRules.increaseIndentPattern);
const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);

describe('字下げ規則', () => {
  it.each([
    'メインとは',
    '売り上げ計上とは　（金額　→　・）',
    '\tここから',
    '\t\t１０回　回数指定し',
    '\t\t\tならば',
    '\t\t作業を　事例をとる',
    '\t\t文字列事例をとり',
    '\tならば　※ コメントが続いてもよい',
  ])('次の行を深くする: %s', (line) => {
    expect(increase.test(line)).toBe(true);
  });

  it.each([
    '\t作業は　変数',
    '売り上げは　変数。',
    '　管理表は　ファイル情報',
    '\t「毎度」を　表示し',
    '\tならば　打ち切り',
    '\t金額とは何かを　表示し',
    '　　値を　一行表示すること。',
  ])('深くしない: %s', (line) => {
    expect(increase.test(line)).toBe(false);
  });

  it.each([
    '\t\tつぎに',
    '\t\tつぎに。',
    '\t繰り返し',
    '\t繰り返す。',
    '\t繰返し',
    '\t事例終り',
    '\t選択終り',
    '\t\tさもなければ',
    '\t\t例外なら　＿既定処理し',
  ])('浅くする: %s', (line) => {
    expect(decrease.test(line)).toBe(true);
  });

  it.each([
    '\tつぎのデータを　表示し',
    '\t繰り返し回数を　クリアし',
    '\t事例終り判定を　表示し',
    '\t値を　表示し',
  ])('浅くしない: %s', (line) => {
    expect(decrease.test(line)).toBe(false);
  });
});

/**
 * 公式コーパスに当てて、閉じ語でない行を浅くしてしまわないことを確かめる。
 * 正規表現だけで書く規則なので、実物で裏を取っておきたい。
 */
const SAMPLES = join(REPO, 'fixtures', 'mind-samples');
const files = existsSync(SAMPLES)
  ? readdirSync(SAMPLES)
      .filter((f) => f.endsWith('.src'))
      .map((f) => join(SAMPLES, f))
  : [];

describe.skipIf(files.length === 0)('公式サンプルでの誤爆', () => {
  it.each(files)('浅くする行は閉じ語で始まっている: %s', (path) => {
    const wrong: string[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!decrease.test(line)) continue;
      const first = lex(line).tokens.find((t) => t.kind === 'word');
      const role = first === undefined ? null : blockRoleOf(first.normalized, first.raw);
      if (role === null || role.role === 'open') wrong.push(line.trim());
    }
    expect(wrong).toEqual([]);
  });

  it.each(files)('深くする行は定義ヘッダか開き語で終わっている: %s', (path) => {
    const wrong: string[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!increase.test(line)) continue;
      if (/^[\s\u3000]*[^\s\u3000]*とは(?:[\s\u3000]|$)/.test(line)) continue;
      const words = lex(line).tokens.filter((t) => t.kind === 'word');
      const last = words.at(-1);
      const role = last === undefined ? null : blockRoleOf(last.normalized, last.raw);
      if (role === null || role.role === 'close') wrong.push(line.trim());
    }
    expect(wrong).toEqual([]);
  });
});
