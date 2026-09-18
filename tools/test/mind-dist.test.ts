import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSafeArchiveEntry, extractArchive } from '../lib/mind-dist.ts';

describe('アーカイブの展開境界', () => {
  it.each(['../outside', 'safe/../../outside', '/tmp/outside', 'C:\\temp\\outside'])(
    '展開先の外を指す名前を拒否する: %s',
    (name) => {
      expect(() => assertSafeArchiveEntry(name)).toThrow(/展開先の外/u);
    },
  );

  it.each(['pmind/file/sample.src', './pmind/file/sample.src', 'dir..name/file.src'])(
    '通常の相対パスを許可する: %s',
    (name) => {
      expect(() => assertSafeArchiveEntry(name)).not.toThrow();
    },
  );

  it('通常のアーカイブを一時ディレクトリ内へ展開する', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mind-dist-test-'));
    const source = join(parent, 'source');
    const archive = join(parent, 'safe.tgz');
    mkdirSync(source);
    writeFileSync(join(source, 'sample.src'), 'メインとは。', 'utf8');
    execFileSync('tar', ['czf', archive, '-C', source, '.']);

    const extracted = extractArchive(archive);
    try {
      expect(readFileSync(join(extracted.dir, 'sample.src'), 'utf8')).toBe('メインとは。');
    } finally {
      extracted.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('外部を指すシンボリックリンクを展開後に拒否する', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mind-dist-test-'));
    const source = join(parent, 'source');
    const archive = join(parent, 'escape.tgz');
    mkdirSync(source);
    const outside = join(parent, 'outside.src');
    writeFileSync(outside, '外部', 'utf8');
    symlinkSync(outside, join(source, 'linked.src'));
    execFileSync('tar', ['czf', archive, '-C', source, '.']);

    expect(() => extractArchive(archive)).toThrow(/リンク|一時ディレクトリの外/u);
  });
});
