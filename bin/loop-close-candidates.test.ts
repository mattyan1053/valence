/**
 * **完了した Issue を閉じる経路が、文面にしか無い**（#335）。
 *
 * **`Closes` を書かない PR がある**（割った途中・親として残す）。**その PR が
 * 完了条件を満たしてマージされても、Issue は open のまま残る**——
 * **#334 のあとは `backlog` へ戻る**ので、**`bin/loop-unlisted-issues` も鳴らない。**
 * **完了しているのに昇格の候補に並び、誰かが取って同じ作業をやり直す。**
 *
 * **ここが出すのは候補だけ**である。**閉じるかどうかは完了条件を読んで決める**
 * （Issue の「やらないこと」）——**このスクリプトは 1 件も閉じない。**
 *
 * **モックを使わない**——**本物のスクリプトへ、本物と同じ形の入力を流す。**
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-close-candidates", import.meta.url));

/** 番号ごとの答え。**PR は `pull_request` を持つ**（GitHub の API がそう返す）。 */
type Entry = { state: "OPEN" | "CLOSED"; title: string; pull?: boolean };

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 偽の `gh` を置いて走らせる。**落とす口も用意する**（読めないを 0 件にしない）。 */
function run(
  args: string[],
  { body, entries, fail }: { body: string; entries: Record<number, Entry>; fail?: string },
): { status: number; stdout: string; stderr: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "close-candidates-"));
  sandboxes.push(dir);
  const stub = join(dir, "gh");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `fail=${JSON.stringify(fail ?? "")}`,
      // **`gh repo view`** — どのリポジトリを見るかは実行時に決まる
      'if [[ "$1" == "repo" ]]; then printf "mattyan1053\\nvalence\\n"; exit 0; fi',
      'if [[ "$1" == "pr" ]]; then',
      '  [[ $fail == "pr" ]] && { echo "boom" >&2; exit 1; }',
      `  cat <<'BODY'`,
      body,
      "BODY",
      "  exit 0",
      "fi",
      'if [[ "$1" == "api" ]]; then',
      '  [[ $fail == "api" ]] && { echo "boom" >&2; exit 1; }',
      // 末尾の番号で引く（`repos/{owner}/{repo}/issues/<N>`）
      '  n="${2##*/}"',
      '  case "$n" in',
      ...Object.entries(entries).map(
        ([number, entry]) =>
          `  ${number}) printf '%s\\u001f%s\\u001f%s\\n' ${JSON.stringify(entry.state)} ${JSON.stringify(entry.title)} ${entry.pull ? "true" : "false"}; exit 0 ;;`,
      ),
      '  *) echo "not found" >&2; exit 1 ;;',
      "  esac",
      "fi",
      'echo "unexpected: $*" >&2; exit 1',
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  // **lease の記録先も隔離する** (#337 のレビュー)。**`bin/loop-lease check` は
  // cwd の `.git`（共通ディレクトリ）へ「入口を飛ばした周回」を書く**ので、
  // **偽の `gh` だけを隔離しても、試験を走らせた回数ぶん運用状態が汚れる。**
  const cwd = join(dir, "repo");
  mkdirSync(cwd, { recursive: true });
  expect(spawnSync("git", ["init", "--quiet", cwd], { encoding: "utf8" }).status).toBe(0);

  const result = spawnSync(SCRIPT, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    timeout: 20_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    cwd,
  };
}

