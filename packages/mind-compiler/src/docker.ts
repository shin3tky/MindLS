/**
 * Docker の中の本物の Mind コンパイラを叩くアダプタ。
 *
 * 設計の理由は `docs/COMPILER-BACKEND.md`。要点だけ。
 *
 *   ・**常駐コンテナに `docker exec`** する。`docker run` は毎回コンテナを作るので、
 *     保存のたびに叩くには重い（32bit x86 のエミュレーションだとなおさら）
 *   ・開発者向けラッパー `mindc` は使わない。ワークスペースに `.mindbuild/` と
 *     成果物を作ってしまうため。素の `mind` をコンテナ内の一時ディレクトリで叩く
 *   ・**UTF-8 → EUC-JP の変換はコンテナの中の `iconv` にやらせる。**
 *     Node の `TextEncoder` は UTF-8 しか出せないので、こちら側でやるなら
 *     `iconv-lite` のような依存が要る。コンテナには最初から `iconv` がある
 *   ・`.inf` は読むだけでワークスペースには書き戻さない
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { CompileDiagnostic, CompileInput, CompileResult, MindCompiler } from './adapter.ts';
import { parseInf, toDiagnostics } from './inf.ts';

/** ワークスペースをコンテナのどこに見せるか */
const MOUNT = '/mindls/workspace';
/** コンパイルをおこなう、コンテナ内の作業場所 */
const WORK = '/tmp/mindls-build';

/** 出力を切り分ける目印。ASCII なので EUC-JP のバイト列の中でも安全に探せる */
const MARK = {
  status: 'MINDLS-STATUS:',
  logBegin: 'MINDLS-LOG-BEGIN',
  logEnd: 'MINDLS-LOG-END',
  infBegin: 'MINDLS-INF-BEGIN',
  infEnd: 'MINDLS-INF-END',
} as const;

export interface RunResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number;
}

/** `docker` の呼び出し。テストから差し替えられるように外に出してある */
export type Runner = (args: readonly string[]) => Promise<RunResult>;

export interface DockerCompilerOptions {
  /** 使うイメージ */
  readonly image: string;
  /** コンテナに見せるワークスペースの絶対パス */
  readonly workspace: string;
  /** `linux/amd64`。Apple Silicon ではエミュレーションになる */
  readonly platform?: string;
  /** `docker` の呼び出しを差し替える（テスト用） */
  readonly run?: Runner;
}

const defaultRunner: Runner = (args) =>
  new Promise((resolvePromise) => {
    execFile(
      'docker',
      [...args],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolvePromise({ stdout, stderr: stderr.toString('utf8'), code });
      },
    );
  });

/** バッファの中から目印に挟まれた部分を切り出す */
function section(out: Buffer, begin: string, end: string): Buffer | null {
  const from = out.indexOf(begin);
  if (from < 0) return null;
  const to = out.indexOf(end, from + begin.length);
  if (to < 0) return null;
  // 目印のうしろの改行を 1 つ食べる
  const start = from + begin.length + (out[from + begin.length] === 0x0a ? 1 : 0);
  return out.subarray(start, to);
}

const decodeEucJp = (b: Buffer): string => new TextDecoder('euc-jp').decode(b);

/**
 * コンテナの中で走らせるスクリプト。
 *
 * ソースのあるフォルダーごと EUC-JP に変換してから `mind` を呼ぶ。同じフォルダーの
 * `"x.src"を　コンパイル。` もこれで解決する。出力は目印で区切って一度に持ち帰る
 * （`docker exec` を何度も往復すると、そのぶん遅くなるため）。
 */
function script(containerPath: string, library: string): string {
  const dir = dirname(containerPath);
  const base = containerPath.slice(dir.length + 1).replace(/\.src$/, '');
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

  return [
    `set -u`,
    `rm -rf ${WORK}; mkdir -p ${WORK}`,
    `cd ${q(dir)} || exit 90`,
    // 変換できないものは EUC-JP のソースとみなしてそのまま写す
    `for f in *.src; do`,
    `  iconv -f UTF-8 -t EUC-JP "$f" > ${WORK}/"$f" 2>/dev/null || cp "$f" ${WORK}/"$f"`,
    `done`,
    `cd ${WORK} || exit 91`,
    // .inf の残骸があると前回のエラーを拾ってしまう
    `rm -f ${q(base)}.inf`,
    `mind ${q(base)} ${q(library)} > ${WORK}/.log 2>&1`,
    `echo "${MARK.status}$?"`,
    `echo ${MARK.logBegin}; cat ${WORK}/.log; echo ${MARK.logEnd}`,
    `if [ -f ${q(base)}.inf ]; then echo ${MARK.infBegin}; cat ${q(base)}.inf; echo ${MARK.infEnd}; fi`,
  ].join('\n');
}

