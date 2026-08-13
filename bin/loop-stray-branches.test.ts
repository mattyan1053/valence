import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-stray-branches", import.meta.url));

/** `gh pr list --limit` の値。**スタブもここで切り詰める**（実物と同じ形にする）。 */
const PR_LIST_LIMIT = 20;

/** remote のブランチ。`git ls-remote --heads` の形。 */
type Branch = { name: string; sha?: string };
/** その head を持つ PR。 */
type Pr = {
  head: string;
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** **fork から出た PR。** origin の同名ブランチとは**別物**である。 */
  crossRepo?: boolean;
  /**
   * その PR の head SHA。**既定はブランチの先端と同じ**（＝中身は PR に入っている）。
   *
   * **マージのあとに積むと、ここがブランチの先端と食い違う**——**その commit は
   * どの PR にも入っていない**ので、**消すと作業が消える**（#177）。
   */
  headOid?: string;
};

/**
 * push されたのに PR が無いブランチを、誰かが見る（#148）。
 *
 * **master は open PR を見て、worker は label を見る。どちらも remote のブランチを
 * 見ない**ので、**PR にならなかったものは、どちらの視界にも入らない**——
 * **実物が 1 日半、誰にも見られずに置かれていた**（365 行の実装と試験）。
 *
 * **倒れる向きが悪い。** 落ちた周回の残りなら、**Issue は `backlog` へ戻っている**ので、
 * **次に取った worker はブランチの存在を知らないまま最初から作り直す**。
 *
 * **2 つを混ぜない。** **PR が無い**（作業が宙に浮いている。**人へ渡す**）と
 * **終わった PR の消し残り**（**掃除してよい**）は、**拾い手も対処も違う**。
 */
