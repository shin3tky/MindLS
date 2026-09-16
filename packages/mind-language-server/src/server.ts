/**
 * Mind の Language Server 本体。
 *
 * 実装は M1 以降。いまは構成を固定するための骨組みだけ置く。
 * ハンドラは mind-core（解析）と mind-compiler（実処理系）の上に載せる。
 */

import { normalize } from '@mindls/core';
import { NullCompiler, type MindCompiler } from '@mindls/compiler';

export interface ServerOptions {
  /** 実コンパイラ連携。設定されていなければ NullCompiler */
  readonly compiler?: MindCompiler;
}

export function createServer(options: ServerOptions = {}): {
  readonly compiler: MindCompiler;
  readonly normalize: (word: string) => string;
} {
  return {
    compiler: options.compiler ?? new NullCompiler(),
    normalize,
  };
}
