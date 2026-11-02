import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const clientRoot = join(dirname(require.resolve('vscode-languageclient/node')), '..', '..');

// VS Code 本体だけを代用し、配布された client のコードと実際の minimatch で照合する。
type Resource = {
  scheme: string;
  path: string;
  fsPath: string;
  with(change: { path: string }): Resource;
};

function uri(path: string): Resource {
  return { scheme: 'file', path, fsPath: path, with: ({ path }: { path: string }) => uri(path) };
}

function loadClientModule<T>(relativePath: string): T {
  const filename = join(clientRoot, 'lib', 'common', relativePath);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    require: (id: string) => id === 'vscode' ? {
      Uri: { parse: (value: string) => uri(decodeURIComponent(new URL(value).pathname)) },
      workspace: { onDidCreateFiles: () => ({ dispose() {} }) },
    } : localRequire(id),
  }, { filename });
  return module.exports as T;
}

const { matchGlobPattern } = loadClientModule<{
  matchGlobPattern: (pattern: string | { baseUri: string; pattern: string }, resource: ReturnType<typeof uri>) => boolean;
}>('utils/globPattern.js');

describe('minimatch 11 と vscode-languageclient の互換性', () => {
  it.each([
    ['**/*.{src,mnd}', '/work/main.src', true],
    ['**/*.{src,mnd}', '/work/lib/helper.mnd', true],
    ['**/*.{src,mnd}', '/work/readme.md', false],
    ['#comment', '/work/main.src', false],
    ['', '/work/main.src', false],
  ])('監視パターン %s と %s を照合できる', (pattern, path, expected) => {
    expect(matchGlobPattern(pattern, uri(path))).toBe(expected);
  });

  it('相対パターンは baseUri の配下だけに一致する', () => {
    const pattern = { baseUri: 'file:///work', pattern: '**/*.src' };
    expect(matchGlobPattern(pattern, uri('/work/lib/main.src'))).toBe(true);
    expect(matchGlobPattern(pattern, uri('/other/main.src'))).toBe(false);
  });

  function fileOperations() {
    return loadClientModule<{
      DidCreateFilesFeature: new (client: unknown) => {
        register(data: unknown): void;
        send(event: { files: ReturnType<typeof uri>[] }): Promise<void>;
      };
    }>('fileOperations.js');
  }

  it('ファイル操作の登録と通知で、拡張子・大文字小文字・scheme を照合できる', async () => {
    const sendNotification = vi.fn();
    const { DidCreateFilesFeature } = fileOperations();
    const feature = new DidCreateFilesFeature({
      middleware: {},
      code2ProtocolConverter: { asDidCreateFilesParams: (event: unknown) => event },
      sendNotification,
    });
    feature.register({ id: 'mind', registerOptions: { filters: [{
      scheme: 'file', pattern: { glob: '**/*.{src,mnd}', options: { ignoreCase: true } },
    }] } });
    const matching = [uri('/work/MAIN.SRC'), uri('/work/.hidden.mnd'), uri('C:\\work\\main.src')];
    await feature.send({ files: [
      ...matching, uri('/work/readme.md'), { ...uri('/work/remote.src'), scheme: 'untitled' },
    ] });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification.mock.calls[0]![1]).toEqual({ files: matching });
  });

  it.each(['', '#comment'])('ファイル操作の無効なパターン %s を拒否する', (glob) => {
    const { DidCreateFilesFeature } = fileOperations();
    const feature = new DidCreateFilesFeature({ code2ProtocolConverter: {} });
    expect(() => feature.register({
      id: 'invalid', registerOptions: { filters: [{ pattern: { glob } }] },
    })).toThrow('Invalid pattern');
  });
});
