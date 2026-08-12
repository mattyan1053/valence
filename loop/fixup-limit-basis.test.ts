import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * コメントに置いた**測り直しの手順**を、そのまま取り出す。
 *
 * **「書いてある」ではなく「走る」を見る**（#181 のレビュー）。前の版は
 * **番号を並べるだけのコマンドと、測るコマンドが散文でつながっていた**——
 * **`$pr` はどこでも束縛されておらず、そのまま走らせると空の番号で落ちる**のに、
 * **主張を見る試験 5 本は全部緑**だった。
 */
function procedure(): string {
  const gate = readFileSync(join(REPO_ROOT, "bin/loop-gate"), "utf8");
  const body =
    gate.split("---8<--- 測り直しの手順 ---")[1]?.split("---8<--- ここまで ---")[0] ?? "";
  return body
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#\s?/, ""))
    .join("\n");
}

/** 手直しの上限が決まっている場所（値のすぐ上に根拠を置く）。 */
function limitSection(): string {
  const gate = readFileSync(join(REPO_ROOT, "bin/loop-gate"), "utf8");
  const before = gate.split("readonly MAX_FIXUP_LINES=")[0] ?? "";
  // **直前のひとかたまり**だけを見る（他の節の記述で満たされないように）
  return before.split(/\n\n/).at(-1) ?? "";
}

/**
 * 手直しの上限に、失効した根拠が残っていないこと（#134）。
 *
 * **60 は「#36 の 44 行を通す / #41 の 74 行を止める」の中間**として決めた値だったが、
 * **#41 は後から「通してよかった」と分かっている**（#126。**4 件中 4 件で人の結論と
 * 食い違っていた**）。**上側の錨が外れたまま**だと、**次に「厳しすぎる / 緩すぎる」と
 * 言われたときに判断できない**。
 *
 * **書いてあることが根拠として通るか**を見る。**語があるかではない**——
 * **今日 3 回、「語はあるが主張が違う」で緑をすり抜けた**（#171 / #176 の 2 回）。
 */
describe("手直しの上限の根拠", () => {
  it("失効した錨が、根拠として残っていない", () => {
    // **`#41` を止めるための値**、はもう成り立たない。**触れてはいけないのではなく、
    // 「いまの根拠」として書かれていてはいけない**
    const section = limitSection();

    expect(section, "止める側の実例として #41 を挙げている").not.toMatch(
      /#41 の本体 \d+ 行を止める/,
    );
  });

  it("測り直しの開始点が、マージ時刻を持つ PR で書いてある", () => {
    // **Issue はマージ時刻を持たない**（#181 のレビュー）。**#126 は契機で、
    // 数え方を変えたのは PR #132**——**開始点を特定できないと、同じ母集団を作れない**
    const section = limitSection();

    expect(section, "数え方を変えた PR が書かれていない").toMatch(/数え方を変えたのは PR #\d+/);
    // **手順もその PR から時刻を取る**（散文と手順が別のものを指さない）
    expect(procedure(), "手順が開始点を自分で取っていない").toMatch(
      /gh pr view \d+ --json mergedAt/,
    );
  });

  it("いまの数え方で測った実測が、根拠として書いてある", () => {
    // **#126 で数え方が変わっている**ので、**その前の実例は比較に使えない**
    // （89 行が同じ PR で 37 行になった）。**測り直した結果**が要る
    const section = limitSection();

    expect(section, "実測に基づく根拠が無い").toMatch(/いまの数え方で測った/);
    expect(section, "上限に触れた実例の有無が書かれていない").toMatch(/0 件/);
  });

  it("人の結論と master の判断を、分けて書いてある", () => {
    // **閾値を決めた側が、その閾値で下した判断を根拠にする**と、**独立した検証に
    // ならない**（master の指摘）。**「60 で困らなかった」と「60 が正しい」は別**である
    const section = limitSection();

    expect(section, "誰が判断したものかを分けていない").toMatch(/master が判断した/);
    expect(section, "独立した検証でないことが書かれていない").toMatch(/独立した検証/);
  });

  it("測り直しの手順が、そのまま走る", () => {
    // **「書いてある」ではなく「走る」を見る**（#181 のレビュー）。
    // **並べるコマンドと測るコマンドが散文でつながっている**と、
    // **`$pr` が束縛されないまま空の番号で落ちる**——**それでも「手順が書いてある」
    // 側の試験は緑**だった。**縛る先を「文があること」から「文が言っていることが
    // 成り立つこと」へ寄せる。**
    //
    // **`gh` と数える側は偽物**にして、**どの PR 番号で呼ばれたか**だけを見る
    const workspace = mkdtempSync(join(tmpdir(), "fixup-basis-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, "bin"), { recursive: true });
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/usr/bin/env bash",
          `[[ $* == *"nameWithOwner"* ]] && { printf 'someone/valence\\n'; exit 0; }`,
          `[[ $* == *"mergedAt"* ]] && { printf '2026-08-11T04:01:16Z\\n'; exit 0; }`,
          `[[ $* == *"headRefOid"* ]] && { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; exit 0; }`,
          // **日時は検索側へ渡す**（絞ってから取る）。**渡していなければ、ここで落ちる**
          'if [[ $* == *"search/issues"* ]]; then',
          '  [[ $* == *"merged:>2026-08-11T04:01:16Z"* ]] || { echo "スタブ: 日時で絞っていない: $*" >&2; exit 1; }',
          '  [[ $* == *"--paginate"* ]] || { echo "スタブ: ページングしていない: $*" >&2; exit 1; }',
          `  printf '%s\\n' 171 137`,
          "  exit 0",
          "fi",
          'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      for (const name of ["loop-fixup-lines", "loop-review-commits"]) {
        writeFileSync(
          join(workspace, "bin", name),
          [
            "#!/usr/bin/env bash",
            `printf '%s\\n' "${name} $*" >> ${JSON.stringify(join(workspace, "calls"))}`,
            `printf '0\\t0\\t0\\n'`,
            "exit 0",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
      }

      const result = spawnSync("bash", ["-c", procedure()], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });

      expect(result.status, `手順が走らない: ${result.stderr}`).toBe(0);
      const calls = existsSync(join(workspace, "calls"))
        ? readFileSync(join(workspace, "calls"), "utf8")
        : "";
      // **番号が渡っていること**（空の番号で測っていない）
      expect(calls, "測る側に PR 番号が渡っていない").toMatch(/loop-fixup-lines 137 /);
      expect(calls, "1 件しか測っていない").toMatch(/loop-fixup-lines 171 /);
      expect(calls, "レビュー済み head を取っていない").toMatch(/loop-review-commits 137/);
      // **測った値が出ること**（走っただけで何も出ないなら、表は作れない）
      expect(result.stdout, "測った結果が出ていない").toMatch(/^137\t/m);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("上側の錨に何が要るかが書いてある", () => {
    // **次に「厳しすぎる / 緩すぎる」と言われたときの出発点**である。
    // **何が足りないか**を書いていないと、**同じところからやり直すことになる**
    expect(limitSection(), "何があれば上限を動かせるのかが無い").toMatch(
      /人が「これは通すべきでなかった」と結論した実例/,
    );
  });
});
