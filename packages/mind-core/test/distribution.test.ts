import { describe, expect, it } from 'vitest';

import { resolveDistribution } from '../src/distribution.ts';
import { manifest } from './helpers/stdlib.ts';

describe('配布物の解決', () => {
  it.each([
    [undefined, 'windows-9', false],
    ['', 'windows-9', false],
    ['auto', 'windows-9', false],
    ['windows-9', 'windows-9', false],
    ['Windows', 'windows-9', false],
    ['mind9', 'windows-9', false],
    [' linux-8 ', 'linux-8', false],
    ['linux', 'linux-8', false],
    ['8', 'linux-8', false],
    ['mac-10', 'windows-9', true],
  ])('%j → %s', (requested, id, fellBack) => {
    expect(resolveDistribution(manifest, requested)).toMatchObject({ id, fellBack });
  });

  it('別名はどの配布物ともかぶらない', () => {
    const seen = new Map<string, string>();
    for (const [id, spec] of Object.entries(manifest.distributions)) {
      for (const key of [id, ...spec.aliases].map((k) => k.toLowerCase())) {
        expect(seen.get(key), `${key} が ${seen.get(key) ?? ''} と ${id} で重複`).toBeUndefined();
        seen.set(key, id);
      }
    }
  });

  it('既定の配布物が定義されている', () => {
    expect(manifest.distributions[manifest.default]).toBeDefined();
  });
});
