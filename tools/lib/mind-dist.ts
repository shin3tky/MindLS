/**
 * Mind の配布物（tgz / zip）を扱う道具。gen-stdlib-dict と extract-samples が共有する。
 *
 * 配布物ごとの差（トップディレクトリ名・ライブラリの置き場所・文字コード）は
 * `packages/mind-core/data/distributions.json` に書いてあり、ここはそれに従うだけ。
 * 新しい版で置き場所が変わったら、コードではなくそちらの `layout` を直す。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DistributionManifest, DistributionSpec } from '../../packages/mind-core/src/distribution.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST_PATH = join(REPO, 'packages/mind-core/data/distributions.json');

/** 配布物を探す場所。先に見つかったほうを使う */
export const ARCHIVE_DIRS = [join(REPO, 'vendor'), resolve(REPO, '../Mind-Docker/vendor')];

export function loadManifest(): DistributionManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as DistributionManifest;
}

export function specOf(manifest: DistributionManifest, id: string): DistributionSpec {
  const spec = manifest.distributions[id];
  if (spec === undefined) {
    const known = Object.keys(manifest.distributions).join(', ');
    throw new Error(`配布物 ${id} は distributions.json にありません（${known}）`);
  }
  return spec;
}

/** `*` と `?` だけのパターンを正規表現にする */
function patternToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** ファイル名から版を取り出す。`mind-for-windows-9.04.zip` → `9.04` */
export function versionOf(archivePath: string): string | null {
  const m = [...basename(archivePath).matchAll(/\d+(?:\.\d+)+/g)];
  return m.length === 0 ? null : m[m.length - 1]![0];
}

function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * 配布物のアーカイブを探す。`archive` のパターンに合うもののうち、版がいちばん新しいもの。
 * vendor/ に新しい版を置けば、定義を触らずにそちらが使われる。
 */
export function findArchive(spec: DistributionSpec, dirs: readonly string[] = ARCHIVE_DIRS): string | null {
  const patterns = spec.archive.map(patternToRegExp);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const hits = readdirSync(dir)
      .filter((f) => patterns.some((p) => p.test(f)))
      .sort((a, b) => compareVersions(versionOf(a) ?? '', versionOf(b) ?? ''));
    const latest = hits[hits.length - 1];
    if (latest !== undefined) return join(dir, latest);
  }
  return null;
}

export interface Extracted {
  /** 展開した一時ディレクトリ */
  readonly dir: string;
  readonly cleanup: () => void;
}

/** アーカイブ内の名前が展開先の外を指せないことを確認する。 */
export function assertSafeArchiveEntry(name: string): void {
  const normalized = name.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`アーカイブに展開先の外を指すパスがあります: ${JSON.stringify(name)}`);
  }
}

