/**
 * Mind の配布物（ディストリビューション）の定義。
 *
 * Mind は配布物ごとに標準ライブラリの中身も置き場所も文字コードも違う。
 *   ・Mind 8 for Linux   … `pmind/file/*.src`、EUC-JP
 *   ・Mind 9 for Windows … `Mind9/file/*.src`、Shift_JIS（CRLF）
 * 言語としては後方互換だが、ライブラリの単語（`fwinAPI.src` と `funixapi.src` など）や
 * ソースの参照位置（`../kernelF/` → `../kernelK/`）は版ごとに動く。
 *
 * そこで、配布物の差はコードに書かず `data/distributions.json` に寄せる。
 * 新しい版で置き場所が変わっても、そのファイルの `layout` を直せば辞書を作り直せる。
 * このモジュールは定義を読んで解決するだけの純関数で、ファイルには触らない。
 */

/** 配布物の中の置き場所。どれもルートからの相対パスのパターン（`*` `?` が使える）の候補列 */
export interface DistributionLayout {
  /**
   * 配布物のルートを見分ける目印。展開した中からこれを含むいちばん浅いディレクトリを
   * ルートとみなす。トップディレクトリの名前（`pmind` `Mind9` …）には依存しない。
   */
  readonly marker: readonly string[];
  /** ライブラリ名 → そのソース。`mind.library` の値と対応する */
  readonly libraries: Readonly<Record<string, readonly string[]>>;
  /** カーネル組み込み単語表（`複写は　アセンブラ定義の処理単語。` の並び） */
  readonly kernelWords: readonly string[];
  /** 完結したプログラム（診断ゼロを守るコーパス） */
  readonly samples: Readonly<Record<string, readonly string[]>>;
  /** 取り込まれる側のソース（構文だけを検査する） */
  readonly fragments: Readonly<Record<string, readonly string[]>>;
  /** 辞書を持たないライブラリ（guilib など）を使うサンプル（構文だけを検査する） */
  readonly guiSamples: Readonly<Record<string, readonly string[]>>;
  /** わざと誤りを入れた教材（エラーになることを検査する） */
  readonly errorSamples: Readonly<Record<string, readonly string[]>>;
  /** samples から除くもの（誤りを入れた教材や GUI の教材を別のバケットに回すため） */
  readonly exclude: readonly string[];
}

export interface DistributionSpec {
  readonly label: string;
  readonly platform: 'windows' | 'linux';
  readonly major: number;
  /** TextDecoder に渡せる名前 */
  readonly encoding: string;
  /** vendor/ で探す配布物のファイル名パターン。複数あれば版の新しいものを使う */
  readonly archive: readonly string[];
  /** 設定で受け付ける別名 */
  readonly aliases: readonly string[];
  readonly layout: DistributionLayout;
}

export interface DistributionManifest {
  readonly default: string;
  readonly distributions: Readonly<Record<string, DistributionSpec>>;
}

export interface ResolvedDistribution {
  readonly id: string;
  readonly spec: DistributionSpec;
  /** 指定が解決できず既定に倒したとき true */
  readonly fellBack: boolean;
}

/**
 * 設定値から配布物を決める。
 *
 * `windows-9` のような ID のほか、`windows` `mind9` `9` などの別名も受け付ける。
 * 大文字小文字と前後の空白は無視する。空・`auto`・未知の値は既定に倒す
 * （未知の値のときは `fellBack` が立つので、呼び出し側で警告できる）。
 */
export function resolveDistribution(
  manifest: DistributionManifest,
  requested: string | null | undefined,
): ResolvedDistribution {
  const fallback = (fellBack: boolean): ResolvedDistribution => {
    const spec = manifest.distributions[manifest.default];
    if (spec === undefined) {
      throw new Error(`distributions.json の既定 ${manifest.default} が定義されていません`);
    }
    return { id: manifest.default, spec, fellBack };
  };

  const key = (requested ?? '').trim().toLowerCase();
  if (key === '' || key === 'auto' || key === 'default') return fallback(false);

  for (const [id, spec] of Object.entries(manifest.distributions)) {
    if (id.toLowerCase() === key || spec.aliases.some((a) => a.toLowerCase() === key)) {
      return { id, spec, fellBack: false };
    }
  }
  return fallback(true);
}

export function distributionIds(manifest: DistributionManifest): string[] {
  return Object.keys(manifest.distributions);
}
