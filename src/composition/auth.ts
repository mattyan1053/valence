/**
 * 合成ルート——**port に adapter を束ねる唯一の場所**（`AGENTS.md` §3）。
 *
 * **ここだけが、Next.js と Supabase と GitHub を同時に知っている。**
 * **`src/app/` は infrastructure を import できない**ので、**画面と実装の間は
 * 必ずここを通る。**
 *
 * **秘密を読むのもここである**（暗号鍵・Client Secret）。**`"use client"` の
 * 付いたファイルからここへ辿れないことは `src/secrets-reach.test.ts` が見る。**
 */

import { cookies } from "next/headers";
import type { LoginResult } from "../application/auth/complete-login";
import { completeLogin } from "../application/auth/complete-login";
import { signOut } from "../application/auth/sign-out";
import type { UserTokenStore } from "../application/ports/user-token-store";
import { readEncryptionKey } from "../infrastructure/crypto/token-cipher";
import { readOAuthCredentials } from "../infrastructure/github/app-credentials";
import { refreshUserTokens } from "../infrastructure/github/user-token";
import {
  createSessionClient,
  currentAccessToken,
  currentUserId,
  endSession,
  exchangeCodeForProviderTokens,
  readSupabaseConnection,
  type SessionCookies,
  startGithubLogin,
} from "../infrastructure/supabase/session";
import { createSupabaseUserTokenStore } from "../infrastructure/supabase/user-token-store";

/**
 * Next.js の Cookie 置き場を、細い口へ合わせる。
 *
 * **書けないと、更新されたセッションが返らない**——**次の要求でログインが切れる。**
 * **Route Handler の外では書けない**ので、**書けなかったことは黙って飲む**
 * （Supabase のクライアントはそれを前提にしている）。
 */
async function nextCookies(): Promise<SessionCookies> {
  const store = await cookies();
  return {
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (updated) => {
      for (const { name, value, options } of updated) {
        try {
          store.set(name, value, options);
        } catch {
          // 読み取り専用の文脈。ここで落とすと、読むだけの画面が開かなくなる。
        }
      }
    },
  };
}

async function sessionClient() {
  return createSessionClient(readSupabaseConnection(process.env), await nextCookies());
}

/** いまログインしている人の置き場。**いなければ `undefined`。** */
async function storeForCurrentUser(
  client: Awaited<ReturnType<typeof sessionClient>>,
): Promise<UserTokenStore | undefined> {
  const [userId, accessToken] = await Promise.all([
    currentUserId(client),
    currentAccessToken(client),
  ]);
  if (userId === undefined || accessToken === undefined) {
    return undefined;
  }
  const connection = readSupabaseConnection(process.env);
  return createSupabaseUserTokenStore({
    // **サーバから叩く。** **ブラウザ向けの名前を使うと、app コンテナが自分自身を叩く。**
    url: connection.serverUrl,
    publishableKey: connection.publishableKey,
    userId,
    userAccessToken: accessToken,
    key: readEncryptionKey(process.env),
  });
}

/** GitHub の認可画面の URL。**戻り先はこちらで決める**（外から受けない）。 */
export async function githubLoginUrl(callbackUrl: string): Promise<string> {
  return startGithubLogin(await sessionClient(), readSupabaseConnection(process.env), callbackUrl);
}

/**
 * コールバックを終える——**セッションを作り、GitHub のトークンを保存する。**
 *
 * **保存まで済んで初めて「入れた」と言う。** **セッションだけできて保存が
 * 落ちると、ログインしているのに何も見えない**（#184 の形）。
 */
export async function completeGithubLogin(code: string): Promise<LoginResult> {
  const client = await sessionClient();
  const provider = await exchangeCodeForProviderTokens(client, code);
  const store = await storeForCurrentUser(client);
  if (store === undefined) {
    // **交換は通ったのに本人が読めない。** **ここで「入れた」にしない。**
    return { kind: "needs-login" };
  }
  const credentials = readOAuthCredentials(process.env);
  return completeLogin({
    store,
    provider,
    refresh: (refreshToken) =>
      refreshUserTokens({ credentials, refreshToken, fetcher: fetch, now: new Date() }),
  });
}

/** ログアウト——**保存したトークンも消す。** */
export async function signOutCurrentUser(): Promise<void> {
  const client = await sessionClient();
  const store = await storeForCurrentUser(client);
  if (store === undefined) {
    // **ログインしていない人がログアウトを押した。** **セッションだけ畳んで終える**
    // ——**消すものが無いことは失敗ではない。**
    await endSession(client);
    return;
  }
  await signOut({ store, endSession: () => endSession(client) });
}
