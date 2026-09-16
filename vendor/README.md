# vendor/

Mind の配布物はここに置きます。**リポジトリにはコミットしません**（`.gitignore` 済み）。

## 入手手順

1. [日本語プログラミング言語 Mind ダウンロードページ](https://www.scripts-lab.co.jp/mind/download/download.html) を開く
2. Linux 版 **`mind-for-linux-8.0.08.tgz`**（2021/08/14 版。Linux 版は Version 8 が最新）をダウンロード
3. このディレクトリに、ファイル名を変えずに置く

```
vendor/mind-for-linux-8.0.08.tgz
```

別バージョンを使う場合は、ビルド引数で指定します。

```sh
docker compose build --build-arg MIND_TARBALL=vendor/mind-for-linux-8.0.10.tgz mind
```

## ライセンスについて

Mind 本体はフリーソフトウェアとして配布されていますが、再配布条件・ランタイム
(`mruntNNN`) の取り扱いは同梱の `README-mind8-linux.txt` に従ってください。
