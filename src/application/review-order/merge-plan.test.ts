import { describe, expect, it } from "vitest";
import type {
  PullRequestApprovalListing,
  PullRequestApprovals,
} from "../ports/pull-request-approvals";
import type { RepositoryPermissions } from "../ports/repository-permissions";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import type { MergePlanInput, MergePlanStep } from "./merge-plan";
import { mergePlan } from "./merge-plan";
import type { MergePullRequestResult } from "./merge-pull-request";

const TARGET = { owner: "acme", name: "web" } as const;
const VISIBLE: VisibleRepositoryListing = { repositories: [TARGET], invalid: [] };

function repositories(): VisibleRepositories {
  return { list: async () => VISIBLE };
}

const PERMISSIONS: RepositoryPermissions = { levelFor: async () => "write" };

function approvals(approved: readonly number[]): PullRequestApprovals & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async listApprovals(userAccessToken): Promise<PullRequestApprovalListing> {
      seen.push(userAccessToken);
      return { approved: new Set(approved), unavailable: [] };
    },
  };
}

/** 呼ばれるたびに答えが変わる口。**流している最中に承認が外れる**形を作る。 */
function approvalsChanging(
  answers: readonly (readonly number[])[],
): PullRequestApprovals & { asked: [number, string][][] } {
  const asked: [number, string][][] = [];
  return {
    asked,
    async listApprovals(_token, _repository, heads): Promise<PullRequestApprovalListing> {
      const answer = answers[asked.length] ?? [];
      asked.push([...heads]);
      return { approved: new Set(answer), unavailable: [] };
    },
  };
}

const STEPS: readonly MergePlanStep[] = [
  { number: 1, headSha: "a".repeat(40) },
  { number: 2, headSha: "b".repeat(40) },
  { number: 3, headSha: "c".repeat(40) },
];

/** どの PR で何を返すか。**押した順も控える。** */
function merges(results: Partial<Record<number, MergePullRequestResult>> = {}) {
  const pressed: number[] = [];
  return {
    pressed,
    merge: async (step: MergePlanStep): Promise<MergePullRequestResult> => {
      pressed.push(step.number);
      return results[step.number] ?? { kind: "merged" };
    },
  };
}

function input(overrides: Partial<MergePlanInput> = {}): MergePlanInput {
  return {
    repository: TARGET,
    steps: STEPS,
    openStore: async () => ({}) as unknown as UserTokenStore,
    ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
    repositories: repositories(),
    permissions: PERMISSIONS,
    approvals: approvals([1, 2, 3]),
    merge: merges().merge,
    ...overrides,
  };
}

