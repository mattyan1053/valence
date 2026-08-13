/**
 * ログインしている人が誰かを決める側（Supabase Auth）。
 *
 * **GitHub の OAuth を回すのは Supabase である** (#194 の判断 1)。**この App の
 * Client ID / Secret をそのまま渡してあり**（`supabase/config.toml` の
 * `[auth.external.github]`）、**GitHub からのコールバックは GoTrue が受ける。**
 *
 * **ここで受け取るのは 2 種類の資格である**（`AGENTS.md` §6）。
 *
 *   Supabase のセッション … **この人が誰か**。行の隔離（RLS）はこれで効く
 *   `provider_token`    … **GitHub を叩くための、その人のトークン**
 *
 * **`provider_token` はログインの瞬間しか渡ってこない**ので、**受け取ったら
 * 置き場へ入れる**（`user-token-store.ts`）。**期限は渡ってこない**ので、
 * **保存する形にするのは `completeLogin` の仕事**である。
 */

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ProviderTokens } from "../../application/auth/complete-login";

/**
 * Cookie の出し入れ。**Next.js を infrastructure へ持ち込まない**ための細い口。
 *
 * **セッションは Cookie に載る。** **読むだけでなく書ける必要がある**——
 * **更新された Cookie を返さないと、次の要求でログインが切れる。**
 */
export type SessionCookies = {
  getAll(): { name: string; value: string }[];
  setAll(cookies: { name: string; value: string; options?: Record<string, unknown> }[]): void;
};

export type SupabaseConnection = {
  readonly url: string;
  readonly publishableKey: string;
};

/** 読む環境変数の名前。`.env.example` と揃える。 */
const URL_NAME = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_NAME = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

const connectionSchema = z.object({
  [URL_NAME]: z.url(),
  [KEY_NAME]: z.string().trim().min(1),
});

/**
 * 繋ぎ先を環境変数から読む。
 *
 * **足りなければ入口で落とす**（`readAppCredentials` と同じ判断）。
 * **値は載せない**——**ログへ流れる。**
 */
export function readSupabaseConnection(
  env: Readonly<Record<string, string | undefined>>,
): SupabaseConnection {
  const parsed = connectionSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`環境変数が設定されていないか、形式が違います: ${URL_NAME} / ${KEY_NAME}`);
  }
  return { url: parsed.data[URL_NAME], publishableKey: parsed.data[KEY_NAME] };
}

export function createSessionClient(
  connection: SupabaseConnection,
  cookies: SessionCookies,
): SupabaseClient {
  return createServerClient(connection.url, connection.publishableKey, {
    cookies: {
      getAll: () => cookies.getAll(),
      setAll: (updated) => {
        cookies.setAll(updated);
      },
    },
  });
}

/**
 * GitHub の認可画面へ送る URL を作る。
 *
 * **`state` はここで作らない。** **PKCE の検証子と `state` を持っているのは
 * Supabase のクライアント**で、**検証子は Cookie に置かれる**——
 * **自前で `state` を足すと、確かめる者が 2 人になり、片方だけ古くなる。**
 *
 * **戻り先は渡した 1 つだけ**である。**`config.toml` の `site_url` と
 * `additional_redirect_urls` に無い URL は GoTrue が弾く**ので、
 * **戻り先を外から差し込まれても、そこへは戻らない。**
 */
export async function startGithubLogin(
  client: SupabaseClient,
  redirectTo: string,
): Promise<string> {
  // **`scopes` は渡さない。** **GitHub App の権限は App 側の設定で決まる**ので、
  // **ここに書いても効かない**——**効かない設定を置くと、読んだ人が「ここで
  // 絞れている」と思う。**
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error !== null || data.url === null) {
    throw new Error("ログインを開始できません");
  }
  return data.url;
}

/**
 * コールバックで受けた `code` をセッションへ交換する。
 *
 * **`provider_token` と `provider_refresh_token` が揃っていなければ失敗させる。**
 * **揃わないまま進むと、ログインはできたのに GitHub を叩けない**——
 * **画面は空で、原因はどこにも出ない**（**遅れて出る失敗**）。
 */
const sessionSchema = z.object({
  provider_token: z.string().min(1),
  provider_refresh_token: z.string().min(1),
});

export async function exchangeCodeForProviderTokens(
  client: SupabaseClient,
  code: string,
): Promise<ProviderTokens> {
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  // **元の例外を持ち上げない。** **応答にはセッションが入りうる。**
  if (error !== null) {
    throw new Error("ログインの応答を受け取れませんでした");
  }
  const parsed = sessionSchema.safeParse(data.session);
  if (!parsed.success) {
    throw new Error("ログインの応答に GitHub のトークンが含まれていません");
  }
  return {
    accessToken: parsed.data.provider_token,
    refreshToken: parsed.data.provider_refresh_token,
  };
}

/** いまログインしている人の id。**いなければ `undefined`。** */
export async function currentUserId(client: SupabaseClient): Promise<string | undefined> {
  // **`getSession` ではなく `getUser` を使う。** **前者は Cookie の中身を
  // そのまま信じる**ので、**書き換えられた Cookie で他人になれる。**
  const { data, error } = await client.auth.getUser();
  if (error !== null || data.user === null) {
    return undefined;
  }
  return data.user.id;
}

/** いまのセッションの access token。**置き場を本人として叩くのに要る。** */
export async function currentAccessToken(client: SupabaseClient): Promise<string | undefined> {
  const { data, error } = await client.auth.getSession();
  if (error !== null || data.session === null) {
    return undefined;
  }
  return data.session.access_token;
}

export async function endSession(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut();
  if (error !== null) {
    throw new Error("セッションを終了できませんでした");
  }
}
