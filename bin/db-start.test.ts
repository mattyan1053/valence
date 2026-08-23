/**
 * **起動だけをやり直す**（#366）。
 *
 * **`database policies` は、runner の都合で落ちることがある**——**`supabase start` が
 * `failed to bind host port for 0.0.0.0:54322` で落ちた**（**実測 2 回**）。
 * **原因は分かっていない**（#436。**前に書いてあった「外向き接続が掴んでいたから」は、
 * 症状から引いた見立て**で、**#434 の実測と食い違う**）。
 *
 * **PR の中身とは関係が無い**ので、**worker へ渡すと 1 往復まるごと無駄になる。**
 *
 * **やり直してよいのは起動だけ**である——**試験まで広げると、落ちているのに緑になる**
 * （#210 と同じ向き）。**その線引きをここで見る。**
 *
 * **本物の Supabase は起こさない。** **`pnpm` を差し替えて、落ち方だけを決める**
 * ——**走っているものと競らない**（`AGENTS.md` §5）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./db-start", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 実測の文面。**書き換えたら、この試験は本物と別のものを見ている。** */
const BIND_FAILURE =
  "failed to bind host port for 0.0.0.0:54322:172.18.0.2:5432/tcp: address already in use";

/** **起きていなかったとき**の文面（`supabase stop`）。 */
const NOT_RUNNING = "supabase local development setup is not running.";

/** **落とせなかったとき**の文面。**docker が居ない・応答しない、が実際の形**である。 */
const STOP_FAILURE = "failed to stop containers: Cannot connect to the Docker daemon";

/**
 * **半分だけ起きている**ときの出力（#371 のレビュー 2 周目）。
 *
 * **落とせたもの・元から居ないもの・落とせなかったものが混ざる**——
 * **「どこかに『居ない』が 1 行あれば良性」だと、この出力が良性に化ける。**
 */
const MIXED_STOP = ["container supabase_db_valence is not running", STOP_FAILURE].join("\n");

/** **良性の行だけが複数**（**締めすぎると、これで止まってしまう**）。 */
const BENIGN_LINES = [
  "supabase local development setup is not running.",
  // **空行が混ざる**（**CLI は区切りに空行を出す**）。**空行を「残った」と読むと、
  // ふつうに起きていなかった回まで止まる。**
  "",
  "container supabase_kong_valence is not running",
].join("\n");

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * **起動のたびに、決めた落ち方をする `pnpm`。**
 *
 * `plan` は 1 回目・2 回目…の結果である（`ok` / `bind` / `other`）。
 * **呼ばれた引数はすべて記録する**——**「やり直していない」も「止めていない」も、
 * ここでしか見えない。**
 */
