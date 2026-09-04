import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-review-head", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-review-head", () => {
  let sandbox: string;

  /** 実リポジトリの記録を汚さないよう、使い捨ての git リポジトリで動かす。 */
  function run(args: string[]): Run {
    const result = spawnSync(SCRIPT, args, { cwd: sandbox, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function listed(pr: string): string[][] {
    const result = run(["--list", pr]);
    expect(result.status).toBe(0);
    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("\t"));
  }

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-review-head-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox], { encoding: "utf8" }).status).toBe(0);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("記録した head SHA を時刻付きで返す", () => {
    expect(run(["10", "a".repeat(40)]).status).toBe(0);

    const rows = listed("10");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[1]).toBe("a".repeat(40));
    // 応答の時刻と比べるので、ISO8601 の UTC で持つ
    expect(rows[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("同じ PR の記録は古い順に積む", () => {
    run(["11", "b".repeat(40)]);
    run(["11", "c".repeat(40)]);

    expect(listed("11").map((row) => row[1])).toEqual(["b".repeat(40), "c".repeat(40)]);
  });

  it("PR ごとに別の記録として持つ", () => {
    run(["12", "d".repeat(40)]);

    expect(listed("12").map((row) => row[1])).toEqual(["d".repeat(40)]);
    expect(listed("13")).toEqual([]);
  });

  it("記録が無い PR は空を返す（応答は「未記録」として扱えればよい）", () => {
    const result = run(["--list", "999"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("SHA として読めないものは記録しない", () => {
    // ブランチ名や短すぎる値を記録すると、あとで head と前方一致してしまう
    expect(run(["14", "main"]).status).toBe(2);
    expect(run(["14", "abc"]).status).toBe(2);
    expect(run(["14", "../../etc/passwd"]).status).toBe(2);
    expect(listed("14")).toEqual([]);
  });

  it("PR 番号として読めないものは記録しない", () => {
    expect(run(["../15", "e".repeat(40)]).status).toBe(2);
    expect(run(["", "e".repeat(40)]).status).toBe(2);
  });

  /** 応答（`<時刻><TAB><SHA or 空>`）を渡して、SHA が確定した行だけを受け取る。 */
  function pair(pr: string, responses: string[]): string[] {
    const result = spawnSync(SCRIPT, ["--pair", pr], {
      cwd: sandbox,
      encoding: "utf8",
      input: responses.join("\n"),
    });
    expect(result.status).toBe(0);
    return result.stdout.split("\n").filter((line) => line !== "");
  }

  it("記録より後に来た SHA 無しの応答は、その記録に結び付く", () => {
    run(["20", "1".repeat(40)]);

    expect(pair("20", ["2099-01-01T00:00:00Z\t"])).toEqual([
      `2099-01-01T00:00:00Z\t${"1".repeat(40)}`,
    ]);
  });

  it("記録より前の応答は結び付けない（何を見たか分からない）", () => {
    run(["21", "2".repeat(40)]);

    expect(pair("21", ["2000-01-01T00:00:00Z\t"])).toEqual([]);
  });

  it("記録が 1 件も無ければ、SHA 無しの応答は結び付かない", () => {
    // **記録を飛ばした周回を、そのまま置く**（#614。**master が今日踏んだ**）。
    //
    // **指摘ゼロのとき、Codex は 👍 だけで返す**——**あれは SHA を持たない。**
    // **記録が無ければ寄せる先が無い**ので、**この応答は数えられない**
    // ——**2 回しかない枠が 1 回消え**、**症状は「要求したのに、いつまでも未レビュー」**。
    //
    // **これは直す振る舞いではない。** **安全側**である（**寄せると、見てもいない
    // head がレビュー済みになる**）——**飛ばさないようにするのが直す側**で、
    // **そちらは `bin/loop-review-budget` が投げる直前に言う。**
    expect(pair("24", ["2099-01-01T00:00:00Z\t"])).toEqual([]);
  });

  it("SHA を持つ応答はその SHA のまま返す", () => {
    expect(pair("22", [`2099-01-01T00:00:00Z\t${"3".repeat(40)}`])).toEqual([
      `2099-01-01T00:00:00Z\t${"3".repeat(40)}`,
    ]);
  });

  it("遅れて届いた応答を、あとから積んだ新しい記録に結び付けない", () => {
    // 自動レビュー(A) → 要求(A) → 指摘つき応答(A) → 直して要求(B) → **A の 👍 が今ごろ届く**
    // 時刻の前後だけで選ぶと B に結び付き、未レビューの B がマージ可能になる。
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    // 記録は古い順に積まれる（同一秒に複数入りうるので追記順が保たれること自体も効く）
    run(["23", a]);
    run(["23", a]);
    run(["23", b]);

    const rows = pair("23", [`2099-01-01T00:00:00Z\t${a}`, "2099-01-01T00:00:01Z\t"]);

    expect(rows).toEqual([`2099-01-01T00:00:00Z\t${a}`, `2099-01-01T00:00:01Z\t${a}`]);
  });

  it("応答が 0 件でも正常に空を返す", () => {
    const result = spawnSync(SCRIPT, ["--pair", "25"], {
      cwd: sandbox,
      encoding: "utf8",
      input: "",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("空行は応答として数えず、記録を消費しない", () => {
    run(["26", "5".repeat(40)]);

    const rows = pair("26", ["", "2099-01-01T00:00:00Z\t"]);

    expect(rows).toEqual([`2099-01-01T00:00:00Z\t${"5".repeat(40)}`]);
  });

  it("--unknown は「SHA の分からないレビュー実行」を指定時刻で記録する", () => {
    expect(run(["--unknown", "30", "2026-08-08T12:00:00Z"]).status).toBe(0);

    expect(listed("30")).toEqual([["2026-08-08T12:00:00Z", "-"]]);
  });

  it("--unknown の時刻が ISO8601(UTC) でなければ記録しない", () => {
    expect(run(["--unknown", "31", "2026-08-08 12:00:00"]).status).toBe(2);
    expect(run(["--unknown", "31", "yesterday"]).status).toBe(2);
    expect(listed("31")).toEqual([]);
  });

  it("SHA の分からない実行に対応した応答は、印 - で返す（結び付けはしない）", () => {
    // **応答はあったが、何を見たか分からない** (#179)。**落とすと、待つ側は
    // 応答が届いているのに上限（既定 480 秒）まで待つ**——**外の人ほど待たされる**。
    //
    // **結び付けはしない**（**見てもいない head がレビュー済みになる**）ので、
    // **SHA の欄は `-`** である。**「返ってきた」と「何を見た」は別の軸**
    const b = "b".repeat(40);
    run(["--unknown", "40", "2026-08-08T12:00:00Z"]);
    run(["40", b]);

    const rows = pair("40", ["2099-01-01T00:00:00Z\t"]);

    expect(rows, "応答が返ったことを落としている").toEqual(["2099-01-01T00:00:00Z\t-"]);
    expect(rows.join("\n"), "見てもいない head に結び付けている").not.toContain(b);
  });

  it("SHA の分からない実行に応答が対応したら、結び付けずに消費する", () => {
    // PR 作成時の自動レビューは master の要求ではないので SHA の記録が無い。
    // その 👍 を「未消費の最も古い記録」へ寄せると、**見てもいない新しい head が
    // レビュー済みになる**。記録を 1 件消費させて、結び付けはしない
    const b = "b".repeat(40);
    run(["--unknown", "32", "2026-08-08T12:00:00Z"]);
    run(["32", b]);

    const rows = pair("32", ["2099-01-01T00:00:00Z\t"]);

    // **記録は 1 件消費するが、head には結び付けない**（印 `-`。#179 で返すようにした）
    expect(rows.join("\n"), "見てもいない head に結び付けている").not.toContain(b);
  });

  it("SHA の分からない実行のあとの応答は、次の記録に結び付く", () => {
    // 消費しすぎて、正常な 👍 まで数えなくなっていないこと
    const c = "c".repeat(40);
    run(["--unknown", "33", "2026-08-08T12:00:00Z"]);
    run(["33", c]);

    const rows = pair("33", ["2099-01-01T00:00:00Z\t", "2099-01-01T00:00:01Z\t"]);

    // 1 件目は SHA 不明の実行を消費して**印 `-`**（#179）、2 件目が実際の記録に結び付く
    expect(rows).toEqual(["2099-01-01T00:00:00Z\t-", `2099-01-01T00:00:01Z\t${c}`]);
  });

  it("どの記録とも一致しない SHA 付き応答は、対応する SHA 不明の実行を消費する", () => {
    // ループ外で作られた PR の自動レビューが SHA 付きで返った場合。消費しないと
    // SHA 不明の記録が残り、**次の 👍 がそこに吸われて現 head が永久に未レビューになる**
    const b = "b".repeat(40);
    run(["--unknown", "34", "2026-08-08T12:00:00Z"]);
    run(["34", b]);

    const rows = pair("34", [`2099-01-01T00:00:00Z\t${"e".repeat(40)}`, "2099-01-01T00:00:01Z\t"]);

    expect(rows).toEqual([`2099-01-01T00:00:00Z\t${"e".repeat(40)}`, `2099-01-01T00:00:01Z\t${b}`]);
  });

  it("レビューできなかった応答は、記録を消費するが結び付けない", () => {
    // 「環境が無い」通知のような応答。要求への応答ではあるが何もレビューしていない
    const f = "f".repeat(40) === "" ? "" : "1234567890abcdef1234567890abcdef12345678";
    run(["35", f]);

    const rows = pair("35", ["2099-01-01T00:00:00Z\t-"]);

    expect(rows).toEqual([]);
  });

  it("レビューできなかった応答が SHA 不明の実行を消化し、次の 👍 は実際の記録に結び付く", () => {
    // 自動レビューが通知だけで失敗 → 環境を直して要求 → 👍 で成功、という経路。
    // 通知が SHA 不明の実行を消化しないと、👍 がそこへ吸われて現 head が永久に未レビューになる
    const g = "1111111111111111111111111111111111111111";
    run(["--unknown", "36", "2026-08-08T12:00:00Z"]);
    run(["36", g]);

    const rows = pair("36", ["2099-01-01T00:00:00Z\t-", "2099-01-01T00:00:01Z\t"]);

    expect(rows).toEqual([`2099-01-01T00:00:01Z\t${g}`]);
  });

  it("記録より多い応答が来ても、余った応答は結び付けない", () => {
    run(["24", "4".repeat(40)]);

    const rows = pair("24", ["2099-01-01T00:00:00Z\t", "2099-01-01T00:00:01Z\t"]);

    expect(rows).toEqual([`2099-01-01T00:00:00Z\t${"4".repeat(40)}`]);
  });

  it("記録は作業ツリーの外に置く（コミットされない）", () => {
    run(["16", "f".repeat(40)]);

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: sandbox, encoding: "utf8" });

    expect(status.stdout.trim()).toBe("");
  });
});
