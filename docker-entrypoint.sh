#!/usr/bin/env bash
#
# 開発コンテナの起動時フック。
#
# 新規 clone 直後は node_modules が無く、next も vitest も解決できない。
# ここで面倒を見ることで、ホスト側が node_modules の有無を気にせずに済む。
#
set -euo pipefail

if [[ ! -d node_modules ]]; then
  echo "==> node_modules が無いため依存をインストールします" >&2
  pnpm install --frozen-lockfile
fi

exec "$@"
