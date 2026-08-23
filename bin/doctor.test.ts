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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  function listening(status = 200): Promise<string> {
    const server = createServer((socket) => {
      // **相手は読まずに閉じることがある**（**`/dev/tcp` は開いたら閉じるだけ**）
      // ——**書いた先が消えると `ECONNRESET`** で、**拾わないと vitest が
      // 「unhandled error」で走り全体を赤にする**（**試験の側の穴**）。
      socket.on("error", () => {});
      socket.end(
        `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Internal Server Error"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    });
    server.on("error", () => {});
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
  function runWhileListening(env?: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(SCRIPT, [], { cwd: dir, env: env ?? process.env });
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

  /** **`./task port` が答える作業場**。**doctor はポートの決め方を訊きに行く。** */
  function taskPort(port: number): void {
    const runner = join(dir, "task");
    writeFileSync(runner, `#!/usr/bin/env bash\n[[ $1 == port ]] && echo ${port}\n`);
    chmodSync(runner, 0o755);
  }

  /**
   * **docker の答えを、こちらで決める**（§5 / #186）。
   *
   * **本物へ訊くと、走っているコンテナで答えが変わる**——**この機械の状態が、
   * 試験の合否を決めてしまう。**
   */
  function fakeDocker(options: { workingDir?: string; created?: string }): NodeJS.ProcessEnv {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const ps =
      options.workingDir === undefined
        ? ""
        : `printf 'abc123|%s\\n' ${JSON.stringify(options.workingDir)}`;
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash\ncase "$1" in\n  ps) ${ps || ":"} ;;\n  inspect) printf '%s\\n' ${JSON.stringify(options.created ?? "")} ;;\nesac\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  }

  /** **curl の無い機械**。**PATH を差し替える**（**この口は curl を要求していない**）。 */
  function withoutCurl(): NodeJS.ProcessEnv {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["bash", "sed", "grep", "tail"]) {
      const from = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" });
      symlinkSync(from.stdout.trim(), join(bin, tool));
    }
    return { ...process.env, PATH: bin };
  }

  it("空白だけの値は、埋まっているとは読まない", () => {
    // **実際に読む側は `trim()` してからはねる**——**アプリは起動しないのに
    // 「正常」と言うと、直しに行く先が変わる**（#419 のレビュー）
    example("TOKEN_ENCRYPTION_KEY");
    env("TOKEN_ENCRYPTION_KEY=   \n");

    const done = run();

    expect(done.stdout, "空白だけの値を埋まっていると読んでいる").toContain("TOKEN_ENCRYPTION_KEY");
    expect(done.status, "足りないのに 0 で返している").toBe(1);
  });

  it("HTTP がエラーなら、繋がらないとは言わない", async () => {
    // **`curl -f` は 4xx / 5xx で非ゼロ**——**「応答がありません（./task up）」と言うと、
    // 打っても直らない**（#419 のレビュー）
    const url = await listening(500);
    example("NEXT_PUBLIC_SUPABASE_URL");
    env(`NEXT_PUBLIC_SUPABASE_URL=${url}\n`);

    const done = await runWhileListening();

    expect(done.stdout, "HTTP のエラーだと言っていない").toMatch(/500/);
    expect(done.stdout, "繋がらないと誤診している").not.toMatch(/繋がりません/);
    expect(done.status, "使えない状態なのに 0 で返している").toBe(1);
  });

  it("curl が無ければ、応答があるとは言わない", async () => {
    // **`/dev/tcp` で分かるのは「開いている」ことだけ**——**同じ状態に、機械によって
    // 違う答えを出さない**（#419 のレビュー）。**500 を返すサーバを `[OK]` にしない。**
    const url = await listening(500);
    example("NEXT_PUBLIC_SUPABASE_URL");
    env(`NEXT_PUBLIC_SUPABASE_URL=${url}\n`);

    const done = await runWhileListening(withoutCurl());

    expect(done.stdout, "curl が無いのに応答を見たと言っている").not.toMatch(/応答があります/);
    expect(done.stdout, "開いていることを言っていない").toMatch(/開いています/);
    expect(done.status, "分からないものを足りない側に数えている").toBe(0);
  });

  it("installation は、アカウントごとにあると言う", () => {
    // **`AGENTS.md` §1**——**org / ユーザーごとにある**。**個人の固定 URL だけを
    // 案内すると、org の installation は映らない**——**「分からない」と言った意味が消える**
    example("SUPABASE_URL");
    env("SUPABASE_URL=http://kong:8000\n");

    const stdout = run().stdout;

    expect(stdout, "org の設定を案内していない").toMatch(/org/i);
    expect(stdout, "アカウントごとだと言っていない").toMatch(/アカウント/);
  });

  it(".env を書き換えたあと作り直していなければ、そう言う", async () => {
    // **`env_file` はコンテナの作成時にしか読まれない**（`SKILL.md`）——**`/` は設定を
    // 使わないので応答は返る**。**ログインは壊れているのに exit 0**（#419 のレビュー）
    const url = await listening();
    example("SUPABASE_URL");
    env("SUPABASE_URL=http://kong:8000\n");
    taskPort(Number(new URL(url).port));

    const done = await runWhileListening(
      fakeDocker({ workingDir: dir, created: "2020-01-01T00:00:00Z" }),
    );

    expect(done.stdout, "古いコンテナのままだと言っていない").toMatch(/作り直/);
    expect(done.stdout, "直し方を言っていない").toMatch(/\.\/task up/);
    expect(done.status, "使えない状態なのに 0 で返している").toBe(1);
  });

  it("作り直してあれば、そうは言わない", async () => {
    const url = await listening();
    example("SUPABASE_URL");
    env("SUPABASE_URL=http://kong:8000\n");
    taskPort(Number(new URL(url).port));

    const done = await runWhileListening(
      fakeDocker({ workingDir: dir, created: "2099-01-01T00:00:00Z" }),
    );

    expect(done.stdout, "作り直してあるのに鳴っている").not.toMatch(/作り直/);
    expect(done.status, "足りないものが無いのに 1 で返している").toBe(0);
  });

  it("別の作業場のアプリが同じポートに居たら、この作業場のものとは言わない", async () => {
    // **エラーにならないので、見ているものが自分のものだと思い込んだまま進む**
    // （`SKILL.md`。#412 / #416）——**「動いています」と言われた人は、そこで調べるのをやめる**
    const url = await listening();
    example("SUPABASE_URL");
    env("SUPABASE_URL=http://kong:8000\n");
    taskPort(Number(new URL(url).port));

    const done = await runWhileListening(
      fakeDocker({ workingDir: "/home/loop/valence-worker-b", created: "2099-01-01T00:00:00Z" }),
    );

    expect(done.stdout, "別の作業場のものだと言っていない").toMatch(/別の作業場/);
    expect(done.status, "他人のアプリを見て 0 で返している").toBe(1);
  });

  it("応答元を確かめられなければ、分からないと言う", async () => {
    // **確かめられないなら `[分かりません]` へ倒す**（この口の作法）
    const url = await listening();
    example("SUPABASE_URL");
    env("SUPABASE_URL=http://kong:8000\n");
    taskPort(Number(new URL(url).port));

    const done = await runWhileListening(fakeDocker({}));

    expect(done.stdout, "確かめていないのに、この作業場のものだと言っている").not.toMatch(
      /応答があります/,
    );
    expect(done.stdout, "分からないと言っていない").toMatch(/分かりません/);
    expect(done.status, "分からないものを足りない側に数えている").toBe(0);
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
