import { describe, expect, it } from "vitest";
import type { UserTokens } from "../ports/user-token-store";
import { completeLogin } from "./complete-login";

const PROVIDER = { accessToken: "gho_from-login", refreshToken: "ghr_from-login" };

const RENEWED: UserTokens = {
  accessToken: "gho_renewed",
  refreshToken: "ghr_renewed",
  expiresAt: new Date("2026-08-14T08:00:00.000Z"),
};

/** 記録された段と例外を集める。**呼ばれなかったことも見たい**ので、配列で持つ。 */
function recorder() {
  const reported: Array<{ stage: string; error: unknown }> = [];
  return {
    reported,
    report: (stage: string, error: unknown) => {
      reported.push({ stage, error });
    },
  };
}

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
      setUp: async () => ({
        openStore: async () => port,
        refresh: async (refreshToken) => {
          expect(refreshToken).toBe(PROVIDER.refreshToken);
          return RENEWED;
        },
        exchange: async () => PROVIDER,
        abandonSession: async () => {},
      }),
      report: () => {},
    });

    expect(result).toEqual({ kind: "signed-in" });
    expect(saved).toEqual([RENEWED]);
  });

  it("受け取ったものをそのまま保存しない", async () => {
    // **期限を推測して入れない。** **8 時間だろうと決め打つと、実際が短かった日に
    // 失効した token で GitHub を叩く**——**症状は 401 で、「権限が無い」と混ざる。**
    const { saved, port } = store();

    await completeLogin({
      setUp: async () => ({
        openStore: async () => port,
        refresh: async () => RENEWED,
        exchange: async () => PROVIDER,
        abandonSession: async () => {},
      }),
      report: () => {},
    });

    expect(saved[0]?.accessToken).not.toBe(PROVIDER.accessToken);
  });

  it("期限を聞けなければ、保存せずに再ログインへ戻す", async () => {
    // **保存しないほうへ倒す。** **期限の分からない 1 組を入れると、
    // 「いつまで使えるか」を誰も知らないまま使い続けることになる。**
    const { saved, port } = store();

    const result = await completeLogin({
      setUp: async () => ({
        openStore: async () => port,
        refresh: async () => {
          throw new Error("だめ");
        },
        exchange: async () => PROVIDER,
        abandonSession: async () => {},
      }),
      report: () => {},
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
      setUp: async () => ({
        openStore: async () => port,
        refresh: async () => RENEWED,
        exchange: async () => PROVIDER,
        abandonSession: async () => {},
      }),
      report: () => {},
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
        setUp: async () => ({
          openStore: async () => undefined,
          refresh: async () => RENEWED,
          exchange: async () => PROVIDER,
          abandonSession,
        }),
        report: () => {},
      });

      expect(result).toEqual({ kind: "needs-login" });
      expect(count(), "セッションが残っている").toBe(1);
    });

    it("期限を聞けなければ、畳んでから入口へ戻す", async () => {
      const { count, abandonSession } = abandoning();
      const { port } = store();

      const result = await completeLogin({
        setUp: async () => ({
          openStore: async () => port,
          refresh: async () => {
            throw new Error("だめ");
          },
          exchange: async () => PROVIDER,
          abandonSession,
        }),
        report: () => {},
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
        setUp: async () => ({
          openStore: async () => port,
          refresh: async () => RENEWED,
          exchange: async () => PROVIDER,
          abandonSession,
        }),
        report: () => {},
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
        setUp: async () => ({
          openStore: async () => port,
          refresh: async () => RENEWED,
          exchange: async () => PROVIDER,
          abandonSession,
        }),
        report: () => {},
      });

      expect(result).toEqual({ kind: "signed-in" });
      expect(count(), "入れた人のセッションを畳んでいる").toBe(0);
    });

    it("置き場を開く途中で落ちたら、畳んでから投げ直す", async () => {
      // **数える場所を、境界の内側へ寄せる** (#224 のレビュー)。**開く手前で落ちると、
      // ここへ一度も入らないまま「作りかけのセッション」が残る**——**設定の不備で
      // 毎回失敗する形**が、まさにそれだった。
      //
      // **「いない人」（`undefined`）と混ぜない。** **前者は入口へ戻せば済む**が、
      // **後者は直るまで直らない**——**握りつぶすと、原因がどこにも出ない。**
      const { count, abandonSession } = abandoning();

      await expect(
        completeLogin({
          setUp: async () => ({
            openStore: async () => {
              throw new Error("鍵が設定されていません");
            },
            refresh: async () => RENEWED,
            exchange: async () => PROVIDER,
            abandonSession,
          }),
          report: () => {},
        }),
      ).rejects.toThrow(/鍵が設定されていません/);

      expect(count(), "セッションが残っている").toBe(1);
    });

    it("畳めなかったら、黙って入口へ戻さない", async () => {
      // **畳めていないことは、呼ぶ側に伝わる必要がある** (`signOut` と同じ判断)。
      // **「入口へ戻した」とだけ返すと、ログイン済みのまま残ったことが消える。**
      const { port } = store();

      await expect(
        completeLogin({
          setUp: async () => ({
            openStore: async () => port,
            refresh: async () => {
              throw new Error("だめ");
            },
            exchange: async () => PROVIDER,
            abandonSession: async () => {
              throw new Error("畳めません");
            },
          }),
          report: () => {},
        }),
      ).rejects.toThrow(/畳めません/);
    });
  });

  /**
   * **落ちた段を残す** (#248)。
   *
   * **握り潰しているのは正しい判断**（例外に token が混ざりうる。§6）だが、
   * **どこにも残らないと人が調べられない**——**実際に、`docker exec` で環境変数を
   * 人が読むまで原因が分からなかった。**
   *
   * **4 つの段を 1 つずつ別の入力で見る**——**1 箇所だけ足して「直した」にすると、
   * 残りは黙ったままになる。**
   */
  describe("落ちた段を残す", () => {
    it("期限を聞けなかったら、refresh と例外を渡す", async () => {
      const { reported, report } = recorder();
      const { port } = store();
      const failure = new Error("gho_secret を含みうる本文");

      await completeLogin({
        setUp: async () => ({
          openStore: async () => port,
          refresh: async () => {
            throw failure;
          },
          exchange: async () => PROVIDER,
          abandonSession: async () => {},
        }),
        report,
      });

      // **例外そのものを渡す。** **種類を見たいのは記録する側**である
      expect(reported).toEqual([{ stage: "refresh", error: failure }]);
    });

    it("保存できなかったら、save と例外を渡す", async () => {
      const { reported, report } = recorder();
      const failure = new Error("だめ");
      const { port } = store({
        save: async () => {
          throw failure;
        },
      });

      await completeLogin({
        setUp: async () => ({
          openStore: async () => port,
          refresh: async () => RENEWED,
          exchange: async () => PROVIDER,
          abandonSession: async () => {},
        }),
        report,
      });

      expect(reported).toEqual([{ stage: "save", error: failure }]);
    });

    it("本人がいなければ、session を残す", async () => {
      // **落ちたわけではないが、段は残す**——**「入口へ戻された」だけが見える状態を
      // 無くすのが目的**で、**例外の有無で分けると、ここだけ消える**
      const { reported, report } = recorder();

      await completeLogin({
        setUp: async () => ({
          openStore: async () => undefined,
          refresh: async () => RENEWED,
          exchange: async () => PROVIDER,
          abandonSession: async () => {},
        }),
        report,
      });

      expect(reported.map(({ stage }) => stage)).toEqual(["session"]);
    });

    it("置き場を開けなかったら、投げ直す前に session を残す", async () => {
      // **投げ直す経路も通す。** **投げてから記録すると、この経路だけ何も残らない**
      const { reported, report } = recorder();
      const failure = new Error("鍵が設定されていません");

      await expect(
        completeLogin({
          setUp: async () => ({
            openStore: async () => {
              throw failure;
            },
            refresh: async () => RENEWED,
            exchange: async () => PROVIDER,
            abandonSession: async () => {},
          }),
          report,
        }),
      ).rejects.toThrow(/鍵が設定されていません/);

      expect(reported).toEqual([{ stage: "session", error: failure }]);
    });

    it("設定を用意できなかったら、setup を残して投げ直す", () => {
      // **`completeLogin` へ入る前に落ちる経路が、いまも黙っていた** (#277)。
      // **環境変数の欠落・形式不正は恒常的に起きる**——**直るまで全員が入れない**のに、
      // **画面にもログにも理由が無い**（**2026-08-14 に人が `docker exec` で読んだ形**）。
      //
      // **用意も手続きごと受け取る**（#276 と同じ理由）——**結果だけを受け取ると、
      // 用意で落ちたときにここへ一度も入らない。**
      const { reported, report } = recorder();
      const failure = new Error("TOKEN_ENCRYPTION_KEY が設定されていません");

      return expect(
        completeLogin({
          setUp: async () => {
            throw failure;
          },
          report,
        }),
      )
        .rejects.toThrow(/設定されていません/)
        .then(() => {
          expect(reported).toEqual([{ stage: "setup", error: failure }]);
        });
    });

    it("交換に失敗したら、exchange を残して投げ直す", async () => {
      // **交換はこの関数より前で起きていた** (#276 のレビュー)。**結果だけを受け取ると、
      // 落ちたときにここへ一度も入らない**——**記録する側を消しても、誰も落ちない。**
      // **`openStore` と同じ形にする**（**手続きごと受け取る**。#224 と同じ理由）
      const { reported, report } = recorder();
      const failure = new Error("交換できません");
      let abandoned = 0;

      await expect(
        completeLogin({
          setUp: async () => ({
            openStore: async () => {
              throw new Error("ここまで来てはいけない");
            },
            refresh: async () => RENEWED,
            exchange: async () => {
              throw failure;
            },
            abandonSession: async () => {
              abandoned += 1;
            },
          }),
          report,
        }),
      ).rejects.toThrow(/交換できません/);

      expect(reported).toEqual([{ stage: "exchange", error: failure }]);
      // **畳まない。** **交換が落ちた時点で、畳む対象のセッションはまだ無い**
      expect(abandoned, "作られていないセッションを畳んでいる").toBe(0);
    });

    it("入れたときは、何も残さない", async () => {
      // **毎回鳴る警告にしない。** **成功した周回で 1 行でも出ると、そのうち読まれなくなる**
      const { reported, report } = recorder();
      const { port } = store();

      await completeLogin({
        setUp: async () => ({
          openStore: async () => port,
          refresh: async () => RENEWED,
          exchange: async () => PROVIDER,
          abandonSession: async () => {},
        }),
        report,
      });

      expect(reported, "成功した周回で記録している").toEqual([]);
    });
  });
});