describe("bin/loop-stray-branches", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "stray-branches-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * `git` と `gh`、そして「着手中の周回があるか」を差し替える。
   *
   * **押し通す判定は持たせない。** 生きている着手の記録があるかは
   * `bin/loop-lease` が持つ（**2 箇所に持つと片方だけ直して食い違う**）。
   */
  function run(options: {
    branches: Branch[];
    prs: Pr[];
    /**
     * **いま作業中のブランチ**（走っている worker の作業場で checkout されているもの）。
     *
     * **「どこかで走っているか」ではない。** どこか 1 つでも走っていれば全部隠すと、
     * **worker が途切れず動く環境では紛失作業が永久に見つからない**。
     */
    busyBranches?: string[];
    /**
     * **detached で走っている作業場の HEAD**（#102）。
     *
     * **worker はブランチを掴まなくなった**ので、**「掴んでいるブランチ」では
     * いま触っているものを表せない**——**先端が同じブランチを抑える**。
     */
    busyDetachedHeads?: string[];
    /** 走っているかどうかを読めない（`bin/loop-lease busy` が exit 2）。 */
    busyUnreadable?: boolean;
    gitFails?: boolean;
    ghFails?: boolean;
  }): { status: number; stdout: string; stderr: string } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    mkdirSync(join(sandbox, "bin"), { recursive: true });

    const busyBranches = options.busyBranches ?? [];
    const busyDetachedHeads = options.busyDetachedHeads ?? [];
    // **掴んでいる作業場のあとに並べる**（`/workspace-<番号>` の番号を続ける）
    const detachedAt = busyDetachedHeads.map((sha, index) => ({
      workspace: `/workspace-${busyBranches.length + index}`,
      sha,
    }));
    writeFileSync(
      join(stub, "git"),
      [
        "#!/usr/bin/env bash",
        ...(options.gitFails === true ? ['echo "git が落ちた" >&2', "exit 1"] : []),
        'if [[ $* == *"ls-remote"* ]]; then',
        ...options.branches.map(
          (branch) =>
            `  printf '%s\\t%s\\n' ${JSON.stringify(branch.sha ?? "a".repeat(40))} ${JSON.stringify(`refs/heads/${branch.name}`)}`,
        ),
        "  exit 0",
        "fi",
        // **走っている作業場で、いま checkout されているブランチ**を答える。
        //
        // **`""` は detached**（`git symbolic-ref --quiet` は**何も出さずに exit 1**）、
        // **`"?"` は本当に読めない**（壊れたリポジトリ。exit 128）——**この 2 つは別物**で、
        // **同じ非ゼロに丸めると、detached を「読めない」と扱ってしまう**（#198）
        'if [[ $* == *"symbolic-ref"* ]]; then',
        ...busyBranches.flatMap((branch, index) =>
          branch === ""
            ? []
            : [
                branch === "?"
                  ? `  [[ $* == *"/workspace-${index}"* ]] && exit 128`
                  : `  [[ $* == *"/workspace-${index}"* ]] && { printf '%s\\n' ${JSON.stringify(branch)}; exit 0; }`,
              ],
        ),
        // **detached の答えは、呼び方で変わる**（#199 のレビュー）——
        // **`--quiet` があれば何も出さずに 1、無ければ 128 で `fatal`** である。
        // **常に 1 を返すと、実装から `--quiet` を外す変異が緑のまま通る**
        // ——**`--quiet` こそがこの直しの本体**なのに、押さえられない。
        '  if [[ $* == *"--quiet"* ]]; then exit 1; fi',
        '  echo "fatal: ref HEAD is not a symbolic ref" >&2',
        "  exit 128",
        "fi",
        // **detached の作業場が、どの commit にいるか。** **無関係な commit を既定に置く**
        // ——**全部を同じ値にすると、「先端が同じか」を見なくても抑えられてしまう**
        'if [[ $* == *"rev-parse"* ]]; then',
        ...detachedAt.map(
          ({ workspace, sha }) =>
            `  [[ $* == *${JSON.stringify(workspace)}* ]] && { printf '%s\\n' ${JSON.stringify(sha)}; exit 0; }`,
        ),
        `  printf '%s\\n' ${JSON.stringify("c".repeat(40))}`,
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        ...(options.ghFails === true ? ['echo "gh が落ちた" >&2', "exit 1"] : []),
        // **PR の head を、問い合わせて・取り出しているか。** ここで確かめないと、
        // **スタブが勝手に返した列**で判定が通り、**尋ねていない実装でも緑**になる
        // （#178 で踏んだ形）。**2 つに分けて見る**——**`--json` から外しても
        // `--jq` に語が残っていれば満たされる**（#173 でそれを踏んだ）
        'if [[ $* == *"pr list"* ]]; then',
        '  if [[ $* != *",headRefOid"* ]]; then',
        '    echo "スタブ: PR の head を問い合わせていない: $*" >&2',
        "    exit 1",
        "  fi",
        '  if [[ $* != *".headRefOid)"* ]]; then',
        '    echo "スタブ: 問い合わせた head を取り出していない: $*" >&2',
        "    exit 1",
        "  fi",
        "fi",
        // **ブランチごとに引く。** **一括で取ると、上限を超えた古い PR が「無い」に化ける**
        // （この repo は既に PR が 171 件）。**fork の PR は別物**なので、
        // **同じリポジトリのものだけ**を返す（`isCrossRepository` で絞るのは呼ぶ側）。
        //
        // **同じ head の PR は、まとめて返す。** 1 件ずつ `exit` すると
        // **最初の 1 件しか返らず**、**「複数付きうる」経路を 1 度も通せない**
        ...[...new Set(options.prs.map((pr) => pr.head))].map((head) => {
          const rows = options.prs
            .filter((pr) => pr.head === head)
            // **上限で切り詰める。** 実物の `--limit` はここで効く——**切り詰めない
            // スタブでは、上限より後ろに一致がある状態を 1 度も作れない**（#180 のレビュー）
            .slice(0, PR_LIST_LIMIT)
            .map(
              (pr) =>
                `${pr.number}\\u001f${pr.state}\\u001f${pr.crossRepo === true ? "true" : "false"}\\u001f${pr.headOid ?? "a".repeat(40)}`,
            )
            .join("\\n");
          return `if [[ $* == *"--head ${head}"* ]]; then printf '%b\\n' ${JSON.stringify(rows)}; exit 0; fi`;
        }),
        // **先端を含む PR は、上限に依らない口で尋ねる**（#180 のレビュー）。
        // **どの PR に入っているかは、その head の一覧の何番目にあるかと関係が無い**
        ...[...new Set(options.prs.map((pr) => pr.headOid ?? "a".repeat(40)))].map((oid) => {
          const rows = options.prs
            .filter((pr) => (pr.headOid ?? "a".repeat(40)) === oid)
            .map(
              (pr) =>
                `${pr.number}\\u001f${pr.state === "OPEN" ? "open" : "closed"}\\u001f${pr.crossRepo === true ? "someone/valence" : "mattyan1053/valence"}\\u001fmattyan1053/valence`,
            )
            .join("\\n");
          return `if [[ $* == *"commits/${oid}/pulls"* ]]; then printf '%b\\n' ${JSON.stringify(rows)}; exit 0; fi`;
        }),
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // **走っている作業場は lease が持つ。** ここでは答えだけを差し替える
    writeFileSync(
      join(sandbox, "bin", "loop-lease"),
      [
        "#!/usr/bin/env bash",
        ...(options.busyUnreadable === true ? ["exit 2"] : []),
        ...busyBranches.map((_branch, index) => `printf '%s\\n' "/workspace-${index}"`),
        ...detachedAt.map(({ workspace }) => `printf '%s\\n' ${JSON.stringify(workspace)}`),
        `exit ${busyBranches.length + detachedAt.length > 0 ? 0 : 1}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // **隣を差し替えるために、写してから走らせる。** スクリプトは
    // `${BASH_SOURCE%/*}/loop-lease` を引く（PATH ではない）ので、**同じ場所に置く**
    const copied = join(sandbox, "bin", "loop-stray-branches");
    copyFileSync(SCRIPT, copied);
    chmodSync(copied, 0o755);

    const result = spawnSync(copied, [], {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("PR が無いブランチを挙げる", () => {
    const result = run({ branches: [{ name: "feat/lost" }], prs: [] });

    expect(result.status, "見つけたのに 0 を返している").toBe(1);
    expect(result.stdout).toContain("feat/lost");
    expect(result.stdout, "種類が出ていない").toContain("no-pr");
  });

  it("終わった PR の消し残りは、別の種類で挙げる", () => {
    // **拾い手も対処も違う。** **こちらは消してよい**——作業は PR に残っている
    const result = run({
      branches: [{ name: "feat/done" }],
      prs: [{ head: "feat/done", number: 76, state: "MERGED" }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "種類が出ていない").toContain("merged-leftover");
    expect(result.stdout, "どの PR かが出ていない").toContain("76");
    // **既定では PR の head とブランチの先端が同じ**（＝中身は PR に入っている）
  });

  it("マージのあとに積まれた commit があるブランチは、消してよいと言わない", () => {
    // **これが本体**（#177）。**`merged-leftover` は「作業は PR に残っているので
    // 消してよい」を意味する**が、**マージのあとに積んだ commit はその PR に入っていない**——
    // **消すと、その作業が消える**。**実物があった**（`feat/await-review` の `9f34c6e`、
    // #78 の叩き台。master は 5 回「削除するだけでよい」と人へ伝えていた）。
    //
    // **倒れる向きがいちばん悪い。** `no-pr` は人を呼ぶ（安全側）が、
    // **こちらは「消してよい」と言う**うえ、**消えたことは次に誰かが探すまで分からない**
    const result = run({
      branches: [{ name: "feat/kept-going", sha: "c".repeat(40) }],
      prs: [{ head: "feat/kept-going", number: 76, state: "MERGED", headOid: "b".repeat(40) }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "消してよいと言っている").not.toContain("merged-leftover");
    expect(result.stdout, "人へ渡す側になっていない").toContain("beyond-pr");
    // **人が判断できる材料を出す**（どの PR の先か / どこまで積まれているか）
    expect(result.stdout, "どの PR かが出ていない").toContain("76");
    expect(result.stdout, "先端が出ていない").toContain("cccccccc");
  });

  it("PR の head と先端が同じなら、これまでどおり消してよい", () => {
    // **止める側だけを見ない**（#168 で踏んだ）。**全部を人へ渡す形でも
    // 上の 1 本は緑になる**ので、**普通の消し残りが残ること**を別に見る
    const result = run({
      branches: [{ name: "feat/done", sha: "b".repeat(40) }],
      prs: [{ head: "feat/done", number: 76, state: "MERGED", headOid: "b".repeat(40) }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "普通の消し残りまで人へ渡している").toContain("merged-leftover");
  });

  it("PR の head を読めなければ、消してよいと言わない", () => {
    // **判定不能を「消してよい」へ倒さない。** **迷ったら人へ渡す側**である
    const result = run({
      branches: [{ name: "feat/unknown-head", sha: "c".repeat(40) }],
      prs: [{ head: "feat/unknown-head", number: 76, state: "MERGED", headOid: "" }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "読めないのに消してよいと言っている").not.toContain("merged-leftover");
  });

  it("open な PR の head は、宙に浮いていない", () => {
    // **作業中のブランチを報告すると、毎周回出る警告になって読まれなくなる**
    const result = run({
      branches: [{ name: "feat/working" }],
      prs: [{ head: "feat/working", number: 99, state: "OPEN" }],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("main は見ない", () => {
    expect(run({ branches: [{ name: "main" }], prs: [] }).status).toBe(0);
  });

  it("いま作業中のブランチは、挙げない", () => {
    // **push から PR 作成までの間に、必ず窓が開く**（master が実測。#148 のコメント）。
    // **時間で切らない**——**遅い周回と落ちた周回は、経過時間では分けられない**（#129）
    const result = run({
      branches: [{ name: "feat/just-pushed" }],
      prs: [],
      busyBranches: ["feat/just-pushed"],
    });

    expect(result.status, "健全な周回の途中で鳴っている").toBe(0);
    expect(result.stdout).toBe("");
  });

  it("走っている周回と無関係なブランチは、隠さない", () => {
    // **ここが本命である。** **どこか 1 つでも走っていれば全部隠す**と、
    // **worker が途切れず動く環境では紛失作業が永久に見つからない**——
    // **動いているほど見つからない**という、**向きが逆**の壊れ方になる（#148 のレビュー）
    const result = run({
      branches: [{ name: "feat/just-pushed" }, { name: "feat/lost-long-ago" }],
      prs: [],
      busyBranches: ["feat/just-pushed"],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "無関係なブランチまで隠している").toContain("feat/lost-long-ago");
    expect(result.stdout, "作業中のブランチを挙げている").not.toContain("feat/just-pushed");
  });

  it("走っているか読めなければ、0 件とも「宙に浮いている」とも言わない", () => {
    // **契約は `exit 2 = 読めない`。** **どちらかへ倒すと、片方の誤りをそのまま作る**
    const result = run({
      branches: [{ name: "feat/x" }],
      prs: [],
      busyUnreadable: true,
    });

    expect(result.status).toBe(2);
  });

  it("周回が走っていても、消し残りは挙げる", () => {
    // **窓は「PR がまだ無い」ほうにしか開かない。** 消し残りは**終わったもの**なので、
    // 走っている周回とは関係が無い
    const result = run({
      branches: [{ name: "feat/done" }],
      prs: [{ head: "feat/done", number: 76, state: "MERGED" }],
      busyBranches: ["feat/done"],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("merged-leftover");
  });

  it("fork の PR は、origin の同名ブランチと同一視しない", () => {
    // **`headRefName` だけをキーにすると、fork の PR が origin の無関係なブランチに
    // 対応付けられる**——**終わっていれば「消してよい」と表示され、
    // 手順どおり消すと PR に残っていない作業が消える**（#148 が塞ごうとした穴を、
    // 塞ぐ側が広げる形）。**同じリポジトリの PR だけを見る**
    const result = run({
      branches: [{ name: "feat/same-name" }],
      prs: [{ head: "feat/same-name", number: 200, state: "MERGED", crossRepo: true }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "fork の PR を自分のものとして数えている").toContain("no-pr");
    expect(result.stdout).not.toContain("merged-leftover");
  });

  it("終わった PR が複数あっても、先端を含むものがあれば消してよい", () => {
    // **`gh pr list` は並び順を保証しない**（`--limit` は「最大何件取るか」だけ）。
    // **最後に読んだ 1 件で決めると、先に返ってきた一致が捨てられる**——
    // **作業は PR に残っているのに、人待ちが毎周回積まれ、3 周ごとに `loop/STOP`**
    // になる（#180 のレビュー）。**呼びすぎる側が積み上がる**形である。
    //
    // **一致するものを先に返す**（後ろが上書きする実装なら、ここで落ちる）
    const result = run({
      branches: [{ name: "feat/remade", sha: "b".repeat(40) }],
      prs: [
        { head: "feat/remade", number: 76, state: "MERGED", headOid: "b".repeat(40) },
        { head: "feat/remade", number: 60, state: "CLOSED", headOid: "c".repeat(40) },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "先端を含む PR があるのに人へ渡している").toContain("merged-leftover");
  });

  it("終わった PR が複数あっても、どれも先端を含まなければ人へ渡す", () => {
    // **集約を「どれか 1 つでも終わっていれば消してよい」に広げない**——
    // **それは先端を見ない形**（#177 の前）に戻ることである
    const result = run({
      branches: [{ name: "feat/remade", sha: "d".repeat(40) }],
      prs: [
        { head: "feat/remade", number: 76, state: "MERGED", headOid: "b".repeat(40) },
        { head: "feat/remade", number: 60, state: "CLOSED", headOid: "c".repeat(40) },
      ],
    });

    expect(result.stdout, "先端を含まないのに消してよいと言っている").toContain("beyond-pr");
  });

  it("先端を含む PR が取得上限より後ろにあっても、消してよいと分かる", () => {
    // **`--limit` は「最大何件取るか」だけ**で、**並び順は保証されない**——
    // **一致が上限より後ろにあると `tip_in_pr=0` のまま**になり、
    // **安全に消せるブランチを人待ちにし続ける**（#180 のレビュー 2 周目）。
    //
    // **上限を上げない。** **根拠の無い数字は消すほうへ倒す**（#134 と同じ形）——
    // **「先端を含む PR があるか」を、一覧の上限と独立に尋ねる**
    const tip = "b".repeat(40);
    const result = run({
      branches: [{ name: "feat/remade-many", sha: tip }],
      prs: [
        // **上限のぶんだけ、一致しない PR を並べる**
        ...Array.from({ length: PR_LIST_LIMIT }, (_unused, index) => ({
          head: "feat/remade-many",
          number: 100 + index,
          state: "CLOSED" as const,
          headOid: "c".repeat(40),
        })),
        // **一致するものは、上限より後ろにある**
        { head: "feat/remade-many", number: 76, state: "MERGED" as const, headOid: tip },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "上限より後ろの一致を見ていない").toContain("merged-leftover");
  });

  it("先端を含む open な PR があれば、消してよいと言わない", () => {
    // **消すと open な PR が壊れる。** **`--head` の一覧は上限で切れる**ので、
    // **先端を含む PR の state も、上限に依らない口から見る**
    const tip = "b".repeat(40);
    const result = run({
      branches: [{ name: "feat/working-many", sha: tip }],
      prs: [
        ...Array.from({ length: PR_LIST_LIMIT }, (_unused, index) => ({
          head: "feat/working-many",
          number: 100 + index,
          state: "CLOSED" as const,
          headOid: "c".repeat(40),
        })),
        { head: "feat/working-many", number: 76, state: "OPEN" as const, headOid: tip },
      ],
    });

    expect(result.status, "作業中の PR がある head を挙げている").toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fork の PR が先端を含んでいても、消してよいと言わない", () => {
    // **fork の PR は別物である**（一覧側と同じ判断）。**origin のブランチを消しても
    // fork には残る**が、**この repo の側から見ると作業は残っていない**——
    // **迷ったら人へ渡す側**へ倒す
    const tip = "b".repeat(40);
    const result = run({
      branches: [{ name: "feat/forked-tip", sha: tip }],
      prs: [
        // origin 側の終わった PR（**先端は含まない**）。表示に使われる
        { head: "feat/forked-tip", number: 60, state: "CLOSED", headOid: "c".repeat(40) },
        // fork の PR が先端を含んでいる
        { head: "feat/forked-tip", number: 200, state: "MERGED", headOid: tip, crossRepo: true },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "fork の PR を自分のものとして数えている").toContain("beyond-pr");
  });

  it("ブランチごとに引く（一括の上限に依らない）", () => {
    // **一括で取ると、上限を超えた古い PR が「無い」に化ける**——
    // **この repo は既に PR が 171 件**で、**古いマージ済みの消し残りが
    // 人の判断待ちとしてループを止める**
    const result = run({
      branches: [{ name: "feat/ancient" }],
      prs: [{ head: "feat/ancient", number: 3, state: "MERGED" }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "ブランチごとに引けていない").toContain("merged-leftover");
  });

  it("平常時は、何も出さない", () => {
    // **毎周回出る警告にしない**（`bin/loop-merge` の消し残り警告が実際にそうなった）
    const result = run({
      branches: [{ name: "main" }, { name: "feat/working" }],
      prs: [{ head: "feat/working", number: 99, state: "OPEN" }],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("走っている作業場のブランチを読めなければ、判定しない", () => {
    // **走っているのに、どのブランチを触っているか分からない**——
    // **抑えるべきかどうかが決められない**ので、**どちらへも倒さない**
    const result = run({
      branches: [{ name: "feat/x" }],
      prs: [],
      // **走ってはいるが、本当に読めない**（壊れたリポジトリ。detached とは別物）
      busyBranches: ["?"],
    });

    expect(result.status).toBe(2);
  });

  it("detached の作業場は、どのブランチも抑えない", () => {
    // **detached は「読めない」ではなく「掴んでいるブランチが無い」**である（#198）。
    // **#197 で worker が `origin/main` へ detach するようになった**ので、
    // **手が空いている worker は常にここへ入る**——**見張りが毎周回「読めない」で終わり、
    // 宙に浮いたブランチが誰にも見られなくなる**（**倒れる向きが「黙って通す」側**）
    const result = run({
      branches: [{ name: "feat/lost-long-ago" }],
      prs: [],
      busyBranches: [""],
    });

    expect(result.status, "detached を「読めない」と扱っている").toBe(1);
    expect(result.stdout, "宙に浮いたブランチを挙げていない").toContain("feat/lost-long-ago");
  });

  it("detached の作業場が先端にいるブランチは、抑える", () => {
    // **worker がブランチを掴まなくなった** (#102) ので、**「掴んでいるブランチ」では
    // いま触っているものを表せない**——**そのままだと、push してから PR ができるまでの
    // 間ずっと「宙に浮いている」と人へ渡す**（**publish-failed の周回では何周も続く**）。
    //
    // **消す側を足したら、残る側の前提を見直す**（`AGENTS.md` §5）——
    // **#148 が入れた「作業中は抑える」が、掴まなくなった時点で効かなくなる。**
    const result = run({
      branches: [{ name: "feat/just-pushed", sha: "b".repeat(40) }],
      prs: [],
      busyDetachedHeads: ["b".repeat(40)],
    });

    expect(result.stdout, "これから PR になるブランチを宙に浮いていると言っている").not.toContain(
      "no-pr",
    );
    expect(result.status).toBe(0);
  });

  it("detached の作業場が別の commit にいるなら、抑えない", () => {
    // **倒す先は 2 つある**（#200 で 3 回出た）——**「走っていれば抑える」にすると、
    // #148 が塞いだ「動いているほど見つからない」へ戻る。**
    // **先端が同じであること**まで見る
    const result = run({
      branches: [{ name: "feat/lost-long-ago", sha: "b".repeat(40) }],
      prs: [],
      busyDetachedHeads: ["d".repeat(40)],
    });

    expect(result.status, "走っている作業場が、無関係なブランチまで抑えている").toBe(1);
    expect(result.stdout).toContain("feat/lost-long-ago");
  });

  it("detached の作業場があっても、ブランチを掴んでいる側は抑える", () => {
    // **入力を 2 つ用意する**（#195 / #196 / #197 で 3 回続けて踏んだ形）。
    // **detached だけだと「抑える側」の経路を 1 度も通らない**——
    // **片方だけ直すと、走っている worker の作業中ブランチを「宙に浮いている」と誤報する**
    const result = run({
      branches: [{ name: "feat/just-pushed" }, { name: "feat/lost-long-ago" }],
      prs: [],
      busyBranches: ["", "feat/just-pushed"],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "作業中のブランチを挙げている").not.toContain("feat/just-pushed");
    expect(result.stdout, "無関係なブランチを隠している").toContain("feat/lost-long-ago");
  });

  it("読めなければ、0 件と同じ顔をしない", () => {
    // **「無かった」と「読めなかった」を同じ値に丸めない**（#136 と同じ家族）
    expect(run({ branches: [], prs: [], gitFails: true }).status).toBe(2);
    expect(run({ branches: [{ name: "feat/x" }], prs: [], ghFails: true }).status).toBe(2);
  });
});
