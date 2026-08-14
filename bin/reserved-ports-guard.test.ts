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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const to = rest.findIndex((line) => /^\s+fi\s*$/.test(line));
  if (to === -1) {
    throw new Error("見張りの終わりが見つかりません");
  }
  // YAML の字下げを落とす。**中身は 1 行も変えない。**
  return rest
    .slice(0, to + 1)
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
 * - `listening` を渡されたら、**listen している行だけ**を返す
 * - 渡されなければ、**TIME-WAIT も混ざった行**を返す（**いまの runner で起きること**）
 */
function withStubSs({ listening = [] as string[], fails = false } = {}) {
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
      // **listen しているものは、渡された番号だけ**
      `listening="${listening.join(" ")}"`,
      'if [[ " $* " == *" listening "* ]]; then',
      "  for port in $listening; do",
      '    printf "0 128 0.0.0.0:%s 0.0.0.0:*\\n" "$port"',
      "  done",
      "  exit 0",
      "fi",
      // **状態で絞らなければ、出ていった接続の残骸まで出る**（#253 で踏んだ形）
      'printf "TIME-WAIT 0 0 10.1.0.157:54324 104.16.10.34:443\\n"',
      "for port in $listening; do",
      '  printf "LISTEN 0 128 0.0.0.0:%s 0.0.0.0:*\\n" "$port"',
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { dir, argv };
}

function runGuard(options?: { listening?: string[]; fails?: boolean }) {
  const { dir, argv } = withStubSs(options);
  // **`-e` を付けて走らせる。** **GitHub Actions の既定が `bash -e`** なので、
  // **付けずに試すと、実物と違う条件で確かめたことになる。**
  const result = spawnSync("bash", ["-e", "-c", `ports="54321\n54322"\n${guardScript()}`], {
    encoding: "utf8",
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

  it("本当に listen している者が居たら、落ちる", () => {
    // **見張りを外さない。** **先に掴まれている状態は実際に起きる**
    const result = runGuard({ listening: ["54322"] });

    expect(result.status).toBe(1);
    expect(result.stderr, "何が握っていたか読めない").toContain("54322");
  });

  it("状態で絞り込んでいる（呼び方を見る）", () => {
    // **stub の演技を消しても、ここは残る。** **絞り込みを外した瞬間に赤くなる**
    //
    // **見るのは 1 回目の呼び出しだけ。** **落ちたときの出力にも `ss` を使う**ので、
    // **全部を混ぜて数えると、判定から絞り込みが消えても診断のほうで当たってしまう**
    const result = runGuard({ listening: ["54322"] });

    expect(result.argv.split("\n")[0], "判定が状態で絞り込んでいない").toMatch(/listening/);
  });

  it("`ss` が落ちたら、見張りも落ちる", () => {
    // **失敗を「握っていない」と同じ見え方にしない**——
    // **黙って外れる見張りは、無いより悪い**
    const result = runGuard({ fails: true });

    expect(result.status, "ss の失敗を素通りしている").not.toBe(0);
  });
});
