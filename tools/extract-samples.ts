/**
 * 配布物から公式サンプル（pmind/sample, pmind/sampleF）を取り出し、
 * UTF-8 に変換して fixtures/mind-samples/ に置く。
 *
 * 文法の広めのスモークテストに使う。再配布はしないので出力は Git 管理外。
 *
 *   node tools/extract-samples.ts
 *   node tools/extract-samples.ts --tgz path/to/mind-for-linux-8.0.08.tgz
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TGZ = resolve(REPO, '../Mind-Docker/vendor/mind-for-linux-8.0.08.tgz');
const OUT_DIR = resolve(REPO, 'fixtures/mind-samples');

const tgzArg = process.argv.indexOf('--tgz');
const tgz = resolve(tgzArg >= 0 ? (process.argv[tgzArg + 1] ?? DEFAULT_TGZ) : DEFAULT_TGZ);

if (!existsSync(tgz)) {
  console.error(`配布物が見つかりません: ${tgz}`);
  console.error('--tgz で場所を指定してください。');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'mind-samples-'));
try {
  execFileSync('tar', ['xzf', tgz, '-C', work], { stdio: ['ignore', 'ignore', 'pipe'] });

  mkdirSync(OUT_DIR, { recursive: true });
  const decoder = new TextDecoder('euc-jp');
  let count = 0;

  for (const sub of ['sample', 'sampleF', 'file']) {
    const dir = join(work, 'pmind', sub);
    if (!existsSync(dir)) continue;
    const outDir = sub === 'file' ? join(OUT_DIR, 'stdlib') : OUT_DIR;
    mkdirSync(outDir, { recursive: true });
    // sampleF のファイル名自体が EUC-JP のことがある。
    // 文字列で受け取ると開き直せなくなるので、バイト列のまま扱う。
    for (const nameBuf of readdirSync(dir, { encoding: 'buffer' })) {
      const decodedName = decoder.decode(nameBuf);
      if (!decodedName.endsWith('.src')) continue;

      const fullPath = Buffer.concat([Buffer.from(`${dir}/`), nameBuf]);
      const text = decoder.decode(readFileSync(fullPath));

      const stem = decodedName.slice(0, -4).replace(/[^\p{L}\p{N}_-]/gu, '_');
      const out = sub === 'file' ? `${stem}.src` : `${sub}-${String(++count).padStart(2, '0')}-${stem}.src`;
      if (sub === 'file') count++;
      writeFileSync(join(outDir, out), text, 'utf8');
    }
  }

  console.log(`${count} 本のソースを ${OUT_DIR} に展開しました（UTF-8。標準ライブラリは stdlib/ 配下）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
