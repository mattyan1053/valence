/**
 * PR のリスク分類。
 *
 * MVP では LLM を使わず、決定論的に判断できる材料だけで分類する。
 * ここは純粋関数であり、GitHub API のレスポンス型ではなく自前の型を入力に取る。
 * 変換は infrastructure の責務。
 */

import { touchesSensitivePath } from "./sensitive-path";

export type RiskTier =
  /** 内容を読まずにマージしてよい。 */
  | "fast-track"
  /** 通常のレビューが要る。 */
  | "needs-review"
  /** 先に人間が見るべき。 */
  | "high-risk";

export type CiStatus = "passing" | "failing" | "pending";

/**
 * 変更されたファイルのパス。
 *
 * **一覧そのものを持つ。** 件数だけだと、**どのファイルを触ったかで決まること**
 * （影響が大きいパスか、他の PR と重なるか）が**この型より外でしか言えない**。
 *
 * **見えた範囲であることを、型で持つ。** GitHub の files API はページングするので、
 * 上限に当たれば**途中までの一覧**が返る。**それを全部だと読ませない**
 * ——**「読めなかった」を「無かった」にしない**（`AGENTS.md` §5）。
 */
export type ChangedPaths = {
  readonly paths: readonly string[];
  /** 上限に当たって**最後まで読んでいない**か。 */
  readonly truncated: boolean;
};

/** リスク判定に必要な、PR の変更内容の要約。 */
export type ChangeSummary = {
  readonly changedFileCount: number;
  readonly changedLineCount: number;
  /**
   * 変更されたファイル。
   *
   * **「影響が大きいパスに触れたか」を真偽値で持たない。** パスと真偽値を並べると、
   * **食い違う組み合わせを作れてしまう**——**同じことを 2 箇所で言って、
   * 片方が事実と違う**形である。**判定はここから導く。**
   */
  readonly changedPaths: ChangedPaths;
  readonly ciStatus: CiStatus;
};

/** これ以下なら「読まなくても分かる大きさ」とみなす。 */
const FAST_TRACK_MAX_FILES = 3;
const FAST_TRACK_MAX_LINES = 50;

export function classifyRiskTier(change: ChangeSummary): RiskTier {
  // **見えたパスだけで判定する。** 当たれば、**残りを見なくても結論は変わらない。**
  // **当たらなかったのに見切れている**ものをどう扱うかは、**材料を作る側が決める**
  // ——`ChangedPaths` が `truncated` を持っているのは、そこで判断できるようにするためである。
  if (change.ciStatus === "failing" || touchesSensitivePath(change.changedPaths.paths)) {
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
