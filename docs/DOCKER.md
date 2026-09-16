# Mind 処理系の Docker 環境

`docs/PLAN.md` M5「実コンパイラ連携」と、正規化エンジンの差分テストのために、
**Mind の実処理系を macOS (Apple Silicon) 上で動かす**ための環境。

---

## 0. 先に押さえておくべき事実（PLAN.md の前提を 2 点修正）

| PLAN.md の記述 | 実際 |
|---|---|
| 「Mind 9 Linux 版が amd64 Docker で動くか検証」 | **Mind 9 に Linux 版は存在しない。** 公式ダウンロードページ上、Linux 版は Version 8（`mind-for-linux-8.0.08`, 2021/08/14）が最新で、Version 9 は Windows 専用 |
| `--platform=linux/amd64` | Mind 8 for Linux は **x86 32bit** バイナリ。64bit OS 上では `glibc.i386` / `libgcc.i386` が必要。したがって **`linux/386`** を使う |

### これで何ができて、何ができないか

- **できる**: 正規化規則・分かち書き・構文の**答え合わせ**。Mind 8 と 9 で言語のコア
  （送り仮名の削除、正規化、分かち書き、制御構文）はほぼ共通なので、M0 の差分テストには十分使える
- **できる**: `.inf`（インフォメーションファイル）の実物を得てフォーマットを確定させる
- **できる**: 標準ライブラリの `.src` が同梱されているかの確認（`make inspect`）→ 辞書自動生成の可否判断
- **できない**: Mind 9 固有の追加単語・GUI 編（`guilib`）の検証。ここは Windows 版 or Windows VM が必要

> Apple Silicon では 32bit x86 を **Rosetta が扱えない**（[Rosetta は x86_64 専用の変換レイヤで i386 は翻訳しない](https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment)）ため、
> 非ネイティブアーキテクチャのエミュレーション実行になる。Docker Desktop で Apple Virtualization framework を
> 使っている場合は `Use Rosetta for x86_64/amd64 emulation on Apple Silicon` のチェックを外すこと
> （Docker VMM は Rosetta 非対応なのでそのままでよい）。
> コンパイル 1 回あたり数秒のオーダーで、対話的な補完には使えない。
> **Language Server 本体はホスト側ネイティブで動かし、このコンテナは「保存時に叩くバックエンド」** として使うこと。

---

## 0.5 配布物を開けて分かったこと（PLAN.md 8章「確認したい事項」への回答）

`vendor/mind-for-linux-8.0.08.tgz`（3.5MB / 438 エントリ / 展開先は `pmind/`）を実際に調べた結果。

### ✅ 標準ライブラリのソース (.src) は同梱されている → 辞書自動生成の **A 案が成立**

| 場所 | .src 数 | 中身 |
|---|---|---|
| `pmind/file/` | **46** | 標準ライブラリ `file` の本体（`file.src` `fopen.src` `console.src` `coutput.src` …） |
| `pmind/tool/` | 15 | 付属ツール |
| `pmind/cgilib/` | 11 (+ sample 8) | CGI ライブラリ |
| `pmind/socketlib/` | 2 (+ sample 7) | ソケットライブラリ |
| `pmind/sample/` `sampleF/` | 6 / 9 | サンプル（`fixtures/` に取り込む候補） |

→ `tools/build-stdlib-dict.ts` は `pmind/file/*.src` の定義行とスタック仕様コメントを
   パースすれば作れる。**`.sym` がバイナリである問題は回避できる。**
   PLAN.md M4 の「B（保険）案」は不要。

コンテナから取り出す例:

```sh
docker compose run --rm mind bash -c 'cp -r /opt/mind/pmind/file /work/vendor/stdlib-src'
```

### コンパイラ・ランタイムはプリビルド済み

