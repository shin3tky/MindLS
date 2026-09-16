/**
 * 標準単語辞書の索引。
 *
 * 辞書そのもの（`data/stdlib.json`）は配布物から生成してコミットしてある。
 * このモジュールは中身を読むだけでファイルには触らない（純関数のまま保つ）。
 * 読み込みは利用側（Language Server）が `@mindls/core/stdlib` から行う。
 */

export interface StdlibWord {
  readonly name: string;
  readonly normalized: string;
  readonly kind: string;
  readonly stack: string | null;
  readonly attrs: readonly string[];
  readonly scope: 'global' | 'local';
  readonly forwardDeclared?: boolean;
  /** 出典。`coutput.src` など */
  readonly file: string;
  readonly line: number;
}

export interface StdlibDocument {
  readonly source: { readonly distribution: string; readonly library: string };
  readonly words: readonly StdlibWord[];
}

export interface StdlibIndex {
  /** 正規形 → 語。大域のものだけを持つ */
  readonly byNormalized: ReadonlyMap<string, StdlibWord>;
  /** 補完候補に出す大域の語 */
  readonly words: readonly StdlibWord[];
  readonly library: string;
}

export function createStdlibIndex(doc: StdlibDocument): StdlibIndex {
  const words = doc.words.filter((w) => w.scope === 'global');
  const byNormalized = new Map<string, StdlibWord>();
  for (const w of words) {
    // 同じ正規形が複数あれば、スタック仕様を持つほうを優先する
    const existing = byNormalized.get(w.normalized);
    if (existing === undefined || (existing.stack === null && w.stack !== null)) {
      byNormalized.set(w.normalized, w);
    }
  }
  return { byNormalized, words, library: doc.source.library };
}

export const EMPTY_STDLIB: StdlibIndex = {
  byNormalized: new Map(),
  words: [],
  library: '',
};
