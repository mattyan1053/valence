/**
 * **握られているかどうかではなく、bind できるかで決める**（#432）。
 *
 * **CI の見張りは「その番号を持つ socket があるか」で落としていた**（#253 / #256）
 * ——**外向きの接続（ESTABLISHED）まで妨げとして数える。** **実測では、それは
 * docker の publish を妨げない**ので、**DB を触っていない PR が、runner 自身の
 * 外向き接続で落ちた**（#431）。
 *
 * **実測**（2026-08-24、この機械）:
 *
 * | 相手 | `docker run -p <port>:80` | ここの判定 |
 * | --- | --- | --- |
 * | 外向きの ESTABLISHED（`10.x:P` → `…:443`） | **通る** | **通る** |
 * | `0.0.0.0:P` で listen | **落ちる**（`address already in use`） | **落ちる** |
 *
 * **身代わりを立てない。** **本物の socket を握らせて確かめる**——**ここで演技を
 * 挟むと、演技のほうが正しいことにしかならない**（#252 / #253 で 2 度、
 * 「妨げになるもの」の見立てを間違えている）。
 */

import { spawnSync } from "node:child_process";
import type { Socket } from "node:net";
import { createConnection, createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./port-free", import.meta.url));

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
});

/** 空いている番号を 1 つ借りる。**その場で返す**（借りた番号は使われていない）。 */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** その番号で listen し続ける相手。**bind を妨げる側。** */
function listening(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

/** その番号を送信元にして外へ出ている相手。**妨げにならない側**（実測）。 */
async function connected(port: number): Promise<void> {
  const target = await listening(await freePort());
  const address = target.address();
  const to = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    const socket = createConnection({ port: to, host: "127.0.0.1", localPort: port }, () =>
      resolve(),
    );
    sockets.push(socket);
  });
}

function run(ports: number[]) {
  const done = spawnSync(SCRIPT, ports.map(String), { encoding: "utf8" });
  return { status: done.status ?? -1, out: `${done.stdout}${done.stderr}` };
}

describe("bin/port-free", () => {
  it("空いていれば、通す", async () => {
    expect(run([await freePort()]).status).toBe(0);
  });

  it("listen している者が居たら、落とす", async () => {
    // **恒久的な失敗は、これまでどおり赤**（#432 の条件）
    const port = await freePort();
    await listening(port);

    const done = run([port]);

    expect(done.status, "塞がっているのに通している").toBe(1);
    expect(done.out, "どの番号か読めない").toContain(String(port));
  });

  it("外向きの接続が握っていても、通す", async () => {
    // **これが #432 の本体**である——**runner 自身の `Runner.Listener` が、
    // GitHub へ張っている接続の送信元ポートに 543xx を掴んでいた。**
    // **docker の publish は、それを妨げとしない**（実測）。
    const port = await freePort();
    await connected(port);

    expect(run([port]).status, "妨げにならない相手で落としている").toBe(0);
  });

  it("1 つでも塞がっていたら、落とす（名指しする）", async () => {
    const free = await freePort();
    const taken = await freePort();
    await listening(taken);

    const done = run([free, taken]);

    expect(done.status).toBe(1);
    expect(done.out, "塞がっている番号を名指ししていない").toContain(String(taken));
  });

  it("番号でないものは、使い方の誤り", () => {
    expect(run([]).status).toBe(2);
    expect(spawnSync(SCRIPT, ["54321x"], { encoding: "utf8" }).status).toBe(2);
  });
});
