import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-review-budget", import.meta.url));

const HEAD = "a".repeat(40);

type Comment = { at: string; login: string; body: string };

/** GitHub 側の状態。**偽の `gh` はこれを返すだけ**にして、判定だけを試す。 */
type State = {
  /** `bin/loop-review-commits --all` が返す行（`<時刻>\t<SHA>\t<live|stale>`）。 */
  reviews?: string[];
  comments?: Comment[];
  /**
   * `bin/loop-review-commits --answers` が返す時刻。
   *
   * **どれが応答かの判定は、こちらでは持たない**——**1 箇所（`loop-review-commits`）に
   * 置いた**ので、ここで真似ると**2 箇所に持つことになる**（今回それで両方壊れた）。
   */
  answers?: string[];
  createdAt?: string;
  headSha?: string;
  /** その取得だけが落ちる。**最初の 1 つだけ試すと、後ろの取得を試せない。** */
  failsOn?: string;
  reviewsExit?: number;
};

type Run = { status: number; stdout: string; stderr: string; calls: string[] };

/**
 * 偽の `bin/loop-review-commits`。
 *
 * **どれが応答かの判定は持たない。** 判定は本物が 1 箇所で持つので、
 * ここは**試験が宣言した答え**をそのまま返す（真似ると 2 箇所に持つことになる）。
 */
function fakeReviewCommits(state: State, callLog: string): string {
  // **応答も同じ出力に混ぜる**（SHA の欄が `-`）。**別々に取ると、その間に
  // レビューが着いたときに「回数は古く、最後の応答時刻は新しい」状態になる**
  const rows = [
    ...(state.reviews ?? []),
    ...(state.answers ?? []).map((at) => `${at}\t-\tanswer`),
  ].join("\n");
  return [
    "#!/usr/bin/env bash",
    `echo "$*" >> ${JSON.stringify(callLog)}`,
    `printf '%b' ${JSON.stringify(rows)}`,
    `[[ -n ${JSON.stringify(rows)} ]] && echo`,
    `exit ${state.reviewsExit ?? 0}`,
  ].join("\n");
}

/**
 * **本物の `gh` を呼ばない。** 見たいのは「状態から終了コードをどう決めるか」であって、
 * 取得の仕方ではない。**`jq` も置かない**——開発コンテナに無いので、
 * **外部に依存したままだとこのスクリプトだけテストが書けない**（`bin/loop-gate` と同じ理由）。
 */
function run(state: State, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "review-budget-"));
  const bin = join(dir, "bin");
  const path = join(dir, "path");
  mkdirSync(bin);
  mkdirSync(path);
  for (const command of ["bash", "date", "cat", "dirname", "grep", "sed", "tr", "sort"]) {
    const found = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
    if (found !== "") {
      symlinkSync(found, join(path, command));
    }
  }

  const script = join(bin, "loop-review-budget");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);

  const comments = (state.comments ?? [])
    .map((comment) => `${comment.at}\t${comment.login}\t${comment.body}`)
    .join("\n");

  writeFileSync(
    join(path, "gh"),
    [
      "#!/usr/bin/env bash",
      ...(state.failsOn === undefined
        ? []
        : [`if [[ $* == *${JSON.stringify(state.failsOn)}* ]]; then exit 1; fi`]),
      'if [[ $* == *"headRefOid"* ]]; then',
      `  echo ${JSON.stringify(state.headSha ?? HEAD)}`,
      "  exit 0",
      "fi",
      'if [[ $* == *"createdAt"* ]]; then',
      `  echo ${JSON.stringify(state.createdAt ?? "2026-01-01T00:00:00Z")}`,
      "  exit 0",
      "fi",
      'if [[ $* == *"/comments"* ]]; then',
      // **集計はスクリプト側で行わせる。** 取り出し済みの答えを返すと、数え方を試せない
      `  printf '%b' ${JSON.stringify(comments)}`,
      `  [[ -n ${JSON.stringify(comments)} ]] && echo`,
      "  exit 0",
      "fi",
      'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
      "exit 2",
    ].join("\n"),
    { mode: 0o755 },
  );

  const callLog = join(dir, "calls.log");
  writeFileSync(join(bin, "loop-review-commits"), fakeReviewCommits(state, callLog), {
    mode: 0o755,
  });

  const result = spawnSync(script, ["12"], {
    encoding: "utf8",
    env: { ...process.env, PATH: path, ...env },
    timeout: 20_000,
  });
  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, calls };
}

