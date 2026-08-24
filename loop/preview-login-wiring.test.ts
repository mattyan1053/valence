/**
 * **人が見る画面から、ログインが完了すること**（#463）。
 *
 * **GoTrue の許可一覧は port まで固定**である（`supabase/config.toml` の
 * 「広げるのはパスだけ。scheme / host / port は固定」）——**人が見る作業場は 3000
 * ではない**（#82 の割り当て）ので、**そこから始めると `site_url` へ落ちて戻り、
 * `/auth/callback` に着かない。**
 *
 * **数字はここに書き写さない。** **port は `task` の割り当てが持つ**ので、
 * **`./task port <作業場名>` から取る**——**割り当てが変わった日に、ここが赤くなる**
 * （`AGENTS.md` §5。**書き写すと、食い違ったまま緑になる**）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** clone そのもの（いちばん最初の worktree）。**人が見る作業場はその隣にある。** */
function mainWorktree(): string {
  const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const first = listed.split("\n").find((line) => line.startsWith("worktree "));
  expect(first, "worktree の一覧を読めません").toBeDefined();
  return (first ?? "").replace(/^worktree /, "");
}

/** その名前の作業場の port。**判定は `task` が 1 箇所で持つ。** */
function portOf(name: string): string {
  const port = execFileSync("./task", ["port", name], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  expect(port, `作業場の port を読めません: ${name}`).toMatch(/^\d+$/);
  return port;
}

/**
 * 人が見る作業場の port。
 *
 * **訊いた名前のぶんが返っていることを、ここで確かめる**——**`./task port` が
 * 名前を無視すると、この作業場のぶん（既定なら 3000）が返り**、**3000 は一覧に
 * 載っている**ので、**下の検査は通ってしまう**（**実際に 1 度そうなった**）。
 */
function previewPort(): string {
  const workspace = basename(mainWorktree());
  const preview = portOf(`${workspace}-preview`);

  expect(preview, "`./task port` が名前を受けていない（この作業場のぶんが返っている）").not.toBe(
    portOf(workspace),
  );
  return preview;
}

function allowlistLine(): string {
  const config = readFileSync(join(REPO_ROOT, "supabase/config.toml"), "utf8");
  const line = /^additional_redirect_urls\s*=.*$/m.exec(config)?.[0];
  expect(line, "許可一覧の行がありません").toBeDefined();
  return line ?? "";
}

describe("人が見る画面から、ログインが完了する", () => {
  it("人が見る画面の port が、許可一覧に載っている", () => {
    // **`localhost` と `127.0.0.1` は別オリジン**である（Cookie も分かれる）
    // ——**開いたほうで完了させる**ので、両方を載せる
    const port = previewPort();
    const listed = allowlistLine();

    expect(listed, `人が見る画面（localhost:${port}）から戻れない`).toContain(
      `http://localhost:${port}/**`,
    );
    expect(listed, `人が見る画面（127.0.0.1:${port}）から戻れない`).toContain(
      `http://127.0.0.1:${port}/**`,
    );
  });

  // **clone の名前で port が変わらないこと**は、`loop/preview-workspace.test.ts` が
  // **本物の clone を 3 つ作って見る** (#473)——**ここから偽の名前を訊いても、
  // それはこの clone の人が見る作業場ではない**（**接尾辞では決めない**）。

  it("既定の作業場のぶんは、そのまま残っている", () => {
    // **既定の振る舞いを変えない**（#463 の条件）——**足すだけ**である
    const listed = allowlistLine();

    expect(listed, "既定の作業場（localhost:3000）が消えている").toContain(
      "http://localhost:3000/**",
    );
    expect(listed, "既定の作業場（127.0.0.1:3000）が消えている").toContain(
      "http://127.0.0.1:3000/**",
    );
  });
});
