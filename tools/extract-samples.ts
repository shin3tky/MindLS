/**
 * 配布物から公式サンプルと標準ライブラリのソースを取り出し、UTF-8 に変換して
 * fixtures/mind-samples/<配布物>/ に置く。
 *
 * 文法の広めのスモークテストと、既定の診断が誤検出しないことの確認に使う。
 * 再配布はしないので出力は Git 管理外。どこから何を取るかは
 * packages/mind-core/data/distributions.json の layout に従う。
 *
 *   fixtures/mind-samples/<配布物>/
 *     samples/    完結したプログラム（layout.samples）。診断ゼロを守る
 *     stdlib/     標準ライブラリ（layout.libraries.file）。診断ゼロを守り、辞書とも突き合わせる
 *     fragments/  取り込まれる側のソース（layout.fragments）。構文だけを検査する
 *     gui/        辞書を持たないライブラリを使うサンプル（layout.guiSamples）。構文だけを検査する
 *     errors/     わざと誤りを入れた教材（layout.errorSamples）。エラーになることを検査する
 *
 *   node tools/extract-samples.ts                    … 定義にある配布物すべて（見つからないものは飛ばす）
 *   node tools/extract-samples.ts --dist windows-9
 *   node tools/extract-samples.ts --dist linux-8 --archive path/to/mind-for-linux-8.0.08.tgz
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO,
  expand,
  loadManifest,
  openDistribution,
  parseDistArgs,
  readSource,
  targetDistributions,
  type OpenedDistribution,
} from './lib/mind-dist.ts';

const OUT_ROOT = join(REPO, 'fixtures/mind-samples');

/** ファイル名に使えない文字を落とす（sampleF には日本語のファイル名がある） */
const stem = (name: string): string => name.replace(/\.src$/i, '').replace(/[^\p{L}\p{N}_-]/gu, '_');

function extract(dist: OpenedDistribution): number {
  const { layout, encoding } = dist.spec;
  const out = join(OUT_ROOT, dist.id);
  rmSync(out, { recursive: true, force: true });

  const buckets: [string, Readonly<Record<string, readonly string[]>>][] = [
    ['samples', layout.samples],
    ['stdlib', { file: layout.libraries['file'] ?? [] }],
    ['fragments', layout.fragments],
    ['gui', layout.guiSamples],
    ['errors', layout.errorSamples],
  ];

  let count = 0;
  for (const [bucket, groups] of buckets) {
    for (const [group, patterns] of Object.entries(groups)) {
      const exclude = bucket === 'samples' ? layout.exclude : [];
      const files = expand(dist.root, patterns, encoding, exclude);
      if (files.length === 0) continue;
      const dir = join(out, bucket);
      mkdirSync(dir, { recursive: true });
      for (const f of files) {
        // 標準ライブラリはファイル名そのまま（辞書の出典と突き合わせるため）
        const name = bucket === 'stdlib' ? `${stem(f.name)}.src` : `${group}-${stem(f.name)}.src`;
        // 改行はそのまま残す（Windows 版は CRLF）。エディタから届くのも CRLF なので、その経路も試す
        writeFileSync(join(dir, name), readSource(f, encoding), 'utf8');
        count++;
      }
    }
  }
  console.log(`[${dist.id}] ${String(count)} 本のソースを ${out} に展開しました（UTF-8）`);
  return count;
}

function main(): void {
  const manifest = loadManifest();
  const args = parseDistArgs(process.argv.slice(2));
  const explicit = args.dists.length > 0;
  let total = 0;
  for (const id of targetDistributions(manifest, args)) {
    const dist = openDistribution(manifest, id, args);
    if (dist === null) {
      const msg = `[${id}] 配布物が見つかりません（vendor/ に置くか、--archive で指定）`;
      if (explicit) {
        console.error(msg);
        process.exit(1);
      }
      console.warn(msg + ' — 飛ばします');
      continue;
    }
    try {
      total += extract(dist);
    } finally {
      dist.cleanup();
    }
  }
  if (total === 0) process.exit(1);
}

main();
