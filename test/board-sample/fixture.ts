/**
 * **判定用の盤面を、作った材料で組む**（#687）。
 *
 * **実データでは判定できない**（#678 で測った）——**#597 の完了条件は「10 本並んだ
 * 画面」だが、31.5 日で一度も並んでいない**（最大 4 本。**ループが 1 人 1 本・
 * 全体 2 本に制限している**ので、構造的に並ばない）。**待っても来ない。**
 *
 * **本物のログインを通った画面を残すと、人の名前が混ざる**（`AGENTS.md` §6）
 * ——**盤面の各行が GitHub のログイン名をそのまま描く**（`assignment-note.ts`）。
 * **ここに置く名前は、すべて作りもの**である。
 *
 * **本物より狭くしない**（#673 で踏んだ形）——**「読めなかった」「切れた」
 * 「分からない」の行も置く。** **揃っているものだけを並べると、いちばん読みにくい
 * 画面が出てこない**（**判定したいのは、まさにそこ**）。
 */

import type { RepositoryBoardResult } from "../../src/application/review-order/view-repository-board";
import { buildDependencyEdges } from "../../src/domain/graph/dependency-graph";
import { orderByDependency } from "../../src/domain/graph/dependency-order";

/** **作りものの持ち主**。**実在の login と重ならない語を選ぶ。** */
const PEOPLE = ["sample-aoi", "sample-kaede", "sample-rin"] as const;

/** **作りものの置き場所。** */
export const SAMPLE_REPOSITORY = { owner: "sample-org", name: "sample-repo" } as const;

/** **1 行ぶんの材料。** **並びはそのまま画面の並びになる。** */
type Row = {
  readonly number: number;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly files: number;
  readonly lines: number;
  readonly paths: readonly string[];
  readonly ci: "passing" | "failing" | "pending";
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly state: "behind" | "blocked" | "clean" | "dirty" | "unknown";
  /** `undefined` = 意見を読めなかった（**「意見が無い」ではない**）。 */
  readonly opinion:
    | {
        readonly approvesHead: boolean;
        readonly changesRequestedOnHead: boolean;
        readonly reviewed: boolean;
      }
    | undefined;
  /** `undefined` = 振り先を読めなかった。 */
  readonly assignment:
    | {
        readonly assignees: readonly string[];
        readonly reviewers: readonly string[];
        readonly authoredByBot: boolean;
      }
    | undefined;
};

const APPROVED = { approvesHead: true, changesRequestedOnHead: false, reviewed: true } as const;
const CHANGES_REQUESTED = {
  approvesHead: false,
  changesRequestedOnHead: true,
  reviewed: true,
} as const;
const REVIEWED = { approvesHead: false, changesRequestedOnHead: false, reviewed: true } as const;
const UNTOUCHED = { approvesHead: false, changesRequestedOnHead: false, reviewed: false } as const;

/** **変更の材料を取れなかった PR。** **行は出るが、危なさは言えない。** */
const UNAVAILABLE_CHANGES = new Set([103, 112]);

