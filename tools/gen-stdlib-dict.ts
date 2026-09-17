/**
 * 標準単語辞書 stdlib.json を生成する。
 *
 * Mind の配布物には標準ライブラリのソース（pmind/file/*.src）が同梱されている。
 * `.sym` はバイナリで読めないが、こちらは読めるので、定義行とスタック仕様コメントを
 * 抽出して辞書にする。処理系と食い違わない辞書がこれで作れる。
 *
 * Docker は要らない。配布物の tgz から直接取り出す。
 *
 * カーネル組み込み単語（`捨て` `複写` `真？` など）はライブラリソースには無い。
 * これらは `pmind/kernel/c_words*.wrd` に
 *   `複写は　アセンブラ定義の処理単語。`
 * の形で並んでいて、`asmword.src` が `"../kernelF/c_words.wrd"を コンパイルする。`
 * として取り込んでいる。つまり配布物の中では .wrd もライブラリソースの一部なので、
 * こちらも同じパーサに通して辞書に入れる。これを入れないと、ごく普通のプログラムでも
 * 未定義単語だらけに見えてしまう。
 *
 * 抽出には mind-core のレキサ／パーサをそのまま使う。独自の正規表現を持つと
 * 解析器と辞書がずれる（実際、regex 版は `（…）` コメントを取りこぼしていた）。
 *
 *   node tools/gen-stdlib-dict.ts
 *   node tools/gen-stdlib-dict.ts --tgz path/to/mind-for-linux-8.0.08.tgz
 *   node tools/gen-stdlib-dict.ts --dir path/to/pmind/file
 *
 * 出力: packages/mind-core/data/stdlib.json（生成物だがコミットする。
 *       これにより拡張の利用者にも CI にも Mind の配布物は不要になる）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../packages/mind-core/src/parser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_TGZ = resolve(REPO, '../Mind-Docker/vendor/mind-for-linux-8.0.08.tgz');
const OUT = resolve(REPO, 'packages/mind-core/data/stdlib.json');

export interface WordEntry {
  name: string;
  normalized: string;
  kind: string;
  /** スタック仕様コメント `（単価、個数 → ・）` の中身 */
  stack: string | null;
  /** 処理単語 / 関数に付く属性（.S .N NN など） */
  attrs: string[];
  scope: 'global' | 'local';
  /** `file` = 標準ライブラリのソース / `kernel` = カーネル組み込み単語表 */
  source: 'file' | 'kernel';
  /** 仮定義 → 本定義 の形で前方参照されていた語 */
  forwardDeclared?: boolean;
  file: string;
  line: number;
}

function parseArgs(argv: string[]) {
  const out: { tgz?: string; dir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tgz') out.tgz = argv[++i];
    else if (argv[i] === '--dir') out.dir = argv[++i];
  }
  return out;
}

const FILE_GLOB = 'pmind/file/*.src';
const KERNEL_GLOB = 'pmind/kernel/c_words*.wrd';

