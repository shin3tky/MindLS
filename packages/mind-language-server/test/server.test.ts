import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LspClient } from './helpers/client.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const URI = 'file:///tmp/revline.src';

const SOURCE = [
  '入力ファイルは　ファイル。',
  '',
  '使い方を表示とは　（・　→　・）',
  '　　「Usage:」を　一行表示すること。',
  '',
  'エラー検査は　　（・  →  ・）',
  '　　エラー？',
  '　　　　ならば　エラー文字列で　重大エラー',
  '　　　　つぎに。',
  '',
  'メインとは',
  '　　入力名は　文字列',
  '　　起動引数（１）を　入力名に　入れ',
  '　　入力名で　入力ファイルを　オープンし　エラー検査し',
  '　　入力ファイルを　クローズし　エラー検査し',
  '　　使い方を表示すること。',
].join('\n');

const lineOf = (needle: string): number => SOURCE.split('\n').findIndex((l) => l.includes(needle));
const charOf = (needle: string, inner: string): number =>
  SOURCE.split('\n')[lineOf(needle)]!.indexOf(inner) + 1;

describe('Language Server（実プロセス）', () => {
  let client: LspClient;

  beforeAll(async () => {
    client = new LspClient();
    await client.initialize();
    client.openDocument(URI, SOURCE);
  }, 20_000);

  afterAll(async () => {
    await client.dispose();
  });

  it('能力を宣言する', async () => {
    const fresh = new LspClient();
    const result = (await fresh.initialize()) as { capabilities: Record<string, unknown> };
    expect(result.capabilities).toMatchObject({
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      workspaceSymbolProvider: true,
      hoverProvider: true,
    });
    await fresh.dispose();
  }, 20_000);

  it('診断を配信する（この入力ではエラー無し）', async () => {
    const params = (await client.waitForNotification('textDocument/publishDiagnostics')) as {
      uri: string;
      diagnostics: Array<{ severity: number; message: string }>;
    };
    expect(params.uri).toBe(URI);
    expect(params.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it('DocumentSymbol を返す', async () => {
    const symbols = (await client.request('textDocument/documentSymbol', {
      textDocument: { uri: URI },
    })) as Array<{ name: string; detail: string; children: Array<{ name: string }> }>;

    expect(symbols.map((s) => s.name)).toEqual([
      '入力ファイル', '使い方を表示', 'エラー検査', 'メイン',
    ]);
    const main = symbols.find((s) => s.name === 'メイン')!;
    expect(main.children.map((c) => c.name)).toEqual(['入力名']);
  });

  it('定義へジャンプする', async () => {
    const line = lineOf('オープンし　エラー検査し');
    const locations = (await client.request('textDocument/definition', {
      textDocument: { uri: URI },
      position: { line, character: charOf('オープンし　エラー検査し', 'エラー検査し') },
    })) as Array<{ uri: string; range: { start: { line: number } } }>;

    expect(locations).toHaveLength(1);
    expect(locations[0]!.range.start.line).toBe(lineOf('エラー検査は'));
  });

  it('送り仮名が違っても同じ定義へ飛ぶ', async () => {
    const line = lineOf('使い方を表示すること');
    const locations = (await client.request('textDocument/definition', {
      textDocument: { uri: URI },
      position: { line, character: 3 },
    })) as Array<{ range: { start: { line: number } } }>;
    expect(locations[0]!.range.start.line).toBe(lineOf('使い方を表示とは'));
  });

  it('参照を列挙する', async () => {
    const line = lineOf('エラー検査は');
    const locations = (await client.request('textDocument/references', {
      textDocument: { uri: URI },
      position: { line, character: 2 },
      context: { includeDeclaration: false },
    })) as Array<{ range: { start: { line: number } } }>;

    expect(locations.map((l) => l.range.start.line).sort((a, b) => a - b)).toEqual([
      lineOf('オープンし　エラー検査し'),
      lineOf('クローズし　エラー検査し'),
    ]);
  });

  it('局所変数の参照はその定義の中に閉じる', async () => {
    const line = lineOf('入力名は　文字列');
    const locations = (await client.request('textDocument/references', {
      textDocument: { uri: URI },
      position: { line, character: 2 },
      context: { includeDeclaration: true },
    })) as Array<{ range: { start: { line: number } } }>;
    const lines = locations.map((l) => l.range.start.line);
    expect(lines).toContain(lineOf('入力名は　文字列'));
    expect(lines).toContain(lineOf('入力名に　入れ'));
    expect(lines.every((l) => l >= lineOf('メインとは'))).toBe(true);
  });

  it('横断検索で正規形から引ける', async () => {
    const symbols = (await client.request('workspace/symbol', { query: '表示' })) as Array<{
      name: string;
    }>;
    expect(symbols.map((s) => s.name)).toContain('使い方を表示');
  });

  it('補完が出る（完了条件: 「表」で表示系）', async () => {
    const line = lineOf('使い方を表示すること');
    const result = (await client.request('textDocument/completion', {
      textDocument: { uri: URI },
      position: { line, character: 3 },
    })) as Array<{ label: string }>;

    const labels = result.map((r) => r.label);
    expect(labels).toContain('表示');
    expect(labels).toContain('一行表示');
    expect(labels).toContain('数値表示');
    expect(labels).toContain('使い方を表示');
  }, 20_000);

  it('補完に局所変数とスニペットが含まれる', async () => {
    const line = lineOf('入力名に　入れ');
    const result = (await client.request('textDocument/completion', {
      textDocument: { uri: URI },
      position: { line, character: 2 },
    })) as Array<{ label: string; insertTextFormat?: number }>;

    expect(result.map((r) => r.label)).toContain('入力名');
    expect(result.find((r) => r.label === 'ここから')?.insertTextFormat).toBe(2);
  }, 20_000);

  it('ホバーでスタック仕様が出る', async () => {
    const line = lineOf('オープンし　エラー検査し');
    const hover = (await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: { line, character: charOf('オープンし　エラー検査し', 'エラー検査し') },
    })) as { contents: { value: string } };

    expect(hover.contents.value).toContain('**エラー検査**');
    expect(hover.contents.value).toContain('・  →  ・');
  }, 20_000);

  it('標準単語のホバーは出典を示す', async () => {
    const line = lineOf('一行表示すること');
    const hover = (await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: { line, character: charOf('一行表示すること', '一行表示') },
    })) as { contents: { value: string } } | null;

    expect(hover?.contents.value).toContain('**一行表示**');
    expect(hover?.contents.value).toContain('標準ライブラリ file');
  }, 20_000);

  it('公式サンプルでも定義ジャンプが効く', async () => {
    const path = join(REPO, 'fixtures', 'mind-samples', 'sample-05-revline.src');
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return; // 配布物が展開されていない環境では飛ばす
    }
    const uri = 'file:///tmp/official-revline.src';
    client.openDocument(uri, text);

    const lines = text.split('\n');
    const useLine = lines.findIndex((l) => l.includes('オープンし　エラー検査し'));
    const defLine = lines.findIndex((l) => l.startsWith('エラー検査は'));
    expect(useLine).toBeGreaterThan(0);

    const locations = (await client.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: useLine, character: lines[useLine]!.indexOf('エラー検査し') + 1 },
    })) as Array<{ range: { start: { line: number } } }>;
    expect(locations[0]!.range.start.line).toBe(defLine);
  }, 20_000);
});

