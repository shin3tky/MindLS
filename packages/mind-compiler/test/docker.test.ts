import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DockerCompiler } from '../src/docker.ts';
import type { RunResult, Runner } from '../src/docker.ts';

/**
 * `docker` の呼び出しだけを差し替えて、そのまわり全部を試す。
 * 本物のコンテナが要るのは最後の 1 手だけなので、そこは外から注入できるようにしてある。
 */
const encode = (text: string): Buffer => Buffer.from(new TextEncoder().encode(text));

interface Call {
  readonly args: readonly string[];
}

const workspace = mkdtempSync(join(tmpdir(), 'mindls-docker-'));
writeFileSync(join(workspace, 'a.src'), 'main\n\tundefined-word\n', 'utf8');

const fake = (
  handler: (args: readonly string[]) => Partial<RunResult>,
): { run: Runner; calls: Call[] } => {
  const calls: Call[] = [];
  const run: Runner = (args) => {
    calls.push({ args });
    const r = handler(args);
    return Promise.resolve({
      stdout: r.stdout ?? Buffer.alloc(0),
      stderr: r.stderr ?? '',
      code: r.code ?? 0,
    });
  };
  return { run, calls };
};

const OK_OUTPUT = encode(
  ['MINDLS-STATUS:0', 'MINDLS-LOG-BEGIN', 'compiled', 'MINDLS-LOG-END', ''].join('\n'),
);

describe('DockerCompiler', () => {
  it('常駐コンテナを 1 度だけ起動し、以降は exec する', async () => {
    const { run, calls } = fake((args) =>
      args[0] === 'run' ? { stdout: encode('abc123\n') } : { stdout: OK_OUTPUT },
    );
    const compiler = new DockerCompiler({ image: 'mind-docker:8.0.08', workspace, run });

    await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });
    await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });

    expect(calls.filter((c) => c.args[0] === 'run')).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === 'exec')).toHaveLength(2);
    expect(calls[1]!.args.slice(0, 2)).toEqual(['exec', 'abc123']);
  });

  it('ワークスペースを読み取り専用で渡す', async () => {
    const { run, calls } = fake((args) =>
      args[0] === 'run' ? { stdout: encode('abc123\n') } : { stdout: OK_OUTPUT },
    );
    const compiler = new DockerCompiler({ image: 'img', workspace, run });
    await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });

    const runArgs = calls[0]!.args;
    expect(runArgs).toContain('--detach');
    expect(runArgs).toContain(`${workspace}:/mindls/workspace:ro`);
    expect(runArgs.slice(-2)).toEqual(['sleep', 'infinity']);
  });

  it('エラーが無ければ ok を返す', async () => {
    const { run } = fake((args) =>
      args[0] === 'run' ? { stdout: encode('c\n') } : { stdout: OK_OUTPUT },
    );
    const compiler = new DockerCompiler({ image: 'img', workspace, run });
    const result = await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });
    expect(result).toMatchObject({ ok: true, diagnostics: [] });
    expect(result.output).toContain('compiled');
  });
});

/**
 * 実物の `.inf` を通してみる。
 *
 * コンテナだけを差し替え、`.inf` は `fixtures/inf-corpus/collected/` に集めた
 * **EUC-JP の原本そのまま**を流す。復号・解析・位置の割り出しまでが一続きで試せる。
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORPUS = join(REPO, 'fixtures', 'inf-corpus');
const REAL_INF = join(CORPUS, 'collected', 'undefined-word', 'report.inf');

describe.skipIf(!existsSync(REAL_INF))('実物の .inf を流す', () => {
  // describe.skipIf が飛ばすのは中のテストだけで、この本体は実行される。
  // コーパスが無い環境でも落ちないよう、ファイルを読むのはテストの中に入れておく
  const stage = (): { dir: string; output: Buffer } => {
    const dir = mkdtempSync(join(tmpdir(), 'mindls-real-'));
    copyFileSync(join(CORPUS, 'undefined-word.src'), join(dir, 'undefined-word.src'));
    return {
      dir,
      output: Buffer.concat([
        Buffer.from('MINDLS-STATUS:1\nMINDLS-LOG-BEGIN\n', 'ascii'),
        readFileSync(join(CORPUS, 'collected', 'undefined-word', 'compile.euc.log')),
        Buffer.from('\nMINDLS-LOG-END\nMINDLS-INF-BEGIN\n', 'ascii'),
        readFileSync(REAL_INF),
        Buffer.from('\nMINDLS-INF-END\n', 'ascii'),
      ]),
    };
  };

  it('EUC-JP を復号し、行と桁つきの診断にする', async () => {
    const { dir, output } = stage();
    const { run } = fake((args) =>
      args[0] === 'run' ? { stdout: encode('c\n') } : { stdout: output },
    );
    const compiler = new DockerCompiler({ image: 'img', workspace: dir, run });
    const result = await compiler.check({
      path: join(dir, 'undefined-word.src'),
      library: 'file',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    const [d] = result.diagnostics;
    expect(d!.message).toBe('"まったく存在しない単語"は未定義の単語です。');
    expect(d!.line).toBe(2);

    const line = readFileSync(join(dir, 'undefined-word.src'), 'utf8').split('\n')[d!.line]!;
    expect(line.slice(d!.character!, d!.endCharacter!)).toBe('まったく存在しない単語し');
    // コンパイラの出力も UTF-8 に直って読める
    expect(result.output).toContain('個のエラーが有ります');
  });
});

describe('うまくいかないとき', () => {
  it('ワークスペースの外は断る', async () => {
    const { run, calls } = fake(() => ({ stdout: encode('c\n') }));
    const compiler = new DockerCompiler({ image: 'img', workspace, run });
    const result = await compiler.check({ path: '/etc/passwd', library: 'file' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toContain('ワークスペース');
    expect(calls).toHaveLength(0); // docker は呼ばない
  });

  it('コンテナを起動できなければ、理由を添えて警告にする', async () => {
    const { run } = fake(() => ({ code: 125, stderr: 'Unable to find image' }));
    const compiler = new DockerCompiler({ image: 'ない:image', workspace, run });
    const result = await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });
    expect(result.diagnostics[0]).toMatchObject({ severity: 'warning' });
    expect(result.diagnostics[0]!.message).toContain('Unable to find image');
  });

  it('コンテナが落ちていたら、起動し直して 1 度だけやり直す', async () => {
    let started = 0;
    const { run, calls } = fake((args) => {
      if (args[0] === 'run') {
        started += 1;
        return { stdout: encode(`c${String(started)}\n`) };
      }
      if (args[1] === 'c1') return { code: 1, stderr: 'Error: No such container: c1' };
      return { stdout: OK_OUTPUT };
    });
    const compiler = new DockerCompiler({ image: 'img', workspace, run });
    await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });
    const result = await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });

    expect(started).toBe(2);
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.args[0] === 'exec').at(-1)!.args[1]).toBe('c2');
  });

  it('dispose でコンテナを片づける', async () => {
    const { run, calls } = fake((args) =>
      args[0] === 'run' ? { stdout: encode('c\n') } : { stdout: OK_OUTPUT },
    );
    const compiler = new DockerCompiler({ image: 'img', workspace, run });
    await compiler.check({ path: join(workspace, 'a.src'), library: 'file' });
    await compiler.dispose();
    expect(calls.at(-1)!.args).toEqual(['rm', '-f', 'c']);
  });
});
