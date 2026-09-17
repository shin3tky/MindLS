/**
 * 配布用のバンドルを作る。
 *
 * npm workspaces では `@mindls/language-server` が node_modules のシンボリックリンクに
 * なっている。vsce はこれを .vsix に入れられないので、拡張と Language Server を
 * それぞれ 1 ファイルに束ねて `packages/vscode-mind/dist/` に置く。
 * 束ねたあとの拡張は隣の `server.js` を起動するだけになり、リンクに頼らなくなる。
 *
 *   node tools/bundle.mts          … 本番用（minify 付き）
 *   node tools/bundle.mts --dev    … デバッグ用（sourcemap 付き・minify 無し）
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'packages', 'vscode-mind', 'dist');
const dev = process.argv.includes('--dev');

/**
 * CJS に束ねると `import.meta.url` が消える。辞書の場所を求めるのに使っているので、
 * `__filename` から同じものを組み立てて差し替える。
 */
const IMPORT_META_URL = '__mindls_import_meta_url';
const banner = [
  `const { pathToFileURL: __mindls_pathToFileURL } = require('node:url');`,
  `const ${IMPORT_META_URL} = __mindls_pathToFileURL(__filename).href;`,
].join('\n');

const common = {
  bundle: true,
  platform: 'node' as const,
  target: 'node20',
  format: 'cjs' as const,
  sourcemap: dev,
  minify: !dev,
  logLevel: 'info' as const,
  banner: { js: banner },
  define: { 'import.meta.url': IMPORT_META_URL },
};

// vsce から呼ばれることもあるので、型検査とビルドはここで面倒みる
execFileSync('npx', ['tsc', '--build'], { cwd: REPO, stdio: 'inherit' });

mkdirSync(OUT, { recursive: true });

await build({
  ...common,
  entryPoints: [join(REPO, 'packages', 'vscode-mind', 'src', 'extension.ts')],
  outfile: join(OUT, 'extension.js'),
  // vscode は VS Code が実行時に渡す。束ねてはいけない
  external: ['vscode'],
});

await build({
  ...common,
  entryPoints: [join(REPO, 'packages', 'mind-language-server', 'src', 'cli.ts')],
  outfile: join(OUT, 'server.js'),
});

// 辞書はバンドルに含めず、隣に置く（analysis.ts がこの名前で探す）
copyFileSync(join(REPO, 'packages', 'mind-core', 'data', 'stdlib.json'), join(OUT, 'stdlib.json'));

for (const name of ['extension.js', 'server.js', 'stdlib.json']) {
  const kb = (statSync(join(OUT, name)).size / 1024).toFixed(1);
  console.log(`  ${name.padEnd(14)} ${kb.padStart(8)} KB`);
}