const ROWS: readonly Row[] = [
  {
    number: 101,
    branch: "feat/reader",
    base: "main",
    title: "読み手の入口をひとつにする",
    files: 2,
    lines: 18,
    paths: ["src/ui/reader/reader.tsx", "src/ui/reader/reader.test.tsx"],
    ci: "passing",
    mergeable: "mergeable",
    state: "clean",
    opinion: APPROVED,
    assignment: { assignees: [PEOPLE[0]], reviewers: [PEOPLE[1]], authoredByBot: false },
  },
  {
    number: 102,
    branch: "feat/reader-paging",
    base: "feat/reader",
    title: "読み手に続きを持たせる（#101 の上）",
    files: 6,
    lines: 240,
    paths: ["src/ui/reader/paging.tsx", "src/application/reader/paging.ts"],
    ci: "passing",
    mergeable: "mergeable",
    state: "blocked",
    opinion: REVIEWED,
    assignment: { assignees: [PEOPLE[0]], reviewers: [], authoredByBot: false },
  },
  {
    number: 103,
    branch: "feat/reader-search",
    base: "feat/reader-paging",
    title: "読み手から探せるようにする（#102 の上）",
    files: 11,
    lines: 620,
    paths: ["src/ui/reader/search.tsx", "src/domain/reader/search.ts"],
    ci: "pending",
    mergeable: "unknown",
    state: "unknown",
    opinion: undefined,
    assignment: undefined,
  },
  {
    number: 104,
    branch: "fix/auth-callback",
    base: "main",
    title: "戻り先を、入口と同じところに揃える",
    files: 1,
    lines: 4,
    paths: ["src/app/auth/callback/route.ts"],
    ci: "passing",
    mergeable: "conflicting",
    state: "dirty",
    opinion: CHANGES_REQUESTED,
    assignment: { assignees: [], reviewers: [PEOPLE[2]], authoredByBot: false },
  },
  {
    number: 105,
    branch: "chore/deps",
    base: "main",
    title: "依存を上げる",
    files: 2,
    lines: 1180,
    paths: ["package.json", "pnpm-lock.yaml"],
    ci: "failing",
    mergeable: "mergeable",
    state: "behind",
    opinion: UNTOUCHED,
    assignment: { assignees: [], reviewers: [], authoredByBot: true },
  },
  {
    number: 106,
    branch: "feat/board-filter",
    base: "main",
    title: "誰の番かで絞れるようにする",
    files: 5,
    lines: 210,
    paths: ["src/ui/ball/ball-filter.ts", "src/domain/triage/board-filter.ts"],
    ci: "passing",
    mergeable: "mergeable",
    state: "clean",
    opinion: APPROVED,
    assignment: { assignees: [PEOPLE[1]], reviewers: [], authoredByBot: false },
  },
  {
    number: 107,
    branch: "feat/board-filter-carry",
    // **枝名が「#106 の続き」と言っているのに、`main` から生えていた** (#740)
    base: "feat/board-filter",
    title: "絞りを、押したあとへ持ち越す",
    files: 4,
    lines: 96,
    paths: ["src/ui/ball/ball-filter.ts", "src/ui/board/board-reload-href.ts"],
    ci: "passing",
    mergeable: "mergeable",
    state: "clean",
    opinion: REVIEWED,
    assignment: { assignees: [], reviewers: [PEOPLE[0], PEOPLE[2]], authoredByBot: false },
  },
  {
    number: 108,
    branch: "refactor/token-store",
    base: "main",
    title: "トークンの置き場所を 1 箇所にする",
    files: 9,
    lines: 430,
    paths: ["src/infrastructure/auth/token-store.ts", ".env.example"],
    ci: "passing",
    mergeable: "mergeable",
    state: "behind",
    opinion: REVIEWED,
    assignment: undefined,
  },
  {
    number: 109,
    branch: "docs/readme",
    base: "main",
    title: "入口の説明を、実装に合わせる",
    files: 1,
    lines: 22,
    paths: ["README.md"],
    ci: "passing",
    mergeable: "mergeable",
    state: "clean",
    opinion: UNTOUCHED,
    assignment: { assignees: [], reviewers: [], authoredByBot: false },
  },
  {
    number: 110,
    branch: "fix/graph-labels",
    base: "main",
    title: "図の札が、線に重なっている",
    files: 3,
    lines: 64,
    paths: ["src/ui/dependency-graph/dependency-graph-figure.tsx"],
    ci: "passing",
    mergeable: "mergeable",
    state: "clean",
    opinion: CHANGES_REQUESTED,
    assignment: { assignees: [PEOPLE[2]], reviewers: [PEOPLE[1]], authoredByBot: false },
  },
  {
    number: 111,
    branch: "feat/cross-repo",
    base: "main",
    title: "横断で open PR を引く",
    files: 7,
    lines: 305,
    paths: ["src/infrastructure/github/cross-repository.ts"],
    ci: "pending",
    mergeable: "unknown",
    state: "unknown",
    opinion: REVIEWED,
    assignment: { assignees: [], reviewers: [PEOPLE[0]], authoredByBot: false },
  },
  {
    number: 112,
    branch: "chore/migrations",
    base: "main",
    title: "マイグレーションを畳む",
    files: 4,
    lines: 88,
    paths: ["supabase/migrations/0001_init.sql"],
    ci: "failing",
    mergeable: "conflicting",
    state: "dirty",
    opinion: undefined,
    assignment: { assignees: [PEOPLE[1]], reviewers: [], authoredByBot: false },
  },
  // **ここから下は、線を訊けるようにするために足した積み重ね** (#740)。
  // **箱 12 個に対して辺が 2 本**では、**何を答えても「読める」になる。**
  {
    number: 113,
    branch: "feat/reader-highlight",
    // **1 本鎖を伸ばす**——**深さが 2 では「どこから見るか」が問題にならない**
    base: "feat/reader-search",
    title: "読み手の当たったところを目立たせる（#103 の上）",
    files: 3,
    lines: 74,
    paths: ["src/ui/reader/reader-highlight.tsx", "src/ui/reader/reader.tsx"],
    ci: "pending",
    mergeable: "unknown",
    state: "behind",
    opinion: UNTOUCHED,
    assignment: { assignees: [PEOPLE[2]], reviewers: [], authoredByBot: false },
  },
  {
    number: 114,
    branch: "feat/board-filter-reset",
    // **枝分かれ**——**#107 と同じ土台**（**線が分かれて見えるのはここだけ**）
    base: "feat/board-filter",
    title: "絞りを、1 回で戻せるようにする（#106 の上）",
    files: 2,
    lines: 31,
    paths: ["src/ui/ball/ball-filter.ts"],
    ci: "passing",
    mergeable: "conflicting",
    state: "dirty",
    opinion: CHANGES_REQUESTED,
    assignment: { assignees: [PEOPLE[0]], reviewers: [PEOPLE[1]], authoredByBot: false },
  },
  {
    number: 115,
    branch: "feat/sync-schema",
    // **循環**（#115 ⇄ #116）——**`order.cyclic` に出る形**である。
    // **本物の盤面には出る**（**取り違えて base を差し替えると起きる**）ので、
    // **見本に無いと、その節を人が見られない。**
    base: "feat/sync-client",
    title: "同期の型を、送り手と受け手で揃える",
    files: 5,
    lines: 140,
    paths: ["src/domain/sync/schema.ts"],
    ci: "failing",
    mergeable: "unknown",
    state: "blocked",
    opinion: UNTOUCHED,
    assignment: { assignees: [], reviewers: [PEOPLE[2]], authoredByBot: false },
  },
  {
    number: 116,
    branch: "feat/sync-client",
    base: "feat/sync-schema",
    title: "同期の受け手を、新しい型で読む",
    files: 4,
    lines: 88,
    paths: ["src/infrastructure/sync/sync-client.ts"],
    ci: "pending",
    mergeable: "unknown",
    state: "unknown",
    opinion: undefined,
    assignment: undefined,
  },
];

