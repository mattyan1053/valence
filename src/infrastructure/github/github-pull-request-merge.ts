/**
 * `PullRequestMerges` の GitHub 実装（#331）。
 *
 * **押した人のトークンで行う**（`AGENTS.md` §6）。**installation トークンで
 * 代用しない**——**あれで実行すると、保護ルールの「マージできる人」を迂回できる**
 * （**#330 で人が決めた条件と同じ形**）。
 *
 * **マージできない理由を、こちらで数え直さない。** **GitHub が断ったことだけを
 * 受け取る**——**コンフリクト・必須チェック・保護ルールの規則を写すと、
 * 写した側が古くなる**（§5）。
 *
 * **断られたのか、届かなかったのかは分ける。** **通信や権限の失敗を
 * 「まだマージできません」と伝えると、押した人は待てば直ると思う。**
 *
 * **検証済みのものだけを内側へ入れる**（§3）。
 */

import { z } from "zod";
import type {
  PullRequestMergeOutcome,
  PullRequestMerges,
  PullRequestMergeTarget,
} from "../../application/ports/pull-request-merge";
import { repositoryUrl } from "./repository-url";

/**
 * **試す順**（#331 のレビュー）。
 *
 * **方法を固定しない。** **このリポジトリは squash と決めてある**が、
 * **この製品は複数のインストール先を跨ぐ**（`AGENTS.md` §1）——
 * **squash を無効にしているリポジトリでは、書き込み権限があってマージ可能でも
 * すべて 405 になり、この機能を 1 度も使えない。** **しかも 405 を
 * `not-mergeable` に丸めるので、画面は「コンフリクトか必須チェックの問題」だと言う**
 * ——**事実でないことを伝えることになる。**
 *
 * **どれを優先するかは決めてよい**ので、**squash を第一候補にする**
 * （**このリポジトリの慣行**。`.claude/rules/git-workflow.md`）。
 * **選ばせるための設定項目は作らない**（§5 の YAGNI）——**要求ごとに解決するだけ**である。
 */
const MERGE_METHOD_PREFERENCE = ["squash", "merge", "rebase"] as const;

/**
 * そのリポジトリで許可されている方式。**要求ごとに引く**（§1）。
 *
 * **使う項目だけを検証する。** **欠けていたら読めなかったことにする**
 * ——**「許可されていない」と「読めなかった」を混ぜない。**
 */
const repositorySchema = z.object({
  allow_squash_merge: z.boolean(),
  allow_merge_commit: z.boolean(),
  allow_rebase_merge: z.boolean(),
});

/**
 * 使う項目だけを検証する。
 *
 * **`merged` まで見る。** **GitHub は `merged: false` を 200 で返すことがある**
 * ——**それを「マージしました」と出すと、入っていない PR が入った顔で並ぶ。**
 */
const mergeSchema = z.object({
  merged: z.boolean(),
});

/**
 * マージ直前に読み直す PR。**base だけを見る**（#350）。
 *
 * **依存判定は一覧を取った時点の base に対して行われる**ので、
 * **そのあと base が別の open PR の head へ張り替えられると、
 * `ready` と判定した要求が新しい土台へマージされる。**
 * **GitHub のマージ API に base を固定する引数は無い**（`sha` は head だけで、
 * GraphQL の `expectedHeadOid` も同じ）ので、**こちらで突き合わせるしかない。**
 */
const basedOnSchema = z.object({
  base: z.object({ ref: z.string().min(1) }),
});

/**
 * マージ要求の応答を、答えへ直す。
 *
 * **断られたのか、届かなかったのかを分ける**——**通信や権限の失敗を
 * 「まだマージできません」と伝えると、押した人は待てば直ると思う。**
 */
async function interpretMergeResponse(response: Response): Promise<PullRequestMergeOutcome> {
  if (!response.ok) {
    if (NOT_MERGEABLE_STATUSES.has(response.status)) {
      return { kind: "not-mergeable" };
    }
    throw new MergeFailed(response.status);
  }

  const parsed = mergeSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new MergeFailed(response.status);
  }
  // **`merged: false` を「マージしました」と言わない**
  return parsed.data.merged ? { kind: "merged" } : { kind: "not-mergeable" };
}

/** 応答から、試す順で最初に許可されている方式を選ぶ。 */
function allowedMethod(
  allowed: z.infer<typeof repositorySchema>,
): (typeof MERGE_METHOD_PREFERENCE)[number] | undefined {
  const enabled = {
    squash: allowed.allow_squash_merge,
    merge: allowed.allow_merge_commit,
    rebase: allowed.allow_rebase_merge,
  };
  return MERGE_METHOD_PREFERENCE.find((method) => enabled[method]);
}

