/**
 * **セッションを更新する境界**（#214 の 1）。
 *
 * **合成ルートの一部**である（§3。**adapter を束ねるのはここだけ**）。
 * **`auth.ts` と分けてあるのは、ここが要求のたびに走るから**——
 * **`next/headers` も暗号鍵も要らない**ので、**繋がずに済むものを繋がない。**
 *
 * **ここは「誰が何を見られるか」を決めない。** **更新するのが境界、読むのが画面**で、
 * **判断を 2 か所に持つと片方だけ古くなる。**
 */

import {
  createSessionClient,
  currentUserId,
  readSupabaseConnection,
} from "../infrastructure/supabase/session";
import {
  type SessionCookieSinks,
  sessionCookiesFor,
} from "../infrastructure/supabase/session-cookies";

/**
 * いまのセッションを読み、**更新されたら Cookie を書き戻す。**
 *
 * **読むと更新される。** **Supabase のクライアントは失効間際のセッションを
 * 読んだときに自分で更新し、新しい Cookie を渡してくる**——**その渡し先を
 * 用意するのが、この境界の仕事**である。
 *
 * **判定できないときは何もしない。** **`currentUserId` は落ちても `undefined` を返す**
 * ので、**ここで「入っていない」と決めつけて Cookie を消さない**——
 * **消すと、置き場が落ちているだけの人がログアウトさせられる**（#214 の 3 つ目と同じ形）。
 * **その要求の画面は同じ置き場を読んで `unavailable` へ倒れる**ので、
 * **古いセッションのまま「使える」ことにはならない。**
 */
export async function refreshSession(sinks: SessionCookieSinks): Promise<void> {
  const connection = readSupabaseConnection(process.env);
  const client = createSessionClient(connection, sessionCookiesFor(sinks));
  await currentUserId(client);
}
