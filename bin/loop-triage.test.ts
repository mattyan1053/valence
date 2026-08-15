import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-triage", import.meta.url));

type Verdict = { status: number; stdout: string; stderr: string };

/** 判定の入力。**master が数と yes/no で答える**もので、散文は入らない。 */
type Situation = {
  findings?: number;
  reworkLines?: number;
  /** **ゲートが実測した、レビュー後の本体変更の行数**（`--rework-lines` の見込みとは別物）。 */
  fixupLines?: number;
  security?: string;
  worse?: string;
  reachable?: string;
};

function triage(situation: Situation, env: Record<string, string> = {}): Verdict {
  const result = spawnSync(
    SCRIPT,
    [
      "--findings",
      String(situation.findings ?? 0),
      "--rework-lines",
      String(situation.reworkLines ?? 0),
      "--fixup-lines",
      String(situation.fixupLines ?? 0),
      "--security",
      situation.security ?? "no",
      "--worse",
      situation.worse ?? "no",
      "--reachable",
      situation.reachable ?? "no",
    ],
    { encoding: "utf8", env: { ...process.env, ...env }, timeout: 20_000 },
  );
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? "").split("\t")[0]?.trim() ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("bin/loop-triage", () => {
  describe("実際に起きた 4 件で、人の結論と一致する", () => {
    // **いまの基準は 4 件中 4 件で外している。** ここが合わないなら、
    // 物差しを直したことにならない（#73 の完了条件）
    it.each([
      {
        name: "#64 / #67 — 数行の修正",
        // 上限到達後に優先度 1 が出たが、どちらも数行で片付いた
        situation: { findings: 1, reworkLines: 5 },
        expected: "rework",
      },
      {
        name: "#96 — 未レビューが 88 行、指摘は残っていない",
        // 未解決スレッドは 0 件。止めたのは第 3 層（手直しが上限超え）だけである。
        //
        // **人の結論は「このままマージ」だった**が、**`defer` ではそこへ行けない**
        // （#324）——**外出しする指摘が無く、ゲートを塞いでいるのは行数**なので、
        // **Issue を 1 件増やしてゲートは落ちたまま**になる。
        // **数え直す道（rebase）がその結論へ行ける唯一の手**である。
        situation: { findings: 0, reworkLines: 88, fixupLines: 88 },
        expected: "recount",
      },
      {
        name: "#100 — 設計判断を含み、いまの構成では踏めない",
        // 作業場が 2 つ以上ないと踏めない（それを作るのは #82）。
        // 人の結論は「#102 へ外出ししてマージ」だった
        situation: { findings: 1, reworkLines: 90, reachable: "no" },
        expected: "defer",
      },
    ])("$name", ({ situation, expected }) => {
      expect(triage(situation).stdout).toBe(expected);
    });
  });

  describe("上から順に当てる", () => {
    it("手直しの範囲なら、ほかを見ずに差し戻す", () => {
      // **外出しは「その場で直せないもの」のためにある。** 2 行で直るものを Issue に
      // すると、誰かが後で読んで PR を立て直してレビューを通すことになり、高くつく
      expect(triage({ findings: 1, reworkLines: 10, reachable: "yes" }).stdout).toBe("rework");
    });

    it("セキュリティは、手直しの範囲を超えたら人を呼ぶ", () => {
      expect(triage({ findings: 1, reworkLines: 200, security: "yes" }).stdout).toBe("human");
    });

    it("入れる前より悪くなるなら人を呼ぶ", () => {
      // **優先度ではなく差し引きで見る。** #100 は塞いだ穴のほうが大きかった
      expect(triage({ findings: 1, reworkLines: 200, worse: "yes" }).stdout).toBe("human");
    });

    it("いまの構成で踏めて、手直しの範囲を超えるなら人を呼ぶ", () => {
      expect(triage({ findings: 1, reworkLines: 200, reachable: "yes" }).stdout).toBe("human");
    });

    it("どれにも当たらなければ、外出ししてマージする", () => {
      expect(triage({ findings: 1, reworkLines: 200 }).stdout).toBe("defer");
    });

    it("セキュリティは、手直しの範囲でも差し戻しより先に来ない", () => {
      // **0 が先である。** §6 に当たっても、2 行で直るなら差し戻すほうが早い
      expect(triage({ findings: 1, reworkLines: 10, security: "yes" }).stdout).toBe("rework");
    });
  });

  it("指摘が残っていなければ、差し戻さない", () => {
    // **差し戻す相手がいない。** 行数だけを見て「小さいから差し戻す」にしない
    expect(triage({ findings: 0, reworkLines: 3 }).stdout).toBe("defer");
  });

  it("手直しの上限はゲートと同じ値を使う", () => {
    // **2 箇所に閾値を持たない。** ゲートが測るのと同じ物差しで見込みを判定する
    expect(triage({ findings: 1, reworkLines: 61 }).stdout).toBe("defer");
    expect(triage({ findings: 1, reworkLines: 61 }, { LOOP_MAX_FIXUP_LINES: "100" }).stdout).toBe(
      "rework",
    );
  });

  it("判定できない入力は 2 で落ちる", () => {
    // **判定不能を「マージ」に倒さない。** 倒すと、答えられない状況ほど通ってしまう
    expect(triage({ security: "maybe" }).status).toBe(2);
    expect(triage({ findings: -1 }).status).toBe(2);
    expect(triage({ reworkLines: 1.5 as unknown as number }).status).toBe(2);
    expect(spawnSync(SCRIPT, [], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(SCRIPT, ["--findings", "1"], { encoding: "utf8" }).status).toBe(2);
  });

  it("なぜその行き先になったかを出す", () => {
    // **記録に残せる形にする。** 行き先だけだと、後から当否を再判断できない
    const verdict = spawnSync(
      SCRIPT,
      [
        "--findings",
        "1",
        "--rework-lines",
        "200",
        "--fixup-lines",
        "0",
        "--security",
        "yes",
        "--worse",
        "no",
        "--reachable",
        "no",
      ],
      { encoding: "utf8" },
    );

    expect(verdict.stdout).toMatch(/^human\t.+/);
    expect(verdict.stdout).toContain("§6");
  });
});

describe("指摘 0 件で、手直しが上限を超えている", () => {
  // **#322 で踏んだ行き止まり**（#324）。**指摘 0 件・CI 全緑・未解決 0 件**で、
  // **残っているのは第 3 層だけ**である。
  it("外出しではなく、数え直しへ渡す", () => {
    // **`defer` は「片付いた」と読めるのに、状態は 1 ミリも動かない**——
    // **外出しする指摘が無く、ゲートを塞いでいるのは行数**である
    expect(triage({ findings: 0, fixupLines: 77 }).stdout).toBe("recount");
  });

  it("なぜそうなるかを出す", () => {
    // **記録に残せる形にする**（既にある行き先と同じ）——**実測と上限が読み取れること**
    const verdict = spawnSync(
      SCRIPT,
      [
        "--findings",
        "0",
        "--rework-lines",
        "0",
        "--fixup-lines",
        "77",
        "--security",
        "no",
        "--worse",
        "no",
        "--reachable",
        "no",
      ],
      { encoding: "utf8" },
    );

    expect(verdict.stdout).toMatch(/^recount\t.+/);
    expect(verdict.stdout).toContain("77");
    expect(verdict.stdout).toContain("取り込み直");
  });

  it("上限内なら、これまでどおり外出しである", () => {
    // **第 3 層が止めていないなら、この行き先は出番ではない**
    expect(triage({ findings: 0, fixupLines: 60 }).stdout).toBe("defer");
  });

  it("指摘が残っているなら、外出しできるので出番ではない", () => {
    // **外出しする相手がいる**ときは、これまでどおり `defer` が効く
    expect(triage({ findings: 1, reworkLines: 200, fixupLines: 77 }).stdout).toBe("defer");
  });

  it("人を呼ぶ側が先に来る", () => {
    // **セキュリティ・差し引き・到達可能は、行数より先に見る**——
    // **数え直しても、その判断は消えない**
    expect(triage({ findings: 0, fixupLines: 77, security: "yes" }).stdout).toBe("human");
    expect(triage({ findings: 0, fixupLines: 77, worse: "yes" }).stdout).toBe("human");
    expect(triage({ findings: 0, fixupLines: 77, reachable: "yes" }).stdout).toBe("human");
  });

  it("上限はゲートと同じ値を使う", () => {
    // **2 箇所に閾値を持たない**（`--rework-lines` の判定と同じ理由）
    expect(triage({ findings: 0, fixupLines: 77 }, { LOOP_MAX_FIXUP_LINES: "100" }).stdout).toBe(
      "defer",
    );
  });

  it("実測を渡さない呼び方は、2 で落ちる", () => {
    // **判定できない入力を「マージ」へ倒さない**（既にある方針と同じ）——
    // **古い呼び方は黙って `defer` にならない**
    const verdict = spawnSync(
      SCRIPT,
      [
        "--findings",
        "0",
        "--rework-lines",
        "0",
        "--security",
        "no",
        "--worse",
        "no",
        "--reachable",
        "no",
      ],
      { encoding: "utf8" },
    );

    expect(verdict.status).toBe(2);
  });
});
