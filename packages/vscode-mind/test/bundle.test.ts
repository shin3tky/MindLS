import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LspClient } from '../../mind-language-server/test/helpers/client.ts';

/**
 * 配布用バンドルの検証。
 *
 * `npm run bundle` を通したあとにだけ走る。ここで確かめたいのは 2 つ。
 *   ・束ねた 1 ファイルでも Language Server が起動すること
 *   ・辞書がリンク越しではなく、隣に置いた distributions.json と stdlib/*.json から読めること
 *     （配布物を切り替えても、それぞれの辞書が引けること）
 * どちらも .vsix にしてからでないと壊れていることに気づけない類の失敗。
 */
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SERVER = join(DIST, 'server.js');
const bundled = existsSync(SERVER) && existsSync(join(DIST, 'distributions.json'));

describe.skipIf(!bundled)('配布用バンドル', () => {
  it('束ねた Language Server が起動して、辞書も読める', async () => {
    const client = new LspClient(SERVER);
    await client.initialize();
    const uri = 'file:///tmp/bundled.src';
    client.openDocument(uri, 'メインとは\n　「こんにちは」を　一行表示すること。');

    const hover = await client.request<{ contents: { value: string } }>('textDocument/hover', {
      textDocument: { uri },
      position: { line: 1, character: 12 },
    });
    // 辞書が読めていれば、出典のファイル名まで出る。既定は Mind 9 for Windows
    expect(hover.contents.value).toContain('標準ライブラリ');
    expect(hover.contents.value).toContain('Mind 9 for Windows');
    await client.dispose();
  }, 30_000);

  it('mind.distribution で Linux 版の辞書に切り替えられる', async () => {
    const client = new LspClient(SERVER);
    await client.initialize({ distribution: 'linux-8' });
    const uri = 'file:///tmp/bundled-linux.src';
    client.openDocument(uri, 'メインとは\n　「こんにちは」を　一行表示すること。');

    const hover = await client.request<{ contents: { value: string } }>('textDocument/hover', {
      textDocument: { uri },
      position: { line: 1, character: 12 },
    });
    expect(hover.contents.value).toContain('Mind 8 for Linux');
    await client.dispose();
  }, 30_000);
});
