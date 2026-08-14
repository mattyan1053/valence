/**
 * **認証を読む要求が、必ず境界を通るか** (#214)。
 *
 * **通らない経路が 1 つでもあると、そこだけ古い Cookie で動く**（#176 の別の形）。
 * **middleware を選んだのはここを満たせるから**で、**Route Handler は呼ばれたときだけ走る**
 * ——**呼び忘れた画面が 1 つできた瞬間に穴が開く。**
 *
 * **`middleware.ts` を import しない。** **`config.matcher` は Next.js が静的に読む**ので
 * **リテラルでなければならず**、**そこから定数を切り出すと、切り出した側だけを見る試験になる**
 * ——**実物に書いてある文字列を読む。**
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import type { SessionCookieSinks } from "./infrastructure/supabase/session-cookies";
import { middleware, refreshedResponse, runtime } from "./middleware";

const source = readFileSync(new URL("./middleware.ts", import.meta.url), "utf8");

/** 実物に書いてある matcher を取り出す。**写さない。** */
function matchers(): RegExp[] {
  const block = source.match(/matcher:\s*\[([\s\S]*?)\]/);
  if (block?.[1] === undefined) {
    throw new Error("middleware.ts に matcher が見つかりません");
  }
  // **書いてある文字列そのものではなく、実行時の値にする。** **`\\.` は
  // ソースでは 2 文字だが、Next.js が受け取るのは 1 文字**——**写したまま
  // 組み立てると、`favicon\.ico` を「バックスラッシュ + 任意の 1 文字」として読む**
  const patterns = [...block[1].matchAll(/"(?:[^"\\]|\\.)*"/g)].map(
    ([literal]) => JSON.parse(literal) as string,
  );
  if (patterns.length === 0) {
    throw new Error("matcher が空です");
  }
  return patterns.map((pattern) => new RegExp(`^${pattern}$`));
}

/** `src/app/` の下から、実際に開かれる path を作る。 */
function routePaths(dir = new URL("./app/", import.meta.url).pathname, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // **`(group)` は URL に出ない。** **`[id]` は何かが入る**ので、代表を 1 つ置く
      const segment = entry.name.startsWith("(")
        ? ""
        : `/${entry.name.replace(/^\[+\.*(.+?)\]+$/, "sample")}`;
      found.push(...routePaths(join(dir, entry.name), `${prefix}${segment}`));
      continue;
    }
    if (/^(page|route)\.tsx?$/.test(entry.name)) {
      found.push(prefix === "" ? "/" : prefix);
    }
  }
  return found;
}

describe("認証を読む要求は、必ず境界を通る", () => {
  it("`src/app/` の全ての経路が matcher に当たる", () => {
    // **次に足された画面が matcher の外に落ちたら、ここで赤くなる。**
    // **除外を 1 つ足すだけで穴が開く**ので、**除外の側ではなく経路の側から数える**
    const patterns = matchers();
    const uncovered = routePaths().filter(
      (path) => !patterns.some((pattern) => pattern.test(path)),
    );

    expect(uncovered, "この経路は境界を通らない").toEqual([]);
  });

  it("経路を数えている（数え漏れたら空になる）", () => {
    // **上の試験は、経路が 0 件でも緑になる**——**数える側が壊れたことに気づけない**
    expect(routePaths()).toContain("/");
    expect(routePaths().length).toBeGreaterThan(1);
  });

  it("静的なファイルは通さない", () => {
    // **通すと、画像 1 枚ごとにセッションの更新が走る**
    const patterns = matchers();

    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(
        patterns.some((pattern) => pattern.test(path)),
        `${path} を通している`,
      ).toBe(false);
    }
  });
});

describe("境界は、誰が何を見られるかを決めない", () => {
  it("行き先を書き換えない", () => {
    // **判断を持つのは画面の側だけ** (#214)。**ここでも判断すると 2 か所になり、
    // 片方だけ古くなる**——**更新するのが境界、読むのが画面である**
    expect(source).not.toMatch(/redirect|rewrite/);
  });
});

