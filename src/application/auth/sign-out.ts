/**
 * ログアウトする。
 *
 * **セッションを切るだけでは足りない。** **保存したトークンが残ると、
 * 次のログインが古い行に当たる**——**「消したつもり」で消えていない状態になる。**
 */

import type { UserTokenStore } from "../ports/user-token-store";

/** セッションを終える口。**どこに置いてあるかは、この向こう側**である。 */
export type EndSession = () => Promise<void>;

export type SignOutInput = {
  readonly store: UserTokenStore;
  readonly endSession: EndSession;
};

export async function signOut({ store, endSession }: SignOutInput): Promise<void> {
  // **順番が本体である。** **行が見えるのは本人の token を持っている間だけ**
  // （行の隔離はセッション側の資格で効く）——**先にセッションを切ると、
  // 消せる者がいなくなって行が残る。**
  let failure: unknown;
  try {
    await store.clear();
  } catch (error) {
    failure = error;
  }

  // **消せなくても、セッションは終える。** **倒す先は 2 つある**——
  // **消えないから居座らせる**と、**ログアウトを押した人がログインしたまま**になる。
  // **そちらのほうが悪い。**
  await endSession();

  // **黙って成功にしない。** **消えていないことは、呼ぶ側に伝わる必要がある。**
  if (failure !== undefined) {
    throw failure;
  }
}
