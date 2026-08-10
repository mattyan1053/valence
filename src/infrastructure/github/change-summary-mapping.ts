/**
 * GitHub の応答からリスク判定の材料（`ChangeSummary`）を組み立てる。
 *
 * **境界の仕事は 2 つだけ。** 応答を Zod で検証することと、ドメインの型へ移すこと。
 * **通信はここに置かない**（`pull-request-mapping` と同じ形）。
 *
 * **影響が大きいパスの判定は `domain` のものを呼ぶ。** ここで書き直すと、
 * 規則が 2 箇所になって片方だけ古くなる。
 */

import { z } from "zod";
import type { ChangeSummary, CiStatus } from "../../domain/triage/risk-tier";
import { touchesSensitivePath } from "../../domain/triage/sensitive-path";

/** 材料にできたか。**できなかった理由は捨てない**（画面が「材料が無い」と出す）。 */
export type ChangeSummaryResult =
  | { readonly ok: true; readonly summary: ChangeSummary }
  | { readonly ok: false; readonly reason: string };

export type ChangeSummaryInput = {
  /** `GET /repos/{owner}/{repo}/pulls/{number}` */
  readonly detail: unknown;
  /** `GET /repos/{owner}/{repo}/pulls/{number}/files`（読めたぶん） */
  readonly files: readonly unknown[];
  /** 上限に当たって**最後まで読んでいない**か。 */
  readonly filesTruncated: boolean;
  /** `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` */
  readonly checks: unknown;
};

const detailSchema = z.object({
  changed_files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

const filesSchema = z.array(z.object({ filename: z.string().min(1) }));

/**
 * **`status` と `conclusion` の両方を見る。** `conclusion` は終わるまで `null` で、
 * そこだけ見ると**走っている途中を「落ちていない」と読む**。
 */
const checksSchema = z.object({
  check_runs: z.array(
    z.object({
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});

/** 落ちたと見なす結末。**「成功以外はすべて」にしない**（skipped まで落ちたことになる）。 */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/**
 * **3 つを潰さない。** `pending` は待てば済み、`failing` は直さないと進まない——
 * 表示側（#110）が分けている区別なので、ここで丸めると意味が無くなる。
 *
 * **1 件も無いものを `passing` にしない。** CI が動いていない PR が素通りする。
 */
function toCiStatus(runs: readonly { status: string; conclusion: string | null }[]): CiStatus {
  if (runs.some((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion))) {
    return "failing";
  }
  if (runs.length === 0 || runs.some((run) => run.status !== "completed")) {
    return "pending";
  }
  return "passing";
}

export function toChangeSummary(input: ChangeSummaryInput): ChangeSummaryResult {
  const detail = detailSchema.safeParse(input.detail);
  if (!detail.success) {
    return { ok: false, reason: `PR の詳細を読めません: ${z.prettifyError(detail.error)}` };
  }
  const files = filesSchema.safeParse(input.files);
  if (!files.success) {
    return { ok: false, reason: `変更ファイルの一覧を読めません: ${z.prettifyError(files.error)}` };
  }
  const checks = checksSchema.safeParse(input.checks);
  if (!checks.success) {
    return { ok: false, reason: `CI の状態を読めません: ${z.prettifyError(checks.error)}` };
  }

  const touches = touchesSensitivePath(files.data.map((file) => file.filename));
  // **「触れていない」と「見ていない」を混同しない。** 見切れたうえで当たらなかったのは
  // 「無い」ではないので、**材料にしない**（画面は行を残して「材料が無い」と出す）。
  // 当たったほうは、残りを見なくても結論が変わらないので材料にしてよい。
  if (!touches && input.filesTruncated) {
    return {
      ok: false,
      reason: "変更ファイルが多すぎて最後まで見切れませんでした（影響の大きいパスの有無が不明）",
    };
  }

  return {
    ok: true,
    summary: {
      changedFileCount: detail.data.changed_files,
      // **追加と削除を足す。** 片方だけだと、消しただけの大きな変更が小さく見える
      changedLineCount: detail.data.additions + detail.data.deletions,
      touchesSensitivePath: touches,
      ciStatus: toCiStatus(checks.data.check_runs),
    },
  };
}
