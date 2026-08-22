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

  it("毎回の合図が、それを読む", () => {
    // **`bin/db-config-drift` の隣**である（**同じ問い**——**走っているものが古い**）
    const warn = read("task").split("warn_stale_containers() {")[1]?.split("\n}")[0] ?? "";

    expect(warn, "合図に入っていない").toContain("image-drift check");
    expect(warn, "止める側にしている").toContain("|| true");
  });

  it("止めずに、警告にする", () => {
    // **`bin/db-config-drift` と揃える**——**古いイメージでもほとんどの作業は進む**ので、
    // **止めると直しに行く経路まで閉じる**（#184 の形）
    const script = read("bin/image-drift");

    expect(script, "警告だと書いていない").toMatch(/\[WARN\]/);
    expect(script, "止める形になっている").not.toMatch(/loop\/STOP/);
  });
});
