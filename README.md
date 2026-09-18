# MindLS

[![OSV-Scanner](https://github.com/shin3tky/MindLS/actions/workflows/osv-scanner.yml/badge.svg?branch=main)](https://github.com/shin3tky/MindLS/actions/workflows/osv-scanner.yml)

日本語プログラミング言語 [Mind](https://www.scripts-lab.co.jp/mind/whatsmind.html)（Scripts Lab Inc.）の
Language Server と VS Code 拡張。

開発計画は [`docs/PLAN.md`](docs/PLAN.md)、実処理系との結合方針は
[`docs/COMPILER-BACKEND.md`](docs/COMPILER-BACKEND.md)。

## 構成

| パッケージ | 役割 |
|---|---|
| `@mindls/core` | 正規化・レキサ・パーサ・シンボルテーブル・診断・リネーム・Semantic Tokens。エディタ非依存 |
| `@mindls/compiler` | `.inf` の解析と、Docker の中の実 Mind コンパイラを叩くアダプタ |
| `@mindls/language-server` | LSP 本体（stdio） |
| `vscode-mind` | VS Code 拡張 |

## セットアップ

```sh
npm install
npm run build     # 全パッケージを dist/ へ
npm test          # Vitest
npm run typecheck
npm run bundle    # 配布用に esbuild で束ねる
npm run package   # .vsix を作る
```

依存パッケージは、GitHub Actions の OSV-Scanner で `package-lock.json` を検査します。
Pull Request では新しく持ち込まれる脆弱性を比較し、`main` への push、毎週月曜日、
および手動実行では依存関係全体を検査します。結果は GitHub の Code scanning に登録されます。
Dependabot は npm パッケージと GitHub Actions の更新を週次で確認し、更新PRを作成します。

#### 依存の版

直接の依存は `package.json` で**版を固定**しています（`^` を付けない）。`.npmrc` の
`save-exact=true` により、`npm install <パッケージ>` で足したものも固定で書かれます。
版を上げるのは Dependabot の PR（`package.json` と `package-lock.json` を一緒に書き換える）を通すときだけです。

- `@mindls/*` はワークスペース内の参照なので `*` のまま
- `engines`（`node` と `vscode`）は依存ではなく対応する下限なので範囲のまま
- **`@types/vscode` は `engines.vscode` の下限と同じ版に固定**し、Dependabot の対象から外しています。
  新しい型を入れると、下限の VS Code に無い API を使っても型エラーにならないためです。
  `packages/vscode-mind` の devDependencies に置いてあるので、`vsce package` も食い違いを検査します。
  上げるときは `engines.vscode` と `@types/vscode` を同じ PR で上げてください
  （いまの下限 1.91 は `vscode-languageclient` 10.x の要求に合わせたもの）

> **`node_modules` を OS 間で共有しないでください。**
> esbuild と rolldown（Vitest）はネイティブバイナリを持ち、`@esbuild/darwin-arm64` の
> ように **OS ごとに別のパッケージ**として入ります。同じフォルダーを macOS と
> Linux（WSL2・コンテナ・リモート開発）の両方から触ると、片方が
> 「You installed esbuild for another platform than the one you're currently using」で
> 止まります。触った側で `npm install` を流し直すのが基本の直しかたです。
> 両方から使いたいなら、足りないほうを消さずに足します。
>
> ```sh
> npm install --no-save --no-package-lock --force \
>   --os=darwin --cpu=arm64 @esbuild/darwin-arm64@$(node -p "require('esbuild').version")
> ```

必要なのは **Node.js 26.5 以上**と **VS Code 1.91 以上**だけです。
開発時のTypeScriptコンパイラは **TypeScript 7.0** を使用します。
**Docker も Mind の配布物も要りません。** 標準単語辞書も、実コンパイラの `.inf` のコーパスも、
生成済みのものをコミットしてあります。

Docker が要るのは次の 2 つだけで、どちらも任意です。

| したいこと | 要るもの |
|---|---|
| 保存時に本物の Mind で検査する（`mind.compiler.enabled`） | `mind-docker:8.0.08` イメージ |
| `.inf` のコーパスを集め直す（`tools/collect-inf.sh`） | 同上 |

## VS Code で試す

### 1. F5 で開く

このリポジトリを VS Code で開き、

1. 一度だけ `npm install && npm run build`
2. **F5**（またはデバッグビューで「拡張を試す (Extension Development Host)」）

新しいウィンドウ（**Extension Development Host**）が開き、`examples/` フォルダーが
読み込まれた状態になります。ここでは拡張がソースから直接動いていて、
インストールされた拡張とは混ざりません。

`.vscode/launch.json` が次を面倒みます。

- `--extensionDevelopmentPath` を `packages/vscode-mind` に向ける
- 起動前に `npm: build` を走らせる
- `examples/` を開く（`.vscode/settings.json` で `*.src` を Mind に関連付け済み）

ターミナルから開きたい場合は同じことを手で書けます。

```sh
code --extensionDevelopmentPath="$PWD/packages/vscode-mind" examples
```

### 2. 動いているか確かめる

開発ホストのウィンドウで `examples/hello.src` を開きます。
右下の言語表示が **Mind** になっていれば拡張は有効です。

| 見るもの | 操作 | 期待 |
|---|---|---|
| ハイライト | そのまま眺める | `※` コメントが灰色、`「…」` が文字列色、`ならば` `つぎに` `繰り返す` がキーワード色 |
| 塗り分け | `一行表示` と `売り上げ計上` を見比べる | 標準ライブラリの単語と、自分で定義した単語が別の色になる（Semantic Tokens） |
| アウトライン | エクスプローラーの「アウトライン」 | `売り上げ計上` `明細を表示` `メイン` が並び、`明細を表示` を開くと局所変数 `＿見出し` と**局所処理単語** `一行分を表示` が子に出る |
| ホバー | `売り上げ計上` の上にカーソル | 種別・スタック仕様 `（金額 → ・）`・属性 `整数入力` が出る |
| ホバー（標準単語） | `一行表示` の上にカーソル | 辞書から `（文字列 → ・）` と出典ファイル名が出る |
| 定義ジャンプ | `売り上げ計上し` で **F12** | 定義行へ飛ぶ。送り仮名が違っても同じ単語として扱われる |
| 参照検索 | 同じ場所で **Shift+F12** | 引用箇所が列挙される |
| 補完 | 新しい行で `表` と打つ | `表示` `一行表示` `数値表示` … が候補に出る。いまいる定義の局所変数が最上位に来る |
| スニペット補完 | `事例` と打って確定 | `事例をとる` … `例外なら` … `事例終り` まで入る |
| リネーム | `売り上げ計上し` で **F2** → `記帳` | `記帳とは` `記帳し` `記帳する。` と、送り仮名と助詞を残したまま全部書き変わる |
| リネームの拒否 | `一行表示` で **F2** | 「このファイルで定義されていません」と理由が出る |
| 字下げ | `ならば` だけの行で **Enter**、次の行で `つぎに` と打つ | 深くなり、`つぎに` で戻る |
| 診断 | `examples/diagnostics.src` を開く | 警告が 3 つ（下記） |
| 診断が出ない例 | `examples/kidoairaku.src`（喜怒哀楽ライフゲーム）を開く | 警告 0。`近傍Ｘの　要素数を` の `要素数` にホバーすると予約語の説明が出る |

`examples/diagnostics.src` はわざと引っかけてあります。

| 行 | 出る警告 |
|---|---|
| `合計（単価　→　金額）し` | `（` の前に空白が無いのでコメントにならない |
| `二乗し` | 定義より前での参照（`仮定義` が要る） |
| `表示しないこと。` | 否定形の送り仮名は照合前に落ちるので、肯定形と同じ単語になる |

未定義単語の診断は `"x.src"を　コンパイル。` でつながるファイルを一緒に見ます。
取り込み先として読むのは**開いているワークスペースの内側のファイルだけ**です（`..` で外へ出るパスや、
外を指すシンボリックリンクは読みません）。
ただし**語彙を把握しきれないと分かったら黙ります** — 取り込み先が 1 つでも見つからない（ワークスペースの外を含む）とき、
`mind.library` が `file` 以外のとき、取り込みの関係がまったく無く `メイン` も無いとき
（＝ライブラリとして書かれた断片）。理由は [`docs/PLAN.md`](docs/PLAN.md) にあります。

### 3. 変更を反映する

| 直したもの | やること |
|---|---|
| `packages/vscode-mind/src/` | 開発ホストで **Ctrl/Cmd+R**（ウィンドウの再読み込み） |
| `packages/mind-core/` `packages/mind-language-server/` | ビルド後、コマンドパレットから **`Mind: Language Server を再起動する`** |
| `syntaxes/mind.tmLanguage.json` | 開発ホストで **Ctrl/Cmd+R** |
| `package.json` の `contributes` | F5 で開き直す |

ビルドは毎回手で打たずに watch に任せるのが楽です。

```sh
npm run watch     # tsc --build --watch
```

`@mindls/core` を直したときに Language Server が古いままなのは、
**別プロセスがすでに読み込んだコードを持っているから**です。再起動コマンドが要ります。

### 4. デバッグする

**拡張側（`extension.ts`）** — F5 で起動したデバッグセッションにそのまま乗ります。
`startLanguageServer` あたりにブレークポイントを置けば止まります。

**Language Server 側** — 別プロセスなので、アタッチが要ります。
拡張はデバッグ起動時に `--inspect=6019` 付きでサーバを立ち上げるので、

1. F5 で開発ホストを起動
2. デバッグビューで「**Language Server にアタッチ**」を実行

これで `analysis.ts` や `@mindls/core` の中で止まります。
「拡張 + Language Server をまとめてデバッグ」（compound）を選べば 1 手で両方つながります。

**やりとりを覗く** — 開発ホストの設定に次を書くと、出力パネルの
「Mind Language Server」に LSP のメッセージが流れます。

```jsonc
{ "mind.trace.server": "verbose" }
```

**サーバが起動しないとき** — 出力パネル「Mind Language Server」と、
`ヘルプ > 開発者ツールの切り替え` のコンソールを見ます。よくある原因は次の 2 つです。

| 症状 | 原因 |
|---|---|
| `Mind Language Server を起動できませんでした` | `npm run build` を忘れている（`packages/mind-language-server/dist/cli.js` が無い） |
| 言語表示が `Plain Text` のまま | `*.src` が別の言語に関連付けられている。`Mind: このワークスペースの文字コードと関連付けを設定する` を実行する |

### 5. Language Server だけを単体で動かす

VS Code を使わずに LSP を叩くこともできます。

```sh
node packages/mind-language-server/dist/cli.js --stdio
```

テストはこれを**実プロセスとして起動**して JSON-RPC を話します
（`packages/mind-language-server/test/helpers/client.ts`）。配線の間違いはここで落ちます。

### 6. .vsix を作る

配布用のパッケージは 2 手でできます。

```sh
npm run bundle     # esbuild で拡張と Language Server を 1 ファイルずつに束ねる
npm run package    # vsce package → dist/vscode-mind-<version>.vsix
```

npm workspaces では `@mindls/language-server` が node_modules のシンボリックリンクになっていて、
vsce はこれを .vsix に入れられません。そこで **esbuild で束ねてから包みます**。
辞書はバンドルに含めず、`distributions.json` と `stdlib/<配布物>.json` として隣に置き、
Language Server がリンク → 隣のファイルの順で探します。

できた .vsix は VS Code の拡張ビューの `…` → 「VSIX からのインストール」で入れられます。

### 7. Marketplace に公開する

#### リリース手順（2 回目以降）

```sh
# 1. 出すものを確かめる
npm run typecheck && npm test
npm run package                     # dist/vscode-mind-<version>.vsix

# 2. 1 コミットにまとめてタグを打つ
git add -A
git commit -m "vscode-mind 0.1.1 をリリース."
git tag v0.1.1
git push origin main --tags

# 3. 確かめたその .vsix を送る
npx vsce publish --packagePath dist/vscode-mind-0.1.1.vsix
```

出す前に見るところ。

| | |
|---|---|
| `packages/vscode-mind/package.json` の `version` | 上げてあるか |
| `CHANGELOG.md`（ルートと `packages/vscode-mind/`） | **2 つある。両方**に同じ内容が要る（.vsix に入るのは後者） |
| `README.md`（ルートと `packages/vscode-mind/`） | 設定の既定値が実装と合っているか |
| `npm run package` の出力 | `dist/`（`distributions.json` と `stdlib/<配布物>.json` を含む）`syntaxes/` `icon.png` `readme.md` `changelog.md` `LICENSE.txt` の 14 ファイル |

> **バージョンは `vsce publish patch` でも上げられます**が、これは `npm version` を呼ぶので
> **コミットとタグが自動で増えます**。1 PR = 1 コミットにまとめたいときは、
> 上のように自分で `version` を書き換えてから `--packagePath` で送るほうが扱いやすいです。

#### はじめて公開するとき

`.vsix` を配るだけなら publisher ID は要りませんが、Marketplace に載せるなら要ります。
ID は**あとから変更できません**。拡張の URL に入るので慎重に決めてください。

1. **Azure DevOps の組織を作る**（Microsoft アカウントが要ります）
   <https://aex.dev.azure.com/>
2. **Personal Access Token を発行する**
   User settings → Personal access tokens → New Token
   - Organization: **All accessible organizations**（特定の組織を選ぶと弾かれます）
   - Scopes: Custom defined → Show all scopes → **Marketplace: Manage**
   - 発行直後にしか表示されないので、その場で控える
3. **パブリッシャーを作る** <https://marketplace.visualstudio.com/manage>
   PAT と同じ Microsoft アカウントで入り、「Create publisher」。ID と表示名を入れる
4. **`packages/vscode-mind/package.json` の `publisher` を、作った ID に直す**
5. 公開する

```sh
npx vsce login <publisher id>   # PAT を聞かれる。どこで実行してもよい
npm run package                 # dist/*.vsix を作って中身を確認する
npx vsce publish --packagePath dist/vscode-mind-<version>.vsix
```

`--packagePath` を使うと、**確認したその .vsix をそのまま送れます**（マニフェストは
.vsix の中から読むので、リポジトリのどこで実行しても構いません）。
作り直しながら出すなら次でも同じです。

```sh
npm run release      # = npm run release -w vscode-mind = vsce publish --no-dependencies
```

> `vsce` はサブコマンドに拡張のパスを取りません。`vsce publish <何か>` の引数は
> **バージョン**（`patch` `minor` `1.0.0`）と解釈されます。パスを渡すと、そのまま
> リポジトリのルートの `package.json` を読みにいき
> 「Missing vscode engine compatibility version」になります。
> パスで指したいときは `--packagePath`、拡張のフォルダーで実行したいときは
> `cd packages/vscode-mind && npx vsce publish --no-dependencies` です。

> **2026年12月1日に Azure DevOps のグローバル PAT が廃止されます。**
> CI から公開するなら、PAT ではなく Microsoft Entra ID（`vsce publish --azure-credential`）に
> 寄せておくのが無難です。

`vsce` は公開時に次を弾きます。いまの構成はどれにも触れていません。

- `icon` が SVG
- `README.md` / `CHANGELOG.md` の画像が https で解決できない（相対パスは repository から補完されます）
- パッケージに秘密情報らしき文字列が混ざっている

### 8. 文字コードについて

本物の Mind のソースは **EUC-JP**（Linux 版）または **Shift_JIS**（Windows 版）です。
VS Code の既定は UTF-8 なので、そのまま開くと日本語が化けます。

`examples/` のサンプルは読みやすさを優先して UTF-8 にしてあり、
`examples/.vscode/settings.json` でそう指定しています。
自分の Mind プロジェクトで使うときは、コマンドパレットから

```
Mind: このワークスペースの文字コードと関連付けを設定する
```

を実行してください。`files.encoding` を Mind 言語スコープで設定し、`*.src` を Mind に関連付けます。

Language Server は VS Code から UTF-8 のテキストを受け取るので、
**解析そのものは文字コードに依存しません。**
変換が要るのは実コンパイラ連携のときだけで、それもコンテナの中の `iconv` にやらせています。

## 設定

| 設定 | 既定 | 内容 |
|---|---|---|
| `mind.distribution` | `windows-9` | 使っている Mind の配布物（`windows-9` / `linux-8`）。標準単語の辞書と、文字コード設定コマンドの既定が切り替わる |
| `mind.library` | `file` | リンクする標準ライブラリ |
| `mind.diagnostics.undefinedWords` | `true` | 定義されていない単語を指摘する。`コンパイル` でつながるファイルは一緒に見る |
| `mind.diagnostics.forwardReferences` | `true` | 定義より前での参照を指摘する |
| `mind.diagnostics.negativeForms` | `true` | 否定形の送り仮名を指摘する |
| `mind.diagnostics.commentParens` | `true` | 空白不足で成立していない `（ ）` コメントを指摘する |
| `mind.compiler.enabled` | `false` | 保存時に本物の Mind コンパイラで検査する（Docker が要る） |
| `mind.compiler.docker.image` | `mind-docker:8.0.08` | そのときに使うイメージ |
| `mind.trace.server` | `off` | LSP のやりとりを出力パネルに記録する |

## アイコン

`packages/vscode-mind/icon.png` は `tools/gen-icon.py` が唯一の出どころです
（Marketplace のアイコンは PNG しか受け付けないため）。直すときはスクリプトを直して

```sh
python3 tools/gen-icon.py
```

## 標準単語辞書と配布物の定義

標準単語辞書は Mind の配布物ごとに 1 つあり、`mind.distribution` で選びます。

| ファイル | 中身 |
|---|---|
| `packages/mind-core/data/distributions.json` | 配布物の定義（ID・別名・文字コード・アーカイブ名・**配布物の中の置き場所**） |
| `packages/mind-core/data/stdlib/windows-9.json` | Mind 9 for Windows の辞書 |
| `packages/mind-core/data/stdlib/linux-8.json` | Mind 8 for Linux の辞書 |

辞書は配布物から生成したもので、**生成物ですがコミットしてあります**。
拡張の利用者にも CI にも配布物は要りません。

```sh
# 配布物を vendor/ に置いてから（再配布しないので Git 管理外）
#   vendor/mind-for-windows-9.04.zip
#   vendor/mind-for-linux-8.0.08.tgz
npm run gen:stdlib                                     # 見つかった配布物すべて
node tools/gen-stdlib-dict.ts --dist windows-9         # 1 つだけ
node tools/gen-stdlib-dict.ts --dist windows-9 --archive path/to/mind-for-windows-9.05.zip
node tools/extract-samples.ts                          # 公式サンプルを fixtures/mind-samples/ に展開（テスト用）
```

内訳は標準ライブラリ `file/*.src` とカーネル組み込み単語表 `kernel/c_words*.wrd` の両方です。
後者を入れないと `捨て` `複写` `真？` といったごく普通の単語まで未定義に見えます。

### 新しい版の配布物が出たら

Mind は言語としては後方互換ですが、ライブラリの単語やソースの置き場所は版ごとに動きます
（トップディレクトリは `pmind/` → `Mind9/`、`asmword.src` が取り込むカーネル単語表は
`../kernelF/` → `../kernelK/`、文字コードは EUC-JP → Shift_JIS）。
その差はコードではなく `distributions.json` に寄せてあります。

1. **同じ系列の改訂版**（9.04 → 9.05 など）: `vendor/` に置いて `npm run gen:stdlib` するだけです。
   アーカイブ名はパターン（`mind-for-windows-9.*.zip`）で探し、版のいちばん新しいものを使います
2. **中の置き場所が変わった**: `layout` のパターンを直します。配布物のルートは
   `marker`（`file/asmword.src` など）を含むいちばん浅いディレクトリとして探すので、
   トップディレクトリの名前が変わっただけなら直さなくて構いません。パターンは和集合で展開するので、
   新旧の場所を両方並べておいても害はありません
3. **新しい系列**（Mind 10 など）: `distributions` に 1 項目足し、`package.json` の
   `mind.distribution` の `enum` に加えます

`npm test` は、定義にあるすべての配布物に辞書がそろっていること、展開したサンプルがあれば
既定の診断がそれらに対して黙っていることを確かめます。

実処理系を動かしたい場合は [Mind-Docker](https://github.com/shin3tky/Mind-Docker) を使います。

## ライセンス

Apache-2.0