describe('診断の配線（実プロセス）', () => {
  const codesOf = (params: unknown): string[] =>
    (params as { diagnostics: Array<{ code: string }> }).diagnostics.map((d) => d.code);

  it('前方参照を既定で報告する', async () => {
    const client = new LspClient();
    await client.initialize();
    client.openDocument('file:///tmp/forward.src', 'メインとは\n　二乗し　表示すること。\n二乗とは\n　掛けること。');
    const params = await client.waitForNotification('textDocument/publishDiagnostics');
    expect(codesOf(params)).toContain('forward-reference');
    await client.dispose();
  }, 20_000);

  it('未定義単語は既定では報告しない', async () => {
    const client = new LspClient();
    await client.initialize();
    client.openDocument('file:///tmp/unknown.src', 'メインとは\n　知らない単語すること。');
    const params = await client.waitForNotification('textDocument/publishDiagnostics');
    expect(codesOf(params)).not.toContain('undefined-word');
    await client.dispose();
  }, 20_000);

  it('initializationOptions で未定義単語を有効にできる', async () => {
    const client = new LspClient();
    await client.initialize({ diagnostics: { undefinedWords: true } });
    client.openDocument('file:///tmp/unknown2.src', 'メインとは\n　知らない単語すること。');
    const params = await client.waitForNotification('textDocument/publishDiagnostics');
    expect(codesOf(params)).toContain('undefined-word');
    await client.dispose();
  }, 20_000);

  it('設定変更で診断を切れる', async () => {
    const client = new LspClient();
    await client.initialize();
    const uri = 'file:///tmp/toggle.src';
    client.openDocument(uri, 'メインとは\n　二乗し　表示すること。\n二乗とは\n　掛けること。');
    expect(codesOf(await client.waitForNotification('textDocument/publishDiagnostics'))).toContain(
      'forward-reference',
    );
    await new Promise((r) => setTimeout(r, 50));
    client.drainNotifications('textDocument/publishDiagnostics');
    client.notify('workspace/didChangeConfiguration', {
      settings: { mind: { diagnostics: { forwardReferences: false } } },
    });
    const params = await client.waitForNotification('textDocument/publishDiagnostics');
    expect(codesOf(params)).not.toContain('forward-reference');
    await client.dispose();
  }, 20_000);
});

