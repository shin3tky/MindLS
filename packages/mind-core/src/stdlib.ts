/**
 * 標準単語辞書の索引。
 *
 * 辞書そのもの（`data/stdlib/<配布物>.json`）は配布物から生成してコミットしてある。
 * 配布物ごとに 1 ファイルで、どれを使うかは `mind.distribution` の設定で決まる。
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
  /** `file` = 標準ライブラリのソース / `kernel` = カーネル組み込み単語表 */
  readonly source: 'file' | 'kernel';
  readonly forwardDeclared?: boolean;
  /** 出典のファイル名。`coutput.src` `c_words.wrd` など */
  readonly file: string;
  readonly line: number;
}

export interface StdlibDocument {
  readonly source: {
    /** `windows-9` `linux-8` など。distributions.json の ID */
    readonly distribution: string;
    readonly library: string;
    /** 表示用の名前。`Mind 9 for Windows` */
    readonly label?: string;
    /** 生成に使った配布物の版。`9.04` */
    readonly version?: string;
  };
  readonly words: readonly StdlibWord[];
}

export interface StdlibIndex {
  /** 正規形 → 語。大域のものだけを持つ */
  readonly byNormalized: ReadonlyMap<string, StdlibWord>;
  /** 補完候補に出す大域の語 */
  readonly words: readonly StdlibWord[];
  readonly library: string;
  /** distributions.json の ID。空なら辞書なし */
  readonly distribution: string;
  /** ホバーに出す出典の説明。`Mind 9 for Windows 9.04` */
  readonly origin: string;
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
  const origin = [doc.source.label ?? doc.source.distribution, doc.source.version ?? '']
    .filter((x) => x !== '')
    .join(' ');
  return {
    byNormalized,
    words,
    library: doc.source.library,
    distribution: doc.source.distribution,
    origin,
  };
}

export const EMPTY_STDLIB: StdlibIndex = {
  byNormalized: new Map(),
  words: [],
  library: '',
  distribution: '',
  origin: '',
};
