import { describe, expect, it } from "vitest";
import type {
  MergePlanResult,
  MergePlanStep,
} from "../../../../../application/review-order/merge-plan";
import {
  planOutcomeParam,
  planStepsFrom,
  planUnavailableReason,
  respondToMergePlan,
} from "./route";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPOSITORY = { owner: "acme", name: "web" } as const;

function pressed(body: URLSearchParams): Request {
  return new Request("http://127.0.0.1:3940/repos/acme/web/merge-plan", {
    method: "POST",
    body,
    headers: { host: "127.0.0.1:3940" },
  });
}

function form(...steps: string[]): URLSearchParams {
  const body = new URLSearchParams();
  for (const step of steps) {
    body.append("step", step);
  }
  return body;
}

function deps(result: MergePlanResult) {
  const ran: (readonly MergePlanStep[])[] = [];
  const reported: string[] = [];
  return {
    ran,
    reported,
    run: async (_repository: unknown, steps: readonly MergePlanStep[]) => {
      ran.push(steps);
      return result;
    },
    report: (_action: "merge-plan", kind: string) => {
      reported.push(kind);
    },
  };
}

async function locationOf(body: URLSearchParams, result: MergePlanResult) {
  const runner = deps(result);
  const response = await respondToMergePlan(pressed(body), REPOSITORY, runner);
  return { runner, response, location: new URL(response.headers.get("location") ?? "") };
}

describe("planStepsFrom", () => {
  it("番号と commit の組を読む", () => {
    expect(planStepsFrom([`1:${SHA_A}`, `2:${SHA_B}`])).toEqual([
      { number: 1, headSha: SHA_A },
      { number: 2, headSha: SHA_B },
    ]);
  });

  it.each([
    ["commit が無い", ["1"]],
    ["commit の形が違う", ["1:abc"]],
    ["番号が数でない", [`x:${SHA_A}`]],
    ["1 本も無い", []],
  ])("%s なら、1 本も流さない", (_name, values) => {
    // **読めたぶんだけ流すと、見せていない並びで押すことになる**
    expect(planStepsFrom(values)).toBeUndefined();
  });

  it("1 本でも読めなければ、全部を捨てる", () => {
    // **止める側へ倒す**——**進むほうが取り返しがつかない**
    expect(planStepsFrom([`1:${SHA_A}`, "2:abc"])).toBeUndefined();
  });

  it("同じ PR を 2 度含む並びは、1 本も流さない", () => {
    // **番号が重なると、どの commit の話かが並びの中で 2 通りになる**（#665 のレビュー）
    // ——**片方が承認済みなら、もう片方も承認済みとして扱われうる**
    expect(planStepsFrom([`7:${SHA_A}`, `7:${SHA_B}`])).toBeUndefined();
  });

  it("同じ commit でも、番号が重なれば捨てる", () => {
    // **重なり自体を断つ**——**「同じだから害が無い」を数えに行かない**
    expect(planStepsFrom([`7:${SHA_A}`, `7:${SHA_A}`])).toBeUndefined();
  });
});

describe("planOutcomeParam", () => {
  it("全部入ったら、何も載せない", () => {
    // **成功をクエリ文字列から出さない**（#342 のレビュー）
    expect(planOutcomeParam({ kind: "ran", merged: [1, 2], remaining: [] })).toBeUndefined();
  });

  it("止まった理由と番号を載せる", () => {
    expect(
      planOutcomeParam({
        kind: "ran",
        merged: [1],
        stoppedAt: { number: 2, reason: "not-mergeable" },
        remaining: [2],
      }),
    ).toEqual({ value: "not-mergeable", at: 2 });
  });

  it("入った本数は載せない", () => {
    // **URL は利用者が作れる**——**「N 本入りました」は取り消せない事実の主張**
    const outcome = planOutcomeParam({
      kind: "ran",
      merged: [1, 2, 3],
      stoppedAt: { number: 4, reason: "base-changed" },
      remaining: [4],
    });

    expect(JSON.stringify(outcome)).not.toContain("3");
  });

  it("見えないリポジトリの存在を教えない", () => {
    expect(planOutcomeParam({ kind: "not-found" })).toEqual({ value: "unavailable" });
  });

  it("知らない理由は、まとめた語へ寄せる", () => {
    const outcome = planOutcomeParam({
      kind: "ran",
      merged: [],
      stoppedAt: { number: 1, reason: "signed-out" },
      remaining: [1],
    });

    expect(outcome).toEqual({ value: "unavailable", at: 1 });
  });
});