function withPnpm(
  plan: ("ok" | "bind" | "other")[],
  /**
   * `stop` の落ち方（#371 のレビュー）。**「そもそも起きていない」と
   * 「落とせなかった」は別**である——**入力に入れないと、その区別は見えない。**
   */
  stop: "ok" | "not-running" | "fails" | "mixed" | "benign-lines" = "ok",
): { dir: string; log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "db-start-"));
  sandboxes.push(dir);
  const log = join(dir, "pnpm.log");
  const count = join(dir, "count");
  writeFileSync(join(dir, "plan"), `${plan.join("\n")}\n`);
  writeFileSync(
    join(dir, "pnpm"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'if [[ "$*" == *"supabase stop"* ]]; then',
      ...(stop === "ok"
        ? ["  exit 0"]
        : [
            `  printf '%b\\n' ${JSON.stringify(
              stop === "not-running"
                ? NOT_RUNNING
                : stop === "mixed"
                  ? MIXED_STOP
                  : stop === "benign-lines"
                    ? BENIGN_LINES
                    : STOP_FAILURE,
            )} >&2`,
            "  exit 1",
          ]),
      "fi",
      'if [[ "$*" != *"supabase start"* ]]; then exit 0; fi',
      `n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `printf '%s' "$n" > ${JSON.stringify(count)}`,
      `plan="$(sed -n "\${n}p" ${JSON.stringify(join(dir, "plan"))})"`,
      "case $plan in",
      "  ok) echo 'started'; exit 0 ;;",
      `  bind) echo ${JSON.stringify(BIND_FAILURE)} >&2; exit 1 ;;`,
      "  *) echo 'migration failed: relation does not exist' >&2; exit 1 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    dir,
    log: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
}

function runStart(dir: string, attempts = 3) {
  return spawnSync(SCRIPT, [], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      DB_START_ATTEMPTS: String(attempts),
      // **待たない**（試験の中で待つ理由が無い）。**本物の既定はスクリプトが持つ。**
      DB_START_WAIT_SEC: "0",
    },
  });
}

const startsIn = (lines: string[]) =>
  lines.filter((line) => line.includes("supabase start")).length;
const stopsIn = (lines: string[]) => lines.filter((line) => line.includes("supabase stop")).length;

describe("bin/db-start", () => {
  it("ポートの衝突なら、やり直して起動する", () => {
    // **これが無いと、PR の中身と関係のない失敗が worker へ渡る**（#366）
    const { dir, log } = withPnpm(["bind", "ok"]);

    const done = runStart(dir);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(startsIn(log()), "やり直していない").toBe(2);
    // **残骸を残したまま上げ直さない**——**半分起きた状態が次の bind を塞ぐ**
    expect(stopsIn(log()), "やり直す前に落としていない").toBeGreaterThanOrEqual(1);
  });

  it("別の理由で落ちたら、やり直さない", () => {
    // **やり直してよいのは runner の都合だけ**である——**本物の失敗を繰り返しても
    // 通らないし、通ってしまうなら、それは隠したことになる**
    const { dir, log } = withPnpm(["other", "ok"]);

    const done = runStart(dir);

    expect(done.status, "落ちていない").not.toBe(0);
    expect(startsIn(log()), "やり直している").toBe(1);
  });

  it("やり直しても同じなら、赤で終わる", () => {
    // **無限にやり直さない**——**塞いでいるのが runner でないなら、人が要る**
    const { dir, log } = withPnpm(["bind", "bind", "bind", "ok"]);

    const done = runStart(dir, 3);

    expect(done.status, "緑で終わっている").not.toBe(0);
    expect(startsIn(log()), "回数の上限が効いていない").toBe(3);
  });

  it("落ちた理由を、そのまま出す", () => {
    // **握っていたものを見分けるのは人**である——**飲み込むと、次に落ちたときに
    // 「原因不明」だけが残る**
    const { dir } = withPnpm(["other"]);

    const done = runStart(dir);

    expect(done.stderr, "理由が消えている").toContain("migration failed");
  });
});

describe("落とせなかったのか、起きていなかったのか", () => {
  it("落とせなかったら、やり直さずに中断する", () => {
    // **塞いだまま 2 回空振りするより、1 回で理由を出すほうが早い**（#371 のレビュー）
    const { dir, log } = withPnpm(["bind", "ok"], "fails");

    const done = runStart(dir);

    expect(done.status, "落ちていない").not.toBe(0);
    expect(startsIn(log()), "落とせていないのにやり直している").toBe(1);
  });

  it("落とせなかった理由を出す", () => {
    // **やり直す仕組みを入れた目的は「人を呼ばずに済ませる」ことだった**が、
    // **呼ぶことになった回に、いちばん要る情報が消えていた**（`>/dev/null 2>&1`）
    const { dir } = withPnpm(["bind", "ok"], "fails");

    const done = runStart(dir);

    expect(done.stderr, "理由が消えている").toContain("Cannot connect to the Docker daemon");
  });

  it("そもそも起きていなかったなら、やり直す", () => {
    // **落とすものが無いのは、失敗ではない**——**ここで中断すると、
    // 1 回目が衝突しただけの回まで人が呼ばれる**
    const { dir, log } = withPnpm(["bind", "ok"], "not-running");

    const done = runStart(dir);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(startsIn(log()), "やり直していない").toBe(2);
  });
});

describe("良性の行が混ざっても、悪性は悪性である", () => {
  it("落とせなかった行が混ざっていたら、中断する", () => {
    // **「どこかに『居ない』が 1 行あれば良性」だと、この出力が良性に化ける**
    // （#371 のレビュー 2 周目）——**構造の話なので、文面が何であっても当たる**
    const { dir, log } = withPnpm(["bind", "ok"], "mixed");

    const done = runStart(dir);

    expect(done.status, "混ざった出力を良性に読んでいる").not.toBe(0);
    expect(startsIn(log()), "落とせていないのにやり直している").toBe(1);
    expect(done.stderr, "理由が消えている").toContain("Cannot connect to the Docker daemon");
  });

  it("良性の行だけなら、これまでどおりやり直す", () => {
    // **締めすぎると、ふつうに起きていなかった回まで止まる**
    // ——**上の 1 件が「混ざっていること」で赤いことを、ここが支えている**
    const { dir, log } = withPnpm(["bind", "ok"], "benign-lines");

    const done = runStart(dir);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(startsIn(log()), "やり直していない").toBe(2);
  });
});

describe("CI が、起動と試験を分けている", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

  /** `database policies` の job だけを切り出す。**別の job の step を拾わない。** */
  function databaseJob(): string {
    const from = workflow.indexOf("  database:");
    expect(from, "database の job が無い").toBeGreaterThanOrEqual(0);
    return workflow.slice(from).split("\n  build:")[0] ?? "";
  }

  function step(name: string): string {
    const job = databaseJob();
    const from = job.indexOf(`- name: ${name}`);
    expect(from, `${name} の step が無い`).toBeGreaterThanOrEqual(0);
    return job.slice(from).split("\n      - ")[0] ?? "";
  }

  it("起動は、やり直す口を通る", () => {
    expect(step("Start Supabase"), "やり直す口を通っていない").toContain("bin/db-start");
  });

  it("試験は、やり直す口を通らない", () => {
    // **ここまでやり直すと、落ちているのに緑になる**（#210 と同じ向き）
    expect(step("Run database policy tests"), "試験までやり直している").not.toContain(
      "bin/db-start",
    );
  });
});

/**
 * **残る側に、確かめられていない原因が書いてあった**（#436）。
 *
 * **実測されているのは症状**（`failed to bind host port`。2 回）で、
 * **「外向きの接続が掴んでいたから」は、そこから引いた見立て**である
 * ——**#434 の実測（外向きの ESTABLISHED は docker の publish を妨げない）と食い違う。**
 *
 * **振る舞いは壊れていない**（**やり直す条件は症状で書いてある**）。
 * **困るのは、次に踏んだ人がそこで調べるのをやめること**——**#431 の赤を、
 * まさにその見立てで説明しかけた。**
 */
describe("見出しが、確かめられていることだけを言う", () => {
  const header = () => readFileSync(SCRIPT, "utf8").split("set -uo pipefail")[0] ?? "";

  it("原因は分かっていない、と書いてある", () => {
    expect(header(), "原因が確かめられていないことを言っていない").toMatch(/原因は分かっていない/);
  });

  it("やり直す条件は、症状のままである", () => {
    // **見出しを直しても、動きは変えない**（#436 の範囲外）
    // ——**症状で書いてあるのは正しい**（**原因が何であれ、やり直す動きは正しい**）
    const script = readFileSync(SCRIPT, "utf8");

    expect(script, "やり直す条件が症状で書かれていない").toContain(
      "readonly RETRYABLE='failed to bind host port|address already in use'",
    );
  });

  it("分かったことへ辿れる", () => {
    // **「外向きの接続は妨げない」は実測されている**（#434 / `bin/port-free`）
    // ——**次に読む人が、そこから続きを調べられるようにする**
    expect(header(), "分かっていることの在り処が書いていない").toMatch(/bin\/port-free|#434/);
  });
});

/**
 * **「直したこと」だけでなく、「壊れたこと」を見る**（#437 のレビュー）。
 *
 * **上の「原因は分かっていない、と書いてある」は、在ることしか見ていない**
 * ——**その 1 行を残したまま断定を足せば、緑のまま通る。** **人は消さずに足す**
 * （**この見出し自身が「足して残す」形で書かれている**）。
 *
 * **禁じたいのは語ではなく、置かれている側**である——**いま信じていること**か、
 * **外した見立て**か。**外した見立ては名指しで残す**（**消すと「なぜ外したか」も消える**）
 * ので、**そこは区画で囲い、外側だけを見る。**
 */
describe("いま信じていることの側に、原因の断定を置かない", () => {
  const header = () => readFileSync(SCRIPT, "utf8").split("set -uo pipefail")[0] ?? "";
  /** 外した見立ての区画。**書式は `bin/db-start` が持つ。** */
  const MARK = {
    from: "--- 外した見立て（いま信じていることではない）",
    to: "--- 外した見立て ここまで",
  };

  /** **区画の外**（＝いま信じていること）だけを取り出す。 */
  function believed(header: string): string {
    const before = header.split(MARK.from)[0] ?? "";
    const after = header.split(MARK.to)[1] ?? "";
    return `${before}${after}`;
  }

  /** 区画の外で、原因を言っている箇所。**「分かっていない」だけは通す。** */
  function claimed(header: string): string[] {
    return believed(header)
      .replaceAll("原因は分かっていない", "")
      .split("\n")
      .filter((line) => line.includes("原因"));
  }

  it("いまの見出しは、そのまま通る", () => {
    // **外した見立てを名指しで残しているのが、いまの見出しの良いところ**である
    // ——**それを禁じる形にしない。**
    expect(claimed(header()), "いまの見出しで鳴っている").toEqual([]);
  });

  it("断定を足したら、拾う", () => {
    // **これが実際に起きるほう**である（**消さずに足す**）
    const added = header().replace(
      "# **原因は分かっていない。**",
      "# **原因は分かっていない。**\n# **原因は、外向き接続である。**",
    );

    expect(claimed(added), "足された断定を見逃している").not.toEqual([]);
  });

  it("外した見立ての中でなら、原因を名指ししてよい", () => {
    // **区画の中は「いま信じていること」ではない**——**引き写しは残せる。**
    const quoted = [
      "# **原因は分かっていない。**",
      `# ${MARK.from}`,
      "# **原因は外向き接続である**、と書いてあった",
      `# ${MARK.to}`,
      "",
    ].join("\n");

    expect(claimed(quoted), "外した見立ての引き写しで鳴っている").toEqual([]);
  });

  it("区画が無ければ、外した見立ても拾う", () => {
    // **囲い忘れを、通してしまわない**——**区画は書式であって、書けば効く。**
    const quoted = [
      "# **原因は分かっていない。**",
      "# **原因は外向き接続である**、と書いてあった",
      "",
    ].join("\n");

    expect(claimed(quoted), "囲っていないのに通している").not.toEqual([]);
  });
});
