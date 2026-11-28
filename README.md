# MindLS

[![Test](https://github.com/shin3tky/MindLS/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/shin3tky/MindLS/actions/workflows/test.yml)
[![OSV-Scanner](https://github.com/shin3tky/MindLS/actions/workflows/osv-scanner.yml/badge.svg?branch=main)](https://github.com/shin3tky/MindLS/actions/workflows/osv-scanner.yml)

日本語プログラミング言語 [Mind](https://www.scripts-lab.co.jp/mind/whatsmind.html)（Scripts Lab Inc.）の Language Server と VS Code 拡張です。構文ハイライト、補完、定義への移動、参照の検索、リネーム、診断を提供します。

[0.1.5 の変更履歴](CHANGELOG.md#015---2026-11-28)には、処理単語のリネーム時の活用と、Mind 8 for Linux の半角カナ・半角中点の照合に関する修正を記載しています。

## VS Code で使う

**VS Code 1.91.0 以上**で動作します。公開版の `shin3tky.vscode-mind` は [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=shin3tky.vscode-mind) からインストールできます。手元に `.vsix` がある場合は、拡張機能ビューの `…` メニューから「VSIX からのインストール」を選びます。標準のエディター機能は Mind の配布物や Docker なしで使えます。

Mind のソースがあるフォルダーを開き、`mind.distribution` を使用する配布物に合わせます。コマンドパレットの **`Mind: このワークスペースの文字コードと関連付けを設定する`** で、ソースの文字コードを選びます。

| `mind.distribution` | 配布物 | コマンドで最初に提示する文字コード |
|---|---|---|
| `windows-9`（既定） | Mind 9 for Windows | Shift_JIS |
| `linux-8` | Mind 8 for Linux | EUC-JP |

`linux-8` では `カウント` と `ｶｳﾝﾄ` を別の単語として扱い、半角中点 `･` の有無も区別します。`windows-9` では半角カナを全角カナと同じものとして扱います。

[設定の一覧、複数ファイルの診断、実コンパイラでの検査](packages/vscode-mind/README.md)は拡張機能の README を参照してください。

## 開発環境のセットアップ

Node.js **26.5.0 以上**と npm を使います。拡張機能を開発ホストで試す場合は VS Code も用意してください。TypeScript 7.0 と Vitest は npm でインストールされます。生成済みの標準単語辞書と実コンパイラの `.inf` コーパスをリポジトリに含めているため、通常のビルドとテストは Docker なしで実行できます。

```sh
npm ci
npm run build
npm run typecheck
npm test
```

esbuild と Vitest の依存先である Rolldown は、OS と CPU アーキテクチャに応じたネイティブパッケージを使います。macOS と Linux（WSL2 やコンテナを含む）などを切り替える場合は、実行する環境で `npm ci` を実行して `node_modules` を用意してください。

### パッケージ構成

| パッケージ | 役割 |
|---|---|
| `@mindls/core` | 単語の正規化、字句解析、構文解析、シンボルテーブル、診断、リネーム、Semantic Tokens |
| `@mindls/compiler` | `.inf` の解析と、Docker 上の実 Mind コンパイラを呼び出すアダプター |
| `@mindls/language-server` | 標準入出力（stdio）で通信する Language Server |
| `vscode-mind` | VS Code 拡張機能、構文ハイライト、Language Client の起動と設定 |

設計の詳細は [開発計画](docs/PLAN.md) と [実コンパイラとの連携](docs/COMPILER-BACKEND.md) を参照してください。

## VS Code で試す

### 開発ホストを起動する

1. リポジトリを VS Code で開き、初回は `npm ci` を実行します。
2. **F5** を押すか、実行とデバッグから **「拡張を試す (Extension Development Host)」** を選びます。
3. ビルド後に開発ホストが起動します。[`examples/hello.src`](examples/hello.src) を開き、ステータスバーの言語モードが **Mind** であることを確認します。

[起動設定](.vscode/launch.json)は `packages/vscode-mind` を開発対象とし、`examples/` を開きます。サンプルの文字コードは UTF-8 です。[サンプル用設定](examples/.vscode/settings.json)で `*.src` を Mind に関連付けています。

ターミナルから開発ホストを起動する場合は、リポジトリのルートで実行します。

```sh
npm run build
code --extensionDevelopmentPath="$PWD/packages/vscode-mind" examples
```

### サンプルで動作を確かめる

| 機能 | `hello.src` での確認方法 |
|---|---|
| ハイライト | `※` のコメント、`「…」` の文字列、`ならば` などのキーワードを確認します。Semantic Tokens に対応したテーマでは標準単語と自分で定義した単語の色分けも確認できます。 |
| アウトライン | `明細を表示` を展開すると、局所変数 `＿見出し` と局所処理単語 `一行分を表示` が表示されます。 |
| ホバー | `売り上げ計上` ではスタック仕様と属性を、`一行表示` では辞書の出典を確認できます。 |
| 定義への移動・参照の検索 | `売り上げ計上し` で **F12** を押すと定義へ移動し、**Shift+F12** で参照を検索できます。 |
| 補完 | `表` を入力すると `表示` などの候補が出ます。`事例` のスニペットを選ぶと `事例をとる` から `事例終り` までが入ります。 |
| リネーム | `売り上げ計上し` で **F2** を押して `記帳する` に変更すると、定義は `記帳するとは`、呼び出しは `記帳し` になります。標準単語の `一行表示` で F2 を押すと、このファイルに定義がない旨が表示されます。 |
| 字下げ | `ならば` だけの行で **Enter** を押すと字下げが深くなり、`つぎに` で戻ります。 |

0.1.5 では、`かごに入れる` を `買う` にリネームすると、呼び出しの `かごに入れ` は `買い` になります。`カートに追加` に変更した場合、呼び出しも `カートに追加` になります。

[`examples/diagnostics.src`](examples/diagnostics.src) では、既定の設定で次の 3 件の警告が出ます。

| 該当箇所 | 警告の理由 |
|---|---|
| `合計（単価　→　金額）し` | `（` の前に空白がなく、括弧内がコメントになりません。 |
| `二乗し` | 定義より前で単語を参照しているため、`仮定義` が必要です。 |
| `表示しないこと。` | 照合時に否定形の送り仮名が落ち、肯定形と同じ単語になります。 |

[`examples/kidoairaku.src`](examples/kidoairaku.src) は、既定の設定で警告が出ない例です。`近傍Ｘの　要素数を` の `要素数` をホバーすると、予約語の説明が表示されます。

### 変更を反映する

TypeScript の変更は `npm run build` でビルドします。継続して作業する場合は `npm run watch` で変更時に再ビルドできます。

| 変更した箇所 | 反映方法 |
|---|---|
| `packages/vscode-mind/src/` | ビルド後、開発ホストで「開発者: ウィンドウの再読み込み」を実行します。 |
| `packages/mind-core/`、`packages/mind-compiler/`、`packages/mind-language-server/` | ビルド後、コマンドパレットから **`Mind: Language Server を再起動する`** を実行します。 |
| `packages/vscode-mind/syntaxes/` | 開発ホストで「開発者: ウィンドウの再読み込み」を実行します。 |
| `packages/vscode-mind/package.json` の `contributes` | 開発ホストを閉じて F5 で開き直します。 |

### デバッグする

- **拡張機能**は F5 で起動したデバッグセッションで調べます。[`extension.ts`](packages/vscode-mind/src/extension.ts) の `startLanguageServer` などにブレークポイントを置けます。
- **Language Server** は別プロセスとして `--inspect=6019` 付きで起動します。開発ホストを起動した後、実行とデバッグで **「Language Server にアタッチ」** を選びます。**「拡張 + Language Server をまとめてデバッグ」** で両方を起動できます。
- **LSP の通信**は `mind.trace.server` を `verbose` に設定すると、出力パネルの「Mind Language Server」で確認できます。

サーバーが起動しない場合は、出力パネルと「開発者ツールの切り替え」で開くコンソールを確認してください。`packages/mind-language-server/dist/cli.js` がなければ `npm run build` を実行します。言語モードが **Plain Text** の場合は、ワークスペースの文字コードと関連付けを設定するコマンドを実行してください。

### Language Server を単体で起動する

ビルド後、標準入出力で直接起動できます。

```sh
node packages/mind-language-server/dist/cli.js --stdio
```

[Language Server のテスト](packages/mind-language-server/test/server.test.ts)では、同じ CLI をサブプロセスとして起動し、JSON-RPC で通信します。

## メンテナンス

### 依存関係

直接依存は `package.json` で版を固定し、更新時は `package-lock.json` も同じ PR で更新します。[`.npmrc`](.npmrc) の `save-exact=true` により、新しい依存も版を固定して追加されます。ワークスペース内の参照である `@mindls/*` には `*` を使い、`engines` には対応範囲を指定します。

`@types/vscode` は `engines.vscode` の下限と同じ **1.91.0** に固定しています。対応下限を引き上げる場合は、両方を同じ PR で更新します。

0.1.5 では `vscode-languageclient` 12.0.0 と `vscode-languageserver` 11.0.2 が共通の LSP プロトコル 3.18.7 と JSON-RPC 10.0.2 を使います。クライアントの glob パターン検証は上流で `minimatch` 11 に対応し、インストール時の互換性パッチを削除しました。`minimatch` 10 系を要求する `@vscode/vsce` 4.1.1 には、[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) への対策として `11.0.9` の override を適用しています。

GitHub Actions の [Test](.github/workflows/test.yml) は、PR・マージキュー・`main` への push・手動実行で `npm run typecheck` と `npm test` を実行し、配布用バンドルが起動するかも確かめます。Node.js は `engines.node` の下限（26.5.0）と 26 系列の最新の 2 つです。Mind の配布物と Docker は使わないので、公式サンプルと実コンパイラを使うテストは飛ばします。

GitHub Actions の [OSV-Scanner](.github/workflows/osv-scanner.yml) は、PR とマージキューで依存関係の差分を、`main` への push・毎週月曜日・手動実行で依存関係全体を検査します。結果は GitHub の Code scanning に登録されます。依存の更新には Dependabot と Renovate を使っています。

### 標準単語辞書と配布物の定義

| ファイル | 内容 |
|---|---|
| [`distributions.json`](packages/mind-core/data/distributions.json) | 配布物の ID、文字コード、単語の照合規則、アーカイブ名、配布物内のファイル配置 |
| [`windows-9.json`](packages/mind-core/data/stdlib/windows-9.json) | Mind 9 for Windows の標準単語辞書 |
| [`linux-8.json`](packages/mind-core/data/stdlib/linux-8.json) | Mind 8 for Linux の標準単語辞書 |

辞書は標準ライブラリ `file/*.src` とカーネル組み込み単語表 `kernel/c_words*.wrd` から生成します。組み込み単語表には `捨て`、`複写`、`真？` などが含まれます。再生成する場合は、対象のアーカイブを Git 管理外の `vendor/` に置きます。

```sh
# vendor/mind-for-windows-9.05.zip または vendor/mind-for-linux-8.0.08.tgz を配置
npm run gen:stdlib
node tools/gen-stdlib-dict.ts --dist windows-9
node tools/gen-stdlib-dict.ts --dist windows-9 --archive vendor/mind-for-windows-9.05.zip
node tools/extract-samples.ts
```

`npm run gen:stdlib` は見つかった配布物を処理し、系列ごとに最も新しいアーカイブを選びます。`--dist` で系列を、`--archive` で入力ファイルを指定できます。`tools/extract-samples.ts` は公式サンプルを `fixtures/mind-samples/` に展開します。`npm test` はすべての配布物の辞書を検査し、展開済みのサンプルがあれば既定の診断も検証します。

#### 配布物の更新を確認する

配布物を `vendor/` に配置し、`npm run gen:stdlib` の後で `git diff -- packages/mind-core/data/stdlib/` を確認します。

| 差分 | 確認すること |
|---|---|
| 差分なし | 対象アーカイブと生成結果を確認します。 |
| `source.version` や `source.origin` のみ変更 | 辞書の由来の更新として記録します。 |
| `counts` や `words` が変更 | 語彙の差分を確認し、CHANGELOG に記載します。 |
| 生成エラー・語数が 0 | アーカイブの構成を確認し、必要に応じて `distributions.json` の `layout` を更新します。 |

辞書の `source.version` はアーカイブの版です。たとえば Windows 版のアーカイブ 9.05 に同梱されたコンパイラは 9.03 と表示します。アーカイブの 9.04 から 9.05 への改訂では評価版 GUI ライブラリや同梱ツールが更新され、辞書は 1,505 語で一致しました。辞書には生成日時を持たせず、再生成時に語彙と由来を比較できるようにしています。

配布物のルートは `layout.marker` に指定したファイルから判定します。内部の配置が変わった場合は `layout` に新しいパターンを追加できます。新系列に対応する場合は、`distributions.json`、`packages/vscode-mind/package.json` の `mind.distribution`、生成した辞書をそろえます。

### コンパイラの診断データとアイコン

- `.inf` コーパスの再収集は `tools/collect-inf.sh` と `mind-docker:8.0.08` を使います。環境の準備と収集手順は [実コンパイラとの連携](docs/COMPILER-BACKEND.md) を参照してください。
- 拡張機能のアイコンを更新するには [`tools/gen-icon.py`](tools/gen-icon.py) を編集し、`python3 tools/gen-icon.py` で `packages/vscode-mind/icon.png` を再生成します。Marketplace には PNG を同梱します。

## 配布とリリース

### VSIX を作る

```sh
npm run typecheck
npm test
npm run package
```

`npm run package` は、ビルド済みの拡張機能と Language Server を esbuild でバンドルしてから VSIX を作ります。0.1.5 の出力先は `dist/vscode-mind-0.1.5.vsix` です。配布物の定義と辞書は `dist/distributions.json` と `dist/stdlib/` に同梱します。バンドルだけを作る場合は `npm run bundle` を実行します。

VSIX を VS Code にインストールし、サンプルで動作を確認します。

```sh
code --install-extension dist/vscode-mind-0.1.5.vsix
```

### リリース前の確認

1. `packages/vscode-mind/package.json` と `package-lock.json` の拡張機能のバージョンをそろえます。
2. ルートと `packages/vscode-mind/` の CHANGELOG を同じ内容にそろえ、末尾の比較リンクを更新します。両方の README を実装と設定の既定値に合わせます。
3. VSIX のマニフェストと、同梱される `readme.md`、`changelog.md`、辞書、バンドルを確認します。
4. リリースブランチの変更を `main` に取り込んだ後、リリースコミットにタグ（0.1.5 の場合は `v0.1.5`）を付けて push します。

### Marketplace に公開する

初回は [Marketplace のパブリッシャー管理画面](https://marketplace.visualstudio.com/manage)でパブリッシャーを作成し、その ID を `packages/vscode-mind/package.json` の `publisher` に設定します。この拡張機能の ID は `shin3tky.vscode-mind` です。

動作確認済みの VSIX は、パブリッシャー管理画面からアップロードできます。CLI を使う場合は、公開用の認証を設定したうえで `--packagePath` に確認済みのファイルを指定します。

```sh
npx vsce publish --packagePath dist/vscode-mind-0.1.5.vsix
```

現在のソースからパッケージを生成して公開する場合は `npm run release` を使います。

GitHub Actions からの公開には Trusted Publishing（OIDC）、Azure Pipelines からの公開には Microsoft Entra ID が使えます。グローバル PAT の廃止日は 2026 年 12 月 1 日です。[VS Code の公開ガイド](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[Azure DevOps の廃止案内](https://learn.microsoft.com/en-us/azure/devops/release-notes/2026/general/sprint-270-update)

## ライセンス

[Apache-2.0](LICENSE)
