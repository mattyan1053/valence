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

  it("承認を、見せた commit で問い合わせる", async () => {
    // **番号だけで聞くと、口は「どの差分の話か」を知らないまま答える**（#635）
    const asked: [number, string][][] = [];
    const reader: PullRequestApprovals = {
      async listApprovals(_token, _repository, heads) {
        asked.push([...heads]);
        return { approved: new Set([1, 2, 3]), unavailable: [] };
      },
    };

    await mergePlan(input({ approvals: reader }));

    expect(asked).toEqual([STEPS.map((step) => [step.number, step.headSha])]);
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
    expect(result.kind).toBe("unavailable");
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
