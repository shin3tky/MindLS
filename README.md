# MindLS

日本語プログラミング言語 [Mind](https://www.scripts-lab.co.jp/mind/whatsmind.html)（Scripts Lab Inc.）の
Language Server と VS Code 拡張。

開発計画は [`docs/PLAN.md`](docs/PLAN.md)、実処理系との結合方針は
[`docs/COMPILER-BACKEND.md`](docs/COMPILER-BACKEND.md)。

## 構成

| パッケージ | 役割 |
|---|---|
| `@mindls/core` | 正規化・レキサ・パーサ・シンボルテーブル・診断・リネーム・Semantic Tokens。エディタ非依存 |
| `@mindls/compiler` | 実 Mind コンパイラを叩くアダプタ（オプトイン・未実装） |
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

必要なのは **Node.js 22 以上**と **VS Code 1.90 以上**だけです。
**Docker も Mind の配布物も要りません。** 標準単語辞書は生成済みのものをコミットしてあります。

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

`examples/diagnostics.src` はわざと引っかけてあります。

| 行 | 出る警告 |
|---|---|
| `合計（単価　→　金額）し` | `（` の前に空白が無いのでコメントにならない |
| `二乗し` | 定義より前での参照（`仮定義` が要る） |
| `表示しないこと。` | 否定形の送り仮名は照合前に落ちるので、肯定形と同じ単語になる |

未定義単語の診断は**既定で無効**です。開発ホストの設定で有効にすると挙動を見られます。

```jsonc
// examples/.vscode/settings.json
{
  "mind.diagnostics.undefinedWords": true
}
```

`"x.src"を　コンパイル。` で取り込む他ファイルの単語をまだ追えないため、
複数ソースに分かれたプログラムでは誤検出になります。既定値の理由は
[`docs/PLAN.md` の M5](docs/PLAN.md) にあります。

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
npm run package    # vsce package → dist/vscode-mind-0.0.1.vsix
```

npm workspaces では `@mindls/language-server` が node_modules のシンボリックリンクになっていて、
vsce はこれを .vsix に入れられません。そこで **esbuild で束ねてから包みます**。
辞書はバンドルに含めず `stdlib.json` として隣に置き、Language Server が
リンク → 隣のファイルの順で探します。

できた .vsix は VS Code の拡張ビューの `…` → 「VSIX からのインストール」で入れられます。

### 7. Marketplace に公開する

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
npx vsce publish --packagePath dist/vscode-mind-0.0.1.vsix
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

バージョンを上げて出すときは `npx vsce publish minor` のように渡します
（`package.json` の更新と git のタグ付けまでやってくれます）。

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
変換が要るのは実コンパイラ連携（オプトイン・未実装）のときだけです。

## 設定

| 設定 | 既定 | 内容 |
|---|---|---|
| `mind.library` | `file` | リンクする標準ライブラリ |
| `mind.diagnostics.undefinedWords` | `false` | 定義されていない単語を指摘する |
| `mind.diagnostics.forwardReferences` | `true` | 定義より前での参照を指摘する |
| `mind.diagnostics.negativeForms` | `true` | 否定形の送り仮名を指摘する |
| `mind.diagnostics.commentParens` | `true` | 空白不足で成立していない `（ ）` コメントを指摘する |
| `mind.compiler.enabled` | `false` | 保存時に実 Mind コンパイラで検査する（Docker が要る・未実装） |
| `mind.compiler.docker.image` | `mind-docker:8.0.08` | 実コンパイラ連携に使うイメージ |
| `mind.trace.server` | `off` | LSP のやりとりを出力パネルに記録する |

## アイコン

`packages/vscode-mind/icon.png` は `tools/gen-icon.py` が唯一の出どころです
（Marketplace のアイコンは PNG しか受け付けないため）。直すときはスクリプトを直して

```sh
python3 tools/gen-icon.py
```

## 標準単語辞書

`packages/mind-core/data/stdlib.json` は Mind の配布物から生成したもので、
**生成物ですがコミットしてあります**。拡張の利用者にも CI にも配布物は要りません。

```sh
npm run gen:stdlib   # 再生成（Mind の配布物が要る。Docker は不要）
```

内訳は標準ライブラリ `pmind/file/*.src` とカーネル組み込み単語表
`pmind/kernel/c_words*.wrd` の両方です。後者を入れないと `捨て` `複写` `真？` といった
ごく普通の単語まで未定義に見えます。

実処理系を動かしたい場合は [Mind-Docker](https://github.com/shin3tky/Mind-Docker) を使います。

## ライセンス

Apache-2.0