/** いまから `minutes` 分前の時刻。**猶予の境目を跨がせるのに使う。** */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const BOT = "chatgpt-codex-connector[bot]";
const US = "mattyan1053";

function request(at: string): Comment {
  return { at, login: US, body: "@codex review" };
}

describe("bin/loop-review-budget", () => {
  describe("exit 0 — 要求してよい", () => {
    it("初回の猶予を過ぎても、レビューが 1 件も無い", () => {
      const budget = run({ reviews: [], createdAt: minutesAgo(60) });

      expect(budget.status).toBe(0);
    });

    it("上限の 1 つ手前なら、まだ要求できる", () => {
      // **上限の前後を必ず含める**（off-by-one で健全な PR が止まる）
      const budget = run(
        { reviews: [`${minutesAgo(60)}\t${"b".repeat(40)}\tlive`], createdAt: minutesAgo(120) },
        { LOOP_MAX_REVIEW_ROUNDS: "2" },
      );

      expect(budget.status).toBe(0);
    });
  });

  describe("exit 1 — 要求してはいけない", () => {
    it("現 head が既にレビュー済み", () => {
      // **何も変わっていないものを二度レビューさせない。** ここが浪費を止める本丸
      const budget = run({ reviews: [`${minutesAgo(60)}\t${HEAD}\tlive`] });

      expect(budget.status).toBe(1);
    });

    it("上限に達している", () => {
      const budget = run(
        {
          reviews: [
            `${minutesAgo(90)}\t${"b".repeat(40)}\tlive`,
            `${minutesAgo(60)}\t${"c".repeat(40)}\tlive`,
          ],
          createdAt: minutesAgo(120),
        },
        { LOOP_MAX_REVIEW_ROUNDS: "2" },
      );

      expect(budget.status).toBe(1);
    });

    it("要求済みで未応答、猶予も過ぎている", () => {
      const budget = run(
        { reviews: [], comments: [request(minutesAgo(60))], createdAt: minutesAgo(120) },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.status).toBe(1);
    });
  });

  describe("exit 3 — まだ要求しない（正常な待ち）", () => {
    it("PR を開いた直後は、自動で入るレビューを待つ", () => {
      const budget = run({ reviews: [], createdAt: minutesAgo(1) });

      expect(budget.status).toBe(3);
    });

    it("要求してから猶予の内側なら待つ", () => {
      // **1 と 3 の取り違えは、健全な PR を `loop/STOP` へ運ぶ**
      const budget = run(
        { reviews: [], comments: [request(minutesAgo(5))], createdAt: minutesAgo(120) },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.status).toBe(3);
    });

    it("猶予の内と外で、1 と 3 が分かれる", () => {
      // **境目そのものを見る。** 判定を消さずに**境目だけずらす**変異を捕まえる
      const inside = run(
        { reviews: [], comments: [request(minutesAgo(29))], createdAt: minutesAgo(120) },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );
      const outside = run(
        { reviews: [], comments: [request(minutesAgo(31))], createdAt: minutesAgo(120) },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect([inside.status, outside.status]).toEqual([3, 1]);
    });

    it("初回の猶予も、内と外で分かれる", () => {
      const inside = run(
        { reviews: [], createdAt: minutesAgo(9) },
        { LOOP_INITIAL_REVIEW_GRACE_MIN: "10" },
      );
      const outside = run(
        { reviews: [], createdAt: minutesAgo(11) },
        { LOOP_INITIAL_REVIEW_GRACE_MIN: "10" },
      );

      expect([inside.status, outside.status]).toEqual([3, 0]);
    });
  });

  describe("exit 2 — 判定できない", () => {
    it.each([
      ["head SHA", { failsOn: "headRefOid" }],
      ["レビュー済み commit", { reviewsExit: 1 }],
      ["コメント", { failsOn: "/comments" }],
    ])("%s を取得できない", (_name, state) => {
      // **判定不能を「要求してよい」に倒さない。** 倒すと、壊れているときほど回る
      expect(run({ reviews: [], createdAt: minutesAgo(60), ...state }).status).toBe(2);
    });

    it("使い方の誤り", () => {
      const bad = spawnSync(SCRIPT, ["#12"], { encoding: "utf8" });

      expect(bad.status).toBe(2);
    });

    it("設定が壊れていれば止まる", () => {
      expect(run({ reviews: [] }, { LOOP_MAX_REVIEW_ROUNDS: "0" }).status).toBe(2);
      expect(run({ reviews: [] }, { LOOP_MAX_REVIEW_ROUNDS: "たくさん" }).status).toBe(2);
    });
  });

  describe("大文字小文字を区別しない", () => {
    // **移し替えでは、確かめるものが 1 つ増える**——**論理が正しいか**に加えて、
    // **前と同じ答えを返すか**。`jq` の `test(…; "i")` は無視していたので、
    // **前が受け取れて後が落とす入力**をここに置く（#122 のレビュー指摘）。
    it("`@Codex Review` も要求として数える", () => {
      // 数えられないと「要求済みで未応答」が見えず、**要求を重ねる**——
      // このスクリプトが守っている絶対ルールそのもの
      const budget = run(
        {
          reviews: [],
          createdAt: minutesAgo(120),
          comments: [{ at: minutesAgo(5), login: US, body: "@Codex Review" }],
        },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.status).toBe(3);
    });
  });

  describe("応答があったかどうかは、1 箇所で決める", () => {
    // **どれが応答かの判定は `bin/loop-review-commits` が持つ**（引き金との対応付けを含む）。
    // ここで真似ると**同じ規則を 2 箇所に持つ**ことになり、**片方だけ直して食い違う**——
    // 実際、**同じ文言の列挙を 2 箇所に持っていたので、両方直したら両方壊れた**。

    it("回数と応答時刻を、1 回の取得から導く", () => {
      // **別々に取ると、その間にレビューが着いたときに
      // 「回数は古く、最後の応答時刻は新しい」**——**同じ head が既にレビュー済みでも
      // `pending` が解け、要求を重ねられる**。**寄せ方ではなく取り方の問題**である
      const budget = run(
        {
          reviews: [],
          createdAt: minutesAgo(300),
          comments: [request(minutesAgo(200))],
          answers: [minutesAgo(100)],
        },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.calls, "2 回取っている（間に着いた応答で食い違う）").toHaveLength(1);
    });

    it("応答があれば、未応答が解ける", () => {
      // **文言は見ない。** `Something went wrong` でも「環境が無い」でも、
      // **応答として数えられていれば解ける**——**Codex 自身が「再試行しろ」と
      // 書いているのに、その経路が塞がる**のを防ぐ（昨夜これで 2 時間止まった）
      const budget = run(
        {
          reviews: [],
          createdAt: minutesAgo(300),
          comments: [request(minutesAgo(200))],
          answers: [minutesAgo(100)],
        },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.stdout, "未応答のまま数えている").toContain("pending=0");
      expect(budget.status, "再要求できない").toBe(0);
    });

    it("応答が無ければ、未応答のまま", () => {
      // **レビュー以外の Codex タスクへの応答は、ここまで届かない**
      // （`loop-review-commits` が引き金と対応させて落とす）。**届かない以上、解けない**
      const budget = run(
        {
          reviews: [],
          createdAt: minutesAgo(300),
          comments: [request(minutesAgo(200))],
          answers: [],
        },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.stdout, "無関係な応答で解けている").toContain("pending=1");
      expect(budget.status, "重ねて要求できてしまう").toBe(1);
    });

    it("応答があっても、レビュー済みにはしない", () => {
      // **ここを取り違えると、未レビューの head がマージ可能になる**
      const budget = run(
        {
          reviews: [],
          createdAt: minutesAgo(300),
          comments: [request(minutesAgo(200))],
          answers: [minutesAgo(100)],
        },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.stdout).toContain("reviewed_head=no");
    });
  });

  it("応答不能の通知より後の要求だけを未応答として数える", () => {
    // **通知を消化しないと、元の要求が永久に未応答として残る**（復旧しても再要求できない）
    const budget = run(
      {
        reviews: [],
        createdAt: minutesAgo(300),
        comments: [
          request(minutesAgo(200)),
          { at: minutesAgo(100), login: BOT, body: "I need you to create an environment" },
        ],
        answers: [minutesAgo(100)],
      },
      { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
    );

    expect(budget.status).toBe(0);
  });
});
