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
      sha: "1b6d3f5a2c7e9d0418ab63cf27e5d9a4b8c10f2e",
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
      sha: "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb",
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
      heads: new Map([
        [8, "1b6d3f5a2c7e9d0418ab63cf27e5d9a4b8c10f2e"],
        [9, "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb"],
      ]),
      titles: new Map([
        [8, "コンテナ周りの改善"],
        [9, "エージェント設定"],
      ]),
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
    expect(toPullRequestRefs([])).toEqual({
      pullRequests: [],
      invalid: [],
      heads: new Map(),
      titles: new Map(),
    });
  });

  it("一覧そのものが読めなければ落とす", () => {
    // ここで空の配列を返すと、**「取得に失敗した」が「PR が 0 件」に化ける**
    expect(() => toPullRequestRefs({ message: "Not Found" })).toThrow();
    expect(() => toPullRequestRefs(null)).toThrow();
  });
});

describe("head の commit を、番号から引ける形で持つ", () => {
  // **マージを「見せたもの」に固定するため**（#331 のレビュー）——
  // **盤面を出してから押すまでに push されると、確かめていない head がマージされる**
  it("実際の応答から head の commit を取り出す", () => {
    const { heads } = toPullRequestRefs(stackedPullRequests);

    expect(heads.get(8)).toBe("1b6d3f5a2c7e9d0418ab63cf27e5d9a4b8c10f2e");
    expect(heads.get(9)).toBe("5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb");
  });

  it("commit が読めない PR も、依存グラフからは消さない", () => {
    // **盤面の本体は依存の図**であって、**マージのボタンはその上に載っているだけ**
    // ——**必須にすると、commit を読めなかった PR がまるごと消える**（#107 と同じ判断）
    const [first] = stackedPullRequests;
    const withoutSha = { ...first, head: { ...first?.head, sha: undefined } };

    const { pullRequests, invalid, heads } = toPullRequestRefs([withoutSha]);

    expect(pullRequests.length, "図から消えている").toBe(1);
    expect(invalid.length).toBe(0);
    expect(heads.has(8), "確かめられない commit を持っている").toBe(false);
  });
});

/**
 * **タイトルを、番号から引ける形で持つ**（#542）。
 *
 * **`PullRequestRef` へ足さない**——**あれは依存を決めるのに要る最小限**である
 * （`heads` と同じ形）。**応答には既に入っている**ので、**問い合わせは足さない。**
 */
describe("タイトルを、番号から引ける形で持つ", () => {
  it("実際の応答からタイトルを取り出す", () => {
    const { titles } = toPullRequestRefs(stackedPullRequests);

    expect(titles.get(8)).toBe("コンテナ周りの改善");
    expect(titles.get(9)).toBe("エージェント設定");
  });

  it("タイトルが読めない PR も、依存グラフからは消さない", () => {
    // **盤面の本体は依存の図**である（`heads` と同じ判断。#107）——**必須にすると、
    // タイトルを読めなかった PR がまるごと消える**
    const [first] = stackedPullRequests;
    const withoutTitle = { ...first, title: undefined };

    const { pullRequests, invalid, titles } = toPullRequestRefs([withoutTitle]);

    expect(pullRequests.length, "図から消えている").toBe(1);
    expect(invalid.length).toBe(0);
    expect(titles.has(8), "読めていないタイトルを持っている").toBe(false);
  });

  it("タイトルの形が変わったら、黙って「無い」へ寄せない", () => {
    // **「読めなかった」を「無かった」に化けさせない**（#543 のレビュー）——
    // **`catch` で飲み込むと、GitHub が形を変えた日に全部の箱が `タイトル不明` になり、
    // `invalid` にも出ない。** **`head.sha` と同じ扱いにする**（**あちらも型の誤りは
    // `invalid` へ行く**）
    const [first] = stackedPullRequests;

    const { pullRequests, invalid } = toPullRequestRefs([{ ...first, title: 42 }]);

    expect(invalid, "型が違うのに、読めたことにしている").toHaveLength(1);
    expect(pullRequests, "読めなかった PR を、読めたことにしている").toHaveLength(0);
  });

  it("空のタイトルは、持っていないものとして扱う", () => {
    // **空文字を持たせると、UI が「短いタイトル」として出す**——**箱に何も無い行が
    // 「タイトル不明」と見分けられなくなる**（#542 の完了条件）
    const [first] = stackedPullRequests;

    const { titles } = toPullRequestRefs([{ ...first, title: "" }]);

    expect(titles.has(8), "空のタイトルを持っている").toBe(false);
  });
});