describe("respondToMergePlan", () => {
  it("読めない要求では、流しに行かない", async () => {
    const { runner, response } = await locationOf(form("1"), { kind: "nothing-to-run" });

    expect(runner.ran, "読めない並びで流している").toEqual([]);
    expect(response.status).toBe(303);
    expect(runner.reported).toEqual(["unreadable-request"]);
  });

  it("読めた並びを、そのまま渡す", async () => {
    const { runner } = await locationOf(form(`1:${SHA_A}`, `2:${SHA_B}`), {
      kind: "ran",
      merged: [1, 2],
      remaining: [],
    });

    expect(runner.ran).toEqual([
      [
        { number: 1, headSha: SHA_A },
        { number: 2, headSha: SHA_B },
      ],
    ]);
  });

  it("全部入ったら、注記を載せずに盤面へ戻す", async () => {
    const { location } = await locationOf(form(`1:${SHA_A}`), {
      kind: "ran",
      merged: [1],
      remaining: [],
    });

    expect(location.searchParams.get("plan")).toBeNull();
    expect(location.pathname).toBe("/repos/acme/web");
  });

  it("止まったら、理由と番号を載せて戻す", async () => {
    const { location } = await locationOf(form(`1:${SHA_A}`, `2:${SHA_B}`), {
      kind: "ran",
      merged: [1],
      stoppedAt: { number: 2, reason: "not-approved" },
      remaining: [2],
    });

    expect(location.searchParams.get("plan")).toBe("not-approved");
    expect(location.searchParams.get("plan-at")).toBe("2");
  });

  it("押した人へ理由が届いているものは、記録に残さない", async () => {
    const { runner } = await locationOf(form(`1:${SHA_A}`), {
      kind: "ran",
      merged: [],
      stoppedAt: { number: 1, reason: "not-mergeable" },
      remaining: [1],
    });

    expect(runner.reported).toEqual([]);
  });

  it("まとめた語は、まとめる前の形で記録に残す", async () => {
    // **`unavailable` は 4 つをまとめた語**（#506 の 2）
    const { runner } = await locationOf(form(`1:${SHA_A}`), {
      kind: "unavailable",
      reason: "approvals/network",
    });

    expect(runner.reported).toEqual(["unavailable/approvals/network"]);
  });

  it("重なった並びは、流しに行かない", async () => {
    const { runner } = await locationOf(form(`7:${SHA_A}`, `7:${SHA_B}`), {
      kind: "nothing-to-run",
    });

    expect(runner.ran, "重なった並びで流している").toEqual([]);
    expect(runner.reported).toEqual(["unreadable-request"]);
  });
});

describe("planUnavailableReason", () => {
  it("止まった理由が語彙に無いときも、記録には残す", () => {
    expect(
      planUnavailableReason({
        kind: "ran",
        merged: [],
        stoppedAt: { number: 1, reason: "needs-login" },
        remaining: [1],
      }),
    ).toBe("stopped/needs-login");
  });

  it("落ちどころも一緒に残す", () => {
    // **握り潰した例外の落ちどころを添える**（#506 の 2-b）
    expect(
      planUnavailableReason({
        kind: "ran",
        merged: [1],
        stoppedAt: { number: 2, reason: "unavailable", detail: "approvals/network" },
        remaining: [2],
      }),
    ).toBe("stopped/unavailable/approvals/network");
  });

  it("届いている理由は残さない", () => {
    expect(
      planUnavailableReason({
        kind: "ran",
        merged: [],
        stoppedAt: { number: 1, reason: "forbidden" },
        remaining: [1],
      }),
    ).toBeUndefined();
  });
});

describe("絞ったまま、プランを流す（#667）", () => {
  function withBall(ball: string, ...steps: string[]): URLSearchParams {
    const body = form(...steps);
    body.append("ball", ball);
    return body;
  }

  it("いま選んでいる絞りを、戻り先へ持ち越す", async () => {
    const { location } = await locationOf(withBall("merger", `1:${SHA_A}`), {
      kind: "ran",
      merged: [1],
      remaining: [],
    });

    expect(location.searchParams.get("ball")).toBe("merger");
  });

  it("止まった理由と、一緒に持ち越す", async () => {
    const { location } = await locationOf(withBall("author", `1:${SHA_A}`), {
      kind: "ran",
      merged: [],
      stoppedAt: { number: 1, reason: "not-approved" },
      remaining: [1],
    });

    expect(location.searchParams.get("plan")).toBe("not-approved");
    expect(location.searchParams.get("ball")).toBe("author");
  });

  it("画面に無い絞りは、載せない", async () => {
    const { location } = await locationOf(withBall("everyone", `1:${SHA_A}`), {
      kind: "ran",
      merged: [1],
      remaining: [],
    });

    expect(location.searchParams.get("ball")).toBeNull();
  });

  it("読めない要求でも、絞りは残る", async () => {
    const { location } = await locationOf(withBall("merger", "1"), {
      kind: "ran",
      merged: [],
      remaining: [],
    });

    expect(location.searchParams.get("ball")).toBe("merger");
  });
});
