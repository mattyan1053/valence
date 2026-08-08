# syntax=docker/dockerfile:1

# Supabase CLI はローカルスタックの起動に docker コマンドそのものを要求する
# (socket を渡すだけでは足りない)。公式イメージから CLI バイナリだけ借りる。
FROM docker:29-cli AS docker-cli

# 開発用イメージ。ホスト環境に Node / pnpm を入れずに済ませるためのもの。
# 本番は Vercel にデプロイする想定 (Dockerfile は使われない) なので、
# ここに production ステージは置かない。
#
# Node 24 は Active LTS (2025-10-28〜)。26 は 2026-10-28 まで LTS にならず、
# かつ corepack が同梱されなくなっているため、まだ上げない。
FROM node:25-bookworm-slim AS dev

# bind mount したファイルの所有者がホストとずれないように uid/gid を合わせる。
# Supabase CLI がホストの Docker daemon を叩けるように docker group の gid も渡す。
# いずれも ./task が実ホストの値を算出して渡すため、ここの既定値は保険。
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG DOCKER_GID=999

ENV PNPM_HOME=/home/node/.local/share/pnpm \
    PATH=/home/node/.local/share/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        procps \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    # ホストの GID がイメージ内で既に使われている場合 (macOS の staff=20 が
    # Debian の dialout と衝突する等) は、そのグループを node の主グループとして
    # 流用する。空いていれば node グループの GID を付け替える。
    if ! getent group "$HOST_GID" >/dev/null; then groupmod -g "$HOST_GID" node; fi; \
    usermod -g "$HOST_GID" node; \
    # UID は流用が効かない (別ユーザーの UID を node に付け替えるとそのユーザーが
    # 壊れる)。衝突したら usermod の分かりにくいエラーで落ちる代わりに、何が
    # 起きたかを言って止まる。root (UID 0) での開発は想定していない。
    if [ "$(id -u node)" != "$HOST_UID" ]; then \
      if getent passwd "$HOST_UID" >/dev/null; then \
        echo "HOST_UID=$HOST_UID はイメージ内の既存ユーザー ($(getent passwd "$HOST_UID" | cut -d: -f1)) と衝突しています。" >&2; \
        echo "root や 1000 未満の UID のホストユーザーでは、この開発環境は使えません。" >&2; \
        exit 1; \
      fi; \
      usermod -u "$HOST_UID" node; \
    fi; \
    # ホストの docker socket の gid を持つグループを用意し、node を所属させる
    if ! getent group "$DOCKER_GID" >/dev/null; then groupadd -g "$DOCKER_GID" hostdocker; fi; \
    usermod -aG "$(getent group "$DOCKER_GID" | cut -d: -f1)" node; \
    # pnpm ストアは名前付きボリュームでマウントする。マウント先がイメージ内に
    # 存在しないと root 所有で作られてしまうため、先に node 所有で掘っておく
    mkdir -p "$PNPM_HOME/store"; \
    chown -R "$HOST_UID:$HOST_GID" /home/node

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN corepack enable

USER node

# 依存が無ければ入れてからコマンドを実行する。これで `compose up` した時点で
# アプリが動いている状態になり、「コンテナは起動しているのに応答しない」を防ぐ。
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["pnpm", "dev"]