describe("mergePlan", () => {
  it("依存の順に、1 本ずつ入れる", async () => {
    const runner = merges();

    const result = await mergePlan(input({ merge: runner.merge }));

    expect(runner.pressed, "並びが渡した順と違う").toEqual([1, 2, 3]);
    expect(result).toEqual({ kind: "ran", merged: [1, 2, 3], remaining: [] });
  });

  it("落ちたら、そこで止めて残りを流さない", async () => {
    // **進むほうが取り返しがつかない**——**マージは取り消せない**
    const runner = merges({ 2: { kind: "not-mergeable" } });

    const result = await mergePlan(input({ merge: runner.merge }));

    expect(runner.pressed, "止まっていない").toEqual([1, 2]);
    expect(result).toEqual({
      kind: "ran",
      merged: [1],
      stoppedAt: { number: 2, reason: "not-mergeable" },
      remaining: [2, 3],
    });
  });

  it("止まった PR も、残りに数える", async () => {
    // **「入っていない」ものは、押した本人にも同じに見える**
    const runner = merges({ 1: { kind: "dependency-pending", blockedBy: [9] } });

    const result = await mergePlan(input({ merge: runner.merge }));

    expect(result.kind === "ran" && result.remaining).toEqual([1, 2, 3]);
    expect(result.kind === "ran" && result.merged).toEqual([]);
  });

  it("見せた commit を承認していない PR は、押しに行かない", async () => {
    // **「順に流す」は、まとめて承認を信じることになる**（#635）
    // ——**承認は commit に付く**ので、**そのあとに push されたものは誰も読んでいない**
    const runner = merges();

    const result = await mergePlan(input({ approvals: approvals([1, 3]), merge: runner.merge }));

    expect(runner.pressed, "承認されていない head を押している").toEqual([1]);
    expect(result).toEqual({
      kind: "ran",
      merged: [1],
      stoppedAt: { number: 2, reason: "not-approved" },
      remaining: [2, 3],
    });
  });

  it("承認を、入れる直前に、その 1 本の commit で問い合わせる", async () => {
    // **番号だけで聞くと、口は「どの差分の話か」を知らないまま答える**（#635）。
    // **1 本ずつ聞く**——**まとめて先に聞くと、流している間に外れた承認を見逃す**
    const reader = approvalsChanging([[1], [2], [3]]);

    await mergePlan(input({ approvals: reader }));

    expect(reader.asked).toEqual(STEPS.map((step) => [[step.number, step.headSha]]));
  });

  it("流している間に承認が外れたら、そこで止まる", async () => {
    // **マージは取り消せない**——**古い答えを信じて進まない**（#665 のレビュー）
    const runner = merges();
    // **1 本目は承認済み。2 本目を聞くときには外れている**
    const reader = approvalsChanging([[1, 2, 3], []]);

    const result = await mergePlan(input({ approvals: reader, merge: runner.merge }));

    expect(runner.pressed).toEqual([1]);
    expect(result).toEqual({
      kind: "ran",
      merged: [1],
      stoppedAt: { number: 2, reason: "not-approved" },
      remaining: [2, 3],
    });
  });

  it("途中で承認を読めなくなっても、どこまで進んだかを言う", async () => {
    // **「1 本も入っていない」と「2 本目で止まった」は別の状態**（#191 のレビュー）
    const runner = merges();
    let asked = 0;
    const flaky: PullRequestApprovals = {
      async listApprovals() {
        asked += 1;
        if (asked > 1) {
          throw new Error("承認の状態を取得できませんでした (HTTP 502)");
        }
        return { approved: new Set([1]), unavailable: [] };
      },
    };

    const result = await mergePlan(input({ approvals: flaky, merge: runner.merge }));

    expect(runner.pressed).toEqual([1]);
    expect(result.kind === "ran" && result.merged).toEqual([1]);
    expect(result.kind === "ran" && result.stoppedAt?.number).toBe(2);
    expect(result.kind === "ran" && result.stoppedAt?.reason).toBe("unavailable");
    expect(result.kind === "ran" && result.stoppedAt?.detail, "落ちどころが消えている").toMatch(
      /approvals\//,
    );
  });

  it("口が「読めなかった」と言った PR を、未承認と言わない", async () => {
    // **口は投げるとは限らない**——**閉じた PR や一覧から落ちたものは
    // `unavailable` に入って返る**（#665 のレビュー）。**`approved` だけを見ると、
    // 「読めなかった」が「承認されていない」に化ける**（この口が消しに来た形である）
    const runner = merges();
    const silent: PullRequestApprovals = {
      async listApprovals(_token, _repository, heads): Promise<PullRequestApprovalListing> {
        const [number = 0] = [...heads.keys()];
        return number === 2
          ? {
              approved: new Set(),
              unavailable: [
                { pullRequestNumber: 2, reason: "開いている PR の一覧に見つかりませんでした" },
              ],
            }
          : { approved: new Set([number]), unavailable: [] };
      },
    };

    const result = await mergePlan(input({ approvals: silent, merge: runner.merge }));

    expect(runner.pressed, "読めていない PR を押している").toEqual([1]);
    expect(result.kind === "ran" && result.merged).toEqual([1]);
    expect(result.kind === "ran" && result.stoppedAt?.number).toBe(2);
    expect(result.kind === "ran" && result.stoppedAt?.reason, "未承認へ倒れている").toBe(
      "unavailable",
    );
    expect(result.kind === "ran" && result.stoppedAt?.detail, "落ちどころが残っていない").toMatch(
      /approvals\//,
    );
    expect(result.kind === "ran" && result.remaining).toEqual([2, 3]);
  });

  it("承認を読めなければ、1 本も押さない", async () => {
    // **読めなかったものを「承認されていない」とも「承認済み」とも言わない**
    // ——**止める側へ倒す**
    const runner = merges();
    const down: PullRequestApprovals = {
      async listApprovals() {
        throw new Error("承認の状態を取得できませんでした (HTTP 502)");
      },
    };

    const result = await mergePlan(input({ approvals: down, merge: runner.merge }));

    expect(runner.pressed).toEqual([]);
    expect(result.kind === "ran" && result.merged).toEqual([]);
    expect(result.kind === "ran" && result.stoppedAt?.reason).toBe("unavailable");
  });

  it("押してよいと分かるまで、承認もマージも呼ばない", async () => {
    // **認可が先である**（`AGENTS.md` §6）
    const runner = merges();
    const reader = approvals([1, 2, 3]);

    const result = await mergePlan(
      input({ openStore: async () => undefined, approvals: reader, merge: runner.merge }),
    );

    expect(result.kind).toBe("signed-out");
    expect(reader.seen, "承認を読みに行っている").toEqual([]);
    expect(runner.pressed, "マージを呼んでいる").toEqual([]);
  });

  it("書き込みの権限が無ければ、1 本も押さない", async () => {
    const runner = merges();

    const result = await mergePlan(
      input({ permissions: { levelFor: async () => "read" }, merge: runner.merge }),
    );

    expect(result.kind).toBe("forbidden");
    expect(runner.pressed).toEqual([]);
  });

  it("流すものが 1 本も無ければ、そう言う", async () => {
    // **「0 本入った」と「流せるものが無かった」を混ぜない**
    const runner = merges();

    const result = await mergePlan(input({ steps: [], merge: runner.merge }));

    expect(result).toEqual({ kind: "nothing-to-run" });
    expect(runner.pressed).toEqual([]);
  });
});
