/**
 * PR のリスク分類。
 *
 * MVP では LLM を使わず、決定論的に判断できる材料だけで分類する。
 * ここは純粋関数であり、GitHub API のレスポンス型ではなく自前の型を入力に取る。
 * 変換は infrastructure の責務。
 */

export type RiskTier =
  /** 内容を読まずにマージしてよい。 */
  | "fast-track"
  /** 通常のレビューが要る。 */
  | "needs-review"
  /** 先に人間が見るべき。 */
  | "high-risk";

export type CiStatus = "passing" | "failing" | "pending";

/** リスク判定に必要な、PR の変更内容の要約。 */
export type ChangeSummary = {
  readonly changedFileCount: number;
  readonly changedLineCount: number;
  /** 認証・課金・インフラ設定など、壊すと影響が大きいパスに触れているか。 */
  readonly touchesSensitivePath: boolean;
  readonly ciStatus: CiStatus;
};

/** これ以下なら「読まなくても分かる大きさ」とみなす。 */
const FAST_TRACK_MAX_FILES = 3;
const FAST_TRACK_MAX_LINES = 50;

export function classifyRiskTier(change: ChangeSummary): RiskTier {
  if (change.ciStatus === "failing" || change.touchesSensitivePath) {
    return "high-risk";
  }

  // CI が終わっていない PR は、小さくても素通しにしない。
  if (change.ciStatus === "pending") {
    return "needs-review";
  }

  const isSmall =
    change.changedFileCount <= FAST_TRACK_MAX_FILES &&
    change.changedLineCount <= FAST_TRACK_MAX_LINES;

  return isSmall ? "fast-track" : "needs-review";
}
