/**
 * GHSA-g3hv-75wg-m249 の修正版 minimatch 11 は makeRe() を持たない。
 * vscode-languageclient 10.1.2 の検証箇所だけ、解析済みパターンの有無を見る形へ直す。
 * 照合本体の match() はそのまま使う。上流が対応したら override とこの処理を外す。
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(require.resolve('vscode-languageclient/node')), '..', '..');
const manifest = join(root, 'package.json');
assert.equal(
  JSON.parse(readFileSync(manifest, 'utf8')).version,
  '10.1.2',
  'vscode-languageclient の版が変わりました。minimatch の互換性パッチを再確認してください。',
);

const before = 'if (!matcher.makeRe()) {';
const after = 'if (matcher.set.length === 0) {';
// 両ファイルを検証してから書く。再実行時は適用済みとして扱う。
const patches = ['utils/globPattern.js', 'fileOperations.js'].map((relativePath) => {
  const file = join(dirname(manifest), 'lib', 'common', relativePath);
  const source = readFileSync(file, 'utf8');
  const oldCount = source.split(before).length - 1;
  const newCount = source.split(after).length - 1;
  assert.ok(
    (oldCount === 1 && newCount === 0) || (oldCount === 0 && newCount === 1),
    `${file}: 想定と異なるコードのため、互換性パッチを適用できません。`,
  );
  return { file, source, patched: source.replace(before, after) };
});

for (const { file, source, patched } of patches) {
  if (source !== patched) writeFileSync(file, patched);
}
