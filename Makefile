# Mind for Linux 8 を Docker で動かすための入口
#
#   make check    … 配布物 (vendor/*.tgz) が置かれているか確認
#   make build    … runtime イメージをビルド
#   make dev      … dev イメージをビルド
#   make shell    … runtime コンテナのシェルに入る
#   make devshell … dev コンテナのシェルに入る
#   make hello    … fixtures/hello.src をコンパイルして実行（疎通確認）
#   make inspect  … 配布物の中身（同梱 .src、bin、lib）を調べる
#   make clean    … コンパイル生成物を削除
#   make distclean… イメージごと削除

COMPOSE ?= docker compose
TARBALL ?= vendor/mind-for-linux-8.0.08.tgz

.PHONY: help check build dev shell devshell hello inspect clean distclean

help:
	@grep -E '^#   ' $(MAKEFILE_LIST) | sed 's/^#   //'

check:
	@test -f $(TARBALL) || { \
	  echo "ERROR: $(TARBALL) がありません。vendor/README.md の手順で配置してください。"; \
	  exit 1; }
	@echo "OK: $(TARBALL)"

build: check
	$(COMPOSE) build mind

dev: check
	$(COMPOSE) build dev

shell: build
	$(COMPOSE) run --rm mind bash

devshell: dev
	$(COMPOSE) run --rm dev bash

hello: build
	$(COMPOSE) run --rm mind bash -c 'cd /work/fixtures && mindc hello file && mindrun ./hello'

inspect: build
	$(COMPOSE) run --rm mind mind-inspect

clean:
	@find . -name '.mindbuild' -type d -prune -exec rm -rf {} + 2>/dev/null || true
	@find ./fixtures -type f \( -name '*.mco' -o -name '*.sym' -o -name '*.his' -o -name '*.inf' \) -delete 2>/dev/null || true
	@echo "cleaned"

distclean: clean
	-$(COMPOSE) down --rmi local --remove-orphans
