# MindLS

日本語プログラミング言語 [Mind](https://www.scripts-lab.co.jp/mind/whatsmind.html)（Scripts Lab Inc.）の
Language Server と VS Code 拡張。

開発計画は [`docs/PLAN.md`](docs/PLAN.md)、実処理系との結合方針は
[`docs/COMPILER-BACKEND.md`](docs/COMPILER-BACKEND.md)。

## 構成

| パッケージ | 役割 |
|---|---|
| `@mindls/core` | 正規化・レキサ・パーサ・シンボルテーブル・診断。エディタ非依存 |
| `@mindls/compiler` | 実 Mind コンパイラを叩くアダプタ（オプトイン・未実装） |
| `@mindls/language-server` | LSP 本体（stdio） |
| `vscode-mind` | VS Code 拡張 |

## セットアップ

```sh
npm install
npm run build     # 全パッケージを dist/ へ
npm test          # Vitest
npm run typecheck
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
| アウトライン | エクスプローラーの「アウトライン」 | `売り上げ計上` `明細を表示` `メイン` が並び、`明細を表示` を開くと局所変数 `＿見出し` と**局所処理単語** `一行分を表示` が子に出る |
| ホバー | `売り上げ計上` の上にカーソル | 種別・スタック仕様 `（金額 → ・）`・属性 `整数入力` が出る |
| ホバー（標準単語） | `一行表示` の上にカーソル | 辞書から `（文字列 → ・）` と出典ファイル名が出る |
| 定義ジャンプ | `売り上げ計上し` で **F12** | 定義行へ飛ぶ。送り仮名が違っても同じ単語として扱われる |
| 参照検索 | 同じ場所で **Shift+F12** | 引用箇所が列挙される |
| 補完 | 新しい行で `表` と打つ | `表示` `一行表示` `数値表示` … が候補に出る。いまいる定義の局所変数が最上位に来る |
| スニペット補完 | `事例` と打って確定 | `事例をとる` … `例外なら` … `事例終り` まで入る |
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

### 6. 文字コードについて

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
