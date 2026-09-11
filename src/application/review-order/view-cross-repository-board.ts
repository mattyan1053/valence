/**
 * **横断の盤面を、画面へ渡せる形にする**（#682）。
 *
 * **1 リポジトリの盤面（`viewRepositoryBoard`）と並ぶ**が、**出すものが違う。**
 * **ファイル変更に依るもの（Tier・同じファイルを触る組）と依存グラフは、
 * こちらには無い**——**口が材料を持っていない**（#681）ので、**出そうとすると
 * 往復が増えることに気づける。**
 *
 * **倒し分けは `listVisibleRepositories` と揃える**（ログインしていない / 入り直す /
 * 故障）——**行き先が違うものを 1 つにまとめない。**
 *
 * **「読めなかった」を画面の手前で捨てない。** **口が `unreadable` / `truncated` を
 * 分けて返す**（#681）ので、**ここはそのまま渡すだけ**である
 * ——**捨てると、盤面は静かに不完全になる。**
 */

import type { ResolvedVisibleRepositories } from "../auth/resolve-visible-repositories";
import { errorKind } from "../observability/error-kind";
import type {
  CrossRepositoryListing,
  CrossRepositoryPullRequests,
} from "../ports/cross-repository-pull-requests";

export type CrossRepositoryBoardResult =
  /** ログインしていない。**誰の権限も無いので、データを出さない**（§6）。 */
  | { readonly kind: "signed-out" }
  /** 失効していて、更新もできなかった。**入口へ戻す。** */
  | { readonly kind: "needs-login" }
  /**
   * **入り直しても直らない**（置き場が落ちている / 引けない）。
   *
   * **どこで落ちたかを添える**（#506 の 2-b）——**画面には出さない**（§6）。
   */
  | { readonly kind: "unavailable"; readonly reason?: string }
  | {
      readonly kind: "board";
      /** **口が返したもの**（#681）。**読めなかったぶんも入っている。** */
      readonly listing: CrossRepositoryListing;
      /**
       * **リポジトリの一覧の側で読めなかった行の数。**
       *
       * **横断の一覧にも出てこない**ので、**数だけでも残す**（§5）
       * ——**黙ると「そのリポジトリは無い」と読まれる。**
       */
      readonly unreadableRepositories: number;
    };

export type ViewCrossRepositoryBoardInput = {
  /**
   * **解決済みのもの**を受ける（#686 のレビュー）——**ここでは引かない。**
   *
   * **`/` は見えるリポジトリの一覧も出す**ので、**それぞれが引くと
   * `/user/repos` が二重**になる（**100 件を超えると全ページが二重**）。
   * **1 度引いて渡すのは `viewHome`** である。
   */
  readonly resolved: ResolvedVisibleRepositories;
  readonly pullRequests: CrossRepositoryPullRequests;
  /**
   * 打ち切りの合図を作る（`approvalsDeadline` と同じ形）。
   *
   * **どれだけ待つかは合成ルートの段取り**である——**`application` は時計を持たない。**
   */
  readonly deadline?: () => AbortSignal;
};

export async function viewCrossRepositoryBoard({
  resolved,
  pullRequests,
  deadline,
}: ViewCrossRepositoryBoardInput): Promise<CrossRepositoryBoardResult> {
  if (resolved.kind !== "resolved") {
    return resolved;
  }
  const { listing, userAccessToken } = resolved;
  const unreadableRepositories = listing.invalid.length;

  // **聞かれていなければ叩かない**——**空の一覧で往復を作らない**（#681 の口と同じ）
  if (listing.repositories.length === 0) {
    return {
      kind: "board",
      listing: { pullRequests: [], unavailable: [], invalid: [] },
      unreadableRepositories,
    };
  }

  try {
    return {
      kind: "board",
      listing: await pullRequests.list(userAccessToken, listing.repositories, {
        signal: deadline?.(),
      }),
      unreadableRepositories,
    };
  } catch (error) {
    // **空の一覧を返さない**——**故障が「open PR が 0 本」に化ける**
    return { kind: "unavailable", reason: `pull-requests/${errorKind(error)}` };
  }
}
