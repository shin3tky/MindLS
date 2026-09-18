# 実 Mind コンパイラとの結合

Language Server が実処理系をどう使うか、そして**どこまで使わないか**を決めた文書。

---

## 0. 結論

**MindLS は Mind の Docker 環境のソースを持たない。** 処理系は
[Mind-Docker](https://github.com/shin3tky/Mind-Docker) が提供し、
MindLS はそのイメージと CLI 契約だけに依存する。

依存の範囲はここまで。

| いつ | Docker | 何のため |
|---|---|---|
| 辞書生成（`npm run gen:stdlib`） | **不要** | 配布物 (`.tgz`) から直接取り出す |
| `.inf` コーパスの収集（`tools/collect-inf.sh`） | 必要（手で 1 回） | 書式の確定と、診断の答え合わせ。結果はコミットしてある |
| 実コンパイラ診断（`mind.compiler.enabled`） | 必要（**既定は無効**） | `.inf` を読んで診断を出す |
| テスト（`npm test`） | **不要** | 要るものはすべて生成物としてコミットしてある |
| 拡張の利用者 | **不要** | 自前解析だけで完結する |

> **拡張の利用者に Docker を要求してはいけない。**
> そのために、Docker から取り出したものは生成物としてコミットし、以後は Docker 無しで回す。

---

## 1. 前提

Mind 8 for Linux の配布物は **x86 32bit** バイナリで、ソースと入出力は **EUC-JP**。
Windows 版（Version 9）は Shift_JIS。Linux 版は Version 8 が最新で、**Version 9 に Linux 版は無い**。

Mind-Docker は 64bit OS 上に 32bit の glibc / libgcc を入れる公式手順どおりの構成で、
Windows 11 + WSL2 / macOS (Apple Silicon) / x86_64 Linux で動作確認済み。

## 2. セットアップ

```sh
git clone https://github.com/shin3tky/Mind-Docker.git ../Mind-Docker
cd ../Mind-Docker
# vendor/mind-for-linux-8.0.08.tgz を配置（vendor/README.md 参照）
make doctor && make build && make selftest
```

これで `mind-docker:8.0.08` イメージができる。MindLS 側はこのタグを見る。

| 設定 | 既定 |
|---|---|
| `MIND_DOCKER_IMAGE` | `mind-docker:8.0.08` |
| VS Code 設定 `mind.compiler.docker.image` | 同上 |

---

## 3. LSP が依存する契約

**`mindc` は使わない。** `mindc` は開発者向けのラッパーで、ソースディレクトリの `*.src` を
まとめて変換し `.mindbuild/` と成果物を作る。LSP がこれを呼ぶとユーザーのワークスペースを汚す。

依存するのは、もう一段下のこれだけ。

| 契約 | 値 |
|---|---|
| Mind 一式の場所 | `/opt/mind/pmind` |
| コンパイラ | `mind <base> <library>`（`PATH` に入っている） |
| ライブラリ | `/opt/mind/pmind/lib/{file,file2,fileg,cgilib,socketlib}.{mco,sym}` |
| 環境変数 | `MLIBPATH=/opt/mind/pmind/lib`, `LANG=ja_JP.eucJP` |
| ソースの文字コード | EUC-JP |
| エラー出力 | `<base>.inf`（**文法エラー時のみ生成**） |

LSP は**コンテナの中の**一時領域に EUC-JP のソースを写し、そこで `mind` を叩き、`.inf` を読む。
UTF-8 → EUC-JP の変換もコンテナの中の `iconv` にやらせる（§4「文字コード」）。
生成物 (`.exe` / `.mco` / `.sym` / `.his`) はすべてその一時領域に落ちるうえ、
ワークスペースは読み取り専用でマウントしてあるので、ユーザーのフォルダーには何も残らない。

### `.inf` の注意

- **文法エラーがあったときだけ生成される。** 前回の残骸があると誤検出するので、実行前に必ず消す
- **開いたまま再コンパイルするとアクセス競合で失敗する**（公式に明記）。
  コンテナの中で `cat` して持ち帰る形にしてあるので、ハンドルを持ち続けることがない
- **エラーの有無は終了コードで判定してよい**（実物で確認済み。エラーが無ければ `.inf` は出ず、
  終了コードは 0）

---

## 4. `.inf` の読みかた — 実物で確かめた

> **訂正。** 当初この章は「`.inf` の位置情報は EUC-JP のバイトオフセットなので、
> UTF-16 位置への逆変換テーブルが要る」と書いていた。**これは誤りだった。**
> 実物を集めたところ（`fixtures/inf-corpus/`）、**`.inf` に桁は入っていない。**
> 逆変換テーブルは不要で、位置は別の方法で決める。

### 書式

```
undefined-word.src 3 行目でエラー。行内容は、
	まったく存在しない単語し
      要因１："まったく存在しない単語"は未定義の単語です。

1 個のエラーが有ります。
```

| 分かったこと | 効いてくるところ |
|---|---|
| **桁は無い。** 行番号・その行の内容そのまま・要因、の 3 つだけ | 逆変換テーブルが丸ごと不要になった |
| 1 つの行に**要因が複数**付く（`要因１` `要因２`） | 診断は要因ごとに 1 件出す |
| 末尾の「N 個のエラー」の N は**要因の総数** | 件数の突き合わせに使える |
| 複数のエラーは**すべて**報告される（最初の 1 件で止まらない） | 1 回のコンパイルで全部拾える |
| 引用される語は**末尾の送り仮名を落とした形**（`存在しない単語ひとつめし` → `"存在しない単語"`） | 桁を求めたあと、ひらがなが続くあいだ範囲を伸ばす |
| 要因によっては語を引用しない（「条件分岐や繰り返し文をアンバランスに使っています。」） | その場合は行全体を指す |
| エラーが無ければ `.inf` は**生成されない**。終了コードも 0 | 有無の判定は終了コードで足りる |

### 位置の決めかた

1. `.inf` を EUC-JP から UTF-8 に復号する
2. 行番号を取る（1 始まり → 0 始まり）
3. 要因が語を引用していれば、**その行の中から探す**。見つかった位置が桁
4. 語の末尾から、ひらがなが続くあいだ範囲を伸ばす（`.inf` は語幹しか出さないため）
5. 引用が無ければ、行の空白を除いた範囲を指す

行番号は EUC-JP の影ソースのものだが、変換は 1 行ずつの写しなので利用者の UTF-8 ソースと
一対一に対応する。念のため、コンパイラが echo し返した行の内容と突き合わせ、
食い違っていたら桁を諦めて行全体を指す（`inf.ts` の `toDiagnostics`）。

`offset.src` という見本を 1 本、桁の数えかたを見分けるためだけに置いてある。
エラーの語の前に全角・半角・記号を混ぜてあり、報告が `36`（文字数）か
`68`（EUC-JP バイト）か `100`（UTF-8 バイト）かで判別できる。**実測は 36** だった
— というより、そもそも桁は報告されず、我々が行の中を探して 36 を得ている。

### 文字コード

EUC-JP への変換自体はいまも必要（コンパイラは EUC-JP しか読まない）。

- **EUC-JP へのエンコードは Node に無い。** `TextDecoder('euc-jp')` で**復号はできる**が、
  `TextEncoder` は UTF-8 しか出せない。
  → **変換はコンテナの中の `iconv` にやらせることにした**ので、`iconv-lite` は要らなくなった。
  こちら側でやるのは `.inf` と出力の**復号**だけで、それは Node の `TextDecoder` で足りる
- EUC-JP に無い文字（絵文字など）はそもそも Mind のソースとして無効。
  ここは握り潰さず、その行を「変換不能」として診断に出す
- 変換は 1 行ずつの写しにする。行を足したり削ったりしないかぎり、行番号はそのまま使える

---

## 5. 起動コスト — 常駐コンテナ + `docker exec`

`docker run` は毎回コンテナを作る。保存のたびに叩くには重い（Apple Silicon では amd64 が
エミュレーションになるぶん、なおさら）。**常駐コンテナに `docker exec` する。**

```
# 最初の診断のときに 1 度だけ
docker run --detach --platform linux/amd64 \
    --volume <ワークスペース>:/mindls/workspace:ro \
    --workdir /mindls/workspace \
    mind-docker:8.0.08 sleep infinity

# 以降は exec だけ
docker exec <id> bash -c '<変換してコンパイルして結果を返すスクリプト>'
```

- **ワークスペースは読み取り専用**でマウントする。生成物（実行ファイル・`.mco`・`.sym`・`.his`）で
  ユーザーのフォルダーを汚さない。コンパイルはコンテナ内の一時領域でおこなう
- コンテナが落ちていたら（`No such container` / `is not running`）、**1 度だけ起動し直して再試行**する
- `shutdown` で `docker rm -f` する
- **保存時のみ**に限ること。打鍵ごとの補完・ホバーは自前解析だけで完結させる

コンテナの中で走らせるスクリプトは、出力を目印（`MINDLS-STATUS:` など）で区切って
**終了コード・コンパイラの出力・`.inf` を一度に持ち帰る**。`docker exec` を何度も往復すると、
そのぶん遅くなるため。

---

## 6. アダプタの形

```ts
// packages/mind-compiler/src/adapter.ts
export interface MindCompiler {
  /** 文法チェックだけおこない、診断を返す */
  check(input: CompileInput): Promise<CompileResult>;
  dispose(): Promise<void>;
}

export interface CompileInput {
  /** コンパイルするソースの絶対パス。中身ではなくパスを渡す */
  readonly path: string;
  readonly library: string;
}
```

**中身ではなくパスを渡す。** 保存時にだけ走らせるのでディスクの内容が最新であり、
パスで渡せば同じフォルダーにある `"x.src"を　コンパイル。` の取り込み先もそのまま解決する。

| 実装 | いつ使うか |
|---|---|
| `NullCompiler` | **既定**。`mind.compiler.enabled` が `false` のとき。常に空の診断を返す |
| `DockerCompiler` | 有効にしたとき。Mind-Docker のイメージを使う |

`DockerCompiler` は `docker` の呼び出しを差し替えられる（`run` オプション）。
コンテナの起動・再起動・後始末・`.inf` の復号までを、本物の Docker 無しで試せるようにしてある。

**うまくいかないときは黙らない。** イメージが無い、コンテナが起動できない、
ファイルがワークスペースの外にある——といった事情は、その旨を**警告として診断に出す**。
設定したのに何も起きないと、効いていないのか、エラーが無いのかが分からない。

（ホストに `pmind` を直接入れて使う `LocalCompiler` は作っていない。
Linux / WSL2 なら動くはずだが、需要が見えてからでよい）

---

## 7. 辞書の生成（Docker 不要）

標準ライブラリのソース `pmind/file/*.src` は配布物に同梱されているので、
**tgz から直接読める**。Docker を起動する必要はない。

```sh
npm run gen:stdlib                                   # vendor/ と ../Mind-Docker/vendor/ を見る
node tools/gen-stdlib-dict.ts --dist linux-8 --archive <path>
node tools/gen-stdlib-dict.ts --dist linux-8 --dir <展開した配布物>
```

出力は `packages/mind-core/data/stdlib/<配布物>.json`。**生成物だがコミットする。**
配布物ごとの置き場所と文字コードは `packages/mind-core/data/distributions.json` にある
（0.1.0 から。Mind 9 for Windows の zip も同じ手順で読む）。
これで拡張の利用者にも CI にも Mind の配布物は要らなくなる。

---

## 8. 参考

- [Mind-Docker](https://github.com/shin3tky/Mind-Docker) — 処理系の Docker 環境（README に構築手順と検証結果）
- [Mind オペレーションマニュアル（Version 8・Linux）](https://www.scripts-lab.co.jp/mind/ver8/doc/operation-1b-Install-linux.html)
- [Mind プログラミングマニュアル（基礎編）](https://www.scripts-lab.co.jp/mind/ver9/doc/indexBase.html)
