import { describe, expect, it } from "vitest";
import { buildDependencyEdges } from "../../domain/graph/dependency-graph";
import { toPullRequestRefs } from "./pull-request-mapping";

/**
 * GitHub の実際の応答（`GET /repos/{owner}/{repo}/pulls`）から、使う項目を抜いたもの。
 * **手で書いた理想形だけだと、実物とずれていても気づけない。**
 * 値はこのリポジトリの #8 / #9（実際に積まれていた 2 本）をそのまま使っている。
 */
const stackedPullRequests = [
  {
    number: 8,
    state: "closed",
    title: "コンテナ周りの改善",
    base: {
      label: "mattyan1053:main",
      ref: "main",
      sha: "9fc0f70e0ef97446de9166febce546e955675bc3",
      repo: { id: 1327515899, full_name: "mattyan1053/valence" },
    },
    head: {
      label: "mattyan1053:chore/docker-improvements",
      ref: "chore/docker-improvements",
      repo: { id: 1327515899, full_name: "mattyan1053/valence" },
    },
  },
  {
    number: 9,
    state: "closed",
    title: "エージェント設定",
    base: {
      label: "mattyan1053:chore/docker-improvements",
      ref: "chore/docker-improvements",
      sha: "9fc0f70e0ef97446de9166febce546e955675bc3",
      repo: { id: 1327515899, full_name: "mattyan1053/valence" },
    },
    head: {
      label: "mattyan1053:chore/agent-config",
      ref: "chore/agent-config",
      repo: { id: 1327515899, full_name: "mattyan1053/valence" },
    },
  },
];

/**
 * fork からの PR。`cli/cli` の実際の応答から抜いたもの。
 * **head の repo が base と違う**——この形が来ることを手で想像すると抜けやすい。
 */
const forkPullRequest = {
  number: 14115,
  state: "closed",
  base: {
    label: "cli:trunk",
    ref: "trunk",
    repo: { id: 212613049, full_name: "cli/cli" },
  },
  head: {
    label: "ameerhmz:fix/preserve-executable-permissions-skill-install",
    ref: "fix/preserve-executable-permissions-skill-install",
    repo: { id: 1329103916, full_name: "ameerhmz/cli" },
  },
};

describe("GitHub の PR 一覧をドメイン型へ変換する", () => {
  it("実際の応答から参照を取り出す", () => {
    const result = toPullRequestRefs(stackedPullRequests);

    expect(result).toEqual({
      pullRequests: [
        {
          number: 8,
          base: { repository: "1327515899", branch: "main" },
          head: { repository: "1327515899", branch: "chore/docker-improvements" },
        },
        {
          number: 9,
          base: { repository: "1327515899", branch: "chore/docker-improvements" },
          head: { repository: "1327515899", branch: "chore/agent-config" },
        },
      ],
      invalid: [],
    });
  });

  it("変換した結果から、そのまま辺が導ける", () => {
    // **境界の仕事は「ドメインが食える形にする」ことである。**
    // 型が合うだけでなく、実際に依存が出るところまで見る
    const { pullRequests } = toPullRequestRefs(stackedPullRequests);

    expect(buildDependencyEdges(pullRequests)).toEqual([{ dependent: 9, dependsOn: 8 }]);
  });

  it("fork からの PR は、head だけ別のリポジトリになる", () => {
    const result = toPullRequestRefs([forkPullRequest]);

    expect(result.pullRequests).toEqual([
      {
        number: 14115,
        base: { repository: "212613049", branch: "trunk" },
        head: {
          repository: "1329103916",
          branch: "fix/preserve-executable-permissions-skill-install",
        },
      },
    ]);
  });

  it("同じブランチ名でも、fork と upstream は別の参照になる", () => {
    // #57 で塞いだ「名前一致で偽の辺ができる」形。**境界がリポジトリを
    // 落とすと、ドメインの対策ごと無効になる**
    const result = toPullRequestRefs([
      { ...forkPullRequest, head: { ref: "trunk", repo: { id: 1329103916 } } },
    ]);

    expect(result.pullRequests[0]?.base.repository).not.toBe(
      result.pullRequests[0]?.head.repository,
    );
  });

  it("必須の項目が欠けた PR はドメインへ渡らず、落ちたことが分かる", () => {
    // **黙って捨てない。** 「取得できたが読めなかった」と「そもそも無かった」を
    // 区別できないと、依存が抜けた図が正しい顔で出る
    const [valid] = stackedPullRequests;
    const result = toPullRequestRefs([{ number: 1, base: { ref: "main" } }, valid]);

    expect(result.pullRequests).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.index).toBe(0);
    expect(result.invalid[0]?.reason).not.toBe("");
  });

  it("head の repo が null の PR も落とす", () => {
    // fork が消されると `head.repo` は null になる。**base で代用しない。**
    // 推測で埋めると、fork の PR が upstream に積まれているように見える
    const result = toPullRequestRefs([{ ...forkPullRequest, head: { ref: "x", repo: null } }]);

    expect(result.pullRequests).toEqual([]);
    expect(result.invalid).toHaveLength(1);
  });

  it("型の違う値は通さない", () => {
    // 番号が文字列で来る、ブランチ名が空、といった応答を弾く
    const result = toPullRequestRefs([
      { ...forkPullRequest, number: "14115" },
      { ...forkPullRequest, base: { ref: "", repo: { id: 212613049 } } },
    ]);

    expect(result.pullRequests).toEqual([]);
    expect(result.invalid).toHaveLength(2);
  });

  it("PR が 0 件でも落ちない", () => {
    expect(toPullRequestRefs([])).toEqual({ pullRequests: [], invalid: [] });
  });

  it("一覧そのものが読めなければ落とす", () => {
    // ここで空の配列を返すと、**「取得に失敗した」が「PR が 0 件」に化ける**
    expect(() => toPullRequestRefs({ message: "Not Found" })).toThrow();
    expect(() => toPullRequestRefs(null)).toThrow();
  });
});
