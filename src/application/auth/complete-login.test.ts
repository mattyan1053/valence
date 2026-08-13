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
    });

    expect(result).toEqual({ kind: "signed-in" });
    expect(saved).toEqual([RENEWED]);
  });

  it("受け取ったものをそのまま保存しない", async () => {
    // **期限を推測して入れない。** **8 時間だろうと決め打つと、実際が短かった日に
    // 失効した token で GitHub を叩く**——**症状は 401 で、「権限が無い」と混ざる。**
    const { saved, port } = store();

    await completeLogin({ store: port, refresh: async () => RENEWED, provider: PROVIDER });

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
    });

    expect(result).toEqual({ kind: "needs-login" });
  });
});
