import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readExamples } from "./fixup-limit-record";

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

/** いま効いている上限（**実例が上限に触れたか**は、この値と突き合わせて決まる）。 */
function defaultLimit(): number {
  const gate = readFileSync(join(REPO_ROOT, "bin/loop-gate"), "utf8");
  const matched = gate.match(/readonly MAX_FIXUP_LINES="\$\{LOOP_MAX_FIXUP_LINES:-(\d+)\}"/);
  if (matched?.[1] === undefined) {
    throw new Error("上限の既定値が読めない");
  }
  return Number(matched[1]);
}

/**
 * 記録した実例（**読み方は `loop/fixup-limit-record.ts` が 1 つだけ持つ**）。
 *
 * **ここが見るのは形だけ**である——**値が本当かは `bin/loop-fixup-basis` が測る。**
 */
function examples() {
  return readExamples(readFileSync(join(REPO_ROOT, "bin/loop-gate"), "utf8"));
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

  it("上限が止め、人が通した実例が、母数に入っている", () => {
    // **「止める側の実例は 0 件」は、もう成り立たない**（#242）。**#224 は上限が止め、
    // 人が「通してよい」と結論した**——**「60 で困らなかった」の反例**である。
    //
    // **語で見ない。** **記録した値と、いま効いている上限を突き合わせる**——
    // **上限を超えた行が 1 件も無ければ、何を書いてあっても実例は付いていない**
    const stopped = examples().filter((example) => Number(example.measured[0]) > defaultLimit());

    expect(stopped.length, "上限に触れた実例が記録されていない").toBeGreaterThan(0);
    expect(
      stopped.map((example) => example.verdict),
      "上限に触れた実例に、人の結論が記録されていない",
    ).toContain("人が通した");
    expect(limitSection(), "止める側が 0 件だという主張が残っている").not.toMatch(
      /止める側の実例は、いまも 0 件/,
    );
  });

  it("記録した実例が、測り直せる形で置いてある", () => {
    // **手で書いた数字を貼らない**（#242 の完了条件）。**測り直しに要るのは
    // PR 番号とレビュー済み SHA と head SHA** で、**この 3 つが揃っていれば
    // `bin/loop-fixup-lines` へそのまま渡せる**——**値だけ残すと、
    // 次に「本当か」と言われたときに誰も確かめられない**。
    //
    // **マージ commit も要る。** **人の結論は PR の状態ではなく `main` の履歴に残る**もので、
    // **PR が閉じ方を変えても、その commit は動かない**
    const recorded = examples();

    expect(recorded.length, "実例が 1 件も記録されていない").toBeGreaterThan(0);
    for (const example of recorded) {
      expect(example.pr, `PR 番号が読めない: ${JSON.stringify(example)}`).toMatch(/^\d+$/);
      // **3 列そろって初めて `bin/loop-fixup-lines` の出力である**（除外のぶんも記録に要る）
      for (const value of example.measured) {
        expect(value, `測った値が数でない: ${JSON.stringify(example)}`).toMatch(/^\d+$/);
      }
      expect(example.reviewed, `レビュー済み SHA が無い: #${example.pr}`).toMatch(/^[0-9a-f]{40}$/);
      expect(example.head, `head SHA が無い: #${example.pr}`).toMatch(/^[0-9a-f]{40}$/);
      expect(example.merge, `マージ commit が無い: #${example.pr}`).toMatch(/^[0-9a-f]{40}$/);
      expect(example.verdict, `その実例をどう扱ったかが無い: #${example.pr}`).not.toBe("");
    }
  });

  it("形しか見ていないことを、名乗ってある", () => {
    // **この本が見ているのは「列が揃っているか」だけ**である（#309 のレビュー）——
    // **`70` を `700` に書き換えても、SHA を別の 40 桁へ差し替えても通る。**
    //
    // **主張を、測っているものへ合わせる。** **本当に測り直す側は
    // `bin/loop-fixup-basis`**（**網と認証が要るので `./task check` には入れない**）で、
    // **記録の側からそこを指していなければ、誰も打たない**
    expect(limitSection(), "測り直す側への道が、記録に書かれていない").toContain(
      "bin/loop-fixup-basis",
    );
  });

  it("測り直す側が、実際に赤くなる場所で走っている", () => {
    // **「CI の専用 job で赤くする」と書いてあっても、job が無ければ誰も測らない**——
    // **`./task check` から外した時点で、打つ人がいなくなる**（#210 で
    // **足りない環境変数で skip した試験が、緑のまま何も見なくなった**のと同じ形）。
    //
    // **置く側と読む側は 1 組である。** **コメントの主張と、workflow の中身を突き合わせる**
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

    expect(workflow, "測り直す側を走らせる job が無い").toMatch(/run: bin\/loop-fixup-basis/);
  });

  it("数え方を変える前の実例を、いまの値として並べていない", () => {
    // **#132 より前の 4 件 (#36 / #41 / #96 / #124) は、いまの数え方の値を持たない**——
    // **89 行が同じ PR で 37 行になった**（#134）。**結論の向きだけが使えて、
    // 行数は使えない**ので、**同じ表に並べると、比べられないものが比べられる**
    const listed = new Set(examples().map((example) => example.pr));

    for (const before of ["36", "41", "96", "124"]) {
      expect(listed.has(before), `#132 より前の #${before} を、いまの実例として並べている`).toBe(
        false,
      );
    }
  });

  it("数え方の誤りを、上限の実例と混ぜていない", () => {
    // **#295 は「上限が厳しすぎた」ではなく「数え方が間違っていた」**（master の指摘）。
    // **混ぜると、閾値を緩める根拠に見える**——**直したのは数え方のほう** (#299 / PR #301)。
    //
    // **当時の 370 行はいま再現できない**（後のレビューが最終 head に載った）ので、
    // **記録に残せるのは、いまの数え方で測った 0 行のほう**である
    const miscount = examples().find((example) => example.pr === "295");

    expect(miscount, "数え方の誤りだった実例が記録されていない").toBeDefined();
    expect(miscount?.verdict, "誤検出を、人が通した実例と同じ扱いで並べている").not.toBe(
      "人が通した",
    );
    expect(limitSection(), "当時の値が再現できないことが書かれていない").toMatch(/再現できない/);
  });

  it("測った値の上振れが、記録と一緒に残っている", () => {
    // **除外されるのは「レビューが要求した」と文字列で結び付いた行だけ**なので、
    // **要求に応じた変更のうち結び付かなかったぶんは本体側に数えられている**。
    // **但し書きを別の場所に置くと、値だけが独り歩きする**——**同じ節に残す**
    expect(limitSection(), "除外の取りこぼしに触れていない").toMatch(/結び付かなかった/);
  });

  it("人の結論と master の判断を、分けて書いてある", () => {
    // **閾値を決めた側が、その閾値で下した判断を根拠にする**と、**独立した検証に
    // ならない**（master の指摘）。**「60 で困らなかった」と「60 が正しい」は別**である
    const section = limitSection();

    expect(section, "誰が判断したものかを分けていない").toMatch(/master が判断した/);
    expect(section, "独立した検証でないことが書かれていない").toMatch(/独立した検証/);
  });

  /**
   * 手順を、偽の `gh` と偽の数える側で走らせる。
   *
   * `failing` を渡すと、**その名前のスクリプトだけが落ちる**——
   * **落ちたときに表を作らないこと**を見るためである。
   */
  function runProcedure(failing?: "loop-review-commits" | "loop-fixup-lines" | "gh") {
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
          ...(failing === "gh" ? ['[[ $* == *"headRefOid"* ]] && exit 1'] : []),
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
            // **1 件目だけ落とす。** 全部落ちる形だと、**表が空になるだけ**で
            // **「欠けた行が混ざる」経路を通らない**
            ...(failing === name ? ['[[ " $* " == *" 137 "* ]] && exit 1'] : []),
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
      const calls = existsSync(join(workspace, "calls"))
        ? readFileSync(join(workspace, "calls"), "utf8")
        : "";
      return { ...result, status: result.status ?? -1, calls };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it.each(["loop-review-commits", "loop-fixup-lines", "gh"] as const)(
    "%s が落ちたら、表を作らない",
    (failing) => {
      // **`printf` は中が落ちても成功する。** **空欄のまま並んだ不完全な表が、
      // 正常な測り直しとして通る**——**落ちた PR がちょうど大きい側だった可能性を、
      // その表は否定しない**（#181 のレビュー 2 周目）。
      // **この表はこの値を動かす唯一の根拠**なので、**欠けたまま出さない**
      const result = runProcedure(failing);

      expect(result.status, "落ちたのに成功している").not.toBe(0);
      expect(result.stdout, "空欄の行が表に混ざっている").not.toMatch(/^137\t$/m);
    },
  );

  it("全件取れなくなる条件と、そのときどうするかが書いてある", () => {
    // **`search/issues` は 1 検索 1000 件が GitHub の上限**（`--paginate` でも越えない）。
    // **消すと「全件取る」が嘘になり、超えた日から母集団が黙って欠ける**——
    // **この Issue が塞ぎに来た形そのもの**である（#181 のレビュー 2 周目）。
    //
    // **数字の出どころが違う。** `--limit 100` は**こちらが選んだ数字で根拠が無かった**が、
    // **1000 は外から与えられた事実**なので、**書いておくことが根拠になる**
    const section = limitSection();

    expect(section, "検索の上限に触れていない").toMatch(/1000 件/);
    expect(section, "超えたときどうするかが書かれていない").toMatch(/期間を割/);
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
