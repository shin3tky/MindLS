#!/usr/bin/env bash
#
# .inf（インフォメーションファイル）の実物を集める。
#
# Mind のコンパイラは文法エラーのときだけ .inf を出す。その中身の書式は
# マニュアルに載っていないので、実物を見るしかない。ここで集めたものが
# @mindls/compiler の .inf パーサと、EUC-JP バイトオフセット → UTF-16 位置の
# 逆変換テーブルの根拠になる。
#
# Docker の中で走らせる（mind-docker:8.0.08）。リポジトリのルートで:
#
#   docker run --rm --platform linux/amd64 \
#     -v "$PWD:/work" -w /work -e LANG=ja_JP.eucJP \
#     mind-docker:8.0.08 bash tools/collect-inf.sh
#
# 出力は fixtures/inf-corpus/collected/<名前>/ 以下。
#   source.euc.src … 実際にコンパイラへ渡した EUC-JP の実体（位置の検算用）
#   compile.log    … コンパイラの出力（UTF-8 に直したもの）
#   compile.euc.log… 同じものの原本（EUC-JP）
#   status         … 終了コード
#   report.inf     … .inf の原本（EUC-JP）。出なければファイルごと無い
#   report.txt     … .inf を UTF-8 に直したもの
set -uo pipefail

SRC_DIR="fixtures/inf-corpus"
OUT_DIR="${SRC_DIR}/collected"
LIB="${MIND_LIB:-file}"

command -v mind >/dev/null || { echo "mind が見つかりません。コンテナの中で実行してください。" >&2; exit 1; }

# 前回の結果は丸ごと捨てる（残骸があると「今回 .inf が出なかった」が分からなくなる）
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"
printf '%-22s %-6s %s\n' "見本" "status" ".inf"
printf '%s\n' "----------------------------------------------------"

for src in "${SRC_DIR}"/*.src; do
    base="$(basename "${src}" .src)"
    out="${OUT_DIR}/${base}"
    mkdir -p "${out}"

    work="$(mktemp -d)"
    iconv -f UTF-8 -t EUC-JP "${src}" > "${work}/${base}.src" || {
        echo "${base}: EUC-JP に変換できませんでした" >&2; rm -rf "${work}"; continue; }

    # .inf は前回の残骸があると誤解のもとになる。まっさらな一時ディレクトリで実行する
    ( cd "${work}" && mind "${base}" ${LIB} ) > "${work}/compile.euc.log" 2>&1
    status=$?

    cp "${work}/${base}.src" "${out}/source.euc.src"
    cp "${work}/compile.euc.log" "${out}/compile.euc.log"
    iconv -f EUC-JP -t UTF-8 -c "${work}/compile.euc.log" > "${out}/compile.log"
    echo "${status}" > "${out}/status"

    if [ -e "${work}/${base}.inf" ]; then
        cp "${work}/${base}.inf" "${out}/report.inf"
        iconv -f EUC-JP -t UTF-8 -c "${work}/${base}.inf" > "${out}/report.txt"
        inf="あり ($(wc -c < "${out}/report.inf") バイト)"
    else
        inf="なし"
    fi

    printf '%-22s %-6s %s\n' "${base}" "${status}" "${inf}"
    rm -rf "${work}"
done

echo
echo "集めたもの: ${OUT_DIR}"
