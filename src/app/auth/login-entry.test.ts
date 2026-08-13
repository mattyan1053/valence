/**
 * **入口を開いただけでは、認可が始まらないこと。**
 *
 * **始まると輪になる** (#224 のレビュー)。**コールバックが失敗したら入口へ戻す**が、
 * **その入口が即座に認可画面へ送ると、キャンセルした人がキャンセルした先で
 * また立たされる**——**戻す仕組みなのに、戻した先が同じ経路の入口**（#184 の形）。
 *
 * **倒す先は 2 つある。** **回り続ける**のと、**行き止まりになる**——
 * **入口から意図して始められないと、誰も入れない。** **両方をここで見る。**
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AUTH = fileURLToPath(new URL(".", import.meta.url));

const START_PATH = "/auth/login/start";

function read(relative: string): string {
  return readFileSync(`${AUTH}${relative}`, "utf8");
}

describe("ログインの入口", () => {
  it("`/auth/login` は画面であって、経路ではない", () => {
    // **Route Handler があると、開いた瞬間に走る。**
    expect(existsSync(`${AUTH}login/route.ts`), "GET で認可が始まる形に戻っている").toBe(false);
    expect(existsSync(`${AUTH}login/page.tsx`)).toBe(true);
  });

  it("入口から、押して始められる", () => {
    // **行き止まりにしない。** 戻した先から始められないと、誰も入れない。
    const page = read("login/page.tsx");
    expect(page).toContain(`action="${START_PATH}"`);
    expect(page).toContain('method="post"');
  });

  it("始める側は POST だけを受ける", () => {
    // **GET で始められると、`<img src>` 1 つで他人を認可画面へ送れる。**
    const start = read("login/start/route.ts");
    expect(start).toMatch(/export async function POST\b/);
    expect(start, "GET でも始められる").not.toMatch(/export async function GET\b/);
  });

  it("コールバックの戻り先は、その画面である", () => {
    // **戻す先が「始まる側」だと、失敗のたびに認可画面へ送り直すことになる。**
    const callback = read("callback/route.ts");
    expect(callback).toContain("loginUrl(request)");
    expect(callback, "始める側へ戻している").not.toContain(START_PATH);
  });
});