function validateArchiveEntries(archivePath: string): void {
  const zip = /\.zip$/iu.test(archivePath);
  const output = zip
    ? execFileSync('unzip', ['-Z1', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('tar', ['tzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const name of output.toString('utf8').split(/\r?\n/u)) {
    if (name !== '') assertSafeArchiveEntry(name);
  }

  // リンクを先に作ってからその配下へ書く形式だと、展開後の検証では手遅れになる。
  // 通常ファイルとディレクトリ以外は、展開前の一覧で拒否する。
  const verbose = zip
    ? execFileSync('unzip', ['-Z', '-l', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('tar', ['tvzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const line of verbose.toString('utf8').split(/\r?\n/u)) {
    if (/^[bchlps][rwxStTs-]{9}[ +]/u.test(line)) {
      throw new Error(`アーカイブにリンクまたは特殊ファイルがあります: ${line}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 展開後に、リンクを含む全要素の実体が展開先の内側にあることを確認する。 */
function validateExtractedTree(dir: string): void {
  const root = realpathSync.native(dir);
  const pending: Buffer[] = [Buffer.from(root)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of readdirSync(current, { encoding: 'buffer' })) {
      const path = Buffer.concat([current, Buffer.from('/'), name]);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`アーカイブにシンボリックリンクがあります: ${path.toString()}`);
      }
      let real: string;
      try {
        real = realpathSync.native(path);
      } catch {
        throw new Error(`アーカイブに解決できないリンクがあります: ${path.toString()}`);
      }
      if (!isWithin(root, real)) {
        throw new Error(`アーカイブの展開結果が一時ディレクトリの外を指しています: ${path.toString()}`);
      }

      if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile()) {
        throw new Error(`アーカイブに通常ファイル以外の要素があります: ${path.toString()}`);
      }
    }
  }
}

/** 配布物を一時ディレクトリに丸ごと展開する（中身の配置を仮定しないため） */
export function extractArchive(archivePath: string): Extracted {
  if (!existsSync(archivePath)) throw new Error(`配布物が見つかりません: ${archivePath}`);
  try {
    validateArchiveEntries(archivePath);
  } catch (error) {
    throw new Error(`配布物のパスを検証できませんでした: ${archivePath}\n${String(error)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'mind-dist-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    if (/\.zip$/i.test(archivePath)) {
      execFileSync('unzip', ['-q', '-o', archivePath, '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    } else {
      execFileSync('tar', ['xzf', archivePath, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    validateExtractedTree(dir);
  } catch (error) {
    cleanup();
    throw new Error(`配布物を展開できませんでした: ${archivePath}\n${String(error)}`);
  }
  return { dir, cleanup };
}

/**
 * 配布物のルートを探す。目印（`file/asmword.src` など）を含むいちばん浅いディレクトリ。
 * トップディレクトリの名前（`pmind` `Mind9`）や深さには依存しない。
 */
export function findRoot(dir: string, markers: readonly string[], maxDepth = 4): string {
  let level: string[] = [dir];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    for (const d of level) {
      if (markers.some((m) => existsSync(join(d, m)))) return d;
    }
    const next: string[] = [];
    for (const d of level) {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        try {
          if (statSync(p).isDirectory()) next.push(p);
        } catch {
          /* 壊れたリンクなどは無視 */
        }
      }
    }
    level = next;
  }
  throw new Error(`配布物のルートが見つかりません（目印: ${markers.join(', ')}）: ${dir}`);
}

export interface SourceFile {
  /** ルートからの相対パス（表示用。ファイル名は復号済み） */
  readonly relative: string;
  /** ファイル名（復号済み） */
  readonly name: string;
  /** 開くためのパス。ファイル名が UTF-8 でないことがあるのでバイト列で持つ */
  readonly path: Buffer;
}

/**
 * ファイル名を復号する。配布物によってはファイル名そのものが EUC-JP / Shift_JIS
 * （Mind 8 の sampleF など）。UTF-8 として読めなければ配布物の文字コードで読む。
 */
function decodeName(buf: Buffer, encoding: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder(encoding).decode(buf);
  }
}

/**
 * パターンの候補を展開する。すべての候補の和集合を、相対パス順に返す。
 * 存在しない候補は黙って何も返さないので、版によって場所が違うなら両方を並べておけばよい。
 */
export function expand(
  root: string,
  patterns: readonly string[],
  encoding: string,
  exclude: readonly string[] = [],
): SourceFile[] {
  const excluded = exclude.map(patternToRegExp);
  const out = new Map<string, SourceFile>();
  for (const pattern of patterns) {
    const segments = pattern.split('/').filter((s) => s !== '');
    let current: { path: Buffer; relative: string }[] = [{ path: Buffer.from(root), relative: '' }];
    for (const [i, seg] of segments.entries()) {
      const last = i === segments.length - 1;
      const re = patternToRegExp(seg);
      const next: typeof current = [];
      for (const c of current) {
        let names: Buffer[];
        try {
          names = readdirSync(c.path, { encoding: 'buffer' });
        } catch {
          continue;
        }
        for (const nameBuf of names) {
          const name = decodeName(nameBuf, encoding);
          if (!re.test(name)) continue;
          const path = Buffer.concat([c.path, Buffer.from('/'), nameBuf]);
          let isDir: boolean;
          try {
            isDir = statSync(path).isDirectory();
          } catch {
            continue;
          }
          if (last ? isDir : !isDir) continue;
          next.push({ path, relative: c.relative === '' ? name : `${c.relative}/${name}` });
        }
      }
      current = next;
    }
    for (const c of current) {
      if (excluded.some((re) => re.test(c.relative))) continue;
      out.set(c.relative, { relative: c.relative, name: c.relative.split('/').pop()!, path: c.path });
    }
  }
  return [...out.values()].sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/** 配布物の文字コードで読む。Windows 版の EOF マーク（^Z）は落とす */
export function readSource(file: SourceFile, encoding: string): string {
  return new TextDecoder(encoding).decode(readFileSync(file.path)).replace(/\x1a+$/u, '');
}

export interface OpenedDistribution {
  readonly id: string;
  readonly spec: DistributionSpec;
  /** 配布物のルート（展開先の中） */
  readonly root: string;
  /** アーカイブのパス。`--dir` で直接渡されたときは null */
  readonly archive: string | null;
  readonly version: string | null;
  readonly cleanup: () => void;
}

/**
 * 配布物を開く。`dir` があればそれを展開済みのルート（またはその親）として使い、
 * なければ `archive`、それも無ければ vendor/ から探す。
 */
export function openDistribution(
  manifest: DistributionManifest,
  id: string,
  opts: { archive?: string; dir?: string } = {},
): OpenedDistribution | null {
  const spec = specOf(manifest, id);
  if (opts.dir !== undefined) {
    const root = findRoot(resolve(opts.dir), spec.layout.marker);
    return { id, spec, root, archive: null, version: null, cleanup: () => {} };
  }
  const archive = opts.archive !== undefined ? resolve(opts.archive) : findArchive(spec);
  if (archive === null) return null;
  const ex = extractArchive(archive);
  try {
    const root = findRoot(ex.dir, spec.layout.marker);
    return { id, spec, root, archive, version: versionOf(archive), cleanup: ex.cleanup };
  } catch (error) {
    ex.cleanup();
    throw error;
  }
}

/** `--dist a --dist b --archive x --dir y` の共通の解釈 */
export function parseDistArgs(argv: readonly string[]): { dists: string[]; archive?: string; dir?: string } {
  const out: { dists: string[]; archive?: string; dir?: string } = { dists: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--dist' && v !== undefined) {
      out.dists.push(v);
      i++;
    } else if ((a === '--archive' || a === '--tgz' || a === '--zip') && v !== undefined) {
      out.archive = v;
      i++;
    } else if (a === '--dir' && v !== undefined) {
      out.dir = v;
      i++;
    }
  }
  return out;
}

/** 配布物を 1 つに決めないといけない引数（--archive / --dir）の組み合わせを検査する */
export function targetDistributions(manifest: DistributionManifest, args: ReturnType<typeof parseDistArgs>): string[] {
  const dists = args.dists.length > 0 ? args.dists : Object.keys(manifest.distributions);
  if ((args.archive !== undefined || args.dir !== undefined) && dists.length !== 1) {
    throw new Error('--archive / --dir を使うときは --dist で配布物を 1 つ指定してください');
  }
  for (const d of dists) specOf(manifest, d);
  return dists;
}
