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

import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { LoginResult } from "../application/auth/complete-login";
import { completeLogin } from "../application/auth/complete-login";
import { ensureUsableToken } from "../application/auth/ensure-usable-token";
import { signOut } from "../application/auth/sign-out";
import type { UserTokenStore } from "../application/ports/user-token-store";
import type { VisibleRepositoriesResult } from "../application/repositories/list-visible-repositories";
import { listVisibleRepositories } from "../application/repositories/list-visible-repositories";
import { type EncryptionKey, readEncryptionKey } from "../infrastructure/crypto/token-cipher";
import { readOAuthCredentials } from "../infrastructure/github/app-credentials";
import { refreshUserTokens } from "../infrastructure/github/user-token";
import { createUserVisibleRepositories } from "../infrastructure/github/user-visible-repositories";
import { reportLoginFailure } from "../infrastructure/observability/login-failure";
import {
  createSessionClient,
  currentAccessToken,
  currentUserId,
  endSession,
  exchangeCodeForProviderTokens,
  readSupabaseConnection,
  type SessionCookies,
  type SupabaseConnection,
  startGithubLogin,
} from "../infrastructure/supabase/session";
import { createSupabaseUserTokenStore } from "../infrastructure/supabase/user-token-store";
import {
  createWaitForWinnersSave,
  createWinnersSaveBudget,
} from "../infrastructure/time/wait-for-winners-save";

/**
 * Next.js の Cookie 置き場を、細い口へ合わせる。
 *
 * **書けないと、更新されたセッションが返らない**——**次の要求でログインが切れる。**
 * **画面（サーバコンポーネント）の文脈では書けない**ので、**ここでは黙って飲む。**
 *
 * **飲んでよいのは、書ける境界が別にあるから**である (#214)——**`src/middleware.ts`
 * が要求のたびに更新し、Cookie を返す。** **ここが最後の砦だった頃は、飲んだ時点で
 * 更新が消えていた。**
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

/**
 * `process.env` だけで決まるもの。**交換より先に読む** (#224 のレビュー)。
 *
 * **同じ理由が当たるものは、同じ側へ寄せる。** **交換が済むと認証の Cookie は
 * 置かれている**ので、**そのあとで設定の不備に気づくと、畳む手間がひとつ増える**
 * ——**落ちる経路は、作らずに済むなら作らない。**
 */
function settings() {
  return {
    credentials: readOAuthCredentials(process.env),
    connection: readSupabaseConnection(process.env),
    key: readEncryptionKey(process.env),
  };
}

async function sessionClient(connection: SupabaseConnection) {
  return createSessionClient(connection, await nextCookies());
}

/**
 * いまログインしている人の置き場。**いなければ `undefined`。**
 *
 * **設定は引数で受ける。** **ここで読むと、読めなかったときに呼ぶ側の外側で
 * 落ちる**——**「作りかけのセッションを畳む」がその経路にだけ効かなくなる。**
 */
async function storeForCurrentUser(
  client: SupabaseClient,
  connection: SupabaseConnection,
  key: EncryptionKey,
  remainingMs?: () => number | undefined,
): Promise<UserTokenStore | undefined> {
  const [userId, accessToken] = await Promise.all([
    currentUserId(client),
    currentAccessToken(client),
  ]);
  if (userId === undefined || accessToken === undefined) {
    return undefined;
  }
  return createSupabaseUserTokenStore({
    // **サーバから叩く。** **ブラウザ向けの名前を使うと、app コンテナが自分自身を叩く。**
    url: connection.serverUrl,
    publishableKey: connection.publishableKey,
    userId,
    userAccessToken: accessToken,
    key,
    // **待つ側の予算を分け合う** (#255)。**渡さなければ、置き場は自分の制限だけで
    // 諦める**——**待ちの上限は、待ちだけでは守れない**（往復にも食われる）
    remainingMs,
  });
}

/** GitHub の認可画面の URL。**戻り先はこちらで決める**（外から受けない）。 */
export async function githubLoginUrl(callbackUrl: string): Promise<string> {
  const { connection } = settings();
  return startGithubLogin(await sessionClient(connection), connection, callbackUrl);
}

