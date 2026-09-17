import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyze } from '../src/diagnostics.ts';
import { parse } from '../src/parser.ts';
import { buildSymbolTable } from '../src/symbols.ts';

/**
 * 実物のコーパスに対する検証。
 *
 * 公式サンプルと標準ライブラリは再配布しないので Git には入れていない。
 * `node tools/extract-samples.ts` で展開したときだけ走る。
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SAMPLES = join(REPO, 'fixtures', 'mind-samples');
const STDLIB = join(SAMPLES, 'stdlib');

const list = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.src')).sort() : [];

const samples = list(SAMPLES);
const stdlib = list(STDLIB);

describe.skipIf(samples.length === 0)('公式サンプル', () => {
  it.each(samples)('%s がエラー無しで解析できる', (name) => {
    const r = parse(readFileSync(join(SAMPLES, name), 'utf8'));
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((e) => `L${String(e.range.start.line + 1)} ${e.message}`)).toEqual([]);
    expect(r.definitions.length).toBeGreaterThan(0);
  });
});

describe.skipIf(stdlib.length === 0)('標準ライブラリ', () => {
  it.each(stdlib)('%s がエラー無しで解析できる', (name) => {
    const r = parse(readFileSync(join(STDLIB, name), 'utf8'));
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((e) => `L${String(e.range.start.line + 1)} ${e.message}`)).toEqual([]);
  });

  it('コミット済みの stdlib.json が最新である', () => {
    const committed = JSON.parse(
      readFileSync(join(REPO, 'packages/mind-core/data/stdlib.json'), 'utf8'),
    ) as { words: Array<{ normalized: string; scope: string; source: string }> };

    const fromSource = new Set<string>();
    for (const name of stdlib) {
      const r = parse(readFileSync(join(STDLIB, name), 'utf8'));
      for (const d of [...r.definitions, ...r.declarations]) {
        if (d.visibility === 'global') fromSource.add(d.name.normalized);
      }
    }
    // カーネル組み込み単語は .wrd 由来なので、ここではライブラリ由来だけを突き合わせる
    const inDict = new Set(
      committed.words
        .filter((w) => w.scope === 'global' && w.source === 'file')
        .map((w) => w.normalized),
    );

    const missing = [...fromSource].filter((w) => !inDict.has(w));
    const extra = [...inDict].filter((w) => !fromSource.has(w));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});

describe.skipIf(samples.length === 0 && stdlib.length === 0)('既定の診断は公式コーパスで黙っている', () => {
  // 既定で出る診断は誤検出ゼロであることを守りたい。実際に動くコードを
  // 一件でも指摘したら、それは診断側の間違いだと考える。
  const all = [
    ...samples.map((f) => [f, join(SAMPLES, f)] as const),
    ...stdlib.map((f) => [`stdlib/${f}`, join(STDLIB, f)] as const),
  ];

  it.each(all)('%s', (_name, path) => {
    const r = parse(readFileSync(path, 'utf8'));
    const found = analyze(r, buildSymbolTable(r)).map(
      (d) => `L${String(d.range.start.line + 1)} [${d.code}] ${d.message}`,
    );
    expect(found).toEqual([]);
  });
});

describe('辞書の中身（コミット済みなので配布物が無くても走る）', () => {
  const dict = JSON.parse(
    readFileSync(join(REPO, 'packages/mind-core/data/stdlib.json'), 'utf8'),
  ) as {
    counts: { global: number; local: number; fromFile: number; fromKernel: number };
    words: Array<{
      name: string;
      normalized: string;
      kind: string;
      stack: string | null;
      attrs: string[];
      source: string;
    }>;
  };

  it('規模が期待どおり', () => {
    // マニュアルは file ライブラリで約 800 単語としている
    expect(dict.counts.fromFile).toBeGreaterThan(600);
    expect(dict.counts.fromFile).toBeLessThan(1000);
    // カーネル単語表は c_words / c_words2 / c_wordsg の和集合で 600 語弱
    expect(dict.counts.fromKernel).toBeGreaterThan(400);
    expect(dict.counts.fromKernel).toBeLessThan(800);
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

describe('シンボルテーブルを実物で組む', () => {
  it.skipIf(stdlib.length === 0)('大域シンボルが正規形で引ける', () => {
    const r = parse(readFileSync(join(STDLIB, 'coutput.src'), 'utf8'));
    const t = buildSymbolTable(r);
    expect(t.globals.get('表示')).toMatchObject({ kind: '処理単語' });
    expect(t.globals.get('一文字表示')).toMatchObject({ kind: '処理単語' });
    // 送り仮名の違いが畳まれている
    expect(t.globals.get('ベル鳴')?.aliases).toContain('ベルを鳴らす');
  });
});
