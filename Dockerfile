# syntax=docker/dockerfile:1

# 開発用イメージ。ホスト環境に Node / pnpm を入れずに済ませるためのもの。
# 本番は Vercel にデプロイする想定なので、ここに production ステージは置かない。
FROM node:22-bookworm-slim AS dev

# bind mount したファイルの所有者がホストとずれないように uid/gid を合わせる。
# Supabase CLI がホストの Docker daemon を叩けるように docker group の gid も渡す。
# いずれも Makefile が実ホストの値を算出して渡すため、ここの既定値は保険。
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
    # node ユーザーは既定で 1000:1000。ホストが違う場合だけ付け替える
    if [ "$HOST_GID" != "1000" ]; then groupmod -g "$HOST_GID" node; fi; \
    if [ "$HOST_UID" != "1000" ]; then usermod -u "$HOST_UID" -g "$HOST_GID" node; fi; \
    # ホストの docker socket の gid を持つグループを用意し、node を所属させる
    if ! getent group "$DOCKER_GID" >/dev/null; then groupadd -g "$DOCKER_GID" hostdocker; fi; \
    usermod -aG "$(getent group "$DOCKER_GID" | cut -d: -f1)" node; \
    mkdir -p "$PNPM_HOME"; \
    chown -R node:node /home/node

RUN corepack enable

USER node
