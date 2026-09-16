import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // 実 Mind コンパイラを使うテストは既定で走らせない（Docker が要るため）。
    //   npm test -- --testNamePattern=... や TEST_MIND_COMPILER=1 で明示的に有効化する
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
