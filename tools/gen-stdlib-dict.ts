/**
 * 標準単語辞書 `packages/mind-core/data/stdlib/<配布物>.json` を生成する。
 *
 * Mind の配布物には標準ライブラリのソース（`file/*.src`）が同梱されている。
 * `.sym` はバイナリで読めないが、こちらは読めるので、定義行とスタック仕様コメントを
 * 抽出して辞書にする。処理系と食い違わない辞書がこれで作れる。
 *
 * 配布物は版ごとに置き場所も文字コードも違う（`pmind/file` + EUC-JP、
 * `Mind9/file` + Shift_JIS …）。その差は `packages/mind-core/data/distributions.json`
 * に書いてあり、このツールはそれに従うだけ。新しい版で置き場所が変わったら、
 * コードではなく定義の `layout` を直す。配布物は vendor/ に置けば自動で見つける
 * （同じ系列で複数あれば版の新しいもの）。Docker は要らない。
 *
 * カーネル組み込み単語（`捨て` `複写` `真？` など）はライブラリソースには無い。
 * これらは `kernel/c_words*.wrd` に
 *   `複写は　アセンブラ定義の処理単語。`
 * の形で並んでいて、`asmword.src` が `"../kernelK/c_words.wrd"を コンパイルする。`
 * として取り込んでいる（Mind 8 では `../kernelF/`）。つまり配布物の中では .wrd も
 * ライブラリソースの一部なので、こちらも同じパーサに通して辞書に入れる。
 *
 * 抽出には mind-core のレキサ／パーサをそのまま使う。独自の正規表現を持つと
 * 解析器と辞書がずれる（実際、regex 版は `（…）` コメントを取りこぼしていた）。
 *
 *   node tools/gen-stdlib-dict.ts                         … 定義にある配布物すべて（見つからないものは飛ばす）
 *   node tools/gen-stdlib-dict.ts --dist windows-9
 *   node tools/gen-stdlib-dict.ts --dist windows-9 --archive path/to/mind-for-windows-9.05.zip
 *   node tools/gen-stdlib-dict.ts --dist linux-8 --dir path/to/pmind
 *
 * 出力: packages/mind-core/data/stdlib/<配布物>.json（生成物だがコミットする。
 *       これにより拡張の利用者にも CI にも Mind の配布物は不要になる）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parse } from '../packages/mind-core/src/parser.ts';
import {
  REPO,
  expand,
  loadManifest,
  openDistribution,
  parseDistArgs,
  readSource,
  targetDistributions,
  type OpenedDistribution,
} from './lib/mind-dist.ts';

const OUT_DIR = join(REPO, 'packages/mind-core/data/stdlib');

/** 辞書にするライブラリ。`mind.library` の既定値 */
const LIBRARY = 'file';

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

function generate(dist: OpenedDistribution): void {
  const { spec } = dist;
  const libraryPatterns = spec.layout.libraries[LIBRARY];
  if (libraryPatterns === undefined) {
    throw new Error(`${dist.id}: layout.libraries.${LIBRARY} が定義されていません`);
  }
  const groups: { source: 'file' | 'kernel'; patterns: readonly string[] }[] = [
    { source: 'file', patterns: libraryPatterns },
    { source: 'kernel', patterns: spec.layout.kernelWords },
  ];

  const raw: WordEntry[] = [];
  let fileCount = 0;
  for (const group of groups) {
    const files = expand(dist.root, group.patterns, spec.encoding);
    if (files.length === 0) {
      throw new Error(
        `${dist.id}: ${group.patterns.join(', ')} に当たるファイルがありません。` +
          '配布物の中の置き場所が変わったなら distributions.json の layout を直してください。',
      );
    }
    fileCount += files.length;
    for (const f of files) raw.push(...parseFile(f.name, group.source, readSource(f, spec.encoding)));
  }

  const words = dedupe(mergeForwardDeclarations(raw));
  const archiveName = dist.archive === null ? basename(dist.root) : basename(dist.archive);

  const doc = {
    generatedBy: 'tools/gen-stdlib-dict.ts',
    generatedAt: new Date().toISOString().slice(0, 10),
    source: {
      distribution: dist.id,
      label: spec.label,
      version: dist.version,
      library: LIBRARY,
      origin: archiveName,
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

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `${dist.id}.json`);
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  console.log(`[${dist.id}] ${archiveName}: ${fileCount} ファイルから ${words.length} 語を抽出しました`);
  console.log(`  global ${doc.counts.global} / local ${doc.counts.local}`);
  console.log(`  library ${doc.counts.fromFile} / kernel ${doc.counts.fromKernel}`);
  console.log(`  -> ${out}`);
}

function main(): void {
  const manifest = loadManifest();
  const args = parseDistArgs(process.argv.slice(2));
  const explicit = args.dists.length > 0;
  const ids = targetDistributions(manifest, args);

  let generated = 0;
  for (const id of ids) {
    const dist = openDistribution(manifest, id, args);
    if (dist === null) {
      const msg = `[${id}] 配布物が見つかりません（vendor/ に ${manifest.distributions[id]!.archive.join(' / ')} を置くか、--archive で指定）`;
      if (explicit) {
        console.error(msg);
        process.exit(1);
      }
      console.warn(msg + ' — 飛ばします');
      continue;
    }
    try {
      generate(dist);
      generated++;
    } finally {
      dist.cleanup();
    }
  }
  if (generated === 0) {
    console.error('辞書を 1 つも生成できませんでした。');
    process.exit(1);
  }
}

main();