/**
 * **GitHub が「いまはマージできない」と断ったときの状態コード。**
 *
 * - **405** — 整っていない（コンフリクト / 必須チェック / 保護ルール）
 * - **409** — head が動いた（**押している間に別の commit が入った**）
 *
 * **どちらも、押した人が次に取る行動は同じ**（**GitHub で PR を見に行く**）ので、
 * **分けない**——**分けようとすると、こちらが規則を写すことになる。**
 */
const NOT_MERGEABLE_STATUSES = new Set([405, 409]);

/**
 * 断られたときのエラー。
 *
 * **応答の中身を載せない**（§6）——**載せるのは状態コードだけ。**
 */
class MergeFailed extends Error {
  /**
   * **断られた状態コード** (#516)。**`message` ではなく欄として持つ**
   * ——**記録に残す側は `message` を読まない**（§6）ので、**文面へ埋めると消える。**
   *
   * **投げどころは 6 箇所**（**マージ・方式の設定・base の読み直し**）
   * **すべてこの形を通る**——**片方だけ載せると、どこで断られたかで見え方が変わる。**
   */
  readonly status: number;

  constructor(status: number) {
    super(`GitHub がマージを受け付けませんでした (status ${status})`);
    this.name = "MergeFailed";
    this.status = status;
  }
}

export type GitHubPullRequestMergesOptions = {
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
};

export function createGitHubPullRequestMerges({
  fetchImpl = fetch,
}: GitHubPullRequestMergesOptions = {}): PullRequestMerges {
  /**
   * **そのリポジトリで許可されている方式を引く。**
   *
   * **読めなければ投げる**——**「許可されていない」と混ぜない。**
   * **ユーザートークンで引く**（§6。**installation で代用しない**）。
   */
  async function methodFor(
    userAccessToken: string,
    repository: PullRequestMergeTarget["repository"],
  ): Promise<(typeof MERGE_METHOD_PREFERENCE)[number] | undefined> {
    const response = await fetchImpl(`${repositoryUrl(repository)}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
      },
    });
    if (!response.ok) {
      throw new MergeFailed(response.status);
    }
    const parsed = repositorySchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new MergeFailed(response.status);
    }
    return allowedMethod(parsed.data);
  }

  /**
   * **いまの base**（#350）。**読めなければ投げる**——**確かめられないまま
   * 通すと、この突き合わせが塞ごうとしたものがそのまま通る。**
   */
  async function baseBranchOf(
    userAccessToken: string,
    repository: PullRequestMergeTarget["repository"],
    number: number,
  ): Promise<string> {
    const response = await fetchImpl(`${repositoryUrl(repository)}/pulls/${number}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
      },
    });
    if (!response.ok) {
      throw new MergeFailed(response.status);
    }
    const parsed = basedOnSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new MergeFailed(response.status);
    }
    return parsed.data.base.ref;
  }

  return {
    async merge(
      userAccessToken: string,
      { repository, number, headSha, expectedBaseBranch }: PullRequestMergeTarget,
    ): Promise<PullRequestMergeOutcome> {
      const method = await methodFor(userAccessToken, repository);
      if (method === undefined) {
        // **どの方式も許可されていない。** **押した人が次にすることは
        // 「GitHub で見る」**なので、`not-mergeable` へ倒す——**故障ではない。**
        return { kind: "not-mergeable" };
      }

      // **base を読み直すのは、マージ要求の直前である**（#350）。
      // **間に別の往復を挟むと、そのぶん窓が広がる**ので、
      // **方式の解決（`methodFor`）より後に置く。**
      //
      // **窓は狭くなるだけで、消えない。** **残るのは
      // 「この読み直しの応答が GitHub を出てから、下のマージが GitHub で処理されるまで」**
      // ——**そこへ base の張り替えが入れば、やはり新しい土台へマージされる。**
      // **塞ぎ切る手は無い**（**マージ API に base を固定する引数が無い**）。
      // **一覧の staleness はリポジトリの大きさで伸びる**（ページングと集計）が、
      // **この読み直しは 1 件なので、窓の大きさが大きさに依らなくなる**
      // ——**それがこの往復 1 回ぶんのコストで買っているものである。**
      if ((await baseBranchOf(userAccessToken, repository, number)) !== expectedBaseBranch) {
        return { kind: "base-changed" };
      }

      const response = await fetchImpl(`${repositoryUrl(repository)}/pulls/${number}/merge`, {
        method: "PUT",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${userAccessToken}`,
          "content-type": "application/json",
        },
        // **`sha` を載せる**（#331 のレビュー）——**盤面を出してから押すまでに
        // push された変更を、確かめないままマージしない。**
        // **載せて初めて、GitHub が head の食い違いを 409 で返す**
        // （**載せなければ、下の 409 の分岐は原則として通らない**）。
        body: JSON.stringify({ merge_method: method, sha: headSha }),
      });

      return await interpretMergeResponse(response);
    },
  };
}
