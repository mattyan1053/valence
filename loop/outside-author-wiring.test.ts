import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCEDURE = ".claude/commands/loop-master.md";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 節ごとの bash ブロック。 */
function blocks(): { section: string; body: string }[] {
  const found: { section: string; body: string }[] = [];
  let section = "";
  let body: string[] | undefined;
  for (const line of read(PROCEDURE).split("\n")) {
    if (/^#{2,4} /.test(line)) {
      section = line.trim();
    }
    if (line.startsWith("```")) {
      if (body !== undefined) {
        found.push({ section, body: body.join("\n") });
      }
      body = line.startsWith("```bash") ? [] : undefined;
      continue;
    }
    body?.push(line);
  }
  return found;
}

/** **対応待ちを数えるブロックを、全部並べる。** 1 つだけ取ると名指しと同じになる。 */
function waitingBlocks(): { section: string; body: string }[] {
  return blocks().filter((block) => block.body.includes("awaiting-worker:"));
}

/**
 * ループの外の著者を待って、全体が止まらないこと（#70）。
 *
 * **ループの外にいる著者は、次に呼ばれるまで動かない。** master は対応待ちの停止を
 * 積むが、**SHA が変わらないので識別子も変わらず、3 周で `loop/STOP`**——
 * **一人の不在が全体停止になる**。
 *
 * **状態は増やさない。** **人待ち（`parked` + `awaiting-human`）は既にある**ので、
 * **そこへ倒す**——「次に動くのはループの外の誰か」という点で同じ状態である。
 */