describe('Semantic Tokens（実プロセス）', () => {
  it('凡例を宣言し、5 個 1 組のデータを返す', async () => {
    const client = new LspClient();
    const result = (await client.initialize()) as {
      capabilities: { semanticTokensProvider?: { legend: { tokenTypes: string[] } } };
    };
    const legend = result.capabilities.semanticTokensProvider?.legend;
    expect(legend?.tokenTypes).toContain('function');

    const uri = 'file:///tmp/semantic.src';
    client.openDocument(uri, '売り上げは　変数。\nメインとは\n　売り上げを　一行表示すること。');
    const tokens = await client.request<{ data: number[] }>('textDocument/semanticTokens/full', {
      textDocument: { uri },
    });
    expect(tokens.data.length % 5).toBe(0);
    expect(tokens.data.length).toBeGreaterThan(0);

    // 3 番目の要素は長さ。`売り上げ` は 4 文字
    expect(tokens.data[2]).toBe(4);
    // 標準単語 `一行表示` には defaultLibrary が立つ
    const library = legend!.tokenTypes.indexOf('function');
    const groups: number[][] = [];
    for (let i = 0; i < tokens.data.length; i += 5) groups.push(tokens.data.slice(i, i + 5));
    expect(groups.some((g) => g[3] === library && g[4] !== 0)).toBe(true);

    await client.dispose();
  }, 20_000);
});

describe('リネーム（実プロセス）', () => {
  const SOURCE_R = [
    '売り上げ計上とは　（金額　→　・）',
    '　増加すること。',
    'メインとは',
    '　１２０円を　売り上げ計上し',
    '　２５０円を　売り上げ計上する。',
  ].join('\n');
  const RENAME_URI = 'file:///tmp/rename.src';

  const open = async () => {
    const c = new LspClient();
    await c.initialize();
    c.openDocument(RENAME_URI, SOURCE_R);
    return c;
  };

  it('prepareRename が助詞を除いた範囲を返す', async () => {
    const c = await open();
    const result = await c.request<{ range: unknown; placeholder: string }>(
      'textDocument/prepareRename',
      { textDocument: { uri: RENAME_URI }, position: { line: 3, character: 8 } },
    );
    expect(result.placeholder).toBe('売り上げ計上し');
    await c.dispose();
  }, 20_000);

  it('全出現を送り仮名ごと書き換える', async () => {
    const c = await open();
    const edit = await c.request<{ changes: Record<string, Array<{ newText: string }>> }>(
      'textDocument/rename',
      { textDocument: { uri: RENAME_URI }, position: { line: 3, character: 8 }, newName: '記帳' },
    );
    expect(edit.changes[RENAME_URI]!.map((e) => e.newText).sort()).toEqual([
      '記帳',
      '記帳し',
      '記帳する',
    ]);
    await c.dispose();
  }, 20_000);

  it('標準単語のリネームは理由を付けて断る', async () => {
    const c = await open();
    await expect(
      c.request('textDocument/prepareRename', {
        textDocument: { uri: RENAME_URI },
        position: { line: 1, character: 2 },
      }),
    ).rejects.toThrow(/予約語|定義されていません/);
    await c.dispose();
  }, 20_000);
});
