/**
 * `RepositoryPermissions` の GitHub 実装（#317 のレビュー）。
 *
 * **ユーザートークンで引く**（`AGENTS.md` §6）。**installation トークンで代用すると、
 * 誰がログインしていても同じ答えになる。**
 *
 * **判定不能を「権限が無い」へ倒さない。** **倒すと、押した人に嘘の理由が伝わる**
 * ——**呼ぶ側は投げたものを `unavailable` として扱う。**
 */

import { describe, expect, it } from "vitest";
import { createUserRepositoryPermissions } from "./user-repository-permissions";

const REPOSITORY = { owner: "acme", name: "web" } as const;

function permissions(response: { status: number; body?: unknown }) {
  const calls: { url: string; authorization: string | null }[] = [];
  const port = createUserRepositoryPermissions({
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { calls, port };
}

function body(permission: Record<string, boolean>) {
  return { permissions: { admin: false, push: false, pull: false, ...permission } };
}

describe("そのユーザーの権限の高さを引く", () => {
  it("ユーザートークンで引く", async () => {
    // **installation トークンで代用しない**（§6）
    const { calls, port } = permissions({ status: 200, body: body({ pull: true }) });

    await port.levelFor("user-token", REPOSITORY);

    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/repos/acme/web"]);
    expect(calls[0]?.authorization, "ユーザートークンを渡していない").toBe("Bearer user-token");
  });

  it.each([
    [{ admin: true, push: true, pull: true }, "admin"],
    [{ push: true, pull: true }, "write"],
    [{ pull: true }, "read"],
    [{}, "none"],
  ] as const)("%o は %s", async (permission, level) => {
    const { port } = permissions({ status: 200, body: body(permission) });

    expect(await port.levelFor("user-token", REPOSITORY)).toBe(level);
  });

  it("権限が載っていなければ、投げる", async () => {
    // **`none` へ倒さない。** **「読めなかった」が「権限が無い」に化ける**
    const { port } = permissions({ status: 200, body: { name: "web" } });

    await expect(port.levelFor("user-token", REPOSITORY)).rejects.toThrow();
  });

  it("断られたら、投げる", async () => {
    const { port } = permissions({ status: 403, body: { message: "secret detail" } });

    await expect(port.levelFor("user-token", REPOSITORY)).rejects.toThrow();
  });

  it("GitHub の文面を、そのまま載せない", async () => {
    // **応答にはそのユーザーの持ち物が並ぶ**（§6）——**載せるのは状態コードだけ**
    const { port } = permissions({ status: 404, body: { message: "acme/web is private" } });

    await expect(port.levelFor("user-token", REPOSITORY)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("acme") }),
    );
  });
});
