import { describe, expect, it } from "vitest";
import type { UserTokens } from "../ports/user-token-store";
import { completeLogin } from "./complete-login";

const PROVIDER = { accessToken: "gho_from-login", refreshToken: "ghr_from-login" };

const RENEWED: UserTokens = {
  accessToken: "gho_renewed",
  refreshToken: "ghr_renewed",
  expiresAt: new Date("2026-08-14T08:00:00.000Z"),
};

function store(overrides: Partial<Record<"save" | "load" | "clear", () => Promise<never>>> = {}) {
  const saved: UserTokens[] = [];
  return {
    saved,
    port: {
      load: overrides.load ?? (async () => undefined),
      save:
        overrides.save ??
        (async (tokens: UserTokens) => {
          saved.push(tokens);
        }),
      clear: overrides.clear ?? (async () => {}),
    },
  };
}

describe("ログインを終える", () => {
  it("受け取った 1 組を、期限の分かる 1 組へ入れ替えて保存する", async () => {
    // **ログインの応答には期限が入っていない。** 期限が要るのは
    // `isUsable` の判断なので、**GitHub に聞いてから保存する。**
    const { saved, port } = store();

    const result = await completeLogin({
      store: port,
      refresh: async (refreshToken) => {
        expect(refreshToken).toBe(PROVIDER.refreshToken);
        return RENEWED;
      },
      provider: PROVIDER,
      abandonSession: async () => {},
    });

    expect(result).toEqual({ kind: "signed-in" });
    expect(saved).toEqual([RENEWED]);
  });

  it("受け取ったものをそのまま保存しない", async () => {
    // **期限を推測して入れない。** **8 時間だろうと決め打つと、実際が短かった日に
    // 失効した token で GitHub を叩く**——**症状は 401 で、「権限が無い」と混ざる。**
    const { saved, port } = store();

    await completeLogin({
      store: port,
      refresh: async () => RENEWED,
      provider: PROVIDER,
      abandonSession: async () => {},
    });

    expect(saved[0]?.accessToken).not.toBe(PROVIDER.accessToken);
  });

  it("期限を聞けなければ、保存せずに再ログインへ戻す", async () => {
    // **保存しないほうへ倒す。** **期限の分からない 1 組を入れると、
    // 「いつまで使えるか」を誰も知らないまま使い続けることになる。**
    const { saved, port } = store();

    const result = await completeLogin({
      store: port,
      refresh: async () => {
        throw new Error("だめ");
      },
      provider: PROVIDER,
      abandonSession: async () => {},
    });

    expect(result).toEqual({ kind: "needs-login" });
    expect(saved).toEqual([]);
  });

  it("保存に失敗したら、ログインできたことにしない", async () => {
    // **保存できていないのに「入れた」と言うと、次の要求で必ず失敗する**
    // ——**その場では動いて見え、次で壊れる**（`ensureUsableToken` と同じ判断）。
    const { port } = store({
      save: async () => {
        throw new Error("だめ");
      },
    });

    const result = await completeLogin({
      store: port,
      refresh: async () => RENEWED,
      provider: PROVIDER,
      abandonSession: async () => {},
    });

    expect(result).toEqual({ kind: "needs-login" });
  });

  /**
   * **入れなかったのに、セッションだけ残さない** (#224 のレビュー)。
   *
   * **交換が済んだ時点で、認証の Cookie は置かれている。** **そこから先で落ちて
   * 「入口へ戻す」とだけ返すと、画面は入口なのに Supabase 側ではログイン済み**
   * ——**この経路が自分で書いた不変条件**（「保存まで済んで初めて『入れた』と言う」）
   * **が、そこで破れる。**
   *
   * **落ちる場所は 3 つある。** **1 つずつ別の入力で見る**——**1 箇所に足して
   * 「直した」にすると、残りの 2 つは残ったままになる。**
   */
  describe("入れなかったときは、セッションも畳む", () => {
    function abandoning() {
      let abandoned = 0;
      return {
        count: () => abandoned,
        abandonSession: async () => {
          abandoned += 1;
        },
      };
    }

    it("本人が読めなければ、畳んでから入口へ戻す", async () => {
      // **交換は通ったのに、置き場を本人として開けない。**
      const { count, abandonSession } = abandoning();

      const result = await completeLogin({
        store: undefined,
        refresh: async () => RENEWED,
        provider: PROVIDER,
        abandonSession,
      });

      expect(result).toEqual({ kind: "needs-login" });
      expect(count(), "セッションが残っている").toBe(1);
    });

    it("期限を聞けなければ、畳んでから入口へ戻す", async () => {
      const { count, abandonSession } = abandoning();
      const { port } = store();

      const result = await completeLogin({
        store: port,
        refresh: async () => {
          throw new Error("だめ");
        },
        provider: PROVIDER,
        abandonSession,
      });

      expect(result).toEqual({ kind: "needs-login" });
      expect(count(), "セッションが残っている").toBe(1);
    });

    it("保存に失敗したら、畳んでから入口へ戻す", async () => {
      const { count, abandonSession } = abandoning();
      const { port } = store({
        save: async () => {
          throw new Error("だめ");
        },
      });

      const result = await completeLogin({
        store: port,
        refresh: async () => RENEWED,
        provider: PROVIDER,
        abandonSession,
      });

      expect(result).toEqual({ kind: "needs-login" });
      expect(count(), "セッションが残っている").toBe(1);
    });

    it("入れたときは、畳まない", async () => {
      // **倒す先は 2 つある。** **成功した人まで畳むと、入った直後に
      // ログアウトさせられる**——**入れない側へ倒しすぎない。**
      const { count, abandonSession } = abandoning();
      const { port } = store();

      const result = await completeLogin({
        store: port,
        refresh: async () => RENEWED,
        provider: PROVIDER,
        abandonSession,
      });

      expect(result).toEqual({ kind: "signed-in" });
      expect(count(), "入れた人のセッションを畳んでいる").toBe(0);
    });

    it("畳めなかったら、黙って入口へ戻さない", async () => {
      // **畳めていないことは、呼ぶ側に伝わる必要がある** (`signOut` と同じ判断)。
      // **「入口へ戻した」とだけ返すと、ログイン済みのまま残ったことが消える。**
      const { port } = store();

      await expect(
        completeLogin({
          store: port,
          refresh: async () => {
            throw new Error("だめ");
          },
          provider: PROVIDER,
          abandonSession: async () => {
            throw new Error("畳めません");
          },
        }),
      ).rejects.toThrow(/畳めません/);
    });
  });
});