/** 配布物から標準ライブラリとカーネル単語表を取り出して一時ディレクトリを返す */
function extractFromTgz(tgzPath: string): { dir: string; cleanup: () => void } {
  if (!existsSync(tgzPath)) {
    console.error(`配布物が見つかりません: ${tgzPath}`);
    console.error('Mind-Docker の vendor/ に配布物を置くか、--tgz / --dir で場所を指定してください。');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'mind-stdlib-'));
  try {
    execFileSync('tar', ['xzf', tgzPath, '-C', dir, '--wildcards', FILE_GLOB, KERNEL_GLOB], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    console.error(`配布物から ${FILE_GLOB} / ${KERNEL_GLOB} を取り出せませんでした: ${tgzPath}`);
    process.exit(1);
  }
  return { dir: join(dir, 'pmind'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * カーネル単語表の種別は `アセンブラ定義の処理単語` という文字列そのものになる。
 * 辞書の上ではただの処理単語として扱いたいので揃えておく。
 */
function canonicalKind(kind: string): string {
  return kind.startsWith('アセンブラ定義') ? '処理単語' : kind;
}

function parseFile(fileName: string, source: 'file' | 'kernel', text: string): WordEntry[] {
  const result = parse(text);
  const entries: WordEntry[] = [];

  for (const d of result.declarations) {
    entries.push({
      name: d.name.raw,
      normalized: d.name.normalized,
      kind: canonicalKind(d.kind),
      stack: null,
      attrs: [],
      scope: d.visibility,
      source,
      file: fileName,
      line: d.range.start.line + 1,
    });
  }

  for (const d of result.definitions) {
    entries.push({
      name: d.name.raw,
      normalized: d.name.normalized,
      kind: canonicalKind(d.kind),
      stack: d.stackSpec,
      attrs: [...d.attrs],
      scope: d.visibility,
      source,
      file: fileName,
      line: d.range.start.line + 1,
    });
  }

  entries.sort((a, b) => a.line - b.line);
  return entries;
}

/**
 * 仮定義 と 本定義 は同じ 1 語なのでまとめる。
 * スタック仕様は書かれているほうを採用し、定義位置は本定義を優先する。
 */
function mergeForwardDeclarations(entries: WordEntry[]): WordEntry[] {
  const out: WordEntry[] = [];
  const index = new Map<string, WordEntry>();

  for (const e of entries) {
    if (e.kind !== '仮定義' && e.kind !== '本定義') {
      out.push(e);
      continue;
    }
    const key = `${e.scope}\u0000${e.normalized}`;
    const found = index.get(key);
    if (found === undefined) {
      const merged: WordEntry = { ...e, kind: '処理単語', forwardDeclared: true };
      index.set(key, merged);
      out.push(merged);
      continue;
    }
    if (e.kind === '本定義') {
      found.file = e.file;
      found.line = e.line;
    }
    if (found.stack === null && e.stack !== null) found.stack = e.stack;
    if (found.attrs.length === 0 && e.attrs.length > 0) found.attrs = e.attrs;
  }
  return out;
}

function listing(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort();
}

/**
 * カーネル単語表は c_words / c_words2 / c_wordsg の 3 つがあり、大半が同じ語である。
 * 正規形が同じものは 1 つに畳む（代表は最初に現れたもの）。
 */
function dedupe(entries: WordEntry[]): WordEntry[] {
  const seen = new Map<string, WordEntry>();
  const out: WordEntry[] = [];
  for (const e of entries) {
    const key = `${e.scope}/${e.source}/${e.normalized}`;
    const found = seen.get(key);
    if (found === undefined) {
      seen.set(key, e);
      out.push(e);
      continue;
    }
    if (found.stack === null && e.stack !== null) found.stack = e.stack;
    if (found.attrs.length === 0 && e.attrs.length > 0) found.attrs = e.attrs;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let root: string;
  let cleanup = () => {};
  let origin: string;

  if (args.dir) {
    root = resolve(args.dir);
    origin = root;
  } else {
    const tgz = resolve(args.tgz ?? DEFAULT_TGZ);
    const ex = extractFromTgz(tgz);
    root = ex.dir;
    cleanup = ex.cleanup;
    origin = tgz;
  }

  try {
    const decoder = new TextDecoder('euc-jp');
    const sources: { source: 'file' | 'kernel'; dir: string; files: string[] }[] = [
      { source: 'file', dir: join(root, 'file'), files: listing(join(root, 'file'), '.src') },
      { source: 'kernel', dir: join(root, 'kernel'), files: listing(join(root, 'kernel'), '.wrd') },
    ];

    const raw: WordEntry[] = [];
    for (const group of sources) {
      for (const f of group.files) {
        const text = decoder.decode(readFileSync(join(group.dir, f)));
        raw.push(...parseFile(f, group.source, text));
      }
    }

    const words = dedupe(mergeForwardDeclarations(raw));
    const fileCount = sources.reduce((n, g) => n + g.files.length, 0);

    const doc = {
      generatedBy: 'tools/gen-stdlib-dict.ts',
      generatedAt: new Date().toISOString().slice(0, 10),
      source: {
        distribution: 'mind-for-linux-8.0.08',
        library: 'file',
        origin: origin.replace(/^.*\//, ''),
        files: fileCount,
      },
      counts: {
        total: words.length,
        global: words.filter((w) => w.scope === 'global').length,
        local: words.filter((w) => w.scope === 'local').length,
        fromFile: words.filter((w) => w.source === 'file').length,
        fromKernel: words.filter((w) => w.source === 'kernel').length,
      },
      words,
    };

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const files = { length: fileCount };
    console.log(`${files.length} ファイルから ${words.length} 語を抽出しました`);
    console.log(`  global ${doc.counts.global} / local ${doc.counts.local}`);
    console.log(`  library ${doc.counts.fromFile} / kernel ${doc.counts.fromKernel}`);
    console.log(`  -> ${OUT}`);
  } finally {
    cleanup();
  }
}

main();
