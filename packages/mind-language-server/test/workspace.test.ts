import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceIndex } from '../src/workspace.ts';

/** 使い捨てのワークスペースを組み立てる */
const build = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'mindls-ws-'));
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  return root;
};

describe('取り込みの索引', () => {
  let root: string;
  beforeAll(() => {
    root = build({
      // main が sub を取り込む、ふつうの 2 ファイル構成
      'main.src': ['"sub.src"を　コンパイル。', '', 'メインとは', '　３を　二乗し　数値表示すること。'].join('\n'),
      'sub.src': ['二乗とは　（数値　→　数値）', '　複写し　掛けること。'].join('\n'),
      // 取り込みとは無関係のファイル
      'other.src': 'ひとりぼっちとは\n　表示すること。',
    });
  });

  it('取り込んだ先の大域シンボルが見える', () => {
    const index = new WorkspaceIndex(root);
    const imports = index.importsFor(join(root, 'main.src'));
    expect(imports.globals.has('二乗')).toBe(true);
    expect(imports.incomplete).toBe(false);
  });

  it('取り込まれた側からも、取り込んだ側が見える', () => {
    // `sub.src` を開いているときも、同じプログラムの語彙として `メイン` が見える。
    // 矢印の向きを無視してたどるのはこのため
    const index = new WorkspaceIndex(root);
    const imports = index.importsFor(join(root, 'sub.src'));
    expect(imports.globals.has('メイン')).toBe(true);
    expect([...imports.files].length).toBe(2);
  });

  it('関係の無いファイルは混ぜない', () => {
    const index = new WorkspaceIndex(root);
    const imports = index.importsFor(join(root, 'main.src'));
    expect(imports.globals.has('ひとりぼっち')).toBe(false);
  });

  it('自分が定義した語は imported に入れない（重複させない）', () => {
    const index = new WorkspaceIndex(root);
    expect(index.importsFor(join(root, 'main.src')).globals.has('メイン')).toBe(false);
  });
});

describe('全部は見えていないとき', () => {
  it('取り込み先が見つからなければ incomplete になる', () => {
    const root = build({
      'main.src': '"どこにも無い.src"を　コンパイル。\nメインとは\n　表示すること。',
    });
    expect(new WorkspaceIndex(root).importsFor(join(root, 'main.src')).incomplete).toBe(true);
  });

  it('条件コンパイルは取り込みではない', () => {
    const root = build({
      'main.src': '条件コンパイル　ＵＮＩＸ環境。\n条件コンパイル終り。\nメインとは\n　表示すること。',
    });
    expect(new WorkspaceIndex(root).importsFor(join(root, 'main.src')).incomplete).toBe(false);
  });
});

describe('ワークスペース境界', () => {
  it('.. でワークスペース外のファイルを取り込まない', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mindls-boundary-'));
    const root = join(parent, 'workspace');
    mkdirSync(root);
    writeFileSync(join(parent, 'outside.src'), '外部の秘密とは\n　表示すること。', 'utf8');
    writeFileSync(
      join(root, 'main.src'),
      '"../outside.src"を　コンパイル。\nメインとは\n　外部の秘密を　表示すること。',
      'utf8',
    );

    const imports = new WorkspaceIndex(root).importsFor(join(root, 'main.src'));
    expect(imports.globals.has('外部の秘密')).toBe(false);
    expect(imports.files).toHaveLength(1);
    expect(imports.incomplete).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('外部を指すシンボリックリンクを取り込まない', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mindls-boundary-'));
    const root = join(parent, 'workspace');
    mkdirSync(root);
    const outside = join(parent, 'outside.src');
    writeFileSync(outside, '外部の秘密とは\n　表示すること。', 'utf8');
    symlinkSync(outside, join(root, 'linked.src'));
    writeFileSync(
      join(root, 'main.src'),
      '"linked.src"を　コンパイル。\nメインとは\n　外部の秘密を　表示すること。',
      'utf8',
    );

    const imports = new WorkspaceIndex(root).importsFor(join(root, 'main.src'));
    expect(imports.globals.has('外部の秘密')).toBe(false);
    expect(imports.files).toHaveLength(1);
    expect(imports.incomplete).toBe(true);
  });
});

describe('循環と入れ子', () => {
  it('取り込みが循環していても止まる', () => {
    const root = build({
      'a.src': '"b.src"を　コンパイル。\nＡとは\n　表示すること。',
      'b.src': '"a.src"を　コンパイル。\nＢとは\n　表示すること。',
    });
    const imports = new WorkspaceIndex(root).importsFor(join(root, 'a.src'));
    expect(imports.globals.has('b')).toBe(true);
    expect(imports.files).toHaveLength(2);
  });

  it('取り込みの取り込みまでたどる', () => {
    const root = build({
      'a.src': '"lib/b.src"を　コンパイル。\nＡとは\n　表示すること。',
      'lib/b.src': '"c.src"を　コンパイル。\nＢとは\n　表示すること。',
      'lib/c.src': 'Ｃとは\n　表示すること。',
    });
    const imports = new WorkspaceIndex(root).importsFor(join(root, 'a.src'));
    expect([...imports.globals].sort()).toEqual(['b', 'c']);
  });
});
