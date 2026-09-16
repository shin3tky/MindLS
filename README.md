# MindLS

日本語プログラミング言語 [Mind](https://www.scripts-lab.co.jp/mind/whatsmind.html)（Scripts Lab Inc.）の
Language Server と VS Code 拡張。

開発計画は [`docs/PLAN.md`](docs/PLAN.md)、実処理系との結合方針は
[`docs/COMPILER-BACKEND.md`](docs/COMPILER-BACKEND.md)。

## 構成

| パッケージ | 役割 |
|---|---|
| `@mindls/core` | 正規化・レキサ・パーサ・シンボルテーブル。エディタ非依存 |
| `@mindls/compiler` | 実 Mind コンパイラを叩くアダプタ（オプトイン） |
| `@mindls/language-server` | LSP 本体（stdio） |
| `vscode-mind` | VS Code 拡張 |

## 開発

```sh
npm install
npm test          # Vitest
npm run typecheck
```

**Docker は必須ではありません。** 標準単語辞書は生成済みのものがコミットされており、
実コンパイラ連携はオプトインです。処理系を動かしたい場合は
[Mind-Docker](https://github.com/shin3tky/Mind-Docker) を使います。

```sh
npm run gen:stdlib   # 辞書の再生成（Mind の配布物が要る。Docker は不要）
```

## ライセンス

Apache-2.0
