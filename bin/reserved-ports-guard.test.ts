/**
 * **CI の見張りが、妨げになるものだけを拾うか** (#253)。
 *
 * **予約したポートを「既に誰かが握っている」と言って止める見張り**が、
 * **出ていった接続の残骸（TIME-WAIT）まで拾っていた**——**あれは Supabase が
 * listen するのを妨げない**ので、**DB に触っていない PR が確率的に落ちた**（#252）。
 *
 * **倒す先は 2 つある。**
 *
 *   **拾いすぎる** … 無関係な socket で落ち、**PR の側を疑って時間を使う**
 *   **拾わなさすぎる** … 本当に握られていても進み、**bind 失敗が「原因不明」で返る**
 *
 * **本物の `ss` はこのコンテナに無い**（開発機の側にしか居ない）。**だから
 * 状態の絞り込みは stub が演じる**——**演じ方が本物と違えば、この試験は嘘になる。**
 * **`ss` に渡している引数そのものも見ているのは、そのため**である
 * （**絞り込みを消せば、演技ではなく呼び方のほうで赤くなる**）。
 *
 * **見張りは workflow の中にある。** **写さずに、実物から取り出して走らせる**——
 * **写すと、直したつもりの側だけが緑になる。**
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const WORKFLOW = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

/** 見張りの本体を、workflow から取り出す。**写さない。** */
function guardScript(): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const from = lines.findIndex((line) => line.includes('filter="$(echo "$ports"'));
  if (from === -1) {
    throw new Error("ci.yml から見張りを取り出せません (書式が変わった?)");
  }
  const rest = lines.slice(from);
  // **step の終わりまで取る** (#432)。**`fi` で切ると、下の判定（`bin/port-free`）が
  // 落ちる**——**取り出す範囲が、見張りの一部しか含まなくなる。**
  const to = rest.findIndex((line, at) => at > 0 && line.trim() !== "" && !/^ {10}/.test(line));
  if (to === -1) {
    throw new Error("見張りの終わりが見つかりません");
  }
  // YAML の字下げを落とす。**中身は 1 行も変えない。**
  return rest
    .slice(0, to)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `ss` の身代わり。**状態での絞り込みだけを演じる。**
 *
 * - `exclude time-wait` を渡されたら、**TIME-WAIT 以外**を返す
 * - `listening` を渡されたら、**listen している行だけ**を返す
 *   （**接続中の socket が落ちる**——**#256 のレビューで踏んだ形**）
 * - どちらも渡されなければ、**TIME-WAIT も混ざった行**を返す（**#253 で踏んだ形**）
 */
