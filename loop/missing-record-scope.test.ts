/**
 * **入口を飛ばした周回の記録が、作業場をまたいで押し出し合う**（#401）。
 *
 * **記録は共通ディレクトリに 1 つで、上限は 20 行**である——**うるさい作業場が
 * 1 つあると、他の作業場の本物が 1 行も残らない。**
 *
 * **当たる先が 2 つある。** **人が `./task loop:status` で読むのは「どの作業場が
 * 入口を飛ばしたか」**であり、**`./task check` の見張り（#398）も、この記録が
 * 増えていないことを測っている**——**別の作業場が 20 行書けば、証拠ごと消える。**
 *
 * **上限そのものは残す**（**際限なく積む記録は、読む気を失わせるぶん、無いのと同じ**）
 * ——**数える単位を作業場ごとにする。**
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECORD = "valence-loop-lease-missing";
/** 上限（`bin/loop-lease` の `MISSING_KEEP_DEFAULT`）。**書き写さずに渡す。** */
const KEEP = 5;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 周回を始められる作業場。**実物のスクリプトを置く**（#227）。 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "missing-record-"));
  sandboxes.push(dir);
  expect(spawnSync("git", ["init", "--quiet", "-b", "main", dir]).status).toBe(0);
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const name of ["loop-lease", "loop-procedure-stamp", "loop-stall"]) {
    const target = join(dir, "bin", name);
    copyFileSync(join(REPO_ROOT, "bin", name), target);
    chmodSync(target, 0o755);
  }
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  writeFileSync(join(dir, ".claude", "commands", "loop-worker.md"), "<!-- 版: 0 -->\n手順書\n");
  return dir;
}

/** この作業場の記録（名前の作り方は `bin/loop-lease` が持つ）。 */
function recordPathOf(dir: string): string {
  const scope = spawnSync(join(dir, "bin", "loop-lease"), ["scope", "worker"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(scope.status, scope.stderr).toBe(0);
  return join(dir, ".git", `${RECORD}-${scope.stdout.trim()}`);
}

const line = (at: number, where: string) =>
  `2026-08-23T00:00:${String(at).padStart(2, "0")}Z\tどの役も誰も持っていない\t${where}`;

/** **記録は作業場ごとに分かれている**（#403 のレビュー 3 件目）。**全部を並べる。** */
function recordOf(dir: string): string[] {
  return readdirSync(join(dir, ".git"))
    .filter((name) => name.startsWith(RECORD) && !name.endsWith(".lock"))
    .flatMap((name) => readFileSync(join(dir, ".git", name), "utf8").split("\n"))
    .filter(Boolean);
}

/** その作業場で `bin/loop-lease check` を打つ（**lease を持っていないので記録される**）。 */
function check(dir: string): void {
  const done = spawnSync(join(dir, "bin", "loop-lease"), ["check"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, LOOP_LEASE_MISSING_KEEP: String(KEEP) },
  });
  expect(done.status, done.stderr).toBe(0);
}

describe("記録の上限は、作業場ごとに数える", () => {
  it("うるさい作業場があっても、他の作業場のぶんが残る", () => {
    // **これが本体**である——**1 つの作業場が上限ぶん書いても、他所の本物は消えない**
    const dir = workspace();
    const noisy = "/home/loop/valence-worker-b";
    const quiet = "/home/loop/valence-worker-c";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${[line(1, quiet), ...Array.from({ length: KEEP * 2 }, (_, at) => line(at + 2, noisy))].join("\n")}\n`,
    );

    check(dir);

    const left = recordOf(dir);
    expect(
      left.filter((row) => row.endsWith(quiet)),
      "静かな作業場のぶんが押し出されている",
    ).toHaveLength(1);
  });

  it("上限は残る（作業場ごとに）", () => {
    // **際限なく積む記録は、読む気を失わせるぶん、無いのと同じ**である
    const dir = workspace();
    writeFileSync(
      recordPathOf(dir),
      `${Array.from({ length: KEEP * 3 }, (_, at) => line(at + 1, dir)).join("\n")}\n`,
    );

    check(dir);

    expect(
      recordOf(dir).filter((row) => row.endsWith(dir)),
      "上限を超えて積んでいる",
    ).toHaveLength(KEEP);
  });

  it("残るのは新しいほうである", () => {
    const dir = workspace();
    writeFileSync(
      recordPathOf(dir),
      `${Array.from({ length: KEEP * 2 }, (_, at) => line(at + 1, dir)).join("\n")}\n`,
    );

    check(dir);

    const left = recordOf(dir).filter((row) => row.endsWith(dir));
    expect(left[0], "古いほうを残している").toContain(`:${String(KEEP + 2).padStart(2, "0")}Z`);
  });

  it("自分のぶんも、上限まで積める", () => {
    // **押し出し合いをやめても、自分の記録が 1 行しか残らないのでは読めない**
    const dir = workspace();

    for (let at = 0; at < KEEP + 2; at++) {
      check(dir);
    }

    expect(recordOf(dir).filter((row) => row.endsWith(dir))).toHaveLength(KEEP);
  });

  it("並び順は、時刻のまま", () => {
    // **`./task loop:status` は、そのまま並べて人に見せる**——**混ぜ直さない**
    const dir = workspace();
    const other = "/home/loop/valence-worker-b";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${[line(1, other), line(2, "/home/loop/valence-worker-c"), line(3, other)].join("\n")}\n`,
    );

    check(dir);

    const left = recordOf(dir);
    expect(left.slice(0, 3).map((row) => row.slice(0, 20))).toEqual([
      line(1, other).slice(0, 20),
      line(2, "x").slice(0, 20),
      line(3, other).slice(0, 20),
    ]);
  });
});

