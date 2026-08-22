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
  {
    body,
    entries,
    fail,
    repo = "mattyan1053/valence",
  }: { body: string; entries: Record<number, Entry>; fail?: string; repo?: string },
): { status: number; stdout: string; stderr: string; cwd: string; asked: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "close-candidates-"));
  sandboxes.push(dir);
  const stub = join(dir, "gh");
  const [owner = "", name = ""] = repo.split("/");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `fail=${JSON.stringify(fail ?? "")}`,
      // **`gh repo view`** — どのリポジトリを見るかは実行時に決まる
      `if [[ "$1" == "repo" ]]; then printf '%s\\n%s\\n' ${JSON.stringify(owner)} ${JSON.stringify(name)}; exit 0; fi`,
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
      // **引きに行った番号を残す** (#358)。**「引かない」を、結果ではなく
      // 呼び出しで見る**——**404 を握り潰す実装でも、結果だけなら同じに見える**
      `  printf '%s\\n' "$n" >>${JSON.stringify(join(dir, "asked"))}`,
      '  case "$n" in',
      ...Object.entries(entries).map(
        ([number, entry]) =>
          `  ${number}) printf '%s\\u001f%s\\u001f%s\\n' ${JSON.stringify(entry.state)} ${JSON.stringify(entry.title)} ${entry.pull ? "true" : "false"}; exit 0 ;;`,
      ),
      // **本物の `gh` と同じ形で落とす** (#358)。**「無い」と「読めなかった」は
      // 別**である——**本物は 404 のとき `gh: Not Found (HTTP 404)` を出す**
      '  *) printf \'{"message":"Not Found","status":"404"}\'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
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
  const askedFile = join(dir, "asked");
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    cwd,
    asked: existsSync(askedFile) ? readFileSync(askedFile, "utf8").split("\n").filter(Boolean) : [],
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

  /**
   * **他のリポジトリの番号を、自分のものとして引きに行く**（#358）。
   *
   * **dependabot は release notes を丸ごと引用する**ので、**引用文の中の `#N` が
   * 「このリポジトリの #N」に見える**——**実測で 30 行の `[FAIL]` が出て exit 2**
   * （PR #357）。**倒す向きは正しい**（読めない → 閉じない）**が、判定が全体で 1 つ**
   * なので、**同じ本文にある本物の閉じ忘れも一緒に落ちる。**
   */
  describe("引用に出てくる他のリポジトリの番号", () => {
    /** **dependabot の本文の形**（リンクの中身が `#N`。リンク先は別のリポジトリ）。 */
    const quoted =
      "<li>Revert i18n localization change " +
      '(<a href="https://redirect.github.com/vercel/next.js/issues/94905">#94905</a>) ' +
      'in <a href="https://redirect.github.com/vercel/next.js/pull/97330">vercel/next.js#97330</a></li>';

    it("引きに行かない", () => {
      const verdict = run(["357"], { body: `${quoted}\n`, entries: {} });

      expect(verdict.asked, "他のリポジトリの番号を引きに行っている").not.toContain("94905");
      expect(verdict.status, verdict.stderr).toBe(0);
    });

    /**
     * **ホストは 1 つではない** (#365 のレビュー)。**dependabot は
     * `redirect.github.com` へ書き換える**ので、**そこに自分のリポジトリの番号が
     * 出ることもある**——**そのリンクを外部として落とすと、本物の候補が黙って消える。**
     *
     * **倒れる先が `exit 2` ではなく `exit 0`（候補なし）**なので、**誰も見ない。**
     */
    it.each([
      { host: "github.com", mine: true, shown: true },
      { host: "github.com", mine: false, shown: false },
      { host: "redirect.github.com", mine: true, shown: true },
      { host: "redirect.github.com", mine: false, shown: false },
    ])("$host のリンク（自分のもの: $mine）は $shown", ({ host, mine, shown }) => {
      const target = mine ? "mattyan1053/valence" : "vercel/next.js";
      const verdict = run(["357"], {
        body: `<li>直したもの (<a href="https://${host}/${target}/issues/319">#319</a>)</li>\n`,
        entries: { 319: { state: "OPEN", title: "ここの Issue" } },
      });

      expect(verdict.stdout.includes("319"), "自分のリンクを落としている").toBe(shown);
      expect(verdict.status, verdict.stderr).toBe(shown ? 1 : 0);
    });

    /**
     * **書式は `<a>` だけではない** (#365 のレビュー)。**Markdown のリンクでも
     * 同じことが起きる**——**リンク先で振り分ける、という軸は同じ**である。
     *
     * **置くのは 2 本**（**書式ごとに全部の組み合わせは置かない**）。**軸は
     * 1 箇所で効いている**ので、**新しい書式について要るのは「両側」だけ**
     * ——**片側だけだと、「全部落とす」実装でも「全部残す」実装でも通る。**
     * **自分のものの側は `redirect.github.com` で置く**（**黙って消える側**なので、
     * **ホストの取りこぼしがそこに出る**）。
     */
    it("Markdown のリンクでも、他所の番号は引きに行かない", () => {
      const verdict = run(["357"], {
        body: "リリースノートより [#94905](https://redirect.github.com/vercel/next.js/issues/94905)\n",
        entries: {},
      });

      expect(verdict.asked, "他のリポジトリの番号を引きに行っている").not.toContain("94905");
      expect(verdict.status, verdict.stderr).toBe(0);
    });

    it("Markdown のリンクでも、自分の番号は残す", () => {
      const verdict = run(["357"], {
        body: "直したもの [#319](https://redirect.github.com/mattyan1053/valence/issues/319)\n",
        entries: { 319: { state: "OPEN", title: "ここの Issue" } },
      });

      expect(verdict.status, verdict.stderr).toBe(1);
      expect(verdict.stdout, "自分のリンクを落としている").toContain("319");
    });

    it("同じ本文の本物の候補は、これまでどおり出す", () => {
      // **これが無いと「静かになった」だけ**で、**見えなくなったのと区別が付かない**
      const verdict = run(["357"], {
        body: `${quoted}\n\nRefs #319\n`,
        entries: { 319: { state: "OPEN", title: "ここの Issue" } },
      });

      expect(verdict.status, verdict.stderr).toBe(1);
      expect(verdict.stdout, "本物の候補まで落ちている").toContain("319");
      expect(verdict.stdout, "他のリポジトリの番号が並んでいる").not.toContain("94905");
    });

    it("無い番号は、候補から外すだけにする", () => {
      // **引用の形は書き手が変える**（#358 の手がかり）——**すり抜けたぶんは、
      // 「無い」で落とす。** **1 件読めなかったことで、読めた候補まで落とさない。**
      const verdict = run(["357"], {
        body: "リリースノートより (#94905)\n\nRefs #319\n",
        entries: { 319: { state: "OPEN", title: "ここの Issue" } },
      });

      expect(verdict.asked, "この形は引きに行く（そのうえで「無い」で落とす）").toContain("94905");
      expect(verdict.status, "無い番号で、読めた候補まで落としている").toBe(1);
      expect(verdict.stdout).toContain("319");
    });

    it("本当に読めなかったときは、これまでどおり止まる", () => {
      // **倒す向きは変えない**——**404 以外は「分からない」**である
      const verdict = run(["357"], {
        body: "Refs #319\n",
        entries: { 319: { state: "OPEN", title: "ここの Issue" } },
        fail: "api",
      });

      expect(verdict.status, "読めないのに 0 件や 1 件で答えている").toBe(2);
    });
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

  it("リポジトリ名の記号を、任意の文字として扱わない", () => {
    // **リポジトリ名は正規表現ではない** (#337 のレビュー)。**`.` を含む名前
    // （`foo.bar`）を ERE へそのまま挿すと、`fooXbar` を指した別のリポジトリの
    // 参照まで「ここのもの」として拾う**——**倒れ方は修飾を見ていなかったときと同じ**で、
    // **無関係な Issue が `gh issue close <N>` の相手として並ぶ。**
    //
    // **名前は文字列として突き合わせる。**
    const verdict = run(["330"], {
      repo: "acme/foo.bar",
      body: "Fixes acme/fooXbar#264\n\nRefs #319\n",
      entries: {
        319: { state: "OPEN", title: "ここの Issue" },
        264: { state: "OPEN", title: "ここの無関係な Issue" },
      },
    });

    expect(verdict.status, verdict.stderr).toBe(1);
    expect(verdict.stdout).toContain("319");
    expect(verdict.stdout, "別のリポジトリの参照を正規表現で拾っている").not.toContain("264");
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
