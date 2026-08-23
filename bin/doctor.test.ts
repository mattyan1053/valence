/**
 * **「使えない理由」を、まとめて言う口**（#413）。
 *
 * **これまでは別々に 4 つ見るしかなかった**（`.env` を目で見る / Supabase へ curl /
 * 作業場ごとの port を調べる / installation はここからは見られない）——
 * **「開けない」と分かったときに、どれが欠けているのかが即答できない。**
 *
 * **いちばん大事なのは「確かめられないもの」を確かめられないと言うこと**である
 * ——**installation は App の JWT が要る**ので、**「無い」ではなく「分からない」。**
 * **このリポジトリで何度も出ている形**（**「読めなかった」を「無かった」に化けさせない**）。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./doctor", import.meta.url));

/** **何も listen していない先**。**port 1 は root でないと bind できない。** */
const CLOSED = "http://127.0.0.1:1";

describe("bin/doctor", () => {
  let dir: string;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-"));
  });

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** **200 を返すだけの相手**。**「見える」側を、自分の砂場で作る**（§5 / #186）。 */
  function listening(): Promise<string> {
    const server = createServer((socket) => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(
          typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "",
        );
      });
    });
  }

  function example(...keys: string[]): void {
    writeFileSync(join(dir, ".env.example"), `${keys.map((key) => `${key}=`).join("\n")}\n`);
  }

  function env(lines: string): void {
    writeFileSync(join(dir, ".env"), lines);
  }

  function run(): { status: number; stdout: string } {
    const done = spawnSync(SCRIPT, [], { cwd: dir, encoding: "utf8" });
    return { status: done.status ?? -1, stdout: `${done.stdout}${done.stderr}` };
  }

  /**
   * **相手が居る場面では、こちらを使う。**
   *
   * **`spawnSync` は event loop を止める**ので、**同じプロセスで listen している
   * 相手は、接続を受け付けられない**——**待っているのは自分自身**で、
   * **curl は 3 秒で諦める。** **「応答がありません」に見えるが、原因は試験の側にある。**
   */
  function runWhileListening(): Promise<{ status: number; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(SCRIPT, [], { cwd: dir });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("close", (status) => resolve({ status: status ?? -1, stdout: out }));
    });
  }

  it(".env が無ければ、そう言う", () => {
    example("SUPABASE_URL");

    const done = run();

    expect(done.stdout, ".env が無いことを言っていない").toContain(".env");
    expect(done.status, "足りないのに 0 で返している").toBe(1);
  });

  it("空のキーを、名前で並べる", () => {
    example("SUPABASE_URL", "TOKEN_ENCRYPTION_KEY");
    env("SUPABASE_URL=http://kong:8000\nTOKEN_ENCRYPTION_KEY=\n");

    const done = run();

    expect(done.stdout, "空のキーが出ていない").toContain("TOKEN_ENCRYPTION_KEY");
    expect(done.status).toBe(1);
  });

  it("値は出さない", () => {
    // **`AGENTS.md` §6**——**埋まっているかどうかだけを言う**
    example("GITHUB_APP_PRIVATE_KEY", "SUPABASE_URL");
    env("GITHUB_APP_PRIVATE_KEY=this-must-never-be-printed\nSUPABASE_URL=\n");

    expect(run().stdout, "秘密の値を画面へ出している").not.toContain("this-must-never-be-printed");
  });

  it("確かめられないものは、「無い」ではなく「分からない」と言う", () => {
    // **installation は App の JWT が要る**ので、**この口からは確かめられない**
    example("SUPABASE_URL");
    env("SUPABASE_URL=http://kong:8000\n");

    const stdout = run().stdout;

    expect(stdout, "installation について何も言っていない").toMatch(/installation/i);
    expect(stdout, "分からないと言っていない").toMatch(/分かりません|分からない/);
  });

  it("確かめられないものを、足りない側に数えない", async () => {
    // **数えると、この口は必ず「使えない」と言い続ける**（**installation は毎回分からない**）
    example("NEXT_PUBLIC_SUPABASE_URL");
    env(`NEXT_PUBLIC_SUPABASE_URL=${await listening()}\n`);

    const done = await runWhileListening();

    expect(done.stdout, "分からないものが出ていない").toMatch(/分かりません|分からない/);
    expect(done.status, "分からないものを足りない側に数えている").toBe(0);
  });

  it("見えない Supabase は、足りない側に数える", () => {
    // **「分からない」と「見えない」は別**である
    example("NEXT_PUBLIC_SUPABASE_URL");
    env(`NEXT_PUBLIC_SUPABASE_URL=${CLOSED}\n`);

    const done = run();

    expect(done.stdout, "Supabase について何も言っていない").toMatch(/Supabase/);
    expect(done.status, "見えないのに 0 で返している").toBe(1);
  });

  it("足りないものがあっても、最後まで言う", () => {
    // **止めない**——**1 つ目で止まると、まとめて言う口にならない**
    example("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
    env(`NEXT_PUBLIC_SUPABASE_URL=${CLOSED}\n`);

    const stdout = run().stdout;

    expect(stdout, "空のキーで止まっている").toMatch(/SUPABASE_URL/);
    expect(stdout, "その先を見ていない").toMatch(/Supabase/);
    expect(stdout, "最後まで行っていない").toMatch(/installation/i);
  });

  it("./task から呼べる", () => {
    // **判定を 2 箇所に持たない**（`./task` の `show_cadence` などと同じ形）
    // ——**人が打つのは `./task doctor`** なので、**そこから届いていなければ同じ。**
    const runner = readFileSync(fileURLToPath(new URL("../task", import.meta.url)), "utf8");

    expect(runner, "./task doctor が無い").toMatch(/cmd_doctor\(\)/);
    expect(runner, "判定を写している").toMatch(/cmd_doctor\(\) \{ \.\/bin\/doctor/);
  });

  it("読めない Supabase の URL は、見えないとは言わない", () => {
    // **`.env` に URL が無いなら、見に行く先が無い**——**「見えない」と言うと、
    // 起動していないのだと読める**
    example("NEXT_PUBLIC_SUPABASE_URL");
    env("NEXT_PUBLIC_SUPABASE_URL=\n");

    expect(run().stdout, "行き先が無いのに「見えない」と言っている").toMatch(
      /分かりません|分からない/,
    );
  });
});
