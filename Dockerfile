# 日本語プログラミング言語 Mind Version 8 (for Linux) を Docker で動かすためのイメージ。
#
# Mind 8 for Linux の配布バイナリ／カーネルは x86 32bit (little endian) を前提としているため、
# ベースイメージは意図的に linux/386 に固定している。
# Apple Silicon の Docker Desktop では非ネイティブアーキテクチャのエミュレーションで動作する
# （Rosetta は x86_64 向けで 32bit x86 は対象外。Apple Virtualization framework を使う場合は
#  Use Rosetta for x86_64/amd64 emulation のチェックを外すこと）。
#
# ビルド前に vendor/mind-for-linux-8.0.08.tgz を配置しておくこと（vendor/README.md 参照）。

ARG DEBIAN_TAG=bookworm-slim

# ---------------------------------------------------------------------------
# base: ロケール（EUC-JP）と共通の環境変数だけを持つ最小ベース
# ---------------------------------------------------------------------------
# hadolint ignore=DL3029  (32bit 固定は意図的)
FROM --platform=linux/386 debian:${DEBIAN_TAG} AS base

ENV DEBIAN_FRONTEND=noninteractive \
    MIND_HOME=/opt/mind \
    MIND_ROOT=/opt/mind/pmind

# Mind の公式手順に合わせた環境変数
#   LANG=ja_JP.eucJP は glibc のコードセット正規化により ja_JP.EUC-JP ロケールに解決される
ENV MLIBPATH=${MIND_ROOT}/lib \
    PATH=${MIND_ROOT}/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=ja_JP.eucJP \
    JLESSCHARSET=japanese

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends locales; \
    sed -i -E 's/^# *(ja_JP\.EUC-JP EUC-JP)/\1/' /etc/locale.gen; \
    sed -i -E 's/^# *(ja_JP\.UTF-8 UTF-8)/\1/'   /etc/locale.gen; \
    sed -i -E 's/^# *(en_US\.UTF-8 UTF-8)/\1/'   /etc/locale.gen; \
    locale-gen; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# builder: 配布 tgz を展開して kernel を make する
# ---------------------------------------------------------------------------
FROM base AS builder

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends binutils gcc make libc6-dev; \
    rm -rf /var/lib/apt/lists/*

# Mind の Makefile が ~ を参照しても壊れないよう HOME を合わせておく
ENV HOME=${MIND_HOME}

ARG MIND_TARBALL=vendor/mind-for-linux-8.0.08.tgz
COPY ${MIND_TARBALL} /tmp/mind.tgz

# 公式手順どおり tar の p オプション必須（cgilib 配下が 777 を要求するため）
RUN set -eux; \
    mkdir -p /tmp/mindx "${MIND_HOME}"; \
    tar xzpf /tmp/mind.tgz -C /tmp/mindx; \
    kerneldir="$(find /tmp/mindx -maxdepth 3 -type d -name kernel | head -n 1)"; \
    if [ -z "${kerneldir}" ]; then \
        echo "ERROR: 配布物の中に kernel/ が見つかりません。tgz が壊れていないか確認してください。" >&2; \
        find /tmp/mindx -maxdepth 2 >&2; \
        exit 1; \
    fi; \
    mv "$(dirname "${kerneldir}")" "${MIND_ROOT}"; \
    rm -rf /tmp/mindx /tmp/mind.tgz

# カーネルのメイク。
#   kernel/makefile は OSDEFINE=LINUX が既定、CC は "gcc -m32" 固定、CFLAGS は "-O6 -funsigned-char -ansi"。
#   1998 年からの C ソースなので、暗黙の関数宣言をエラーにする gcc 14 以降ではビルドが通らない。
#   bookworm (gcc 12) を意図的に固定しているのはこのため。
#
#   なお bin/ には 2021 年ビルドの 32bit ELF がすでに同梱されているため、
#   どうしても make が通らない場合は SKIP_KERNEL_MAKE=1 で同梱バイナリのまま使える。
ARG SKIP_KERNEL_MAKE=0
RUN set -eux; \
    if [ "${SKIP_KERNEL_MAKE}" = "1" ]; then \
        echo "SKIP_KERNEL_MAKE=1: 同梱バイナリをそのまま使います"; \
    else \
        cd "${MIND_ROOT}/kernel"; \
        make clean || true; \
        make all; \
        make install; \
    fi; \
    ls -l "${MIND_ROOT}/bin"; \
    test -x "${MIND_ROOT}/bin/mind"

# ---------------------------------------------------------------------------
# runtime: Mind のコンパイル／実行ができる最小イメージ
# ---------------------------------------------------------------------------
FROM base AS runtime

COPY --from=builder /opt/mind /opt/mind
COPY docker/bin/ /usr/local/bin/
RUN chmod 0755 /usr/local/bin/mindc /usr/local/bin/mindrun /usr/local/bin/mind-inspect /usr/local/bin/mind-entrypoint

# bash -l のようにログインシェルで起動された場合、/etc/profile が PATH を上書きしてしまう。
# profile.d で Mind の環境変数を入れ直しておく。
RUN set -eux; \
    printf '%s\n' \
      'export MIND_HOME=/opt/mind' \
      'export MIND_ROOT=/opt/mind/pmind' \
      'export MLIBPATH="${MIND_ROOT}/lib"' \
      'case ":${PATH}:" in *:"${MIND_ROOT}/bin":*) ;; *) export PATH="${MIND_ROOT}/bin:${PATH}" ;; esac' \
      'export LANG=ja_JP.eucJP' \
      'export JLESSCHARSET=japanese' \
      > /etc/profile.d/mind.sh; \
    chmod 0644 /etc/profile.d/mind.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/mind-entrypoint"]
CMD ["bash"]

# ---------------------------------------------------------------------------
# dev: Language Server 開発用。runtime にツール類を足しただけ
#
# 注意: Apple Silicon では全体が 386 のエミュレーション実行になるため遅い。
#       Language Server 本体はホスト側ネイティブで動かし、このコンテナは
#       「Mind コンパイラのバックエンド」として使う構成を推奨（README 参照）。
# ---------------------------------------------------------------------------
FROM runtime AS dev

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        file \
        git \
        less \
        procps \
        python3 \
        python3-venv \
        vim-tiny; \
    rm -rf /var/lib/apt/lists/*

# Node.js を中で動かしたい場合は以下を有効化（Debian i386 の nodejs は 18.x 系・32bit ヒープ制限あり）
# RUN set -eux; apt-get update; apt-get install -y --no-install-recommends nodejs npm; rm -rf /var/lib/apt/lists/*

CMD ["bash"]
