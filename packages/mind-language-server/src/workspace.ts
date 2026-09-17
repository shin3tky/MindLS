/**
 * ワークスペースの取り込み索引。
 *
 * Mind のプログラムは `"x.src"を　コンパイル。` で複数のソースに分かれる。
 * 1 ファイルだけを見ていると、取り込み先で定義された単語がすべて未定義に見えるので、
 * 未定義単語の診断が使えない。ここでワークスペース全体を走査して、
 * **同じプログラムに属するファイルの大域シンボル**を集める。
 *
 * 取り込みの順番は見ない。順番まで考えると「あとで定義された単語を先に使っている」も
 * 拾えるが、判定を外したときに**正しいコードを赤くしてしまう**。前方参照の検査は
 * 1 ファイルの中だけで行い（`forward-reference`）、ここでは
 * **取り込みでつながっているファイルの和集合**という、甘いほうに倒した見方をする。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

import { parse } from '@mindls/core';
import type { ParseResult } from '@mindls/core';

/** 走査するファイル数の上限。大きなワークスペースで固まらないように */
const MAX_FILES = 4_000;
/** 掘り下げる深さの上限 */
const MAX_DEPTH = 8;
/** 見に行かないフォルダー */
const SKIP = new Set(['node_modules', '.git', '.mindbuild', 'dist', 'out', 'obj']);
const EXTENSIONS = new Set(['.src', '.mnd', '.wrd']);

interface Entry {
  readonly path: string;
  readonly mtimeMs: number;
  /** このファイルが定義する大域シンボル（正規形） */
  readonly globals: ReadonlySet<string>;
  /** 解決できた取り込み先の絶対パス */
  readonly includes: readonly string[];
  /** 解決できなかった取り込み先。1 つでもあれば「全部は見えていない」 */
  readonly missing: readonly string[];
}

export interface ImportedSymbols {
  /** 同じプログラムに属するファイルが定義する大域シンボル（正規形） */
  readonly globals: ReadonlySet<string>;
  /** つながっているファイルの絶対パス（自分を含む） */
  readonly files: readonly string[];
  /** 取り込み先のファイルが見つからなかったか。true なら未定義単語の診断は諦める */
  readonly incomplete: boolean;
}

export const EMPTY_IMPORTS: ImportedSymbols = {
  globals: new Set(),
  files: [],
  incomplete: false,
};

function globalsOf(result: ParseResult): Set<string> {
  const out = new Set<string>();
  for (const d of result.definitions) {
    if (d.visibility === 'global') out.add(d.name.normalized);
    // 局所処理単語は外から見えないので入れない
  }
  for (const d of result.declarations) {
    if (d.visibility === 'global') out.add(d.name.normalized);
  }
  return out;
}

export class WorkspaceIndex {
  private readonly root: string;
  private readonly cache = new Map<string, Entry>();
  /** 走査済みのファイル一覧。ワークスペースが変わるまで使い回す */
  private files: string[] | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** ファイルが増減したかもしれないときに呼ぶ */
  invalidate(path?: string): void {
    this.files = null;
    if (path === undefined) this.cache.clear();
    else this.cache.delete(resolve(path));
  }

  /**
   * そのファイルと同じプログラムに属するファイルの大域シンボルを集める。
   *
   * 「同じプログラム」= 取り込みの矢印を**向きを無視して**たどって届く範囲。
   * `fhead.src` を開いているとき、それを取り込む `file.src` と、
   * `file.src` が取り込む他のファイルまで見えるようにするため。
   */
  importsFor(path: string): ImportedSymbols {
    const start = resolve(path);
    const neighbours = this.neighbourGraph();

    const seen = new Set<string>([start]);
    const queue = [start];
    const globals = new Set<string>();
    let incomplete = false;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const entry = this.entryOf(current);
      if (entry === null) {
        incomplete = true;
        continue;
      }
      if (current !== start) for (const g of entry.globals) globals.add(g);
      if (entry.missing.length > 0) incomplete = true;

      for (const next of neighbours.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    return { globals, files: [...seen], incomplete };
  }

  /** 取り込みの矢印を両向きに開いた隣接表 */
  private neighbourGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
      const list = graph.get(a);
      if (list === undefined) graph.set(a, [b]);
      else if (!list.includes(b)) list.push(b);
    };

    for (const file of this.allFiles()) {
      const entry = this.entryOf(file);
      if (entry === null) continue;
      for (const target of entry.includes) {
        link(file, target);
        link(target, file);
      }
    }
    return graph;
  }

  /** 1 ファイルを解析して覚える。更新されていれば読み直す */
  private entryOf(path: string): Entry | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return null;
    }

    const cached = this.cache.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null;
    }

    const parsed = parse(text);
    const includes: string[] = [];
    const missing: string[] = [];
    const dir = dirname(path);

    for (const ref of parsed.includes) {
      const target = resolve(dir, ref.path);
      if (exists(target)) includes.push(target);
      else missing.push(ref.path);
    }

    const entry: Entry = { path, mtimeMs, globals: globalsOf(parsed), includes, missing };
    this.cache.set(path, entry);
    return entry;
  }

  /** ワークスペースの中の Mind ソースを集める */
  private allFiles(): string[] {
    if (this.files !== null) return this.files;
    const out: string[] = [];
    walk(this.root, 0, out);
    this.files = out;
    return out;
  }
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      walk(full, depth + 1, out);
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
}