/**
 * **判定用の盤面。**
 *
 * **10 本以上並べる**（#597 の完了条件）。**線を訊ける形にしてある** (#740)
 * ——**枝分かれ・深さ・循環**を持たせた。
 */
export function sampleBoard(): RepositoryBoardResult {
  // **辺と順序は、行から出す** (#740)。**手で並べると、行を足したときに置いていかれる**
  // ——**実際に、行が 12 に増えても辺は 2 本のまま**だった（**足した本人の diff には
  // 出てこない側**。`AGENTS.md` §5）。**判定はドメインの 1 箇所が持つ。**
  const pullRequests = ROWS.map((row) => ({
    number: row.number,
    base: { repository: SAMPLE_REPOSITORY.name, branch: row.base },
    head: { repository: SAMPLE_REPOSITORY.name, branch: row.branch },
  }));
  const edges = buildDependencyEdges(pullRequests);

  return {
    kind: "board",
    plan: {
      pullRequests,
      edges,
      order: orderByDependency(pullRequests, edges),
      // **読めなかった行**（#673）。**位置しか分からない。**
      invalid: [{ index: ROWS.length, reason: "number が数値ではありませんでした" }],
      // **切れた行には、変更の材料を持たせない** (#687 の実装で踏んだ)。
      // **`changesUnavailable` にだけ載せても、その番号が一覧に無ければ何も出ない**
      // ——**行があって、その行の材料が欠けている**のが本物の形である。
      changes: new Map(
        ROWS.filter((row) => !UNAVAILABLE_CHANGES.has(row.number)).map((row) => [
          row.number,
          {
            changedFileCount: row.files,
            changedLineCount: row.lines,
            changedPaths: { paths: row.paths, truncated: row.number === 105 },
            ciStatus: row.ci,
            failingChecks:
              row.ci === "failing"
                ? [
                    {
                      kind: "check-run" as const,
                      name: "unit",
                      outcome: "failure",
                      issuer: undefined,
                    },
                  ]
                : [],
            baseCi: undefined,
          },
        ]),
      ),
      // **切れた行**（#673）。**「触れていない」ではなく「見ていない」。**
      changesUnavailable: [
        {
          pullRequestNumber: 103,
          kind: "timedout",
          reason: "変更の一覧が時間内に返りませんでした",
        },
        { pullRequestNumber: 112, kind: "unreadable", reason: "変更の一覧を読めませんでした" },
      ],
      heads: new Map(
        ROWS.filter((row) => row.number !== 103).map((row) => [row.number, `c0ffee${row.number}`]),
      ),
      titles: new Map(ROWS.map((row) => [row.number, row.title])),
      mergeStatuses: new Map(
        ROWS.map((row) => [
          row.number,
          {
            mergeable: row.mergeable,
            state: row.state,
            behindBy: row.state === "behind" ? 12 : undefined,
          },
        ]),
      ),
      // **`undefined` の行は入れない**——**「読めなかった」は、地図に載っていないこと**
      // **で表す**（`ballOf` と `assignmentNote` がそう読む）。**`!` で潰さない。**
      opinions: new Map(
        ROWS.flatMap((row) =>
          row.opinion === undefined ? [] : [[row.number, row.opinion] as const],
        ),
      ),
      assignments: new Map(
        ROWS.flatMap((row) =>
          row.assignment === undefined ? [] : [[row.number, row.assignment] as const],
        ),
      ),
      // **最後に動いた時刻**（#715）。**見本は作り物**なので、**行ごとに 1 日ずつ古くする**
      // ——**同じ数ばかりだと、日数で並べ替えたときに何も分からない。**
      // **1 行だけ持たせない**（`heads` と同じ）——**「読めなかった」は、
      // 地図に載っていないことで表す。**
      updatedAt: new Map(
        ROWS.filter((row) => row.number !== 112).map((row, index) => [
          row.number,
          `2026-09-${String(12 - index).padStart(2, "0")}T09:00:00Z`,
        ]),
      ),
    },
    approvals: {
      approved: new Set([101, 106]),
      // **分からない行**（#673）。**承認の有無を読めなかった。**
      unavailable: [{ pullRequestNumber: 111, reason: "承認の一覧を読めませんでした" }],
    },
    issues: {
      issues: [
        { number: 201, title: "盤面が、数が増えると読めなくなる" },
        { number: 202, title: "見た目が当たっていない" },
        { number: 203, title: "横断の盤面を、入口から見られるようにする" },
      ],
      invalid: [{ index: 3, reason: "title を読めませんでした" }],
      assignments: new Map([
        [201, { assignees: [PEOPLE[0]], authoredByBot: false }],
        [202, { assignees: [], authoredByBot: false }],
      ]),
    },
  };
}