/**
 * コールバックを終える——**セッションを作り、GitHub のトークンを保存する。**
 *
 * **保存まで済んで初めて「入れた」と言う。** **セッションだけできて保存が
 * 落ちると、ログインしているのに何も見えない**（#184 の形）。
 */
export async function completeGithubLogin(code: string): Promise<LoginResult> {
  const { credentials, connection, key } = settings();
  const client = await sessionClient(connection);

  let provider: Awaited<ReturnType<typeof exchangeCodeForProviderTokens>>;
  try {
    provider = await exchangeCodeForProviderTokens(client, code);
  } catch (error) {
    // **交換はここでしか起きない**ので、**段の名前もここでしか付けられない** (#248)。
    // **投げ直す。** **握り潰すと、設定の不備が「入口へ戻った」に化ける**
    reportLoginFailure("exchange", error);
    throw error;
  }

  return completeLogin({
    // **開く手続きごと渡す。** **開いた結果だけを渡すと、開く手前で落ちたときに
    // `completeLogin` へ入らず、畳む経路を通らない。**
    openStore: () => storeForCurrentUser(client, connection, key),
    provider,
    refresh: (refreshToken) =>
      refreshUserTokens({ credentials, refreshToken, fetcher: fetch, now: new Date() }),
    // **入れられなかったら、作りかけのセッションを畳む。**
    abandonSession: () => endSession(client),
    // **落ちた段だけを残す** (#248)。**何をどこへ書くかは adapter が持つ**（§3）
    report: reportLoginFailure,
  });
}

/** ログアウト——**保存したトークンも消す。** */
export async function signOutCurrentUser(): Promise<void> {
  const { connection, key } = settings();
  const client = await sessionClient(connection);
  const store = await storeForCurrentUser(client, connection, key);
  if (store === undefined) {
    // **ログインしていない人がログアウトを押した。** **セッションだけ畳んで終える**
    // ——**消すものが無いことは失敗ではない。**
    await endSession(client);
    return;
  }
  await signOut({ store, endSession: () => endSession(client) });
}

/**
 * **いまログインしている人が見られるリポジトリ**を返す。
 *
 * **束ねるのはここだけ**（§3）——**画面は port の結果しか知らない。**
 *
 * **更新した Cookie は、この経路では書けない**（`nextCookies` が飲む）。
 * **書くのは `src/middleware.ts`** (#214)——**要求はそこを必ず通り、更新された
 * セッションはブラウザと、この要求の続きの両方へ渡る。**
 *
 * **ここが読むのは、その境界が置いた Cookie である。** **判断を持つのはこちらだけ**
 * ——**境界は運ぶだけで、「誰が何を見られるか」を決めない。**
 */
export async function visibleRepositoriesForCurrentUser(): Promise<VisibleRepositoriesResult> {
  const { credentials, connection, key } = settings();
  const client = await sessionClient(connection);
  // **待つ側と置き場で、1 つの予算を分け合う** (#255)。**別々に作ると、
  // それぞれが自分の時刻から数え**——**合計は上限を超える。**
  const budget = createWinnersSaveBudget();
  return listVisibleRepositories({
    openStore: () => storeForCurrentUser(client, connection, key, () => budget.peekRemainingMs()),
    ensure: (store) =>
      ensureUsableToken({
        store,
        refresh: (refreshToken) =>
          refreshUserTokens({ credentials, refreshToken, fetcher: fetch, now: new Date() }),
        now: new Date(),
        // **更新に負けたら、勝った側の保存を短く待つ** (#214)——
        // **待たないと、切れる必要が無かった人を入口へ送る。**
        // **待つ長さを決めているのは、この adapter だけである**
        waitForWinnersSave: createWaitForWinnersSave({ budget }),
      }),
    // **ユーザートークンで解決する**（§6）——**installation トークンで代用しない。**
    repositories: createUserVisibleRepositories(),
  });
}
