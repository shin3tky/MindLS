/**
 * 標準単語辞書 stdlib.json を生成する。
 *
 * Mind の配布物には標準ライブラリのソース（pmind/file/*.src）が同梱されている。
 * `.sym` はバイナリで読めないが、こちらは読めるので、定義行とスタック仕様コメントを
 * 抽出して辞書にする。処理系と食い違わない辞書がこれで作れる。
 *
 * Docker は要らない。配布物の tgz から直接取り出す。
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

/** 配布物から pmind/file/*.src を取り出して一時ディレクトリを返す */
function extractFromTgz(tgzPath: string): { dir: string; cleanup: () => void } {
  if (!existsSync(tgzPath)) {
    console.error(`配布物が見つかりません: ${tgzPath}`);
    console.error('Mind-Docker の vendor/ に配布物を置くか、--tgz / --dir で場所を指定してください。');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'mind-stdlib-'));
  try {
    execFileSync('tar', ['xzf', tgzPath, '-C', dir, '--wildcards', 'pmind/file/*.src'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    console.error(`配布物から pmind/file/*.src を取り出せませんでした: ${tgzPath}`);
    process.exit(1);
  }
  return { dir: join(dir, 'pmind', 'file'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 行を分かち書きで区切る */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (isSeparator(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** `（… → …）` を取り出す。中点コメントと違い、矢印があるものだけをスタック仕様とみなす */
function extractStackSpec(rest: string): string | null {
  const m = rest.match(/[（(]([^）)]*)[）)]/);
  if (!m || m[1] === undefined) return null;
  const body = m[1];
  if (!/→|->/.test(body)) return null;
  return body.replace(/[\s　]+/g, ' ').trim();
}

function detectKind(rest: string): Kind {
  for (const k of KINDS) {
    if (rest.includes(k)) return k;
  }
  return '不明';
}

function extractAttrs(rest: string): string[] {
  // 処理単語 / 関数 に続くスタック属性（.S .N .D NN SN など）
  const m = rest.match(/(?:処理単語|関数)[\s　]+([.\w]+(?:[\s　]+[.\w]+)*)/);
  if (!m || m[1] === undefined) return [];
  return m[1].split(/[\s　]+/).filter((a) => /^[.A-Za-z0-9]+$/.test(a));
}

function parseFile(fileName: string, text: string): WordEntry[] {
  const result = parse(text);
  const entries: WordEntry[] = [];

  for (const d of result.declarations) {
    entries.push({
      name: d.name.raw,
      normalized: d.name.normalized,
      kind: d.kind,
      stack: null,
      attrs: [],
      scope: d.visibility,
      file: fileName,
      line: d.range.start.line + 1,
    });
  }

  for (const d of result.definitions) {
    entries.push({
      name: d.name.raw,
      normalized: d.name.normalized,
      kind: d.kind,
      stack: d.stackSpec,
      attrs: [...d.attrs],
      scope: d.visibility,
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let srcDir: string;
  let cleanup = () => {};
  let origin: string;

  if (args.dir) {
    srcDir = resolve(args.dir);
    origin = srcDir;
  } else {
    const tgz = resolve(args.tgz ?? DEFAULT_TGZ);
    const ex = extractFromTgz(tgz);
    srcDir = ex.dir;
    cleanup = ex.cleanup;
    origin = tgz;
  }

  try {
    const decoder = new TextDecoder('euc-jp');
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.src')).sort();
    const raw: WordEntry[] = [];

    for (const f of files) {
      const text = decoder.decode(readFileSync(join(srcDir, f)));
      raw.push(...parseFile(f, text));
    }

    const words = mergeForwardDeclarations(raw);

    const doc = {
      generatedBy: 'tools/gen-stdlib-dict.ts',
      generatedAt: new Date().toISOString().slice(0, 10),
      source: {
        distribution: 'mind-for-linux-8.0.08',
        library: 'file',
        origin: origin.replace(/^.*\//, ''),
        files: files.length,
      },
      counts: {
        total: words.length,
        global: words.filter((w) => w.scope === 'global').length,
        local: words.filter((w) => w.scope === 'local').length,
      },
      words,
    };

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    console.log(`${files.length} ファイルから ${words.length} 語を抽出しました`);
    console.log(`  global ${doc.counts.global} / local ${doc.counts.local}`);
    console.log(`  -> ${OUT}`);
  } finally {
    cleanup();
  }
}

main();