/**
 * **残しても、読む口に届かなければ同じ**（#403 のレビュー）。
 *
 * **`./task loop:status` は末尾 3 行しか見せていなかった**——**うるさい作業場が
 * 3 行書けば、静かな作業場の行はファイルに残っていても画面には出ない。**
 * **#401 が言っていたのは、そこ**である（**§5: 入れたが、実行される場所に届いていない**）。
 */
describe("読む口が、作業場ごとに見せる", () => {
  /** `./task` の関数を、そのまま取り出して走らせる。**書き写さない。** */
  function shellFunction(name: string): string {
    const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");
    const from = runner.indexOf(`${name}() {`);
    expect(from, `${name} が ./task にありません`).toBeGreaterThanOrEqual(0);
    return `${runner.slice(from).split("\n}\n")[0] ?? ""}\n}\n`;
  }

  function shown(dir: string): string {
    const done = spawnSync(
      "bash",
      ["-c", `${shellFunction("show_missing_lease")}\nshow_missing_lease`],
      { cwd: dir, encoding: "utf8" },
    );
    expect(done.status, done.stderr).toBe(0);
    return done.stdout;
  }

  it("静かな作業場が、うるさい作業場に隠れない", () => {
    // **これが本体**である——**残っていても、見えなければ同じ**
    const dir = workspace();
    const noisy = "/home/loop/valence-worker-b";
    const quiet = "/home/loop/valence-worker-c";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${[line(1, quiet), ...Array.from({ length: 8 }, (_, at) => line(at + 2, noisy))].join("\n")}\n`,
    );

    const out = shown(dir);

    expect(out, "静かな作業場が画面に出ていない").toContain(quiet);
    expect(out, "うるさい作業場が出ていない").toContain(noisy);
  });

  it("件数は、作業場ごとに出す", () => {
    // **「全部で 20 件」では、どこが飛ばしているのか分からない**
    const dir = workspace();
    const noisy = "/home/loop/valence-worker-b";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${Array.from({ length: 4 }, (_, at) => line(at + 1, noisy)).join("\n")}\n`,
    );

    expect(shown(dir), "作業場ごとの件数が出ていない").toMatch(/4 件[\s\S]*valence-worker-b/);
  });

  it("1 件も無ければ、何も言わない", () => {
    // **静かな日に、読むものを増やさない**
    const dir = workspace();
    writeFileSync(join(dir, ".git", RECORD), "");

    expect(shown(dir).trim()).toBe("");
  });
});

/**
 * **記録全体にも、有限の方針がある**（#403 のレビュー）。
 *
 * **作業場ごとに上限を持たせただけでは、作業場が増えたぶん増え続ける**
 * ——**`./task loop:worker:add` は名前を自由に付けられる**ので、
 * **消した作業場の行も永久に残る。**
 *
 * **「いま実在する作業場だけ残す」では消せない**——**`./task loop:worker:paths` は
 * worker のぶんしか並べない**（master の作業場は意図して除外。#381）ので、
 * **それで判定すると master の記録が毎回消える。**
 * **見るのは「最近その作業場から記録があったか」**である。
 */
