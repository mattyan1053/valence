/**
 * **更新されたセッションを、行くべき 2 か所へ渡す** (#214)。
 *
 * **Supabase のクライアントは、失効間際のセッションを読むと勝手に更新する。**
 * **そのとき新しい Cookie を渡してくるが、渡す先は 2 つある。**
 *
 *   **ブラウザ** … 次の要求が新しいセッションを持ってくる
 *   **この要求の続き** … 同じ要求の中で描かれる画面が、新しいセッションを読む
 *
 * **どちらか一方だけでは足りない。** **ブラウザにだけ書くと、いま描いている画面が
 * 古い Cookie で動き**、**続きにだけ書くと、次の要求でまた失効する。**
 *
 * **ここには「誰が何を見られるか」の判断を置かない** (#214)。**運ぶだけである**
 * ——**判断を持つのは画面の側（`listVisibleRepositories`）だけ**で、
 * **2 か所に持つと、片方だけ古くなる。**
 */

import type { SessionCookies } from "./session";

export type UpdatedCookie = {
  readonly name: string;
  readonly value: string;
  readonly options?: Record<string, unknown>;
};

export type SessionCookieSinks = {
  /** この要求が持ってきたもの。 */
  read(): { name: string; value: string }[];
  /** **この要求の続き**が読む先。 */
  toRequest(cookie: { name: string; value: string }): void;
  /**
   * 差し替えた要求から、応答を作り直す。
   *
   * **Next.js の応答は、作った時点の要求を写して持つ**ので、
   * **差し替える前に作ると古いまま**である。
   */
  renew(): void;
  /** **ブラウザ**が受け取る先。 */
  toBrowser(cookie: UpdatedCookie): void;
};

export function sessionCookiesFor(sinks: SessionCookieSinks): SessionCookies {
  return {
    getAll: () => sinks.read(),
    setAll: (updated) => {
      if (updated.length === 0) {
        // **何も変わっていない要求まで応答を組み直さない。**
        return;
      }
      // **順序がすべて。** **要求を差し替える → 作り直す → ブラウザへ書く。**
      // **先に作り直すと差し替えが入らず、後で作り直すとブラウザへ書いたものが消える**
      // ——**どちらも「書いた」ようには見える。**
      for (const { name, value } of updated) {
        sinks.toRequest({ name, value });
      }
      sinks.renew();
      for (const cookie of updated) {
        sinks.toBrowser(cookie);
      }
    },
  };
}
