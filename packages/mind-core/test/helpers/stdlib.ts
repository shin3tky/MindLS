/**
 * テスト用に、コミット済みの配布物別辞書を読む。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DistributionManifest } from '../../src/distribution.ts';
import { createStdlibIndex, type StdlibDocument, type StdlibIndex } from '../../src/stdlib.ts';

export const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

export const manifest = JSON.parse(
  readFileSync(join(DATA, 'distributions.json'), 'utf8'),
) as DistributionManifest;

export const DISTRIBUTION_IDS = Object.keys(manifest.distributions);

/** 辞書の JSON そのもの。`id` を省けば既定の配布物 */
export function stdlibDocument(id: string = manifest.default): StdlibDocument & {
  counts: { total: number; global: number; local: number; fromFile: number; fromKernel: number };
} {
  return JSON.parse(readFileSync(join(DATA, 'stdlib', `${id}.json`), 'utf8')) as ReturnType<
    typeof stdlibDocument
  >;
}

export function loadStdlib(id: string = manifest.default): StdlibIndex {
  return createStdlibIndex(stdlibDocument(id));
}
