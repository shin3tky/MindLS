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
| 診断 | 構文の対応ミス、定義より前での参照、否定形の送り仮名、成立していない `（ ）` コメント |

## Mind の書きかたに合わせてあります

- **送り仮名は照合の前に落とされます。** `繰り返す` `繰り返し` `繰返し` は同じ単語です。
  この拡張も同じ規則で単語を畳むので、表記が揺れていてもジャンプも参照も効きます
- **区切りは TAB・空白（半角/全角）・カンマ（半角/全角）・読点だけ**です。
  `赤い色で表示する` は 1 単語として扱われます
- `（ ）` は**両端に空白があるときだけ**コメントです。無ければ配列の添字になります
- トップレベルの `終り。` から先はコンパイルされないので、灰色で表示します

## はじめに

Mind のソースは **EUC-JP**（Linux 版）または **Shift_JIS**（Windows 版）です。
VS Code の既定は UTF-8 なので、フォルダーを開いたらコマンドパレットから
**`Mind: このワークスペースの文字コードと関連付けを設定する`** を実行してください。
`files.encoding` を Mind 言語スコープで設定し、`*.src` を Mind に関連付けます。

## 設定

| 設定 | 既定 | 内容 |
|---|---|---|
| `mind.library` | `file` | リンクする標準ライブラリ |
| `mind.diagnostics.undefinedWords` | `false` | 定義されていない単語を指摘する |
| `mind.diagnostics.forwardReferences` | `true` | 定義より前での参照を指摘する |
| `mind.diagnostics.negativeForms` | `true` | 否定形の送り仮名を指摘する |
| `mind.diagnostics.commentParens` | `true` | 空白不足で成立していない `（ ）` コメントを指摘する |
| `mind.trace.server` | `off` | Language Server とのやりとりを出力パネルに記録する |

`mind.diagnostics.undefinedWords` が既定で無効なのは、`"x.src"を　コンパイル。` で
取り込む他ファイルの単語をまだ追えないためです。1 ファイルで完結するプログラムなら
有効にして構いません。

## 既知の制限

- 複数ファイルにまたがるシンボル解決は未対応です
- 実 Mind コンパイラによる検査は未実装です（[Mind-Docker](https://github.com/shin3tky/Mind-Docker) を使う予定）
- 全文フォーマッタはありません（入力中の字下げのみ）

## ライセンス

Apache-2.0 — [shin3tky/MindLS](https://github.com/shin3tky/MindLS)

Mind は Scripts Lab Inc. の製品です。この拡張は非公式で、同社とは関係ありません。
