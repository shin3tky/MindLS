# 実 Mind コンパイラとの結合

Language Server が実処理系をどう使うか、そして**どこまで使わないか**を決めた文書。
`docs/DOCKER.md` を置き換える。

---

## 0. 結論

**MindLS は Mind の Docker 環境のソースを持たない。** 処理系は
[Mind-Docker](https://github.com/shin3tky/Mind-Docker) が提供し、
MindLS はそのイメージと CLI 契約だけに依存する。

依存の範囲はここまで。

| いつ | Docker | 何のため |
|---|---|---|
| 辞書生成 | **不要** | 配布物 (`.tgz`) から直接取り出す |
| 正規化の差分テスト | 必要（任意実行） | 実コンパイラとの答え合わせ |
| M5 の実コンパイラ診断 | 必要（**オプトイン**） | `.inf` を読んで診断を出す |
| 拡張の利用者 | **不要** | 自前解析だけで MVP は成立する |

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

LSP は一時ディレクトリに EUC-JP のソースを書き、そこで `mind` を叩き、`.inf` を読む。
生成物 (`.exe` / `.mco` / `.sym` / `.his`) はすべて一時ディレクトリに落ちるので、
ユーザーのワークスペースには何も残らない。

### `.inf` の注意

- **文法エラーがあったときだけ生成される。** 前回の残骸があると誤検出するので、実行前に必ず消す
- **開いたまま再コンパイルするとアクセス競合で失敗する**（公式に明記）。読み終えたら必ず閉じる

---

## 4. 文字コードとオフセットの逆変換 — ここが実装の核

`.inf` の位置情報は **EUC-JP のバイトオフセット**で、LSP が返すべきなのは
**UTF-16 コードユニットの位置**。この変換を取り違えると、診断がずれた場所に出る。

**変換はラッパーに任せず、`@mindls/compiler` が自分でおこなう。** 自分で変換すれば、
書き出しと同時に「UTF-8 の文字位置 ↔ EUC-JP のバイト位置」の対応表をその場で作れる。
外部コマンドに投げると、この対応表が作れない。

```
エディタ上の UTF-16 位置
   ↕  （TextDocument が持つ）
UTF-8 の文字位置
   ↕  ← @mindls/compiler の offset-map が持つ
EUC-JP のバイト位置  ← .inf が返してくるのはこれ
```

実装メモ:

- **EUC-JP へのエンコードは Node に無い。** `TextDecoder('euc-jp')` で**復号はできる**が、
  `TextEncoder` は UTF-8 しか出せない。符号化には `iconv-lite`（純 JS・テーブル同梱）を使う
- 行ごとにエンコードし、行頭のバイトオフセットを配列で持てば、逆変換は二分探索で済む
- EUC-JP に無い文字（絵文字など）はそもそも Mind のソースとして無効。
  ここは握り潰さず、その行を「変換不能」として診断に出す

---

## 5. 起動コスト

`docker compose run` / `docker run` は毎回コンテナを作る。保存のたびに叩くには重い。

**常駐コンテナ + `docker exec` を既定にする。** コンテナのライフサイクルは
`@mindls/compiler` の Docker アダプタが持ち、最初の診断で起動し、終了時に落とす。

```
docker run -d --rm --name mindls-<workspace-hash> \
    -v <tmpdir>:/work -w /work mind-docker:8.0.08 sleep infinity
docker exec mindls-<...> mind hello file
```

Apple Silicon では amd64 がエミュレーションになるぶん遅い。**保存時のみ**に限ること。
打鍵ごとの補完・ホバーは自前解析だけで完結させる。

---

## 6. アダプタの形

```ts
// packages/mind-compiler/src/adapter.ts
export interface MindCompiler {
  /** 文法チェックだけおこない、診断を返す */
  check(input: CompileInput): Promise<CompileResult>;
  dispose(): Promise<void>;
}
```

| 実装 | いつ使うか |
|---|---|
| `DockerCompiler` | 既定。Mind-Docker のイメージを使う |
| `LocalCompiler` | ホストに `pmind` が入っている場合（Linux / WSL2） |
| `NullCompiler` | 設定されていないとき。常に空の診断を返す |

---

## 7. 辞書の生成（Docker 不要）

標準ライブラリのソース `pmind/file/*.src` は配布物に同梱されているので、
**tgz から直接読める**。Docker を起動する必要はない。

```sh
npm run gen:stdlib                      # ../Mind-Docker/vendor/*.tgz を見る
node tools/gen-stdlib-dict.ts --tgz <path>
node tools/gen-stdlib-dict.ts --dir <pmind/file>
```

出力は `packages/mind-core/data/stdlib.json`。**生成物だがコミットする。**
これで拡張の利用者にも CI にも Mind の配布物は要らなくなる。

---

## 8. 参考

- [Mind-Docker](https://github.com/shin3tky/Mind-Docker) — 処理系の Docker 環境（README に構築手順と検証結果）
- [Mind オペレーションマニュアル（Version 8・Linux）](https://www.scripts-lab.co.jp/mind/ver8/doc/operation-1b-Install-linux.html)
- [Mind プログラミングマニュアル（基礎編）](https://www.scripts-lab.co.jp/mind/ver9/doc/indexBase.html)
