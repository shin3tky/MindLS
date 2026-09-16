/**
 * tmLanguage を実際に走らせてトークンを取り出すヘルパ。
 *
 * TextMate 文法は正規表現が 1 つ壊れるだけで着色が崩れるうえ、目視では気づきにくい。
 * VS Code と同じエンジン（vscode-textmate + vscode-oniguruma）でトークン化して、
 * スコープをテストで固定する。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as vsctmTypes from 'vscode-textmate';

// vscode-textmate / vscode-oniguruma は CJS。ESM からは require で読む。
const require = createRequire(import.meta.url);
const oniguruma = require('vscode-oniguruma');
const vsctm = require('vscode-textmate');
const HERE = dirname(fileURLToPath(import.meta.url));
const GRAMMAR_PATH = join(HERE, '..', '..', 'syntaxes', 'mind.tmLanguage.json');

export interface Token {
  readonly text: string;
  readonly scopes: readonly string[];
  /** 0 始まりの行番号 */
  readonly line: number;
}

let registryPromise: Promise<vsctmTypes.Registry> | null = null;

function getRegistry(): Promise<vsctmTypes.Registry> {
  registryPromise ??= (async () => {
    const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
    const wasm = readFileSync(wasmPath);
    await oniguruma.loadWASM(new Uint8Array(wasm).buffer);
    return new vsctm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
      }),
      loadGrammar: (scopeName: string) => {
        if (scopeName !== 'source.mind') return Promise.resolve(null);
        return Promise.resolve(vsctm.parseRawGrammar(readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH));
      },
    });
  })();
  return registryPromise;
}

export async function tokenize(source: string): Promise<Token[]> {
  const registry = await getRegistry();
  const grammar = await registry.loadGrammar('source.mind');
  if (grammar === null) throw new Error('source.mind の文法を読み込めませんでした');

  const tokens: Token[] = [];
  let ruleStack: vsctmTypes.StateStack = vsctm.INITIAL;

  source.split('\n').forEach((line, lineNo) => {
    const result = grammar.tokenizeLine(line, ruleStack);
    for (const t of result.tokens as Array<{ startIndex: number; endIndex: number; scopes: string[] }>) {
      const text = line.slice(t.startIndex, t.endIndex);
      if (text.trim() === '') continue;      // 空白だけのトークンは見ない
      tokens.push({ text, scopes: t.scopes, line: lineNo });
    }
    ruleStack = result.ruleStack;
  });

  return tokens;
}

/** そのテキストのトークンが持つスコープを返す（最初に見つかったもの） */
export async function scopesOf(source: string, text: string): Promise<readonly string[]> {
  const tokens = await tokenize(source);
  const hit = tokens.find((t) => t.text === text);
  if (hit === undefined) {
    throw new Error(
      `トークン ${JSON.stringify(text)} が見つかりません。実際のトークン: ` +
        JSON.stringify(tokens.map((t) => t.text)),
    );
  }
  return hit.scopes;
}

/** そのテキストのトークンが指定のスコープを持つか */
export async function hasScope(source: string, text: string, scope: string): Promise<boolean> {
  const scopes = await scopesOf(source, text);
  return scopes.some((s) => s === scope || s.startsWith(`${scope}.`));
}