describe("更新された Cookie が、続きと応答の両方へ乗る", () => {
  // **ここが主目的である** (#252 のレビュー)。**sink を単体で見るだけでは、
  // `middleware.ts` の中の結線が誰にも実行されない**——**消しても緑になる。**

  /** Supabase の代わり。**読んだときに更新が 1 回起きた、を演じる。** */
  const updates =
    (updated: { name: string; value: string }) => async (sinks: SessionCookieSinks) => {
      seen.push(...sinks.read());
      sinks.toRequest(updated);
      sinks.renew();
      sinks.toBrowser({ ...updated, options: { path: "/" } });
    };

  let seen: { name: string; value: string }[] = [];

  const request = () => {
    const built = new NextRequest(new URL("http://localhost/"));
    built.cookies.set("sb-access", "old");
    return built;
  };

  it("持ってきた Cookie を、更新する側へ渡す", async () => {
    seen = [];

    await refreshedResponse(request(), updates({ name: "sb-access", value: "new" }));

    expect(seen).toEqual([{ name: "sb-access", value: "old" }]);
  });

  it("応答は、更新された Cookie をブラウザへ返す", async () => {
    // **返らないと、次の要求でまた失効する**（#214 の 1 つ目の症状そのもの）
    seen = [];

    const response = await refreshedResponse(
      request(),
      updates({ name: "sb-access", value: "new" }),
    );

    expect(response.cookies.get("sb-access")?.value).toBe("new");
  });

  it("この要求の続きも、更新された Cookie を読む", async () => {
    // **応答にだけ書くと、いま描いている画面が古いまま動く。**
    // **`NextResponse.next({ request })` は作った時点の要求を写す**ので、
    // **差し替えたあとに作り直しているかどうかが、ここに出る**
    seen = [];
    const incoming = request();

    const response = await refreshedResponse(
      incoming,
      updates({ name: "sb-access", value: "new" }),
    );

    expect(incoming.cookies.get("sb-access")?.value, "続きが古い Cookie を読む").toBe("new");
    // **応答が持って行くのは、作った時点の写し**である——**差し替えた後に
    // 作り直していなければ、ここに古い値が残る**（`x-middleware-request-cookie`）
    expect(
      response.headers.get("x-middleware-request-cookie"),
      "差し替える前の要求を応答へ写している",
    ).toBe("sb-access=new");
  });

  it("更新が起きなければ、Cookie を足さない", async () => {
    // **毎回書くと、更新していないのに `Set-Cookie` が付く**
    const response = await refreshedResponse(request(), async () => {});

    expect(response.cookies.getAll()).toEqual([]);
  });
});

describe("Next.js が呼ぶ入口", () => {
  it("Node.js で走る", () => {
    // **既定の Edge では設定を読めない** (#252 のレビュー)——**`process.env` を
    // オブジェクトごと渡した先の参照は静的に置き換えられず、Edge には注ぎ込まれない。**
    // **外すと、要求のたびに落ちる**（**そして `next build` は通る**）
    expect(runtime).toBe("nodejs");
  });

  it("更新する側が繋がっている（繋ぎ先を読む）", async () => {
    // **`middleware` は結線だけ**だが、**その 1 行が抜けても上の試験は緑**である
    // ——**実物を呼んで、繋ぎ先の設定まで届いていることを見る。**
    //
    // **繋ぎ先が無いときに落ちること**を確かめる（**黙って素通りしない**）。
    // **`process.env` をオブジェクトごと渡している**ので、**渡し方が壊れたら
    // 設定があっても落ちる**——**その向きもここに出る。**
    const saved = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;

    try {
      await expect(middleware(new NextRequest(new URL("http://localhost/")))).rejects.toThrow(
        /SUPABASE_URL/,
      );
    } finally {
      if (saved !== undefined) {
        process.env.SUPABASE_URL = saved;
      }
    }
  });
});
