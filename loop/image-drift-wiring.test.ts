/**
 * **イメージの指紋が、作るときと見るときで繋がっているか**（#380）。
 *
 * **どこか 1 つでも外れると、鳴らないか、鳴りっぱなしになる**——
 * **`./task` が渡し、compose が build 引数として通し、Dockerfile がラベルに焼き、
 * 毎回の合図がそれを読む。** **4 つで 1 つの経路**である。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("イメージが古いことの合図", () => {
  it("`./task` が、compose へ指紋を渡す", () => {
    // **`./task build` のときだけ渡すと、`compose up` の暗黙 build で
    // 「いつの build か分からない」イメージが普通に生まれる**
    const compose = read("task").split("compose() {")[1]?.split("\n}")[0] ?? "";

    expect(compose, "指紋を渡していない").toContain("VALENCE_BUILD_INPUTS");
    expect(compose, "指紋を自前で作っている").toContain("image-drift digest");
  });

  it("compose が、build 引数として通す", () => {
    expect(read("compose.yaml"), "build 引数に無い").toMatch(/args:[\s\S]*VALENCE_BUILD_INPUTS/);
  });

  it("Dockerfile が、ラベルに焼く", () => {
    const dockerfile = read("Dockerfile");

    expect(dockerfile).toContain("ARG VALENCE_BUILD_INPUTS");
    expect(dockerfile, "ラベルにしていない").toContain("LABEL valence.build-inputs=");
  });

  it("`./task` が、指紋を作れなかったことを黙らない", () => {
    // **黙って空にすると、ラベルの無いイメージが普通に生まれ**、
    // **以後の合図が「分からない」と言い続ける**（#382 のレビュー）
    const compose = read("task").split("compose() {")[1]?.split("\n}")[0] ?? "";

    expect(compose, "失敗を黙って空にしている").toMatch(/\[WARN\]/);
  });

  it("合図は、走っているコンテナも見る", () => {
    // **`./task build` はタグを作り直すだけ**——**入れ替えるまで、走っているのは古い**
    const warn = read("task").split("warn_stale_containers() {")[1]?.split("\n}")[0] ?? "";
    // **コメントは落として見る**——**理由の説明として書いた語に当たると、
    // 実際の呼び出しを直さなくても赤くなる**（`bin/loop-close-candidates` の試験と同じ）
    const executed = warn
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    expect(executed, "コンテナを渡していない").toContain("com.docker.compose.service=app");
    // **compose を増やさない**——**`./task` を打つたびに通るところ**である
    expect(executed, "compose を 1 回増やしている").not.toMatch(/compose ps/);
  });

  it("毎回の合図が、それを読む", () => {
    // **`bin/db-config-drift` の隣**である（**同じ問い**——**走っているものが古い**）
    const warn = read("task").split("warn_stale_containers() {")[1]?.split("\n}")[0] ?? "";

    expect(warn, "合図に入っていない").toContain("image-drift check");
    expect(warn, "止める側にしている").toContain("|| true");
  });

  it("見る側と、作り直す側が同じ集合である", () => {
    // **鳴ったまま消せない警告を作らない** (#382 のレビュー。§5 / #184)——
    // **`./task build` が作り直さないサービスを見ていると、案内どおり打っても
    // 鳴り続ける**（**消せない警告は、読まれなくなる警告**）。
    //
    // **偽の docker を見ている試験からは、`./task` が何を作り直すかは見えない**
    // ——**食い違っても、どちらも緑になる。**
    const task = read("task");
    const warn = task.split("warn_stale_containers() {")[1]?.split("\n}")[0] ?? "";
    const build = task.split("cmd_build() {")[1]?.split("}")[0] ?? "";

    const watched = [...warn.matchAll(/workspace_name\)-([a-z-]+)"/g)].map((m) => m[1]).sort();
    const rebuilt = (build.match(/compose build ([a-z\- ]+)/)?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .sort();

    expect(watched.length, "見ているサービスが読めない").toBeGreaterThan(0);
    expect(rebuilt, "見ている集合と、作り直す集合が違う").toEqual(watched);
  });

  it("止めずに、警告にする", () => {
    // **`bin/db-config-drift` と揃える**——**古いイメージでもほとんどの作業は進む**ので、
    // **止めると直しに行く経路まで閉じる**（#184 の形）
    const script = read("bin/image-drift");

    expect(script, "警告だと書いていない").toMatch(/\[WARN\]/);
    expect(script, "止める形になっている").not.toMatch(/loop\/STOP/);
  });
});
