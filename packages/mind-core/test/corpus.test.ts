import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyze } from '../src/diagnostics.ts';
import { resolveDistribution } from '../src/distribution.ts';
import { parse } from '../src/parser.ts';
import { buildSymbolTable } from '../src/symbols.ts';
import { DISTRIBUTION_IDS, loadStdlib, manifest, stdlibDocument } from './helpers/stdlib.ts';

/**
 * 実物のコーパスに対する検証。配布物ごとに同じ検証を回す。
 *
 * 公式サンプルと標準ライブラリは再配布しないので Git には入れていない。
 * `node tools/extract-samples.ts` で fixtures/mind-samples/<配布物>/ に展開したときだけ走る。
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SAMPLES_ROOT = join(REPO, 'fixtures', 'mind-samples');

const list = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.src')).sort() : [];

/**
 * 公式の配布物のほうに誤りがあると見ているもの。実コンパイラで確かめられたら外す。
 * キーは `<配布物>/<バケット>/<ファイル>`。
 */
const KNOWN_DIVERGENCES: Record<string, string> = {
  // 220 行目の `つぎき` は `つぎに` の誤記に見える。ひらがなだけの語の末尾で落ちるのは
  // 助詞と思われるものだけ（マニュアル 02）なので、我々は `ならば` が閉じないと判断する。
  // 同梱の .mco はあるので実コンパイラは通している可能性がある。Windows 版で要確認
  'windows-9/gui/samplew-stddialog-file.src': '`つぎき`（`つぎに` の誤記？）',
};

const errorsOf = (path: string): string[] =>
  parse(readFileSync(path, 'utf8'))
    .diagnostics.filter((d) => d.severity === 'error')
    .map((e) => `L${String(e.range.start.line + 1)} ${e.message}`);

