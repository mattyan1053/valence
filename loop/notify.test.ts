import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 受け渡しの手順書。**両方に同じ担保が要る**ので、片方だけ直っても通らないようにする。
 *
 * **役で数える** (#319)。**入口と本体に分かれた**ので、**ファイルで数えると
 * 移した節がどちらからも漏れる**——**役ごとに、続けて 1 つの手順として読む。**
 */
const ROLES: LoopRole[] = ["master", "worker"];

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 役なら手順書ぜんぶ、パスならそのファイル。 */
function textOf(target: LoopRole | string): string {
  return target === "master" || target === "worker" ? procedureText(target) : read(target);
}

describe("受け渡しの通知", () => {
  it.each([...ROLES, "loop/README.md"])("%s に、場面別の表を戻さない", (target) => {
    // **送るのは出口の 1 回だけ**（`bin/loop-handoff`）。場面別の表を併存させると、
    // **通常経路で 2 通飛ぶ**うえ、**列挙の漏れはそのまま残る**——
    // 出口へ一本化した意味が消える
    // **「消した側」だけでなく「指している側」も見る。** README から入った者が
    // **存在しない節を探す**うえ、新しい手順と食い違う（実際に残っていた）
    expect(textOf(target)).not.toContain("通知を送る場面");
  });

  it.each(ROLES)("%s に、受け取ったらその場で 1 周回すことが書いてある", (role) => {
    // **送る側だけ書いても待ちは 1 分も減らない。** 受け取った側が動いて初めて縮む
    expect(procedureText(role)).toContain("### 通知を受け取ったら");
  });

  it.each(ROLES)("%s で、周回を保険と位置づけている", (role) => {
    // **通知が主、周回は保険。** 相手が居ない・送信に失敗した場合でも、
    // 次の周回で同じ結論に至れることが前提である
    expect(procedureText(role)).toMatch(/保険/);
  });

  it.each([...ROLES, "loop/README.md"])("%s に周回の間隔を書かない", (target) => {
    // **間隔を変えられるのはループを起動している人だけ**で、手順書からは変えられない。
    // 数字を書くと、実際の設定と食い違ったまま基準として読まれる
    expect(textOf(target)).not.toMatch(/[0-9]+\s*分/);
  });
});