describe("記録は、全体としても増え続けない", () => {
  /** 作業場ごとのファイルを、古い順に並べて置く。 */
  function otherWorkspaces(dir: string, count: number): string[] {
    const made: string[] = [];
    for (let at = 0; at < count; at++) {
      const path = join(dir, ".git", `${RECORD}-worker-${String(at).padStart(2, "0")}`);
      writeFileSync(path, `${line(at + 1, `/home/loop/valence-worker-${at}`)}\n`);
      // **落とす順は「最後に書いた時刻」**なので、**古い順に見えるようにする**
      const when = new Date(Date.now() - (count - at) * 60_000);
      utimesSync(path, when, when);
      made.push(path);
    }
    return made;
  }

  it("古い作業場のファイルから落ちる", () => {
    const dir = workspace();
    const made = otherWorkspaces(dir, 15);

    check(dir);

    expect(existsSync(made[0] ?? ""), "いちばん古い作業場が残っている").toBe(false);
    expect(existsSync(made[14] ?? ""), "新しい作業場が落ちている").toBe(true);
  });

  it("同じ秒に並んでも、いま書いた作業場は残る", () => {
    // **`stat %Y` は秒**なので**同値になり、`sort` はパス名（digest の辞書順）に落ちる**
    // ——**「必ず残る」を順序に頼って書くと、たったいま積んだ 1 行が消える**
    // （#403 のレビュー）。**消える先が悪い。**
    const dir = workspace();
    // **名前で負ける形を作る**——**`sort` の最後の拠り所は行そのもの**なので、
    // **digest（16 進）より後ろに並ぶ名前**を置くと、**同じ秒ではこちらが先に落ちる。**
    const made = Array.from({ length: 15 }, (_, at) => {
      const path = join(dir, ".git", `${RECORD}-worker-zz${String(at).padStart(2, "0")}`);
      writeFileSync(path, `${line(at + 1, `/home/loop/valence-worker-zz${at}`)}\n`);
      return path;
    });
    check(dir);
    const mine = recordPathOf(dir);
    // **全部を同じ秒に揃える**（**いま書いたぶんも含めて**）
    const when = new Date(1_800_000_000_000);
    for (const path of [...made.filter(existsSync), mine]) {
      utimesSync(path, when, when);
    }

    check(dir);

    expect(existsSync(mine), "同じ秒に並ぶと、いま書いたぶんが消える").toBe(true);
  });

  it("いま書いた作業場は、必ず残る", () => {
    // **自分の記録が、他所の数で押し出されない**
    const dir = workspace();
    otherWorkspaces(dir, 15);

    check(dir);

    expect(
      recordOf(dir).some((row) => row.endsWith(dir)),
      "いま書いたぶんが落ちている",
    ).toBe(true);
  });
});

/**
 * **古い版の書き手が、作業場ごとの履歴を切り詰める**（#403 のレビュー 3 件目）。
 *
 * **移行中は、master と worker の worktree が違う版を実行する。** **親版の
 * `record_missing` は同じ共有ファイルを全体上限で書き戻す**ので、
 * **こちらが作業場ごとに残しても、あちらが 1 度書いた瞬間に消える。**
 *
 * **`AGENTS.md` §5 の「版をまたいで読まれるもの」**である——**足す側に逃げ道があるのは、
 * 古い読み手が「決まった場所だけ」を読むと確かめたとき**。**あちらが読み書きするのは
 * `valence-loop-lease-missing` 1 つ**なので、**こちらは別の名前へ置く。**
 */
describe("古い版の書き手に、切り詰められない", () => {
  it("作業場ごとに、別の置き場所へ書く", () => {
    const dir = workspace();

    check(dir);

    const files = readdirSync(join(dir, ".git")).filter(
      (name) => name.startsWith(RECORD) && !name.endsWith(".lock"),
    );
    expect(files, "共有の 1 つへ書いている").not.toEqual([RECORD]);
    expect(files.length, "どこにも書いていない").toBeGreaterThan(0);
  });

  it("古い版が共有ファイルを畳んでも、こちらの記録は残る", () => {
    // **親版の `record_missing` を、そのまま真似る**（`tail -n 20` で全体を書き戻す）
    const dir = workspace();
    check(dir);
    const before = recordOf(dir).filter((row) => row.endsWith(dir));
    expect(before.length, "こちらの記録が無い").toBeGreaterThan(0);

    const shared = join(dir, ".git", RECORD);
    writeFileSync(
      shared,
      `${Array.from({ length: 30 }, (_, at) => line(at + 1, "/home/loop/valence-master")).join("\n")}\n`,
    );
    const done = spawnSync(
      "bash",
      ["-c", `kept="$(tail -n 20 "${shared}")"; printf '%s\n' "$kept" > "${shared}"`],
      { encoding: "utf8" },
    );
    expect(done.status, done.stderr).toBe(0);

    expect(
      recordOf(dir).filter((row) => row.endsWith(dir)),
      "古い版に切り詰められている",
    ).toEqual(before);
  });

  it("古い版が書いたぶんも、読む口には出る", () => {
    // **共有ファイルは残る**（**あちらが書く先**）——**読む側は両方を見る。**
    const dir = workspace();
    const old = "/home/loop/valence-master";
    writeFileSync(join(dir, ".git", RECORD), `${line(1, old)}\n`);
    check(dir);

    const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");
    const from = runner.indexOf("show_missing_lease() {");
    const shown = spawnSync(
      "bash",
      ["-c", `${runner.slice(from).split("\n}\n")[0] ?? ""}\n}\nshow_missing_lease`],
      { cwd: dir, encoding: "utf8" },
    );

    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout, "古い版のぶんが出ていない").toContain(old);
    expect(shown.stdout, "こちらのぶんが出ていない").toContain(dir);
  });
});
