import { describe, expect, it } from "vitest";
import { toChangeSummary } from "./change-summary-mapping";

const DETAIL = { changed_files: 3, additions: 10, deletions: 4 };
const FILES = [{ filename: "src/ui/button.tsx" }];
const PASSING = { check_runs: [{ status: "completed", conclusion: "success" }] };
/** Commit Status しか登録しないリポジトリもある。**既定は「信号なし」。** */
const NO_STATUSES = { state: "pending", statuses: [] };

describe("toChangeSummary", () => {
  it("実データの形から材料を組み立てる", () => {
    const result = toChangeSummary({
      detail: DETAIL,
      files: FILES,
      filesTruncated: false,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    expect(result).toEqual({
      ok: true,
      summary: {
        changedFileCount: 3,
        // **追加と削除を足す。** 片方だけだと、消しただけの大きな変更が小さく見える
        changedLineCount: 14,
        touchesSensitivePath: false,
        ciStatus: "passing",
      },
    });
  });

  it("影響が大きいパスの判定は domain のものを使う", () => {
    // **infrastructure で書き直さない。** 2 箇所に規則を持つと片方だけ古くなる
    const result = toChangeSummary({
      detail: DETAIL,
      files: [{ filename: "src/infrastructure/github/app-jwt.ts" }],
      filesTruncated: false,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    expect(result.ok && result.summary.touchesSensitivePath).toBe(true);
  });

  describe("CI の 3 状態", () => {
    it.each([
      [{ check_runs: [{ status: "completed", conclusion: "success" }] }, "passing"],
      [{ check_runs: [{ status: "completed", conclusion: "failure" }] }, "failing"],
      [{ check_runs: [{ status: "in_progress", conclusion: null }] }, "pending"],
      // **終わっているものと落ちているものが混ざれば落ちている**
      [
        {
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "failure" },
          ],
        },
        "failing",
      ],
      // **走っている途中で 1 つ落ちていれば、待っても直らない**
      [
        {
          check_runs: [
            { status: "in_progress", conclusion: null },
            { status: "completed", conclusion: "failure" },
          ],
        },
        "failing",
      ],
      // **1 件も無いのを passing にしない**（CI が動いていない PR が素通りする）
      [{ check_runs: [] }, "pending"],
      // **知らない結末を passing にしない。** `conclusion` は GitHub が増やす値で、
      // 増えたことを知る手立てがない（#114 の「列挙は必ず古くなる」と同じ）
      [{ check_runs: [{ status: "completed", conclusion: "stale" }] }, "failing"],
      [{ check_runs: [{ status: "completed", conclusion: "これから増える値" }] }, "failing"],
      // **通ったと見なすものは明示する**
      [{ check_runs: [{ status: "completed", conclusion: "skipped" }] }, "passing"],
      [{ check_runs: [{ status: "completed", conclusion: "neutral" }] }, "passing"],
    ])("%o は %s", (checks, expected) => {
      const result = toChangeSummary({
        detail: DETAIL,
        files: FILES,
        filesTruncated: false,
        checks,
        statuses: NO_STATUSES,
      });

      expect(result.ok && result.summary.ciStatus).toBe(expected);
    });
  });

  describe("Commit Status しか使わないリポジトリ", () => {
    // **道具立てを前提にしない**（`AGENTS.md` §1）。Checks API を使わず
    // Commit Status だけを登録する CI がある。**両方見て初めてどちらでも動く**
    function ciOf(checks: unknown, statuses: unknown): string | false {
      const result = toChangeSummary({
        detail: DETAIL,
        files: FILES,
        filesTruncated: false,
        checks,
        statuses,
      });
      return result.ok && result.summary.ciStatus;
    }

    it("check run が無くても、Commit Status が通っていれば passing", () => {
      expect(ciOf({ check_runs: [] }, { state: "success", statuses: [{ state: "success" }] })).toBe(
        "passing",
      );
    });

    it("Commit Status が落ちていれば failing", () => {
      expect(ciOf(PASSING, { state: "failure", statuses: [{ state: "failure" }] })).toBe("failing");
    });

    it("Commit Status が走っていれば pending", () => {
      expect(ciOf(PASSING, { state: "pending", statuses: [{ state: "pending" }] })).toBe("pending");
    });

    it("どちらにも信号が無ければ pending", () => {
      // **1 つも無いのを passing にしない**（CI が動いていない PR が素通りする）
      expect(ciOf({ check_runs: [] }, NO_STATUSES)).toBe("pending");
    });
  });

  describe("見ていないものを「無い」にしない", () => {
    it("見切れていて、影響が大きいパスが見つからなければ材料にしない", () => {
      // **「触れていない」と「見ていない」を混同しない**（#107 / #114 と同じ考え方）。
      // false を入れると、**見ていないだけの PR に「読まずにマージしてよい」と出る**
      const result = toChangeSummary({
        detail: DETAIL,
        files: FILES,
        filesTruncated: true,
        checks: PASSING,
        statuses: NO_STATUSES,
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/見切れ|多すぎ/);
    });

    it("見切れていても、見えた範囲で当たっていれば材料になる", () => {
      // **当たったことは確かである。** 残りを見なくても結論は変わらない
      const result = toChangeSummary({
        detail: DETAIL,
        files: [{ filename: ".env" }],
        filesTruncated: true,
        checks: PASSING,
        statuses: NO_STATUSES,
      });

      expect(result.ok && result.summary.touchesSensitivePath).toBe(true);
    });
  });

  it.each([
    ["詳細が読めない", { detail: { additions: 1 }, files: FILES, checks: PASSING }],
    ["ファイル一覧が読めない", { detail: DETAIL, files: [{ name: "x" }], checks: PASSING }],
    ["CI の応答が読めない", { detail: DETAIL, files: FILES, checks: { check_runs: "?" } }],
  ])("%s なら材料にしない", (_name, input) => {
    // **読めなかったものを推測で埋めない。** 埋めると、誤った Tier が理由つきで出る
    const result = toChangeSummary({ statuses: NO_STATUSES, ...input, filesTruncated: false });

    expect(result.ok).toBe(false);
  });
});
