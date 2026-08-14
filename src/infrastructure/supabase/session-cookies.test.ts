/**
 * **更新された Cookie が、行くべき 2 か所へ行くか** (#214)。
 *
 * **倒す先は 2 つある。**
 *
 *   **ブラウザへ行かない** … 次の要求でまた失効し、**入り直しても直らない**
 *   **この要求の続きへ行かない** … 同じ要求の中で、**画面だけが古い Cookie を読む**
 *
 * **片方だけ見ると、両方の向きで緑になる形が残る。**
 */

import { describe, expect, it } from "vitest";
import { sessionCookiesFor } from "./session-cookies";

type Step = { where: "request" | "browser" | "renew"; name?: string; value?: string };

/** 呼ばれ方も見る。**何を、どの順で、どこへ書いたか。** */
function sinks(initial: { name: string; value: string }[]) {
  const steps: Step[] = [];
  return {
    steps,
    sinks: {
      read: () => initial,
      toRequest: ({ name, value }: { name: string; value: string }) => {
        steps.push({ where: "request", name, value });
      },
      renew: () => {
        steps.push({ where: "renew" });
      },
      toBrowser: ({ name, value }: { name: string; value: string }) => {
        steps.push({ where: "browser", name, value });
      },
    },
  };
}

describe("更新された Cookie を、続きとブラウザの両方へ渡す", () => {
  it("持ってきたものをそのまま読ませる", () => {
    const { sinks: sink } = sinks([{ name: "sb-access", value: "old" }]);

    expect(sessionCookiesFor(sink).getAll()).toEqual([{ name: "sb-access", value: "old" }]);
  });

  it("更新された 1 組は、両方へ行く", () => {
    // **ブラウザにだけ書くと、この要求の画面が古いまま読む**——
    // **要求の続きにだけ書くと、次の要求でまた失効する。**
    const { steps, sinks: sink } = sinks([]);

    sessionCookiesFor(sink).setAll([
      { name: "sb-access", value: "new", options: { httpOnly: true } },
      { name: "sb-refresh", value: "next" },
    ]);

    expect(steps.filter((step) => step.where === "request")).toEqual([
      { where: "request", name: "sb-access", value: "new" },
      { where: "request", name: "sb-refresh", value: "next" },
    ]);
    expect(steps.filter((step) => step.where === "browser")).toEqual([
      { where: "browser", name: "sb-access", value: "new" },
      { where: "browser", name: "sb-refresh", value: "next" },
    ]);
  });

  it("応答は、要求を差し替えた後・ブラウザへ書く前に作り直す", () => {
    // **作り直しは順序がすべて。** **先に作ると差し替えた Cookie が入らず、
    // 後に作るとブラウザへ書いたものが捨てられる**——**どちらも「書いた」ようには見える。**
    const { steps, sinks: sink } = sinks([]);

    sessionCookiesFor(sink).setAll([{ name: "sb-access", value: "new" }]);

    expect(steps.map((step) => step.where)).toEqual(["request", "renew", "browser"]);
  });

  it("更新が空なら、作り直さない", () => {
    // **毎回作り直すと、何も変わっていない要求まで応答を組み直す**
    const { steps, sinks: sink } = sinks([]);

    sessionCookiesFor(sink).setAll([]);

    expect(steps).toEqual([]);
  });

  it("options はブラウザへ渡す", () => {
    // **`httpOnly` や `maxAge` が落ちると、置かれ方が変わる**
    const seen: unknown[] = [];
    const cookies = sessionCookiesFor({
      read: () => [],
      toRequest: () => {},
      renew: () => {},
      toBrowser: (cookie) => {
        seen.push(cookie.options);
      },
    });

    cookies.setAll([{ name: "sb-access", value: "new", options: { httpOnly: true, maxAge: 60 } }]);

    expect(seen).toEqual([{ httpOnly: true, maxAge: 60 }]);
  });
});
