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
    # ホストの GID がイメージ内で既に使われている場合 (macOS の staff=20 が
    # Debian の dialout と衝突する等) は、そのグループを node の主グループとして
    # 流用する。空いていれば node グループの GID を付け替える。
    if ! getent group "$HOST_GID" >/dev/null; then groupmod -g "$HOST_GID" node; fi; \
    usermod -g "$HOST_GID" node; \
    if [ "$(id -u node)" != "$HOST_UID" ]; then usermod -u "$HOST_UID" node; fi; \
    # ホストの docker socket の gid を持つグループを用意し、node を所属させる
    if ! getent group "$DOCKER_GID" >/dev/null; then groupadd -g "$DOCKER_GID" hostdocker; fi; \
    usermod -aG "$(getent group "$DOCKER_GID" | cut -d: -f1)" node; \
    # pnpm ストアは名前付きボリュームでマウントする。マウント先がイメージ内に
    # 存在しないと root 所有で作られてしまうため、先に node 所有で掘っておく
    mkdir -p "$PNPM_HOME/store"; \
    chown -R "$HOST_UID:$HOST_GID" /home/node

RUN corepack enable

USER node