describe("ループの外の著者", () => {
  /**
   * そのブロックを走らせ、**何が呼ばれたか**を返す。
   *
   * **判定・`gh`・`bin/loop-stall` は偽物**にして、**呼ばれたことだけ**を見る。
   */
  function runBlock(
    body: string,
    outsideExit: number,
    options: {
      editFails?: boolean;
      commentFails?: boolean;
      parkedHead?: string;
      headExit?: number;
    } = {},
  ) {
    const workspace = mkdtempSync(join(tmpdir(), "outside-author-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, "bin"), { recursive: true });
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$*" >> ${JSON.stringify(join(workspace, "gh-calls"))}`,
          ...(options.editFails === true ? ['[[ $* == *"pr edit"* ]] && exit 1'] : []),
          ...(options.commentFails === true ? ['[[ $* == *"pr comment"* ]] && exit 1'] : []),
          // 保留の一覧（**外す経路**が引く）
          `[[ $* == *"pr list"* ]] && { printf '%s\\n' 12; exit 0; }`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      for (const [name, script] of [
        [
          "loop-outside-author",
          ["#!/usr/bin/env bash", 'printf "someone-else\\n"', `exit ${outsideExit}`, ""],
        ],
        [
          "loop-stall",
          [
            "#!/usr/bin/env bash",
            `printf '%s\\n' "$*" >> ${JSON.stringify(join(workspace, "stalled"))}`,
            "exit 0",
            "",
          ],
        ],
        ["loop-head", ["#!/usr/bin/env bash", `exit ${options.headExit ?? 0}`, ""]],
        [
          "loop-parked-head",
          [
            "#!/usr/bin/env bash",
            `printf '%s\\n' "$*" >> ${JSON.stringify(join(workspace, "parked-head"))}`,
            options.parkedHead === undefined
              ? "[[ $1 == get ]] && exit 1"
              : `[[ $1 == get ]] && { printf '%s\\n' ${JSON.stringify(options.parkedHead)}; exit 0; }`,
            "exit 0",
            "",
          ],
        ],
      ] as const) {
        writeFileSync(join(workspace, "bin", name), script.join("\n"), { mode: 0o755 });
      }

      spawnSync("bash", ["-c", body.replace(/<[^>]+>/g, "1")], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });

      const readIf = (name: string) =>
        existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), "utf8") : "";
      return {
        gh: readIf("gh-calls"),
        stalled: readIf("stalled"),
        parkedHead: readIf("parked-head"),
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("対応待ちを数える節は、必ず著者を確かめる", () => {
    // **絞ってから見ない。** **数える節が 1 つでも判定を通らなければ、
    // そこから全体停止が入る**（#166 / #168 と同じ形）
    expect(
      waitingBlocks().map((block) => [block.section, block.body.includes("loop-outside-author")]),
    ).toEqual([
      ["### 要求が満たされたか確かめる（`changes-requested`）", true],
      ["#### rework — worker へ差し戻す", true],
    ]);
  });

  it("外の著者なら、保留にして数えない", () => {
    // **これが本体。** **数えると、待っているものが届いた瞬間に全体が止まる**
    for (const block of waitingBlocks()) {
      const result = runBlock(block.body, 0);

      expect(result.gh, `${block.section}: 保留にしていない`).toContain("--add-label parked");
      expect(result.gh, `${block.section}: 何待ちか分からない保留になっている`).toContain(
        "awaiting-human",
      );
      expect(result.stalled, `${block.section}: 外の著者を待って数えている`).toBe("");
    }
  });

  it("ループのアカウントなら、これまでどおり数える", () => {
    // **止める側だけを見ない**（#168 で踏んだ）。**worker の対応待ちは数え続ける**——
    // ここを止めると、**対応が来ないまま何周でも回る**
    for (const block of waitingBlocks()) {
      const result = runBlock(block.body, 1);

      expect(result.stalled, `${block.section}: worker の対応待ちを数えていない`).toContain(
        "awaiting-worker",
      );
      expect(result.gh, `${block.section}: 中の PR を保留にしている`).not.toContain(
        "--add-label parked",
      );
    }
  });

  it("読めないときも、これまでどおり数える", () => {
    // **判定不能を「外」に倒さない。** 倒すと、**worker の対応待ちが人待ちに化ける**
    for (const block of waitingBlocks()) {
      const result = runBlock(block.body, 2);

      expect(result.stalled, `${block.section}: 分からないのに数えていない`).toContain(
        "awaiting-worker",
      );
    }
  });

  it("保留にできなければ、これまでどおり数える", () => {
    // **ループは止まる側にある。** **保留したつもりで何も付いていない**のがいちばん悪い
    // （人待ちの節と同じ倒し方）
    for (const block of waitingBlocks()) {
      const result = runBlock(block.body, 0, { editFails: true });

      expect(result.stalled, `${block.section}: 保留に失敗したのに数えていない`).toContain(
        "awaiting-worker",
      );
    }
  });

  it("どちらの著者でも、何が足りないかを投稿する", () => {
    // **これが最悪の倒れ方だった**（#176 のレビュー）。**外の枝にだけ置くと、
    // 通常の worker（＝ほぼ全部）が何を直せばよいか分からないまま 3 周で `loop/STOP`**——
    // **この PR が消しに来た「一人の不在で全部止まる」を、別の形で作る**。
    //
    // **散文には書いてあった。** **試験はブロックだけを走らせる**ので、
    // **散文に残ったコメントは誰も確かめない**
    for (const block of waitingBlocks()) {
      for (const outside of [0, 1, 2]) {
        const result = runBlock(block.body, outside);

        expect(result.gh, `${block.section}: 著者判定 ${outside} で投稿していない`).toContain(
          "pr comment",
        );
      }
    }
  });

  it("理由を投稿できなければ、保留にせず数える", () => {
    // **理由の無い保留を作らない** (#163)。**投稿してから保留にする**ので、
    // **投稿が落ちた時点で保留にしない**——戻す操作が要らない
    for (const block of waitingBlocks()) {
      const result = runBlock(block.body, 0, { commentFails: true });

      expect(result.gh, `${block.section}: 理由が無いのに保留にしている`).not.toContain(
        "--add-label parked",
      );
      expect(result.stalled, `${block.section}: 投稿に失敗したのに数えていない`).toContain(
        "awaiting-worker",
      );
    }
  });

  it("保留にするときは、保留にした head を記録する", () => {
    // **著者が対応したかを、あとから状態だけで決めるため**（#70 の完了条件）
    for (const block of waitingBlocks()) {
      const result = runBlock(block.body, 0);

      expect(result.parkedHead, `${block.section}: 保留にした head を残していない`).toContain(
        "record",
      );
    }
  });

  describe("保留を外す", () => {
    /** 保留を外す経路のブロック。 */
    function unparkBlock(): string {
      const found = blocks().find((block) => block.body.includes("loop-parked-head get"));
      expect(found, "保留を外す経路が無い").toBeDefined();
      return found?.body ?? "";
    }

    it("head が動いていたら、外す", () => {
      // **fork から出す人に triage 権限は無い**ので、**自分では外せない**——
      // **push しても誰も見に来ない**（`bin/loop-silent-park` にも出てこない）
      const result = runBlock(unparkBlock(), 0, { parkedHead: "a".repeat(40), headExit: 1 });

      expect(result.gh, "保留を外していない").toContain("--remove-label parked");
      expect(result.gh, "何待ちかの印を外していない").toContain("awaiting-human");
    });

    it("head が同じなら、外さない", () => {
      // **対応していないのに外すと、また指摘して保留に戻すだけ**（毎周回うるさくなる）
      const result = runBlock(unparkBlock(), 0, { parkedHead: "a".repeat(40), headExit: 0 });

      expect(result.gh, "動いていないのに外している").not.toContain("--remove-label parked");
    });

    it("head を読めなければ、外さない", () => {
      // **判定不能をどちらへも倒さない**（このループの原則）
      const result = runBlock(unparkBlock(), 0, { parkedHead: "a".repeat(40), headExit: 2 });

      expect(result.gh, "読めないのに外している").not.toContain("--remove-label parked");
    });

    it("記録の無い保留は、触らない", () => {
      // **人が外すと決めた保留がある**（先行 PR 待ち）。**そこまで外すと、
      // 保留の意味が消える**
      const result = runBlock(unparkBlock(), 0, { headExit: 1 });

      expect(result.gh, "人待ちの保留まで外している").not.toContain("--remove-label parked");
    });

    it("ループの中の著者なら、触らない", () => {
      // **中の保留は、これまでどおり人が外す**（`awaiting-human` の規定）
      const result = runBlock(unparkBlock(), 1, { parkedHead: "a".repeat(40), headExit: 1 });

      expect(result.gh, "中の保留まで外している").not.toContain("--remove-label parked");
    });
  });

  it("判定は 1 箇所に置く", () => {
    // **手順書が自前で判定しない**（#159 で踏んだ形）
    expect(read(PROCEDURE), "手順書が自前で著者を見ている").not.toContain("--json author");
  });

  it("ループの外から割り込む方法が、README にある", () => {
    // **ループの外にいる人が読む場所は 1 つ**である（Issue の完了条件）。
    //
    // **散らばった語で見ない。** README には既に「割り込み」「起票」「parked」が
    // 別の話で出てくるので、**全体を検索すると、何も書かなくても満たされる**——
    // **書いたのに入っていない**を、こちらから作ってしまう。**節を取り出して見る**
    const section = read("loop/README.md").split("## ループの外から割り込む")[1] ?? "";
    const body = section.split(/\n## /)[0] ?? "";

    expect(body, "節が無い").not.toBe("");
    expect(body, "状態の正が Issue だと書かれていない").toContain("Issue");
    expect(body, "急ぐときの伝え方が書かれていない").toContain("通知");
    expect(body, "外から出した PR の扱いが書かれていない").toContain("parked");
    expect(body, "label を外すのが著者だと書かれていない").toMatch(/外す/);
  });
});