describe("bin/loop-close-candidates", () => {
  it("参照していて、まだ open の Issue を挙げる", () => {
    const verdict = run(["330"], {
      body: "**3 本目である。**\n\nRefs #319\n",
      entries: { 319: { state: "OPEN", title: "手順書が変わるたびに本文が古くなる" } },
    });

    expect(verdict.status, verdict.stderr).toBe(1);
    expect(verdict.stdout).toContain("319");
  });

  it("もう閉じている Issue は挙げない", () => {
    // **`Closes` で自動的に閉じたぶんがここ**である——**state で落ちる**ので、
    // **閉じた参照の一覧が取り切れなくても、倒れる先は変わらない**
    const verdict = run(["330"], {
      body: "Closes #319\n",
      entries: { 319: { state: "CLOSED", title: "済んだもの" } },
    });

    expect(verdict.status, verdict.stderr).toBe(0);
    expect(verdict.stdout.trim()).toBe("");
  });

  it("PR の番号は Issue として挙げない", () => {
    // **本文には PR 番号も出てくる**（「#328 が先」など）——**混ぜると、
    // 閉じる相手として PR が並ぶ**
    const verdict = run(["330"], {
      body: "**#328 が先に入った。**\n\nRefs #319\n",
      entries: {
        319: { state: "OPEN", title: "残っているもの" },
        328: { state: "OPEN", title: "別の PR", pull: true },
      },
    });

    expect(verdict.status, verdict.stderr).toBe(1);
    expect(verdict.stdout).toContain("319");
    expect(verdict.stdout).not.toContain("328");
  });

  it("参照が無ければ、何も出さない", () => {
    const verdict = run(["330"], { body: "参照の無い本文\n", entries: {} });

    expect(verdict.status, verdict.stderr).toBe(0);
    expect(verdict.stdout.trim()).toBe("");
  });

  it("読めなかったら、0 件と言わない", () => {
    // **「候補なし」と「読めない」は別**である——**混ぜると、読めなかった周回が
    // 「閉じるものは無い」になり、完了した Issue が昇格の候補へ戻る**
    expect(run(["330"], { body: "Refs #319\n", entries: {}, fail: "pr" }).status).toBe(2);
    expect(
      run(["330"], {
        body: "Refs #319\n",
        entries: { 319: { state: "OPEN", title: "x" } },
        fail: "api",
      }).status,
    ).toBe(2);
  });

  it("使い方の誤りは、0 件と混ぜない", () => {
    expect(run([], { body: "", entries: {} }).status).toBe(2);
    expect(run(["330", "余計な引数"], { body: "", entries: {} }).status).toBe(2);
    expect(run(["PR"], { body: "", entries: {} }).status).toBe(2);
  });

  it("このスクリプトは 1 件も閉じない", () => {
    // **完了条件を読むのは master の仕事**である（Issue の「やらないこと」）——
    // **機械が閉じる形にすると、割った途中の PR で作業が消える**
    // **コメントは落として見る** (#337 のレビュー対応で踏んだ)。**理由の説明として
    // `gh issue close` を書くことはある**——**言及に当たると、実際に閉じる口が
    // 無くても赤くなり、逆に文面を削れば通ってしまう。** **実行される行だけを見る。**
    const code = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    expect(code, "閉じる口を持っている").not.toContain("issue close");
  });
  it("別のリポジトリを指した参照は挙げない", () => {
    // **`owner/other#264` から `264` だけを取ると、ここの #264 が候補に並ぶ**
    // （#337 のレビュー）——**手順書の `gh issue close <N>` は `-R` を付けない**ので、
    // **無関係な Issue を閉じる相手として出す。** **その番号がここに無ければ
    // API が落ちて exit 2 になり、本物の候補まで巻き添えで消える。**
    const verdict = run(["330"], {
      body: "Fixes owner/other#264\n\nRefs #319\n",
      entries: { 319: { state: "OPEN", title: "ここの Issue" } },
    });

    expect(verdict.status, verdict.stderr).toBe(1);
    expect(verdict.stdout).toContain("319");
    expect(verdict.stdout, "別のリポジトリの番号が並んでいる").not.toContain("264");
  });

  it("ここのリポジトリを明示した参照は挙げる", () => {
    // **修飾されていても、指しているのがここなら候補である**
    const verdict = run(["330"], {
      body: "Refs mattyan1053/valence#319\n",
      entries: { 319: { state: "OPEN", title: "ここの Issue" } },
    });

    expect(verdict.status, verdict.stderr).toBe(1);
    expect(verdict.stdout).toContain("319");
  });

  it("lease の記録は、砂場の中に落ちる", () => {
    // **`bin/loop-lease check` は cwd の共通ディレクトリへ「入口を飛ばした周回」を
    // 書く**（#337 のレビュー）——**偽の `gh` だけ隔離しても `spawnSync` は cwd を継ぐ**
    // ので、**走らせた回数ぶん運用の記録へ混ざる**（`AGENTS.md` §5。#186）。
    //
    // **「実物が増えていないこと」だけを見ない**——**記録が重複を落とす形なら、
    // 隔離をやめても同じ中身のままで緑になる。** **砂場に落ちていることを見る。**
    const verdict = run(["330"], {
      body: "Refs #319\n",
      entries: { 319: { state: "OPEN", title: "x" } },
    });

    expect(
      existsSync(join(verdict.cwd, ".git", "valence-loop-lease-missing")),
      "lease の記録が砂場に無い（実物へ書いている）",
    ).toBe(true);
  });
});