export class DockerCompiler implements MindCompiler {
  private readonly image: string;
  private readonly workspace: string;
  private readonly platform: string;
  private readonly run: Runner;
  /** 常駐コンテナの id。まだ起動していなければ null */
  private container: string | null = null;
  /** 起動が重なったときに同じ Promise を共有する */
  private starting: Promise<string> | null = null;

  constructor(options: DockerCompilerOptions) {
    this.image = options.image;
    this.workspace = resolve(options.workspace);
    this.platform = options.platform ?? 'linux/amd64';
    this.run = options.run ?? defaultRunner;
  }

  async check(input: CompileInput): Promise<CompileResult> {
    const path = resolve(input.path);
    const inside = this.toContainerPath(path);
    if (inside === null) {
      return failure(
        `${path} はワークスペース（${this.workspace}）の外にあるので、コンテナから見えません`,
      );
    }

    let container: string;
    try {
      container = await this.ensureContainer();
    } catch (error) {
      return failure(describe(error));
    }

    const result = await this.run([
      'exec',
      container,
      'bash',
      '-c',
      script(inside, input.library),
    ]);

    // コンテナが落ちていたら、一度だけ起動し直して再試行する
    if (result.code !== 0 && /No such container|is not running/i.test(result.stderr)) {
      this.container = null;
      const retryContainer = await this.ensureContainer();
      return this.interpret(
        await this.run(['exec', retryContainer, 'bash', '-c', script(inside, input.library)]),
        path,
      );
    }

    return this.interpret(result, path);
  }

  async dispose(): Promise<void> {
    const container = this.container;
    this.container = null;
    this.starting = null;
    if (container === null) return;
    await this.run(['rm', '-f', container]);
  }

  /** ワークスペース内の絶対パスを、コンテナから見たパスに直す */
  private toContainerPath(path: string): string | null {
    if (!isAbsolute(path)) return null;
    const rel = relative(this.workspace, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return `${MOUNT}/${rel.split(sep).join('/')}`;
  }

  /** 常駐コンテナを用意する。すでにあればそれを返す */
  private ensureContainer(): Promise<string> {
    if (this.container !== null) return Promise.resolve(this.container);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<string> {
    const result = await this.run([
      'run',
      '--detach',
      '--platform',
      this.platform,
      // ワークスペースは読むだけ。生成物でユーザーのフォルダーを汚さない
      '--volume',
      `${this.workspace}:${MOUNT}:ro`,
      '--workdir',
      MOUNT,
      this.image,
      // 何もせず起きているだけのプロセス。exec の入れ物として使う
      'sleep',
      'infinity',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `コンテナを起動できませんでした（${this.image}）: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
      );
    }
    const id = result.stdout.toString('utf8').trim();
    if (id === '') throw new Error('コンテナの id を取得できませんでした');
    this.container = id;
    return id;
  }

  /** `docker exec` の出力を診断に変える */
  private interpret(result: RunResult, path: string): CompileResult {
    const out = result.stdout;
    const logBytes = section(out, MARK.logBegin, MARK.logEnd);
    const output = logBytes === null ? result.stderr : decodeEucJp(logBytes);

    const statusAt = out.indexOf(MARK.status);
    const status =
      statusAt < 0
        ? null
        : Number(
            out
              .subarray(statusAt + MARK.status.length, statusAt + MARK.status.length + 8)
              .toString('ascii')
              .split('\n')[0],
          );

    if (status === null) {
      // 目印が出ていない = スクリプトが走る前に落ちた
      return failure(
        `コンパイラを実行できませんでした: ${result.stderr.trim() || output.trim() || `exit ${String(result.code)}`}`,
      );
    }

    const infBytes = section(out, MARK.infBegin, MARK.infEnd);
    if (infBytes === null) {
      // .inf が無い = 文法エラー無し。status が 0 でなければ別の失敗
      return status === 0
        ? { ok: true, diagnostics: [], output }
        : failure(`コンパイルに失敗しました (exit=${String(status)})\n${output.trim()}`, output);
    }

    const report = parseInf(decodeEucJp(infBytes));
    const lines = readLines(path);
    return {
      ok: false,
      diagnostics: toDiagnostics(report, lines, path),
      output,
    };
  }
}

/** 位置合わせのために、利用者の UTF-8 ソースを読む */
function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function failure(message: string, output = ''): CompileResult {
  const diagnostic: CompileDiagnostic = {
    file: '',
    line: 0,
    character: null,
    endCharacter: null,
    severity: 'warning',
    message,
  };
  return { ok: false, diagnostics: [diagnostic], output };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
