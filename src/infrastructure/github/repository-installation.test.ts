import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppCredentials } from "./app-credentials";
import { resolveRepositoryInstallation } from "./repository-installation";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const credentials: AppCredentials = { appId: "1234", privateKey };
const now = new Date("2026-08-10T00:00:00Z");

function respondingWith(routes: Record<string, { body: string; status?: number }>) {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const route = routes[request.url];
    if (route === undefined) {
      return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
    }
    return Promise.resolve(new Response(route.body, { status: route.status ?? 200 }));
  };
  return { calls, fetchImpl };
}

const VALENCE = "https://api.github.com/repos/mattyan1053/valence/installation";
const OTHER = "https://api.github.com/repos/mattyan1053/other/installation";

describe("リポジトリの installation を実行時に解決する", () => {
  it("応答から installation の ID を取り出す", async () => {
    const { fetchImpl } = respondingWith({ [VALENCE]: { body: '{"id":5678,"app_id":1234}' } });

    const installation = await resolveRepositoryInstallation({
      credentials,
      repository: { owner: "mattyan1053", name: "valence" },
      now,
      fetchImpl,
    });

    expect(installation).toBe("5678");
  });

  it("リポジトリが違えば installation も違う", async () => {
    // **App ごとに 1 つではない。** インストール先ごとに増えるので、
    // 1 つ固定の前提がコードに残っていると、2 つ目のリポジトリで嘘の ID を使う
    const { fetchImpl } = respondingWith({
      [VALENCE]: { body: '{"id":5678}' },
      [OTHER]: { body: '{"id":9012}' },
    });
    const resolve = (name: string) =>
      resolveRepositoryInstallation({
        credentials,
        repository: { owner: "mattyan1053", name },
        now,
        fetchImpl,
      });

    expect([await resolve("valence"), await resolve("other")]).toEqual(["5678", "9012"]);
  });

  it("App の JWT を Bearer で載せる", async () => {
    // installation を引くのは **App として**である（installation token はまだ無い）
    const { calls, fetchImpl } = respondingWith({ [VALENCE]: { body: '{"id":5678}' } });

    await resolveRepositoryInstallation({
      credentials,
      repository: { owner: "mattyan1053", name: "valence" },
      now,
      fetchImpl,
    });
    const authorization = calls[0]?.headers.get("authorization") ?? "";

    expect(authorization.startsWith("Bearer ")).toBe(true);
    expect(authorization.slice("Bearer ".length).split(".")).toHaveLength(3);
  });

  it("App が入っていないリポジトリなら投げる", async () => {
    // **空や 0 を返さない。** 返すと URL に載って、症状が「PR が 0 件」に化ける
    const { fetchImpl } = respondingWith({});

    await expect(
      resolveRepositoryInstallation({
        credentials,
        repository: { owner: "mattyan1053", name: "valence" },
        now,
        fetchImpl,
      }),
    ).rejects.toThrow(/404/);
  });

  it("応答が読めなければ、断られたのとは別の文面で投げる", async () => {
    const { fetchImpl } = respondingWith({ [VALENCE]: { body: '{"id":"5678"}' } });

    await expect(
      resolveRepositoryInstallation({
        credentials,
        repository: { owner: "mattyan1053", name: "valence" },
        now,
        fetchImpl,
      }),
    ).rejects.toThrow(/読め/);
  });

  it("投げるときに応答の中身を載せない", async () => {
    const { fetchImpl } = respondingWith({
      [VALENCE]: { body: '{"id":"5678","secret":"leaked"}' },
    });

    const message = await resolveRepositoryInstallation({
      credentials,
      repository: { owner: "mattyan1053", name: "valence" },
      now,
      fetchImpl,
    }).catch((error: unknown) => String(error));

    expect(message).not.toContain("leaked");
  });
});
