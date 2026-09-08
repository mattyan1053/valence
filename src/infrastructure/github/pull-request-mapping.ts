/**
 * GitHub の PR 一覧（`GET /repos/{owner}/{repo}/pulls`）をドメイン型へ変換する。
 *
 * **境界の仕事は 2 つだけ。** 応答を Zod で検証することと、ドメインの型へ移すこと。
 * **通信はここに置かない。** 純粋関数のままにしておけば、実際の応答を貼ったテストで
 * 外部 I/O 無しに確かめられる。
 */

import { z } from "zod";
import type {
  InvalidPullRequest,
  ListedPullRequests,
} from "../../application/ports/pull-request-source";
import type { PullRequestRef } from "../../domain/graph/dependency-graph";
import type { Assignment } from "../../domain/triage/assignment";

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
 * head だけは commit も読む（#331 のレビュー）。
 *
 * **マージは「見せたもの」に固定する**——**盤面を出してから押すまでに push されると、
 * 利用者が確かめていない head がマージされる。** **その commit を要求に載せるため、
 * ここで拾う。**
 *
 * **必須にしない。** **必須にすると、commit を読めなかった PR が
 * 依存グラフからまるごと消える**——**盤面の本体は依存の図**であって、
 * **マージのボタンはその上に載っているだけ**である（#107 と同じ判断）。
 * **読めなければ、その行のマージだけができない。**
 */
const headRefSchema = branchRefSchema.extend({
  sha: z.string().min(1).optional(),
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
  head: headRefSchema,
  /**
   * **タイトルも読む**（#542）。**必須にしない**——**`head.sha` と同じ理由**で、
   * **読めなかった PR が依存グラフからまるごと消える**のを避ける。
   *
   * **空文字は「無い」へ寄せる**——**残すと、表示の側で「短いタイトル」と
   * 「取れなかった」が見分けられなくなる。**
   *
   * **飲み込むのは空文字だけ**である（#543 のレビュー）。**`catch` で包むと
   * 型の誤りまで飲み込み**、**GitHub が形を変えた日に、全部の箱が黙って
   * 「タイトル不明」になって `invalid` にも出ない**——**「読めなかった」が
   * 「無かった」に化ける**（#521 の裏返し）。**形が違うぶんは `head.sha` と
   * 同じく `invalid` へ行かせる。**
   */
  title: z
    .string()
    .optional()
    .transform((title) => (title === "" ? undefined : title)),
});

/**
 * 誰に振られているか（#631）。
 *
 * **一覧の応答がそのまま持っている**ので、**取りに行く往復は要らない。**
 *
 * **まとめて任意にする。** **`assignees` だけ在って `requested_reviewers` が
 * 読めない、という半端な形を作らない**——**片方だけで「誰にも出ていない」と
 * 言うことになる。** **読めなければ、その PR は地図に入らない**
 * （**`assignmentStateOf` が `unknown` へ倒す**）。
 *
 * **`user.type` で bot を見る。** **login の `[bot]` で判定しない**
 * ——**人が同じ名前を付けられる。**
 */
const assignmentSchema = z.object({
  assignees: z.array(z.object({ login: z.string().min(1) })),
  requested_reviewers: z.array(z.object({ login: z.string().min(1) })),
  requested_teams: z.array(z.object({ slug: z.string().min(1) })),
  user: z.object({ type: z.string() }),
});

/**
 * 応答をドメインの型へ変換する。
 *
 * **一覧そのものが読めなければ落とす。** 空の配列を返すと、取得の失敗が
 * 「PR が 0 件」に化ける。1 件ずつの失敗とは別の話なので、扱いも分ける。
 */
export function toPullRequestRefs(response: unknown): ListedPullRequests {
  const listed = z.array(z.unknown()).safeParse(response);
  if (!listed.success) {
    throw new Error(`PR の一覧として読めません: ${z.prettifyError(listed.error)}`);
  }

  const pullRequests: PullRequestRef[] = [];
  const invalid: InvalidPullRequest[] = [];
  // **番号から引ける形で持つ**（`changes` と同じ形）——**依存を決める型
  // （`PullRequestRef`）へ足さない。** **あれは「依存を決めるのに要る最小限」**である
  const heads = new Map<number, string>();
  // **タイトルも同じ形で持つ**（#542）——**`PullRequestRef` は依存を決める型のまま**
  const titles = new Map<number, string>();
  // **誰に振られているかも同じ形**（#631）——**読めなかった PR は入らない**
  const assignments = new Map<number, Assignment>();
  for (const [index, item] of listed.data.entries()) {
    const parsed = pullRequestSchema.safeParse(item);
    if (!parsed.success) {
      invalid.push({ index, reason: z.prettifyError(parsed.error) });
      continue;
    }
    pullRequests.push(toRef(parsed.data));
    if (parsed.data.head.sha !== undefined) {
      heads.set(parsed.data.number, parsed.data.head.sha);
    }
    if (parsed.data.title !== undefined) {
      titles.set(parsed.data.number, parsed.data.title);
    }
    // **本体とは別に検証する**（#631）——**ここが読めなくても、依存グラフは出す**
    // （**`head.sha` と同じ判断**）
    const people = assignmentSchema.safeParse(item);
    if (people.success) {
      assignments.set(parsed.data.number, toAssignment(people.data));
    }
  }
  return { pullRequests, invalid, heads, titles, assignments };
}

function toAssignment(people: z.infer<typeof assignmentSchema>): Assignment {
  return {
    assignees: people.assignees.map((assignee) => assignee.login),
    // **個人と team を 1 つに並べる**——**どちらも「誰かに出ている」**である
    reviewers: [
      ...people.requested_reviewers.map((reviewer) => reviewer.login),
      ...people.requested_teams.map((team) => team.slug),
    ],
    authoredByBot: people.user.type === "Bot",
  };
}

function toRef(pullRequest: z.infer<typeof pullRequestSchema>): PullRequestRef {
  return {
    number: pullRequest.number,
    base: { repository: String(pullRequest.base.repo.id), branch: pullRequest.base.ref },
    head: { repository: String(pullRequest.head.repo.id), branch: pullRequest.head.ref },
  };
}
