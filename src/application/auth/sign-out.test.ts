import { describe, expect, it } from "vitest";
import { signOut } from "./sign-out";

function recorder() {
  const order: string[] = [];
  return {
    order,
    store: {
      load: async () => undefined,
      save: async () => {},
      clear: async () => {
        order.push("clear");
      },
    },
    endSession: async () => {
      order.push("end-session");
    },
  };
}

describe("ログアウトする", () => {
  it("保存したトークンも消える", async () => {
    // **セッションだけ消してトークンが残ると、次のログインが古い行に当たる。**
    const { order, store, endSession } = recorder();

    await signOut({ store, endSession });

    expect(order).toContain("clear");
  });

  it("トークンを消してから、セッションを終える", async () => {
    // **順番が本体である。** **行が見えるのは本人の token を持っている間だけ**
    // （RLS）——**先にセッションを切ると、消せる者がいなくなって行が残る。**
    const { order, store, endSession } = recorder();

    await signOut({ store, endSession });

    expect(order).toEqual(["clear", "end-session"]);
  });

  it("消せなくても、セッションは終える", async () => {
    // **倒す先は 2 つある。** **消えないから居座らせる**と、
    // **ログアウトを押した人がログインしたまま**になる——そちらのほうが悪い。
    const order: string[] = [];

    await expect(
      signOut({
        store: {
          load: async () => undefined,
          save: async () => {},
          clear: async () => {
            throw new Error("だめ");
          },
        },
        endSession: async () => {
          order.push("end-session");
        },
      }),
    ).rejects.toThrow();

    expect(order, "セッションを終えていない").toEqual(["end-session"]);
  });
});
