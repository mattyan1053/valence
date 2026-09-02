import { execFileSync, spawnSync } from "node:child_process";
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
  /**
   * **応答はあったが、何を見たか分からない**もの（#179）。
   *
   * **`answer` と混ぜない**——あちらは**レビューできなかった応答**で、
   * **通知として数える**。こちらは**待つのをやめてよいだけ**である。
   */
  acks?: string[];
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
    ...(state.acks ?? []).map((at) => `${at}\t-\tack`),
  ].join("\n");
  return [
    "#!/usr/bin/env bash",
    `echo "$*" >> ${JSON.stringify(callLog)}`,
    // **名前の出所も本物と同じ形にする**（#135）。呼ぶ側は起動時にここから取る
    `if [[ $1 == --bot ]]; then printf '%s\\n' ${JSON.stringify(BOT)}; exit 0; fi`,
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

/**
 * レビュー用の bot。**値をここに書き写さない**——`bin/loop-review-commits` が正で、
 * **写しを持つと、出所を変えても緑のまま**になり、**追随を確かめられない**（#135）。
 */
const BOT = execFileSync(fileURLToPath(new URL("./loop-review-commits", import.meta.url)), [
  "--bot",
])
  .toString()
  .trim();
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

      // **名前の引き（`--bot`）は数えない。** ここで見たいのは**レビューの取得**が
      // 1 回であること——**名前は判定に使う値ではなく、判定する相手**である（#135）
      const fetches = budget.calls.filter((call) => call !== "--bot");

      expect(fetches, "2 回取っている（間に着いた応答で食い違う）").toHaveLength(1);
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

    it("何を見たか分からない応答は、応答不能の通知として数えない", () => {
      // **`notice` は「レビューできなかった」**（環境が無い等）で、**判定を変える**。
      // **👍 はそれではない**ので、**混ぜると #78 の完了条件 3 に触る** (#179)
      const budget = run(
        {
          reviews: [],
          createdAt: minutesAgo(300),
          comments: [request(minutesAgo(200))],
          acks: [minutesAgo(100)],
        },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.stdout, "通知として数えている").not.toContain("環境が無い");
      expect(budget.stdout, "レビュー済みにしている").toContain("reviewed_head=no");
    });

    it("何を見たか分からない応答でも、未応答は解ける", () => {
      // **返ってきたことは事実**である。**解けないと、要求済みで未応答のまま
      // 猶予を過ぎ、`review-unanswered` が積まれる**
      const budget = run(
        {
          reviews: [],
          createdAt: minutesAgo(300),
          comments: [request(minutesAgo(200))],
          acks: [minutesAgo(100)],
        },
        { LOOP_PENDING_REVIEW_GRACE_MIN: "30" },
      );

      expect(budget.stdout, "応答が届いているのに未応答のまま").not.toContain("pending=1");
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

/**
 * **応答不能の通知も、上限に数える**（#356）。
 *
 * **これがこの停止の直接の原因**である——**Codex の枠が尽きてエラー応答が返ると、
 * `notice` は増えるが `rounds` は増えない**（SHA を持たないため）。
 * **上限は `rounds` だけを見ていた**ので、**毎周回 `@codex review` を投げ直した。**
 * **master は毎周「要求する」という仕事をしている**ので、**空転にも数えられず、
 * `loop/STOP` にも到達しない**——**人が気づくまで止まらない。**
 *
 * **スクリプトのコメントは最初から「投げた要求と、bot からの応答不能通知も数える」と
 * 書いてあった。** **実装がそれに追いついていなかった。**
 */
describe("応答不能の通知が続くとき、上限で止まる（#356）", () => {
  /** エラー応答が n 回返った状態。**要求はすべて応答済み**（`pending` は 0）。 */
  function erroredTimes(n: number): State {
    const answers = Array.from({ length: n }, (_, i) => minutesAgo(100 - i * 10));
    return {
      reviews: [],
      answers,
      comments: answers.map((_at, i) => request(minutesAgo(101 - i * 10))),
      createdAt: minutesAgo(300),
    };
  }

  it("エラー応答だけが続いても、上限に達したら要求しない", () => {
    // **これが無いと、毎周回投げ続ける**（利用者が 5 日ループを止めた原因）
    const budget = run(erroredTimes(2), { LOOP_MAX_REVIEW_ROUNDS: "2" });

    expect(budget.stdout, budget.stdout).toContain("上限");
    expect(budget.status).toBe(1);
  });

  it("上限の 1 つ手前なら、まだ要求できる", () => {
    // **ただ厳しくするだけにしない**（#356 の完了条件）——**前後を必ず含める**
    const budget = run(erroredTimes(1), { LOOP_MAX_REVIEW_ROUNDS: "2" });

    expect(budget.status).toBe(0);
  });

  it("本物のレビューと通知は、同じ 1 つの予算を食う", () => {
    // **どちらも「要求して往復した」1 回**である——**分けて数える理由が無い**
    const budget = run(
      {
        reviews: [`${minutesAgo(90)}\t${"b".repeat(40)}\tlive`],
        answers: [minutesAgo(60)],
        comments: [request(minutesAgo(95)), request(minutesAgo(65))],
        createdAt: minutesAgo(300),
      },
      { LOOP_MAX_REVIEW_ROUNDS: "2" },
    );

    expect(budget.stdout, budget.stdout).toContain("上限");
    expect(budget.status).toBe(1);
  });

  it("数えた中身が読めるように出す", () => {
    // **`rounds` を「レビューされた回数」のまま残す**——**読む側が誤解しない**ように、
    // **予算を食った合計は別の名前で出す**（#356 の指示）
    const budget = run(erroredTimes(1), { LOOP_MAX_REVIEW_ROUNDS: "2" });

    expect(budget.stdout).toMatch(/rounds=0\b/);
    expect(budget.stdout).toMatch(/notice=1\b/);
    expect(budget.stdout).toMatch(/attempts=1\b/);
  });

  it("本物のレビューが返る経路は、これまでどおり", () => {
    // **退行の検出**——**通知が 0 件なら、予算は今までと同じ数え方になる**
    const budget = run(
      {
        reviews: [`${minutesAgo(60)}\t${"b".repeat(40)}\tlive`],
        createdAt: minutesAgo(120),
      },
      { LOOP_MAX_REVIEW_ROUNDS: "2" },
    );

    expect(budget.status).toBe(0);
    expect(budget.stdout).toMatch(/attempts=1\b/);
  });
});
