# Mind for VS Code

日本語プログラミング言語 [Mind](https://www.scripts-lab.co.jp/mind/whatsmind.html)（Scripts Lab Inc.）を
VS Code で書くための拡張です。**Mind の配布物も Docker も要りません。**

## できること

| | |
|---|---|
| ハイライト | 構文ハイライトに加え、Semantic Tokens で**自分の単語と標準ライブラリの単語を塗り分け**ます |
| アウトライン | 定義の下に局所変数と局所処理単語がぶら下がります |
| 定義ジャンプ / 参照 | `反応し` の上で F12 を押すと `反応する` の定義に飛びます |
| 補完 | 局所変数 → このファイルの定義 → 制御構文 → スニペット → 標準単語の順 |
| ホバー | 種別・スタック仕様・属性。標準単語なら出典のファイル名まで |
| リネーム | `売り上げ計上し` を `記帳` にすると `記帳し` に。送り仮名と助詞は残ります |
| 診断 | 構文の対応ミス、未定義の単語、定義より前での参照、否定形の送り仮名、成立していない `（ ）` コメント |
| 実コンパイラ | 保存したときに本物の Mind に通して検査（任意・Docker が要る） |

## Mind の書きかたに合わせてあります

- **送り仮名は照合の前に落とされます。** `繰り返す` `繰り返し` `繰返し` は同じ単語です。
  この拡張も同じ規則で単語を畳むので、表記が揺れていてもジャンプも参照も効きます
- **区切りは TAB・空白（半角/全角）・カンマ（半角/全角）・読点だけ**です。
  `赤い色で表示する` は 1 単語として扱われます
- `（ ）` は**両端に空白があるときだけ**コメントです。無ければ配列の添字になります
- トップレベルの `終り。` から先はコンパイルされないので、灰色で表示します

## はじめに

使っている Mind に合わせて **`mind.distribution`** を選んでください。
標準単語の辞書（補完・ホバー・未定義単語の診断）が切り替わります。

| `mind.distribution` | 配布物 | ソースの文字コード |
|---|---|---|
| `windows-9`（既定） | Mind 9 for Windows | Shift_JIS |
| `linux-8` | Mind 8 for Linux | EUC-JP |

VS Code の既定は UTF-8 なので、フォルダーを開いたらコマンドパレットから
**`Mind: このワークスペースの文字コードと関連付けを設定する`** を実行してください。
`files.encoding` を Mind 言語スコープで設定し、`*.src` を Mind に関連付けます
（`mind.distribution` に合った文字コードが最初の候補に出ます）。

## 複数ファイルのプログラム

`"x.src"を　コンパイル。` でつながるファイルは一緒に見ます。取り込まれる側を開いていても、
取り込む側の単語が見えます。

未定義単語の診断は、**語彙を把握しきれないと分かったら黙ります**。

- 取り込み先のファイルが 1 つでも見つからないとき
- `mind.library` が `file` 以外のとき（その語彙の辞書を持っていないため）
- 取り込みの関係がまったく無く `メイン` も無いとき（＝ライブラリとして書かれた断片）

見えていないものを「未定義」と呼ぶのは誤検出でしかないので、黙るほうを選んでいます。

## 本物のコンパイラに通す（任意）

`mind.compiler.enabled` を `true` にすると、**保存したとき**に Docker の中の本物の Mind に
通して検査します。単語の有無・型・助詞など、静的解析では届かないところまで見てくれます。

イメージは [Mind-Docker](https://github.com/shin3tky/Mind-Docker) で作ります。

```sh
git clone https://github.com/shin3tky/Mind-Docker.git
cd Mind-Docker && make build     # mind-docker:8.0.08 ができる
```

打鍵のたびには走りません（重すぎます）。コンテナは常駐させて使い回し、
ワークスペースは読み取り専用で渡すので、生成物でフォルダーが汚れることはありません。

## 設定

| 設定 | 既定 | 内容 |
|---|---|---|
| `mind.distribution` | `windows-9` | 使っている Mind の配布物（`windows-9` / `linux-8`）。標準単語の辞書が切り替わる |
| `mind.library` | `file` | リンクする標準ライブラリ |
| `mind.diagnostics.undefinedWords` | `true` | 定義されていない単語を指摘する |
| `mind.diagnostics.forwardReferences` | `true` | 定義より前での参照を指摘する |
| `mind.diagnostics.negativeForms` | `true` | 否定形の送り仮名を指摘する |
| `mind.diagnostics.commentParens` | `true` | 空白不足で成立していない `（ ）` コメントを指摘する |
| `mind.compiler.enabled` | `false` | 保存時に本物の Mind コンパイラで検査する（Docker が要る） |
| `mind.compiler.docker.image` | `mind-docker:8.0.08` | そのときに使うイメージ |
| `mind.trace.server` | `off` | Language Server とのやりとりを出力パネルに記録する |

## 既知の制限

- `guilib`（GUI 編）の語彙は入っていません。基本セットには GUI ライブラリのソースが
  同梱されていないためです。GUI のプログラムでは `mind.library` を `guilib` にしてください
  （未定義単語の診断が黙ります）
- 実コンパイラ連携（`mind.compiler.enabled`）は Mind 8 for Linux の Docker イメージを使います。
  Mind 9 for Windows にしか無い単語は、そちらではエラーになります
- 全文フォーマッタはありません（入力中の字下げのみ）。
  Mind には字下げの流儀が複数あり、整形すると既存のソースに大きな差分が出るためです
- `条件コンパイル` の条件は評価しません。その配下の取り込みも「取り込み」として数えます

## ライセンス

Apache-2.0 — [shin3tky/MindLS](https://github.com/shin3tky/MindLS)

Mind は Scripts Lab Inc. の製品です。この拡張は非公式で、同社とは関係ありません。
