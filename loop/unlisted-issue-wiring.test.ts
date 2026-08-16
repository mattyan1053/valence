/**
 * **どの一覧にも出てこない open Issue を、周回の出口で見る**（#325）。
 *
 * **スクリプトがあっても、呼ばれなければ何も起きない**——**このリポジトリは
 * 「錠を作って、掛けていない」を繰り返し踏んでいる**（#176）。
 *
 * **手順書のどのファイルに載っているかは、ここでは決めない**（#319 で入口と本体に
 * 分かれた）——**置き場所を知っているのは `loop/procedure-doc.ts` だけ**である。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 出口のうち、この検出器を扱っている段。**次の口（`bin/loop-handoff`）までを見る。** */
function section(): string {
  const text = procedureText("master");
  const from = text.indexOf("bin/loop-unlisted-issues");
  expect(from, "master の手順書がこの検出器を呼んでいない").toBeGreaterThanOrEqual(0);
  const to = text.indexOf("bin/loop-handoff master", from);
  expect(to, "出口（bin/loop-handoff master）より後ろに置かれている").toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("どの一覧にも出てこない Issue を、出口で見る", () => {
  it("周回の出口で呼んでいる", () => {
    // **毎周回、状態だけを見る**——`bin/loop-claim audit` / `idle` /
    // `bin/loop-stray-branches` と同じ場所である。**呼ぶ場面を散文で並べない**
    // （経路が増えたときに漏れる）
    expect(section()).not.toBe("");
  });

  it("宙に浮いたブランチを見たあとに置いてある", () => {
    // **状態だけを見る検査は 1 か所に固めてある。** 離すと、片方だけ足された
    // 経路から漏れる
    const text = procedureText("master");

    expect(text.indexOf("bin/loop-unlisted-issues")).toBeGreaterThan(
      text.indexOf("bin/loop-stray-branches"),
    );
  });

  it("見つかったら、停止として数えると書いてある", () => {
    // **数えないと、3 周の経路に乗らない**——**人が呼ばれない**。
    // **どの Issue かが分かる識別子**であること（人が来たときに追える）
    expect(section(), "停止を積むと書いていない").toMatch(
      /bin\/loop-stall "unlisted-issue:<Issue番号>"/,
    );
  });

  it("読めなかったときを「0 件」と読まないと書いてある", () => {
    // **測れないことを、健全と同じ出口にしない**（`bin/loop-claim idle` と同じ）
    expect(section(), "読めなかったときの行き先が書いていない").toMatch(/exit 2/);
    expect(section(), "0 件と読まないことが書いていない").toMatch(/0 件.{0,10}読まない/);
  });

  it("平常時は何も出ないと書いてある", () => {
    // **毎周回鳴る警告は読まれなくなる**（`bin/loop-stray-branches` と同じ）
    expect(section(), "平常時に鳴らないことが書いていない").toMatch(/平常時/);
  });

  it("master が label を付け直す形になっていない", () => {
    // **どこへ戻すかは中身を読まないと決まらない**（Issue の「やらないこと」）——
    // **自動で付けて回ると、`backlog` へ戻すべきものが `ready` に立ちうる**
    expect(section(), "master が label を付け直している").not.toContain("gh issue edit");
  });

  it("識別子が、停止の一覧にある", () => {
    // **一覧に無い識別子は exit 2 で弾かれる**——**綴りがずれると、
    // 記録されないまま毎周回「積んだつもり」になる**
    const listed = spawnSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      encoding: "utf8",
    });

    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout, "停止の一覧に無い").toContain("unlisted-issue:<Issue番号>");
  });
});
