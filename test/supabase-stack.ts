/**
 * DB を要求する試験のための、ローカル Supabase への足場。
 *
 * **ここを通るのは試験だけである。** 製品コードは `src/infrastructure/supabase/` を通る。
 *
 * **持ち主以外に行が返らないこと**を確かめたいので、**本物の利用者を 2 人作り、
 * それぞれの token で読む**。**service_role では試さない**——
 * **あれは RLS を素通りする**ので、**ポリシーを 1 行も書かなくても緑になる。**
 */

import { createHmac, randomUUID } from "node:crypto";

/** ローカルスタックへの繋ぎ先。**リポジトリにも `.env` にも置かない** (`AGENTS.md` §6)。 */
export type StackConnection = {
  readonly url: string;
  /** 匿名鍵。**利用者として読むときに使う。** */
  readonly publishableKey: string;
  /** 秘密鍵。**試験用の利用者を作って消すためだけに使う。** */
  readonly secretKey: string;
  /** 利用者の token を署名する鍵。**PostgREST が検証するのと同じもの。** */
  readonly jwtSecret: string;
};

/**
 * **ローカルのスタックだと言い切れるホストだけ。**
 *
 * **試験は利用者を作って消す。** **繋ぎ先を間違えたときに壊れるのは向こう側**なので、
 * **入口で止める**——**「消してしまってから気づく」経路を作らない。**
 */
const LOCAL_HOSTS = ["kong", "127.0.0.1", "localhost", "[::1]", "host.docker.internal"];

const REQUIRED = {
  url: "SUPABASE_URL",
  publishableKey: "SUPABASE_PUBLISHABLE_KEY",
  secretKey: "SUPABASE_SECRET_KEY",
  jwtSecret: "SUPABASE_JWT_SECRET",
} as const;

/**
 * 繋ぎ先を環境変数から読む。
 *
 * **足りなければ落とす。skip しない。** **skip は緑に見える**ので、
 * **CI で環境変数を渡し損ねた日から、この試験は何も見なくなる**——
 * **「RLS が効いている」を、誰も確かめていない状態で言い続けることになる。**
 */
export function readStackConnection(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StackConnection {
  const missing = Object.values(REQUIRED).filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `DB を要求する試験には Supabase の接続情報が要ります。未設定: ${missing.join(", ")}` +
        " (./task test:db から実行すること)",
    );
  }
  const url = (env[REQUIRED.url] as string).trim().replace(/\/+$/, "");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${REQUIRED.url} が URL として読めません`);
  }
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `${REQUIRED.url} がローカルのスタックを指していません: ${host}` +
        " (この試験は利用者を作って消すので、手元以外へは繋がない)",
    );
  }
  return {
    url,
    publishableKey: (env[REQUIRED.publishableKey] as string).trim(),
    secretKey: (env[REQUIRED.secretKey] as string).trim(),
    jwtSecret: (env[REQUIRED.jwtSecret] as string).trim(),
  };
}

/** ログイン済みの試験用利用者。 */
export type StackUser = {
  readonly id: string;
  /** 本人としての access token。**PostgREST はこれを見て `auth.uid()` を決める。** */
  readonly accessToken: string;
};

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 応答が失敗なら投げる。
 *
 * **本文を載せる。** ここはローカルの試験専用で、**載せないと「どこで落ちたか」が
 * 状態コードだけになる**（製品コードの判断とは別。`AGENTS.md` §6 の対象は
 * 本番のログである）。
 */
async function expectOk(response: Response, what: string): Promise<unknown> {
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`${what} に失敗しました (HTTP ${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

/** 試験のたびに違う人にする。**同じ人を使い回すと、前の周回の行が残って通る。** */
function uniqueEmail(): string {
  return `valence-test-${randomUUID()}@example.com`;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * その人としての access token を作る。
 *
 * **メール+パスワードでログインしない。** **`supabase/config.toml` は
 * `[auth.email] enable_signup = false`** で、**認証は GitHub OAuth だけ**と決めてある
 * ——**試験を通すために、その決定を緩めない** (`AGENTS.md` §5)。
 *
 * **手で作っても、検証する相手は本物である。** **PostgREST は同じ鍵で署名を検め、
 * `auth.uid()` は `sub` を読む**——**確かめたいポリシーは、この token で動く。**
 */
function signAccessToken(connection: StackConnection, userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      iss: `${connection.url}/auth/v1`,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const signature = createHmac("sha256", connection.jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * 利用者を 1 人作って返す。
 *
 * **`auth.users` に本当に行を作る。** **`user_id` は外部キー**なので、
 * **作り話の UUID では保存そのものが通らない**——**通ってしまうなら、
 * その外部キーが効いていない。**
 */
export async function createStackUser(connection: StackConnection): Promise<StackUser> {
  const created = (await expectOk(
    await fetch(`${connection.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: connection.secretKey,
        authorization: `Bearer ${connection.secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: uniqueEmail(), email_confirm: true }),
    }),
    "試験用の利用者の作成",
  )) as { id?: unknown };
  if (typeof created.id !== "string") {
    throw new Error("試験用の利用者を作りましたが、id が返りませんでした");
  }

  return { id: created.id, accessToken: signAccessToken(connection, created.id) };
}

/** 片付ける。**行は `on delete cascade` で一緒に消える。** */
export async function deleteStackUser(connection: StackConnection, user: StackUser): Promise<void> {
  const response = await fetch(`${connection.url}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: {
      apikey: connection.secretKey,
      authorization: `Bearer ${connection.secretKey}`,
    },
  });
  await expectOk(response, "試験用の利用者の削除");
}

/** その人として PostgREST を叩く。 */
export function requestAs(
  connection: StackConnection,
  user: StackUser,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("apikey", connection.publishableKey);
  headers.set("authorization", `Bearer ${user.accessToken}`);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${connection.url}/rest/v1/${path}`, { ...init, headers });
}
