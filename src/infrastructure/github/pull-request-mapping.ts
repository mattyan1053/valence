/**
 * GitHub の PR 一覧（`GET /repos/{owner}/{repo}/pulls`）をドメイン型へ変換する。
 *
 * **境界の仕事は 2 つだけ。** 応答を Zod で検証することと、ドメインの型へ移すこと。
 * **通信はここに置かない。** 純粋関数のままにしておけば、実際の応答を貼ったテストで
 * 外部 I/O 無しに確かめられる。
 */

import { z } from "zod";
import type { PullRequestRef } from "../../domain/graph/dependency-graph";

/**
 * 変換の結果。
 *
 * **落ちたものを黙って捨てない。** 捨てると「取得できたが読めなかった」と
 * 「そもそも無かった」が区別できず、**依存が抜けた図が正しい顔で出る**。
 */
export type PullRequestMapping = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly invalid: readonly InvalidPullRequest[];
};

/** 検証に落ちた 1 件。 */
export type InvalidPullRequest = {
  /**
   * 応答の何件目か（0 始まり）。**番号ではなく位置で示す**のは、
   * 番号そのものが読めないことがあるためである。
   */
  readonly index: number;
  /** 何が読めなかったか。 */
  readonly reason: string;
};

/**
 * ブランチの参照。
 *
 * **`repo.id` をリポジトリの識別子にする。** ドメインは「同じ文字列なら同じリポジトリ」
 * としか決めていない（`BranchRef`）ので、境界が何を入れるかを決める。`id` は
 * **GitHub が振る不変の識別子**で、リポジトリ名や owner が変わっても変わらない。
 * `full_name` は表示のためのもので、**改名すると別のリポジトリが同じ名前を取れる**。
 */
const branchRefSchema = z.object({
  ref: z.string().min(1),
  repo: z.object({ id: z.number().int() }),
});

/**
 * 使う項目だけを検証する。
 *
 * 応答には他にも多くの項目が来るが、**使わないものまで型を固定すると、
 * GitHub 側の追加や変更で読めなくなる**。ここに書いたものが欠けたら落とす。
 */
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  base: branchRefSchema,
  head: branchRefSchema,
});

/**
 * 応答をドメインの型へ変換する。
 *
 * **一覧そのものが読めなければ落とす。** 空の配列を返すと、取得の失敗が
 * 「PR が 0 件」に化ける。1 件ずつの失敗とは別の話なので、扱いも分ける。
 */
export function toPullRequestRefs(response: unknown): PullRequestMapping {
  const listed = z.array(z.unknown()).safeParse(response);
  if (!listed.success) {
    throw new Error(`PR の一覧として読めません: ${z.prettifyError(listed.error)}`);
  }

  const pullRequests: PullRequestRef[] = [];
  const invalid: InvalidPullRequest[] = [];
  for (const [index, item] of listed.data.entries()) {
    const parsed = pullRequestSchema.safeParse(item);
    if (!parsed.success) {
      invalid.push({ index, reason: z.prettifyError(parsed.error) });
      continue;
    }
    pullRequests.push(toRef(parsed.data));
  }
  return { pullRequests, invalid };
}

function toRef(pullRequest: z.infer<typeof pullRequestSchema>): PullRequestRef {
  return {
    number: pullRequest.number,
    base: { repository: String(pullRequest.base.repo.id), branch: pullRequest.base.ref },
    head: { repository: String(pullRequest.head.repo.id), branch: pullRequest.head.ref },
  };
}
