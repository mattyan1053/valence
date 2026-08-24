/**
 * **どの一覧にも出てこない open Issue を見つける** (#325)。
 *
 * **#319 で実際に起きた。** **`in-progress` を外した先が無く**、**open のまま label が
 * 0 件**になった——**master のステップ 6 が読むのは `ready` / `in-progress` / `backlog`**
 * なので**昇格の候補にも上がらず**、**`audit` も `handoff` も黙った**（**どちらも
 * 「label と PR の食い違い」を見るもの**で、**label が無いことは食い違いではない**）。
 *
 * **全部の検査が「健全」と答える。** **気づいたのは master が前の周回を覚えていたから**で、
 * **セッションが落ちれば消える記憶**である。
 *
 * **モックを使わない**——**本物のスクリプトへ、本物と同じ形の入力を流す。**
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-unlisted-issues", import.meta.url));

type Issue = { number: number; labels: string[] };

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 偽の `gh` を置いて走らせる。
 *
 * **ページの切れ目を、そのまま置く** (#328 のレビュー)。**本物の `gh api graphql
 * --paginate` は内側の `pageInfo` を辿って続きを読む**ので、**辿る形になっていない
 * 要求には 1 ページ目しか返さない**——**「件数で打ち切ると取りこぼす」を再現する。**
 */
function run(options: {
  issues?: Issue[];
  /** **1 ページ目より先にしか出てこない Issue。** 打ち切る実装では見えない */
  beyondFirstPage?: Issue[];
  fails?: boolean;
  args?: string[];
  /**
   * **番号を指して読み直したときに返る label**（#487）。
   *
   * **索引（一覧）は label を触った直後に遅れる**（#285。実測 3 回）——**遅れている
   * あいだ、label のある Issue が「1 つも無い」に見える。** **既定は一覧と同じ**
   * （**遅れていない**）で、**食い違わせたいときだけ渡す。**
   */
  reread?: Record<number, string[]>;
  /** **読み直しが落ちる。** **「無い」に倒さないこと**を見る */
  rereadFails?: boolean;
}): {
  status: number;
  stdout: string[];
  stderr: string;
  /** **走らせた場所**。`bin/loop-lease check` の記録はここへ落ちる */
  workspace: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "unlisted-issues-"));
  sandboxes.push(dir);
  const path = join(dir, "path");
  mkdirSync(path, { recursive: true });
  // **走らせる場所を砂場にする** (#338)。**`bin/loop-unlisted-issues` は冒頭で
  // `bin/loop-lease check` を通す**ので、**cwd を継ぐと実物の共通 `.git` へ書く**
  // ——**人が診断に使う記録（上限 20 行）が、試験の雑音で押し出される**（#186 / #192）。
  const workspace = join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
  expect(spawnSync("git", ["init", "--quiet", workspace]).status, "砂場を作れない").toBe(0);
  // **本物の `--jq` が出す形**（#328 のレビュー 2 周目）。**label は 1 行ずつ**で、
  // **区切りは US**——**繋いで渡すと、カンマを含む label 名が測れない。**
  const asLines = (issues: Issue[]): string =>
    issues
      .flatMap((issue) => [
        `issue\u001f${issue.number}`,
        ...issue.labels.map((label) => `label\u001f${label}`),
      ])
      .join("\n");
  const head = asLines(options.issues ?? []);
  const tail = asLines(options.beyondFirstPage ?? []);
  // **読み直しの答え。** **渡されなければ、一覧と同じ**（索引が遅れていない状態）
  const known = [...(options.issues ?? []), ...(options.beyondFirstPage ?? [])];
  const reread: Record<number, string[]> = {
    ...Object.fromEntries(known.map((issue) => [issue.number, issue.labels])),
    ...(options.reread ?? {}),
  };
  const rereadCases = Object.entries(reread).flatMap(([number, labels]) => [
    `    ${number}) printf '%b' ${JSON.stringify(labels.join("\n"))}; [[ -n ${JSON.stringify(labels.join("\n"))} ]] && echo; exit 0 ;;`,
  ]);
  writeFileSync(
    join(path, "gh"),
    [
      "#!/usr/bin/env bash",
      ...(options.fails === true ? ["exit 1"] : []),
      'if [[ $* == *"repo view"* ]]; then',
      '  echo "owner"',
      '  echo "repo"',
      "  exit 0",
      "fi",
      // **番号を指した読み直し**（#487）。**一覧とは別の答えを返せる**
      'if [[ $* == *"issue view"* ]]; then',
      ...(options.rereadFails === true ? ["  exit 1"] : []),
      // **番号は `$3`**（`gh issue view <番号> --json …`）——**`$2` は `view` である**
      '  case "$3" in',
      ...rereadCases,
      "    *) exit 0 ;;",
      "  esac",
      "fi",
      `printf '%b' ${JSON.stringify(head)}`,
      `[[ -n ${JSON.stringify(head)} ]] && echo`,
      // **続きは、内側を辿る要求にだけ返す**（`--paginate` と `pageInfo` と `after:`）
      'if [[ $* == *"--paginate"* && $* == *"pageInfo"* && $* == *"after:"* ]]; then',
      `  printf '%b' ${JSON.stringify(tail)}`,
      `  [[ -n ${JSON.stringify(tail)} ]] && echo`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(path, "gh"), 0o755);

  const result = spawnSync(SCRIPT, options.args ?? [], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, PATH: `${path}:${process.env.PATH ?? ""}` },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout.split("\n").filter((line) => line !== ""),
    stderr: result.stderr,
    workspace,
  };
}

