---
name: dev-environment
description: Valence の開発環境（コンテナ、./task、Supabase ローカルスタック）を操作・調査するときに使う。アプリが起動しない、Supabase に繋がらない、DB を覗きたい、コンテナを作り直したい、といった場面。
---

# 開発環境の操作

**ホストには何もインストールしない。すべてコンテナ内で実行する。**
ホストで `pnpm` / `npx` / `node` を直接実行しないこと。

コマンドの一覧は `./task help` が正。ここには**それを読んでも分からないこと**だけを書く。

## コンテナの構成

| サービス | ネットワーク | docker socket | 生存期間 |
| --- | --- | --- | --- |
| `app` | bridge（`127.0.0.1:3000` のみ publish）＋ Supabase の network | **持たない** | 常駐 |
| `supabase-cli` | host | 持つ | コマンド実行中のみ |
| `smee` | bridge | 持たない | `./task smee` の間（フォアグラウンド） |

`app` の `CMD` は `pnpm dev`。**コンテナが起動していればアプリは動いている。**
依存の導入は entrypoint が面倒を見るので、clone 直後でも `./task up` だけでよい。

## よくある詰まり

### アプリが「空応答」を返す（`ERR_EMPTY_RESPONSE` / `curl: (52)`）

compose のポート公開（docker-proxy）はホスト側で listen し続けるため、
**コンテナ内に応答する相手がいなくても TCP は繋がる。** 「接続拒否」ではなく
「空応答」ならこれを疑う。

```bash
ss -tlnp | grep :3000                       # ホスト側は listen している
docker compose exec -T app pgrep -a node    # コンテナ内に next がいるか
./task restart                              # 動いていなければ再起動
```

`pkill -f "next dev"` で止めようとしないこと。パターンが自分の親シェルにも
一致して巻き添えで死ぬ。用途ごとに使い分ける。

| やりたいこと | コマンド |
| --- | --- |
| 再起動する（設定を読み直す等） | `./task restart` |
| 止めたままにする | `docker compose stop app` |
| 環境ごと落とす | `./task down` |

### Supabase に繋がらない

**接続先が 2 通りあり、取り違えると原因が分かりにくい。**

| どこから | URL | 理由 |
| --- | --- | --- |
| サーバー側（Route Handler / Server Component） | `http://kong:8000` | `app` が Supabase と同じ docker network にいる |
| ブラウザ側（`NEXT_PUBLIC_*`） | `http://localhost:54321` | ブラウザはコンテナ名を解決できない |

`localhost:54321` を publish しているのは `compose.yaml` ではなく、
supabase CLI が立てた `supabase_kong_valence` コンテナ。

### Supabase CLI の癖

CLI は**ホストの Docker daemon にスタックを立てさせる一方、疎通確認は自身の
127.0.0.1 を見る**。そのため docker socket とホストのネットワーク名前空間の
両方を要求する。これを `app` に持たせるとアプリのコンテナがホスト root 相当の
権限を常時抱えることになるので、`supabase-cli` サービスへ切り出してある。

**`app` に docker socket や `network_mode: host` を戻さないこと。**

他に踏んだ癖:

- socket を渡すだけでは足りず、`docker` コマンド自体を PATH に要求する
- bind mount がホストのパスで解決されるため、プロジェクトを `${PWD}:${PWD}` にマウントしている
- `supabase-cli` から `env_file` を外すと `config.toml` の `env()` が解決できず、
  GitHub OAuth の資格情報が空のままスタックが起動する

### 起動しているサービスが少ない

`db` / `auth` / `rest` / `kong` の 4 つだけ。`realtime` `storage` `edge_runtime`
`local_smtp` `analytics` `studio` は `supabase/config.toml` で無効にしてある。
MVP で使わないうえ、イメージだけで数 GB になるため。必要になったら個別に有効化する。

DB を覗くときは `./task db:psql`（studio は無効）。

## リモート VM から使う

```bash
ssh -L 3000:localhost:3000 <user>@<remote-vm>
```

ブラウザから Supabase を直接叩くようになったら `-L 54321:localhost:54321` も足す。