function withStubSs({
  listening = [] as string[],
  connected = [] as string[],
  fails = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reserved-ports-"));
  made.push(dir);
  const argv = join(dir, "argv");
  const stub = join(dir, "ss");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >>"${argv}"`,
      fails ? "echo 'ss: 失敗しました' >&2; exit 1" : "",
      // **listen しているものと、接続中のものは、渡された番号だけ**
      `listening="${listening.join(" ")}"`,
      `connected="${connected.join(" ")}"`,
      "print_listening() { for port in $listening; do",
      '  printf "LISTEN 0 128 0.0.0.0:%s 0.0.0.0:*\\n" "$port"',
      "done; }",
      // **接続中のものは、その番号を送信元に使って外へ出ている**
      // ——**bind を妨げるのはこちら**である（workflow の 76〜79 行）
      "print_connected() { for port in $connected; do",
      '  printf "ESTAB 0 0 10.1.0.157:%s 104.16.10.34:443\\n" "$port"',
      "done; }",
      'if [[ " $* " == *" exclude time-wait "* ]]; then',
      "  print_listening; print_connected; exit 0",
      "fi",
      'if [[ " $* " == *" listening "* ]]; then',
      "  print_listening; exit 0",
      "fi",
      // **状態で絞らなければ、出ていった接続の残骸まで出る**（#253 で踏んだ形）
      'printf "TIME-WAIT 0 0 10.1.0.157:54324 104.16.10.34:443\\n"',
      "print_listening; print_connected",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { dir, argv };
}

/**
 * `bin/port-free` の身代わり。**bind できるかどうかを演じる。**
 *
 * **本物を呼ぶと、この機械で走っている Supabase が合否を決める**（`AGENTS.md` §5 /
 * #186）——**判定そのものは `bin/port-free.test.ts` が、本物の socket で見ている。**
 */
function withStubPortFree(dir: string, blocked: string[]): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  const stub = join(dir, "bin", "port-free");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `blocked="${blocked.join(" ")}"`,
      "[[ -n $blocked ]] || exit 0",
      'echo "bind できません: $blocked" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
}

function runGuard(options?: {
  listening?: string[];
  connected?: string[];
  fails?: boolean;
  blocked?: string[];
}) {
  const { dir, argv } = withStubSs(options);
  // **判定は `bin/port-free` が持つ** (#432)。**既定は「bind できる」**
  // ——**`ss` に何が出ていても、それだけでは落ちない。**
  withStubPortFree(dir, options?.blocked ?? []);
  // **`-e` を付けて走らせる。** **GitHub Actions の既定が `bash -e`** なので、
  // **付けずに試すと、実物と違う条件で確かめたことになる。**
  const result = spawnSync("bash", ["-e", "-c", `ports="54321\n54322"\n${guardScript()}`], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
  return { ...result, argv: readFileSync(argv, "utf8") };
}

describe("予約したポートの見張り", () => {
  it("出ていった接続の残骸だけなら、通す", () => {
    // **#253 そのもの。** **TIME-WAIT は Supabase の listen を妨げない**
    const result = runGuard();

    expect(result.status, `落ちている: ${result.stderr}`).toBe(0);
  });

  it("bind できないなら、落ちる", () => {
    // **見張りを外さない。** **先に掴まれている状態は実際に起きる**
    // ——**変わったのは「何をもって塞がっているとするか」だけ**である (#432)
    const result = runGuard({ listening: ["54322"], blocked: ["54322"] });

    expect(result.status).toBe(1);
    expect(result.stderr, "何が握っていたか読めない").toContain("54322");
  });

  it("状態で絞り込んでいる（呼び方を見る）", () => {
    // **stub の演技を消しても、ここは残る。** **絞り込みを外した瞬間に赤くなる**
    //
    // **見るのは 1 回目の呼び出しだけ。** **落ちたときの出力にも `ss` を使う**ので、
    // **全部を混ぜて数えると、判定から絞り込みが消えても診断のほうで当たってしまう**
    const result = runGuard({ listening: ["54322"] });

    expect(result.argv.split("\n")[0], "判定が TIME-WAIT を除いていない").toMatch(
      /exclude time-wait/,
    );
  });

  it("接続中の socket は、出すが、それだけでは落とさない", () => {
    // **#256 では「拾う」と決めていた**——**外向きの接続が bind を妨げる**と
    // 見立てていたためである。**実測では妨げない**（`bin/port-free.test.ts`）ので、
    // **runner 自身の外向き接続で、DB を触っていない PR が赤くなっていた**（#431 / #432）。
    //
    // **出力からは落とさない。** **次に落ちたときに読めるのはここだけ**である
    // ——**判定から降りただけで、診断には残る。**
    const result = runGuard({ connected: ["54322"] });

    expect(result.status, "妨げにならない相手で落としている").toBe(0);
    expect(result.stderr, "何が居たのか読めない").toContain("54322");
  });

  it("bind できないときは、全ての socket を出す", () => {
    // **落ちたときに読むのはこの出力だけ**である（TIME-WAIT も含めて出す）
    const result = runGuard({ connected: ["54322"], blocked: ["54322"] });

    expect(result.status).toBe(1);
    expect(result.stderr, "参考の一覧が出ていない").toContain("TIME-WAIT");
  });

  it("`ss` が落ちたら、見張りも落ちる", () => {
    // **失敗を「握っていない」と同じ見え方にしない**——
    // **黙って外れる見張りは、無いより悪い**
    const result = runGuard({ fails: true });

    expect(result.status, "ss の失敗を素通りしている").not.toBe(0);
  });
});