describe("bin/loop-unlisted-issues", () => {
  it("状態 label が 1 つも無い open Issue を挙げる", () => {
    // **これが本題である。** **外した先が無い Issue は、どのループの視界にも入らない**
    const listed = run({ issues: [{ number: 319, labels: [] }] });

    expect(listed.status, "どの一覧にも出てこない Issue を見逃している").toBe(1);
    expect(listed.stdout).toEqual(["319"]);
  });

  it.each(["backlog", "ready", "in-progress", "blocked"])(
    "`%s` が付いていれば挙げない",
    (label) => {
      // **緩めすぎない側ではなく、鳴らしすぎない側の担保。** **平常時に鳴る警告は
      // 読まれなくなる**（`bin/loop-stray-branches` と同じ）
      const listed = run({ issues: [{ number: 319, labels: [label] }] });

      expect(listed.status, `${label} が付いているのに挙げている`).toBe(0);
      expect(listed.stdout).toEqual([]);
    },
  );

  it("索引が遅れていても、label があるなら挙げない", () => {
    // **これが #487 の芯**である。**一覧の索引は label を触った直後に遅れる**
    // （#285。実測 3 回）——**遅れているあいだ、label のある Issue が「1 つも無い」に
    // 見える。** **この答えは人を呼ぶ側へ流れる**（`unlisted-issue` → 3 周で `loop/STOP`）
    // ので、**誤報は「自分で消えた状態のために人が呼ばれる」になる。**
    //
    // **番号を指した直接の読み取りは遅れない**（`bin/loop-handoff` の `count_labelled`）。
    const listed = run({ issues: [{ number: 319, labels: [] }], reread: { 319: ["ready"] } });

    expect(listed.status, "索引の遅れで誤報している").toBe(0);
    expect(listed.stdout).toEqual([]);
  });

  it("読み直せなければ、無いに倒さない", () => {
    // **「読めない」を「ある」とも「無い」とも混ぜない**（`AGENTS.md` §5）
    // ——**出す直前に確かめられなかったのだから、この周回では分からない。**
    const listed = run({ issues: [{ number: 319, labels: [] }], rereadFails: true });

    expect(listed.status, "読めないのに「ある」と言っている").toBe(2);
    expect(listed.stdout, "確かめられていない番号を出している").toEqual([]);
  });

  it("読み直しても label が無ければ、これまでどおり挙げる", () => {
    // **鳴らし損ねない側**（#319 が塞いだもの）——**読み直しを足しても、本題は残る**
    const listed = run({ issues: [{ number: 319, labels: [] }], reread: { 319: [] } });

    expect(listed.status, "本当に label が無い Issue を挙げていない").toBe(1);
    expect(listed.stdout).toEqual(["319"]);
  });

  it("`waiting-condition` だけの Issue は挙げる", () => {
    // **あれは `backlog` に付ける修飾**である（`loop/README.md` の表）——
    // **`bin/loop-handoff` も `labels:["backlog","waiting-condition"]` と
    // 両方を指定して数える**ので、**単独で付いている Issue はどの一覧にも出てこない。**
    //
    // **倒す向きで決めた**——**鳴らしすぎても人が見て何も無いだけ**だが、
    // **鳴らし損ねると、この Issue が塞ぎに来た状態がそのまま残る。**
    const listed = run({ issues: [{ number: 319, labels: ["waiting-condition"] }] });

    expect(listed.status, "どの一覧にも出てこないのに黙っている").toBe(1);
    expect(listed.stdout).toEqual(["319"]);
  });

  it("`backlog` と併用された `waiting-condition` は挙げない", () => {
    // **本来の使い方。** **`backlog` に居るので、昇格の候補としては見えている**
    // （渡さないと決めているだけ）
    const listed = run({ issues: [{ number: 312, labels: ["backlog", "waiting-condition"] }] });

    expect(listed.status, "正しく付いている Issue で鳴っている").toBe(0);
    expect(listed.stdout).toEqual([]);
  });

  it("状態を表さない label だけでは、付いていないのと同じ", () => {
    // **`deferred-finding` や `awaiting-human` は状態ではない**——
    // **付いていても、どの一覧にも出てこない**
    const listed = run({ issues: [{ number: 300, labels: ["deferred-finding"] }] });

    expect(listed.status, "状態でない label で黙っている").toBe(1);
    expect(listed.stdout).toEqual(["300"]);
  });

  it("平常時は何も出さない", () => {
    // **毎周回出る警告は読まれなくなる**（`bin/loop-stray-branches` と同じ理由）
    const listed = run({
      issues: [
        { number: 1, labels: ["backlog"] },
        { number: 2, labels: ["in-progress", "waiting-condition"] },
      ],
    });

    expect(listed.status).toBe(0);
    expect(listed.stdout).toEqual([]);
  });

  it("複数あれば、全部挙げる", () => {
    const listed = run({
      issues: [
        { number: 319, labels: [] },
        { number: 320, labels: ["ready"] },
        { number: 325, labels: [] },
      ],
    });

    expect(listed.status).toBe(1);
    expect(listed.stdout).toEqual(["319", "325"]);
  });

  it("一覧を読めなければ、0 件と読まずに止まる", () => {
    // **測れないことを、健全と同じ出口にしない**（`bin/loop-claim idle` と同じ）
    // ——**「無い」と答えると、読めないあいだこの検出器だけが静かに消える**
    const listed = run({ issues: [{ number: 319, labels: [] }], fails: true });

    expect(listed.status, "読めなかったのに答えを返している").toBe(2);
    expect(listed.stderr).not.toBe("");
  });

  it("1 ページ目より先にある Issue も見る", () => {
    // **件数で打ち切ると、古い Issue から状態 label が外れても気づけない**
    // （#328 のレビュー）——**症状は「何も出ない」**なので、
    // **この検出器だけが静かに消える**（**この PR が消しに来た形そのもの**）。
    //
    // **1 ページ目には label の付いた Issue しか置かない**——**続きを読まなければ
    // 「無い」と答える。**
    const listed = run({
      issues: [{ number: 1, labels: ["backlog"] }],
      beyondFirstPage: [{ number: 400, labels: [] }],
    });

    expect(listed.status, "打ち切って「無い」と答えている").toBe(1);
    expect(listed.stdout).toEqual(["400"]);
  });

  it("カンマを含む label 名で黙らない", () => {
    // **label 名にカンマを入れられる**（#328 のレビュー 2 周目）——**一覧を
    // カンマで繋いでから探すと、`foo,ready,bar` という 1 つの label が
    // `,ready,` に部分一致する。** **付いていない `ready` が付いていることになり、
    // その Issue だけが対象なら exit 0**——**また誰にも見つからないまま残る。**
    //
    // **倒す向き**: **「分からない」を「付いている」側へ倒さない**
    // （**付いていない側へ倒れれば挙がるだけ**だが、**逆は黙る**）。
    const listed = run({ issues: [{ number: 400, labels: ["foo,ready,bar"] }] });

    expect(listed.status, "部分一致で「付いている」と読んでいる").toBe(1);
    expect(listed.stdout).toEqual(["400"]);
  });

  it("入口確認の記録は、走らせた砂場に残る", () => {
    // **実物の共通 `.git` に書かない** (#338)。**記録には上限（20 行）がある**ので、
    // **試験のたびに雑音が入ると、本物の「入口を飛ばした周回」が押し出される**
    // ——**あれは人が診断に使う記録**である（#192）。
    //
    // **「実物が増えないこと」では測らない。** **他の周回が同時に書きうる**ので、
    // **合否が他人の持ち物で決まる**（#186）——**書き先が砂場であることを、
    // 砂場の側で見る。**
    const listed = run({ issues: [{ number: 319, labels: [] }] });

    expect(listed.status).toBe(1);
    expect(
      // **記録は作業場ごとに分かれている** (#403 のレビュー)
      readdirSync(join(listed.workspace, ".git")).some(
        (name) => name.startsWith("valence-loop-lease-missing") && !name.endsWith(".lock"),
      ),
      "入口確認の記録が砂場に無い（実物の共通 .git へ書いている）",
    ).toBe(true);
  });

  it("使い方の誤りは、無いと混ぜない", () => {
    expect(run({ args: ["余計な引数"] }).status).toBe(2);
  });
});
