import { describe, expect, it } from "vitest";
import type { Ball } from "../../domain/triage/ball";
import { ballNote } from "./ball-note";

const BALLS: readonly Ball[] = ["author", "merger", "reviewer", "nobody", "unknown"];

describe("ボールが誰にあるかを、行の言葉にする", () => {
  it("役割ごとに違う文言が出る", () => {
    // **書き忘れたら、名前も出ないまま画面に出る**（`TIER_TEXT` と同じ形）
    const said = BALLS.map(ballNote).filter((note) => note !== undefined);

    expect(new Set(said).size).toBe(said.length);
    expect(said).toHaveLength(BALLS.length - 1);
  });

  it("誰の番でもないことは、言う", () => {
    // **これが #636 でいちばん効く札**である——**誰も見ていない PR が、
    // 盤面では他と同じ顔で並んでいた。**
    expect(ballNote("nobody")).toMatch(/誰の番でもありません/);
  });

  it("分からないときは、何も言わない", () => {
    // **読めなかったものと、規則のどれにも当たらないものが入る**（`ballOf`）
    // ——**毎行に出すと読まれなくなる**（#248）。
    expect(ballNote("unknown")).toBeUndefined();
  });

  it("「誰の番でもない」を、分からないと混ぜない", () => {
    // **放置と、判定できないは別**である（Issue の「気をつけること」）
    expect(ballNote("nobody")).not.toBe(ballNote("unknown"));
  });

  it("著者の番であることが分かる", () => {
    expect(ballNote("author")).toMatch(/著者/);
  });

  it("マージする人の番であることが分かる", () => {
    expect(ballNote("merger")).toMatch(/マージ/);
  });
});
