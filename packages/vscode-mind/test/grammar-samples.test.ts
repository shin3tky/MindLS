import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tokenize } from './helpers/tokenize.ts';

/**
 * 公式サンプルに対する広めのスモークテスト。
 *
 * サンプルは再配布しないので Git には入れていない。
 * `node tools/extract-samples.ts` で展開したときだけ走る。
 */
const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'mind-samples');
const files = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => f.endsWith('.src')) : [];

describe.skipIf(files.length === 0)('公式サンプル', () => {
  it.each(files)('%s の着色が崩れない', async (name) => {
    const src = readFileSync(join(SAMPLES, name), 'utf8');
    const toks = await tokenize(src);

    // 文字列やコメントが閉じられずに暴走すると、巨大なトークンが 1 つできる
    const runaway = toks.find((t) => t.text.length > 400);
    expect(runaway, `暴走したトークン: ${runaway?.scopes.join(' ')}`).toBeUndefined();

    // 文字列・コメントがファイルの大半を飲み込んでいないこと
    const swallowed = toks.filter((t) =>
      t.scopes.some((s) => s.startsWith('string.') || s.startsWith('comment.block')),
    ).length;
    expect(swallowed / Math.max(toks.length, 1)).toBeLessThan(0.7);

    // 定義がひとつも取れていなければ、定義パターンが壊れている
    expect(toks.some((t) => t.scopes.some((s) => s.startsWith('entity.name.function')))).toBe(true);
  });
});
