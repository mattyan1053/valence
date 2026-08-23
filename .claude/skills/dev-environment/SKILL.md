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
| `app` | bridge（`127.0.0.1:<この作業場のポート>` のみ publish）＋ Supabase の network | **持たない** | 常駐 |
| `supabase-cli` | host | 持つ | コマンド実行中のみ |
| `smee` | bridge | 持たない | `./task smee` の間（フォアグラウンド） |

`app` の `CMD` は `pnpm dev`。**コンテナが起動していればアプリは動いている。**
依存の導入は entrypoint が面倒を見るので、clone 直後でも `./task up` だけでよい。

### どのポートで開くか

**作業場ごとに違う**（#82）。**書き写さないこと**——**決めているのは `./task`** である。

```bash
# ここは、作業場のある機械で打つ（コンテナが動いている側）
port="$(./task port)"                                      # この作業場のポート
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$port/"
docker ps --filter "publish=$port" --format '{{.Names}}'   # 誰のものか確かめる
```

**最後の 1 行が要る。** **別の作業場のポートを開いても、エラーにならない**
——**アプリが普通に開く**ので、**見ているものが自分のものだと思い込んだまま進む。**
**出てくる名前は compose project（作業場のディレクトリ名）で始まる**ので、
**そこが自分の作業場でなければ、見ているのは他人のアプリである。**

## よくある詰まり

### アプリが「空応答」を返す（`ERR_EMPTY_RESPONSE` / `curl: (52)`）

compose のポート公開（docker-proxy）はホスト側で listen し続けるため、
**コンテナ内に応答する相手がいなくても TCP は繋がる。** 「接続拒否」ではなく
「空応答」ならこれを疑う。

```bash
# ここは、作業場のある機械で打つ
ss -tlnp | grep ":$(./task port)"           # ホスト側は listen している
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

### コンテナ内で環境変数が空（`.env` には値があるのに）

**`env_file` はコンテナの作成時にしか読まれない。** `.env` を書き換えても、
既に動いているコンテナには反映されない。**再起動でも読み直さない。**

症状が「環境変数が空」なので、**読み方のバグと見分けがつかない**。`process.env` の綴りや
`.env` の書式を疑う前に、まず**コンテナの作成時刻と `.env` の更新時刻**を比べる。

```bash
docker inspect valence-app-1 --format '{{.Created}}'   # コンテナが作られた時刻
stat -c '%y' .env                                      # これより古ければ読まれていない
```

反映させるコマンドは `./task up`。**`./task restart` では直らない。**

| やること | 反映 | 中身 |
| --- | --- | --- |
| `./task restart` | **されない** | `docker compose restart app`（作り直さない） |
| `docker compose stop` → `start` | **されない** | 同上 |
| `./task up` | される | `docker compose up -d app`。compose が設定の変化を見てコンテナを作り直す |
| `docker compose up -d --force-recreate app` | される | 変化を検出しない compose でも確実に作り直す |

`./task up` は変化が無ければ作り直さない（冪等）。作り直すと **dev サーバーは再起動する**
ので、`./task dev` でログを追っていたら追い直すこと。

**`./task check` などの他のコマンドでは反映されない。** それらが内部で呼ぶのは
「動いていなければ起動する」処理で、**動いているコンテナには何もしない**。

### Supabase に繋がらない

**接続先が 2 通りあり、取り違えると原因が分かりにくい。**

| どこから | URL | 理由 |
| --- | --- | --- |
| サーバー側（Route Handler / Server Component） | `http://kong:8000` | `app` が Supabase と同じ docker network にいる |
| ブラウザ側（`NEXT_PUBLIC_*`） | `http://localhost:54321` | ブラウザはコンテナ名を解決できない |

`localhost:54321` を publish しているのは `compose.yaml` ではなく、
supabase CLI が立てた `supabase_kong_valence` コンテナ。

### DB を要求するテスト

`./task test:db` が、**マイグレーションから作り直してから** `*.db.test.ts` を走らせる。
接続情報は実行時にスタックから取るので、`.env` に書くものは無い。

**スタックは全作業場で 1 つを共有し、`./task db:*` と `./task test:db` は直列化してある**
（`.git/valence-db.lock`）。**待たされるのは正常**で、諦めたときだけ理由が出る。
`./task db:psql` だけは対話用なので直列化していない（`task` のコメントに理由がある）。

「別の作業場が DB を使っています」で止まるなら、**返し忘れではなく本当に走っている**。
`docker ps` で `supabase_db_valence` を触っているものを見る。

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

## ログイン後の盤面を、人が 1 度開く

**機械はここを通れない**（#409 / #411）。**GitHub の認可画面は、人が押さないと進まない**
——**この 1 手だけは人がやる。**

**1 度でよい。** **セッションが続く限り、次からは開くだけ**である。

### 開く

```bash
# ここは、作業場のある機械で打つ
port="$(./task port)"
./task up            # 動いていなければ
```

**リモートの VM に作業場があるなら、転送してから開く**（下の「リモート VM から使う」）。

1. ブラウザで `http://127.0.0.1:<port>/` を開く
2. **ログインへ** → **GitHub でログイン** → **GitHub の認可画面で許可する**（初回だけ）
3. 戻ると、**見られるリポジトリが並ぶ**——**1 つ選ぶと盤面**（`/repos/<owner>/<name>`）

**並ばないときは、GitHub App がそのアカウントに入っていない。** **入れるかどうかは
人の判断**である——**この道具は入れない**（`AGENTS.md` §1。**installation は実行時に
解決するもので、設定に固定しない**）。

### 開いたら、確かめる

```bash
# ここは、作業場のある機械で打つ
gh pr list --repo <owner>/<name> --state open --json number --jq '.[].number'
```

- **盤面に並ぶ PR の番号が、これと一致するか**（**1 件でよい**）
- **PR が 0 本なら、0 本と分かる形で見えるか**（**空白ではなく、そう読める文が出るか**）
- **依存の順に並んでいるか**・**Tier が各行に出ているか**・**Approve / Merge が出ているか**

### 報せること

- **開けなかったとき**——**どの段で止まったか**（**URL と、画面に出ていた文**）
- **食い違ったとき**——**盤面の番号と、`gh pr list` の番号**

**貼らないもの**: **`.env` の値・トークン・cookie・smee の URL**（`AGENTS.md` §6）。
**URL は path まで**——**認可の戻りには `code=` が載る。**

## リモート VM から使う

```bash
# ここは手元（ブラウザのある機械）で打つ
#
# **ポートを訊く先は、向こう**である——**手元で `./task port` を打つと、手元の
# ディレクトリ名から別の port が出る**（`valence` という名前の clone が手元にあれば、
# **転送は通り、画面も開く**。**開いたのは別の作業場のアプリ**である）
port="$(ssh <user>@<remote-vm> 'cd <作業場のパス> && ./task port')"
ssh -L "$port:localhost:$port" <user>@<remote-vm>
```

ブラウザから Supabase を直接叩くようになったら `-L 54321:localhost:54321` も足す。
