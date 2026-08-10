import { describe, expect, it } from "vitest";
import { toChangeSummary } from "./change-summary-mapping";

const DETAIL = { changed_files: 3, additions: 10, deletions: 4 };
const FILES = [{ filename: "src/ui/button.tsx" }];
const PASSING = { check_runs: [{ status: "completed", conclusion: "success" }] };

describe("toChangeSummary", () => {
  it("実データの形から材料を組み立てる", () => {
    const result = toChangeSummary({
      detail: DETAIL,
      files: FILES,
      filesTruncated: false,
      checks: PASSING,
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
    ])("%o は %s", (checks, expected) => {
      const result = toChangeSummary({
        detail: DETAIL,
        files: FILES,
        filesTruncated: false,
        checks,
      });

      expect(result.ok && result.summary.ciStatus).toBe(expected);
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
    const result = toChangeSummary({ ...input, filesTruncated: false });

    expect(result.ok).toBe(false);
  });
});