`pmind/bin/` に `mind` `mindC` `mindex` `mmake` `mhist` `mgrep` などが
**ELF 32-bit LSB / Intel 80386** として同梱済み。ランタイムは `mrunt010` `mrunt057` `mrunt060` `mrunt160`。
標準ライブラリの `.mco` / `.sym` も `pmind/lib/` にビルド済みで入っている。

→ `kernel/` の make は「手元の glibc に合わせて作り直す」ための工程。
   どうしても通らない場合は `--build-arg SKIP_KERNEL_MAKE=1` で同梱バイナリのまま使える。

### なぜ bookworm (gcc 12) を固定しているか

`pmind/kernel/makefile` は以下の内容。

```make
OSDEFINE = LINUX          # 既定でこれが選ばれている
CC       = gcc -m32       # 32bit 固定（amd64 で使うなら gcc-multilib が要る）
CFLAGS   = -O6 -funsigned-char -ansi
```

1998 年からの C ソースなので、暗黙の関数宣言を **エラー**にする gcc 14 以降ではビルドが通らない可能性が高い。
bookworm (gcc 12) なら警告止まり。trixie 以降に上げるときはここを疑うこと。

### 文字コードの追加情報

配布物同梱の `usemind` / `usemindc` / `kernel/makefile` は **EUC-JP**。
`pmind/bin/` には `euc2sjis` / `sjis2euc` という変換ツールも同梱されている。

---

## 1. 準備

### 1.1 配布物を置く

`vendor/README.md` の手順で `vendor/mind-for-linux-8.0.08.tgz` を配置する。
再配布しないため Git には入れない（`.gitignore` 済み）。

```sh
ls -l vendor/mind-for-linux-8.0.08.tgz
```

### 1.2 Apple Silicon の場合: Rosetta を切っておく

Docker Desktop の Settings → General → Virtual Machine Options。

- **Docker VMM** … Rosetta 非対応なのでそのままでよい
- **Apple Virtualization framework** … `Use Rosetta for x86_64/amd64 emulation on Apple Silicon` のチェックを外す

386 の binfmt が入っていない場合のみ:

```sh
docker run --privileged --rm tonistiigi/binfmt --install 386
```

---

## 2. 使い方

```sh
make check     # 配布物が置かれているか確認
make build     # runtime イメージをビルド（初回は QEMU 経由で数分〜十数分）
make hello     # fixtures/hello.src をコンパイルして実行（疎通確認）
make inspect   # 配布物の中身を調べる（同梱 .src / bin / lib）
make shell     # コンテナのシェルに入る
```

コンテナ内では以下が使える。

| コマンド | 説明 |
|---|---|
| `mind <base> <lib>` | Mind の本物のコンパイラ（EUC-JP のソースを要求） |
| `mindc <src> <lib>` | **UTF-8 のソース**をコンパイルするラッパー |
| `mindrun <exe>` | 生成した実行ファイルを入出力 UTF-8 で実行するラッパー |
| `mind-inspect` | 配布物の中身を調べる |

---

## 3. 文字コードの扱い

Mind 8 for Linux は **EUC-JP 固定**（Windows 版は Shift_JIS）。
一方このリポジトリのソースは UTF-8 で管理したい。そこでラッパーが境界で変換する。

```
fixtures/hello.src (UTF-8)
   └→ mindc が .mindbuild/hello.src (EUC-JP) を生成
        └→ 本物の mind がコンパイル
             └→ 出力・.inf を EUC-JP → UTF-8 に戻す
                  └→ 実行ファイル・.mco/.sym/.his/.inf を元の場所へ書き戻す
```

- `.mindbuild/` は生成物（`.gitignore` 済み）。デバッグのため既定では残す。
  消したい場合は `MIND_KEEP_BUILD=0`
- ソースの**ファイル名は ASCII のみ**（`mindc` がチェックする）
- EUC-JP に存在しない文字（絵文字、`①` など）があると変換時にエラーで止まる。
  これは「Mind のソースとして無効」なので、握り潰さずエラーにしている

### PLAN.md M5 のオフセット変換について