describe.each(DISTRIBUTION_IDS)('配布物 %s', (id) => {
  const base = join(SAMPLES_ROOT, id);
  const dirs = {
    samples: join(base, 'samples'),
    stdlib: join(base, 'stdlib'),
    fragments: join(base, 'fragments'),
    gui: join(base, 'gui'),
    errors: join(base, 'errors'),
  };
  const samples = list(dirs.samples);
  const stdlib = list(dirs.stdlib);
  const fragments = list(dirs.fragments);
  const gui = list(dirs.gui);
  const broken = list(dirs.errors);
  const known = (bucket: string, name: string): boolean =>
    KNOWN_DIVERGENCES[`${id}/${bucket}/${name}`] !== undefined;
  const stdlibIndex = loadStdlib(id);

  describe.skipIf(samples.length === 0)('公式サンプル', () => {
    it.each(samples)('%s がエラー無しで解析できる', (name) => {
      const path = join(dirs.samples, name);
      expect(errorsOf(path)).toEqual([]);
      // `mtail.src` のように定数を 1 つ置いて別ファイルに続くだけのものもある
      const r = parse(readFileSync(path, 'utf8'));
      expect(r.definitions.length + r.declarations.length).toBeGreaterThan(0);
    });
  });

  describe.skipIf(fragments.length + gui.length === 0)('取り込み用ソースと GUI サンプル（構文だけ）', () => {
    it.each([
      ...fragments.filter((f) => !known('fragments', f)).map((f) => [`fragments/${f}`, join(dirs.fragments, f)] as const),
      ...gui.filter((f) => !known('gui', f)).map((f) => [`gui/${f}`, join(dirs.gui, f)] as const),
    ])('%s がエラー無しで解析できる', (_name, path) => {
      expect(errorsOf(path)).toEqual([]);
    });
  });

  describe.skipIf(broken.length === 0)('わざと誤りを入れた教材', () => {
    it.each(broken)('%s はエラーになる', (name) => {
      expect(errorsOf(join(dirs.errors, name)).length).toBeGreaterThan(0);
    });
  });

  describe.skipIf(stdlib.length === 0)('標準ライブラリ', () => {
    it.each(stdlib)('%s がエラー無しで解析できる', (name) => {
      expect(errorsOf(join(dirs.stdlib, name))).toEqual([]);
    });

    it(`コミット済みの stdlib/${id}.json が最新である`, () => {
      const fromSource = new Set<string>();
      for (const name of stdlib) {
        const r = parse(readFileSync(join(dirs.stdlib, name), 'utf8'));
        for (const d of [...r.definitions, ...r.declarations]) {
          if (d.visibility === 'global') fromSource.add(d.name.normalized);
        }
      }
      // カーネル組み込み単語は .wrd 由来なので、ここではライブラリ由来だけを突き合わせる
      const inDict = new Set(
        stdlibDocument(id)
          .words.filter((w) => w.scope === 'global' && w.source === 'file')
          .map((w) => w.normalized),
      );

      const missing = [...fromSource].filter((w) => !inDict.has(w));
      const extra = [...inDict].filter((w) => !fromSource.has(w));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it('大域シンボルが正規形で引ける', () => {
      const r = parse(readFileSync(join(dirs.stdlib, 'coutput.src'), 'utf8'));
      const t = buildSymbolTable(r);
      expect(t.globals.get('表示')).toMatchObject({ kind: '処理単語' });
      expect(t.globals.get('一文字表示')).toMatchObject({ kind: '処理単語' });
      // 送り仮名の違いが畳まれている
      expect(t.globals.get('ベル鳴')?.aliases).toContain('ベルを鳴らす');
    });
  });

  describe.skipIf(samples.length === 0 && stdlib.length === 0)('既定の診断は公式コーパスで黙っている', () => {
    // 既定で出る診断は誤検出ゼロであることを守りたい。実際に動くコードを
    // 一件でも指摘したら、それは診断側の間違いだと考える。
    const all = [
      ...samples.map((f) => [f, join(dirs.samples, f)] as const),
      ...stdlib.map((f) => [`stdlib/${f}`, join(dirs.stdlib, f)] as const),
    ];

    it.each(all)('%s', (_name, path) => {
      const r = parse(readFileSync(path, 'utf8'));
      const found = analyze(r, buildSymbolTable(r), { stdlib: stdlibIndex }).map(
        (d) => `L${String(d.range.start.line + 1)} [${d.code}] ${d.message}`,
      );
      expect(found).toEqual([]);
    });
  });

  describe('辞書の中身（コミット済みなので配布物が無くても走る）', () => {
    const dict = stdlibDocument(id);

    it('出典が配布物の定義と一致する', () => {
      expect(dict.source).toMatchObject({
        distribution: id,
        label: manifest.distributions[id]!.label,
        library: 'file',
      });
    });

    it('規模が期待どおり', () => {
      // マニュアルは file ライブラリで約 800 単語としている
      expect(dict.counts.fromFile).toBeGreaterThan(600);
      expect(dict.counts.fromFile).toBeLessThan(1200);
      // カーネル単語表は c_words* の和集合で 600 語前後
      expect(dict.counts.fromKernel).toBeGreaterThan(400);
      expect(dict.counts.fromKernel).toBeLessThan(900);
    });

    it.each(['捨て', '複写', '真？', 'スタックポインタ'])(
      'カーネル組み込み単語 %s が入っている',
      (name) => {
        const w = dict.words.find((x) => x.name === name);
        expect(w).toMatchObject({ kind: '処理単語', source: 'kernel' });
      },
    );

    it.each([
      ['表示', '処理単語', '文字列 → ・'],
      ['一行表示', '処理単語', '文字列 → ・'],
      ['改行', '処理単語', '・ → ・'],
    ])('%s が期待どおりに入っている', (name, kind, stack) => {
      const w = dict.words.find((x) => x.name === name);
      expect(w).toMatchObject({ kind, stack });
    });

    it('壊れた名前が混ざっていない', () => {
      expect(dict.words.filter((w) => /^[（(「]/.test(w.name))).toEqual([]);
    });
  });
});

describe('配布物ごとの差', () => {
  const win = loadStdlib('windows-9');
  const linux = loadStdlib('linux-8');

  it.each([
    ['windows-9', 'Ｗｉｎｄｏｗｓディレクトリ', 'fwinAPI.src'],
    ['windows-9', '一行切り出し', 'cmain.src'],
    ['linux-8', '分身を作る', 'fexecunix.src'],
  ])('%s にだけある %s（%s）', (id, name, file) => {
    const [mine, other] = id === 'windows-9' ? [win, linux] : [linux, win];
    const w = [...mine.byNormalized.values()].find((x) => x.name === name);
    expect(w).toMatchObject({ file });
    expect([...other.byNormalized.values()].some((x) => x.name === name)).toBe(false);
  });

  it('既定は windows-9 で、定義にあるすべての配布物に辞書がある', () => {
    expect(resolveDistribution(manifest, undefined).id).toBe('windows-9');
    for (const id of DISTRIBUTION_IDS) expect(stdlibDocument(id).words.length).toBeGreaterThan(0);
  });
});
