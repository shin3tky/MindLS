/**
 * 実 Mind コンパイラを呼び出すアダプタの契約。
 *
 * 実装は M5 で入れる。設計の根拠は docs/COMPILER-BACKEND.md を参照。
 * 要点だけ再掲する。
 *
 *   ・開発者向けラッパー `mindc` は使わない。素の `mind` を一時ディレクトリで叩く
 *     （`mindc` はワークスペースに `.mindbuild/` と成果物を作るため）
 *   ・文字コード変換とオフセットの逆変換はこのパッケージが持つ。
 *     `.inf` の位置情報は EUC-JP のバイトオフセットで、LSP が返すのは UTF-16 の位置
 *   ・保存時のみ呼ぶ。打鍵ごとの補完・ホバーは mind-core の自前解析だけで完結させる
 */

export interface CompileInput {
  /**
   * コンパイルするソースの絶対パス。
   *
   * 中身ではなくパスを渡す。実コンパイラ連携は**保存時にだけ**走らせるので、
   * ディスクの内容が最新である。パスで渡すと、同じフォルダーにある
   * `"x.src"を　コンパイル。` の取り込み先もそのままコンパイルできる。
   */
  readonly path: string;
  /** リンクする標準ライブラリ。既定は `file` */
  readonly library: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'hint';

export interface CompileDiagnostic {
  readonly file: string;
  /** 0 始まりの行番号 */
  readonly line: number;
  /** 0 始まりの UTF-16 コードユニット位置。特定できない場合は null（= 行全体） */
  readonly character: number | null;
  /** 範囲の終端。`character` が null なら null */
  readonly endCharacter: number | null;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

export interface CompileResult {
  readonly ok: boolean;
  readonly diagnostics: readonly CompileDiagnostic[];
  /** コンパイラの生出力（UTF-8 に変換済み）。デバッグ用 */
  readonly output: string;
}

export interface MindCompiler {
  /** 文法チェックだけおこない、診断を返す */
  check(input: CompileInput): Promise<CompileResult>;
  /** 常駐コンテナなどの後始末 */
  dispose(): Promise<void>;
}

/**
 * コンパイラ連携が設定されていないときの実装。常に「診断なし」を返す。
 * 既定はこれ。拡張の利用者に Docker を要求しないため。
 */
export class NullCompiler implements MindCompiler {
  check(_input: CompileInput): Promise<CompileResult> {
    return Promise.resolve({ ok: true, diagnostics: [], output: '' });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