`mindc` は `.inf` をそのまま（UTF-8 に変換して）書き戻す。
`.inf` 内の位置情報は **EUC-JP のバイトオフセット**である点に注意。
Language Server 側で「EUC-JP バイトオフセット → 行・UTF-16 列」の逆変換が必要
（`docs/PLAN.md` M5 参照）。変換テーブルを作る際は、`mindc` が作る
`.mindbuild/<name>.src`（EUC-JP の実体）と元の UTF-8 ソースを突き合わせるのが確実。

---

## 4. イメージの構成

`Dockerfile` はマルチステージ。

| ステージ | 中身 | 用途 |
|---|---|---|
| `base` | `debian:bookworm-slim` (linux/386) + ja_JP.EUC-JP ロケール | 共通土台 |
| `builder` | `binutils` / `gcc` / `make` / `libc6-dev` を入れて配布 tgz を展開し `kernel` を make | ビルド専用（最終イメージには残らない） |
| `runtime` | ビルド済み `/opt/mind/pmind` + ラッパー | **既定。LS のバックエンド用** |
| `dev` | runtime + `build-essential` / `git` / `python3` など | コンテナ内で開発したい場合 |

インストール先は公式手順の `~/pmind` ではなく `/opt/mind/pmind`。
`builder` では `HOME=/opt/mind` を設定しているので、Makefile が `~` を参照しても整合する。

環境変数は公式手順どおり:

```
PATH     … /opt/mind/pmind/bin を追加
MLIBPATH … /opt/mind/pmind/lib
LANG     … ja_JP.eucJP
JLESSCHARSET … japanese
```

Node.js は **あえて入れていない**。Debian i386 の `nodejs` は 18.x 系で 32bit ヒープ制限があり、
QEMU 上では遅い。Language Server はホスト側の Node で動かすこと。
どうしても中で動かしたい場合は `Dockerfile` の `dev` ステージのコメント行を有効化する。

---

## 5. Language Server からの呼び出し（M5 のアダプタ想定）

`mind.compiler.docker` を設定したときの実行イメージ:

```sh
docker compose run --rm --no-TTY mind \
  bash -c 'cd /work/<相対パス> && mindc <base> file'
```

あるいはイメージを直接:

```sh
docker run --rm --platform linux/386 \
  -v "$PWD:/work" -w /work \
  mindls/mind:8.0.08 mindc fixtures/hello file
```

`docker compose run` は毎回コンテナを立ち上げるため、保存のたびに起動コストがかかる。
頻度が上がるなら、常駐コンテナに `docker exec` する方式に切り替えるとよい。

---

## 6. うまくいかないときの切り分け

| 症状 | 見るところ |
|---|---|
| `exec format error` | Rosetta が有効、または 386 の binfmt が無い → 1.2 |
| `COPY vendor/... not found` | `vendor/*.tgz` が無い、または `.dockerignore` で除外していないか確認 |
| `kernel/ が見つかりません` | tgz が壊れている / 展開構成が想定と違う。`tar tzf vendor/*.tgz \| head` で確認 |
| `make all` が失敗 | `builder` に入って手で make する: `docker build --target builder -t mindbuild . && docker run -it --platform linux/386 mindbuild bash` |
| 日本語が化ける | コンテナ内で `locale` を確認。`ja_JP.eucJP` が出ていること |
| 実行ファイルが動かない | ランタイム `mrunt*` が `bin/` にあるか（`make inspect`） |

---

## 7. 参考

- [Mind オペレーションマニュアル 1b. インストール（Linux）](https://www.scripts-lab.co.jp/mind/ver8/doc/operation-1b-Install-linux.html)
- [Mind ダウンロードページ](https://www.scripts-lab.co.jp/mind/download/download.html)
- [Mind オペレーションマニュアル 2. ディレクトリ構成](https://www.scripts-lab.co.jp/mind/ver8/doc/operation-2-Directory.html)
