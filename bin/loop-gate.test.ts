import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-gate", import.meta.url));

const HEAD = "a".repeat(40);

/**
 * レビュー用の bot。**値をここに書き写さない**——`bin/loop-review-commits` が正で、
 * **写しを持つと、出所を変えても緑のまま**になる（#135）。
 */
const BOT = execFileSync(fileURLToPath(new URL("./loop-review-commits", import.meta.url)), [
  "--bot",
])
  .toString()
  .trim();

/** gh の `--jq` の `@base64` と同じ符号化。 */
function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

type Run = { status: number; stdout: string; stderr: string };

/**
 * ゲートが呼ぶものをすべて差し替えて動かす。
 *
 * **本物の `gh` を呼ばない。** ゲートは読み取りだけだが、GitHub に依存すると
 * オフラインで落ち、CI の時間も読めなくなる。
 *
 * **補助スクリプトも差し替える。** ここで見たいのは「補助スクリプトの中身」ではなく
 * **その結果をゲートが合否へどう束ねるか**（結線）である。中身は各スクリプトの
 * テストが固定している。ゲートは `$(dirname "$0")/…` で隣を呼ぶので、コピーの隣に
 * 偽物を置けばそちらが実行される。
 */
function runGate(env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "loop-gate-"));
  const bin = join(dir, "bin");
  const path = join(dir, "path");
  mkdirSync(bin);
  mkdirSync(path);
  symlinkSync("/usr/bin/bash", join(path, "bash"));
  // ゲートが隣の補助スクリプトを引くのに使う。gh はここに置かない（差し替えを通す）
  symlinkSync("/usr/bin/dirname", join(path, "dirname"));
  // 必須チェック名を @base64 と同じ形に揃えるのに使う
  symlinkSync("/usr/bin/base64", join(path, "base64"));
  symlinkSync("/usr/bin/tr", join(path, "tr"));

  const gate = join(bin, "loop-gate");
  copyFileSync(SCRIPT, gate);
  chmodSync(gate, 0o755);

  // gh の差し替え。**引数の中身で分岐する**ので、呼ぶ場所が変わればここも合わなくなる。
  //
  // **--jq の式まで見る。** 値を取り出しているのは gh 側の --jq で、スタブが
  // 「取り出し済みの値」を返すだけだと、**--jq を消しても壊しても緑のまま**になる。
  // 本番では生の JSON が mapfile へ流れ込み、ゲートは常に落ちる。
  writeFileSync(
    join(path, "gh"),
    `#!/usr/bin/env bash
args="$*"

# 期待する断片が無ければ「想定外の呼び出し」として失敗させる
require() {
  local frag
  for frag in "$@"; do
    if [[ $args != *"$frag"* ]]; then
      echo "スタブ: 想定外の gh 呼び出し ($frag が無い): $args" >&2
      exit 1
    fi
  done
}

case "$args" in
  *"--json state,isDraft,baseRefName,headRefOid"*)
    require "--jq" ".state" ".isDraft" ".baseRefName" ".headRefOid"
    [[ -n \${FAKE_PR_VIEW_FAIL:-} ]] && exit 1
    printf '%s\\n' "\${FAKE_PR_STATE:-OPEN}" "\${FAKE_PR_DRAFT:-false}" \\
      "\${FAKE_PR_BASE:-main}" "\${FAKE_PR_HEAD:-${HEAD}}"
    ;;
  *"--json changedFiles,additions,deletions"*)
    require "--jq" ".changedFiles" ".additions" ".deletions"
    [[ -n \${FAKE_SIZE_FAIL:-} ]] && exit 1
    printf '%s\\n' "\${FAKE_SIZE_FILES:-5}" "\${FAKE_SIZE_LINES:-100}"
    ;;
  "pr checks"*)
    require "--jq" "(type)" ".name" "@base64" ".bucket"
    [[ -n \${FAKE_CHECKS_FAIL:-} ]] && exit 1
    printf '%s' "\${FAKE_CHECKS-T$'\\t'array$'\\n'C$'\\t'YWxwaGE=$'\\t'pass}"
    printf '\\n'
    ;;
  "api graphql"*)
    require "--jq" "isResolved"
    [[ -n \${FAKE_THREADS_FAIL:-} ]] && exit 1
    printf '%s\\n' "\${FAKE_THREADS:-0}"
    ;;
  *) exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  // 補助スクリプトの差し替え。出力と終了コードだけを持つ
  writeFileSync(
    join(bin, "loop-review-commits"),
    `#!/usr/bin/env bash
# **名前の出所も本物と同じ形にする**（#135）。ゲートは起動時にここから取る
if [[ $1 == --bot ]]; then printf '%s\\n' "${BOT}"; exit 0; fi
printf '%s\\n' "\${FAKE_REVIEWED-2026-01-01T00:00:00Z$'\\t'${HEAD}}"
exit \${FAKE_REVIEWED_EXIT:-0}
`,
    { mode: 0o755 },
  );
  // **受け取った引数を標準エラーへ出す。** ゲートは標準出力しか読まないので、
  // 出力を汚さずに「何を渡したか」を確かめられる
  writeFileSync(
    join(bin, "loop-fixup-lines"),
    `#!/usr/bin/env bash
echo "fixup-args: $*" >&2
printf '%s\\n' "\${FAKE_FIXUP-10$'\\t'0$'\\t'0}"
exit \${FAKE_FIXUP_EXIT:-0}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "loop-deferred-budget"),
    `#!/usr/bin/env bash
exit \${FAKE_DEFERRED_EXIT:-0}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "loop-open-requests"),
    `#!/usr/bin/env bash
echo "fake"
exit \${FAKE_REQUESTS_EXIT:-0}
`,
    { mode: 0o755 },
  );

  const result = spawnSync(gate, ["12"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: path,
      // 既定の必須チェック一覧に引きずられないよう、1 件へ絞る
      LOOP_REQUIRED_CHECKS: "alpha",
      ...env,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("外出しした指摘の残量", () => {
  it("溜まりすぎていればマージさせない", () => {
    // **既定を「外出ししてマージ」にした以上、歯止めはここにしかない**（#73）。
    // 外出しの経路だけで見ると、**その周回のマージが 1 回遅れるだけ**で、
    // 次の周回はゲートが通って素通りする（#103 のレビューで指摘された）
    const gate = runGate({ FAKE_DEFERRED_EXIT: "1" });

    expect(gate.status).toBe(1);
    expect(gate.stdout).toMatch(/\[FAIL\].*外出し/);
  });

  it("判定できなければマージさせない", () => {
    // **判定不能を合格として扱わない**（このゲートの原則）
    expect(runGate({ FAKE_DEFERRED_EXIT: "2" }).status).toBe(1);
  });
});

describe("bin/loop-gate の合格", () => {
  it("7 条件すべて成立なら exit 0 で、検証した head SHA を出す", () => {
    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`GATE PASS pr=12 head=${HEAD}`);
    // マージの実行方法まで案内する（案内が古いとラッパーが呼ばれない）
    expect(result.stdout).toContain(`bin/loop-merge 12 ${HEAD}`);
  });
});

describe("bin/loop-gate の不合格", () => {
  it("落ちたときも、検証した head SHA を丸ごと出す", () => {
    // **この値は記録へ写される**（`awaiting-worker:<PR番号>@<SHA>` など）。
    // **縮めて出すと、写す側は縮んだ値しか持てない**——**合格の経路とは
    // 別の長さになり、同じ head が別の識別子になる**（#145）。
    //
    // **`bin/loop-head same` に渡すのもこの値**である。**周回の途中で head が
    // 動いたかを確かめる**ためには、**評価した head が全部読めること**が要る
    const result = runGate({ FAKE_PR_STATE: "MERGED" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`GATE FAIL pr=12 head=${HEAD}`);
  });
});

describe("bin/loop-gate は 1 条件でも欠ければ止める", () => {
  /** 条件ごとに「その条件だけを不成立にする」env と、落ちる行の目印。 */
  const cases: { name: string; env: Record<string, string>; marker: string }[] = [
    { name: "判定対象: open でない", env: { FAKE_PR_STATE: "MERGED" }, marker: "判定対象" },
    { name: "判定対象: draft", env: { FAKE_PR_DRAFT: "true" }, marker: "判定対象" },
    { name: "判定対象: base が main でない", env: { FAKE_PR_BASE: "dev" }, marker: "判定対象" },
    { name: "規模上限: ファイル数", env: { FAKE_SIZE_FILES: "999" }, marker: "規模上限" },
    { name: "規模上限: 行数", env: { FAKE_SIZE_LINES: "99999" }, marker: "規模上限" },
    {
      name: "GHA CI: 必須チェックが pass でない",
      env: { FAKE_CHECKS: `T\tarray\nC\t${b64("alpha")}\tfail` },
      marker: "GHA CI",
    },
    {
      name: "GHA CI: 必須チェックが無い",
      env: { FAKE_CHECKS: `T\tarray\nC\t${b64("beta")}\tpass` },
      marker: "GHA CI",
    },
    // **文面まで見る。** 「0 件」を消しても必須チェック不足で落ちるので、
    // 目印だけだと検査を消したことに気づけない
    {
      name: "GHA CI: チェックが 0 件",
      env: { FAKE_CHECKS: "T\tarray" },
      marker: "1 件も登録されていません",
    },
    { name: "レビュー: 1 件も無い", env: { FAKE_REVIEWED: "" }, marker: "レビュー" },
    {
      name: "レビュー: 現 head が未レビューで上限未満",
      env: { FAKE_REVIEWED: `2026-01-01T00:00:00Z\t${"b".repeat(40)}` },
      marker: "レビュー",
    },
    {
      // **チェック名は PR 側で決められる**（pull_request で走る job 名）。
      // 名前 "dummy\nC\talpha" を持つ成功ジョブが 1 つあると、生のまま並べる実装では
      // 2 行目が `C<TAB>alpha<TAB>pass` になり、**実在しない必須チェックが pass に見える**
      // （修正前の実装に食わせて GATE PASS が出ることを確認済み）
      name: "GHA CI: 区切りを含むチェック名で必須チェックを偽装できない",
      env: { FAKE_CHECKS: `T\tarray\nC\t${b64("dummy\nC\talpha")}\tpass` },
      marker: "GHA CI",
    },
    { name: "未解決スレッドがある", env: { FAKE_THREADS: "2" }, marker: "未解決スレッド" },
    {
      name: "master の要求が残っている",
      env: { FAKE_REQUESTS_EXIT: "1" },
      marker: "master の要求",
    },
  ];

  for (const { name, env, marker } of cases) {
    it(`${name} → exit 1 で、その行が FAIL になる`, () => {
      const result = runGate(env);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("GATE FAIL");
      expect(result.stdout).toMatch(new RegExp(`\\[FAIL\\][^\\n]*${marker}`));
    });
  }
});

describe("bin/loop-gate は判定できないものを合格にしない", () => {
  // **「分からない」を「合格」に丸めないことが、この設計の芯**である
  const cases: { name: string; env: Record<string, string>; marker: string }[] = [
    { name: "PR の情報を取れない", env: { FAKE_PR_VIEW_FAIL: "1" }, marker: "判定対象" },
    { name: "規模を取れない", env: { FAKE_SIZE_FAIL: "1" }, marker: "規模上限" },
    { name: "チェック結果を取れない", env: { FAKE_CHECKS_FAIL: "1" }, marker: "GHA CI" },
    { name: "スレッドを取れない", env: { FAKE_THREADS_FAIL: "1" }, marker: "未解決スレッド" },
    {
      name: "レビュー済み commit を取れない",
      env: { FAKE_REVIEWED_EXIT: "1" },
      marker: "レビュー",
    },
    {
      name: "master の要求を判定できない",
      env: { FAKE_REQUESTS_EXIT: "2" },
      marker: "master の要求",
    },
    {
      name: "手直し量を取れない",
      env: {
        FAKE_REVIEWED: `2026-01-01T00:00:00Z\t${"b".repeat(40)}\n2026-01-02T00:00:00Z\t${"c".repeat(40)}`,
        FAKE_FIXUP_EXIT: "1",
      },
      marker: "レビュー",
    },
    {
      name: "手直し量が数値でない",
      env: {
        FAKE_REVIEWED: `2026-01-01T00:00:00Z\t${"b".repeat(40)}\n2026-01-02T00:00:00Z\t${"c".repeat(40)}`,
        FAKE_FIXUP: "x\ty\tz",
      },
      marker: "レビュー",
    },
    {
      // **欄が増えたのに古い形で返ってきたら、黙って読み替えない。**
      // 3 列目を「無ければ 0」で受けると、要求ぶんが常に 0 に見え、
      // **除外が効いていないことに気づけない**
      name: "手直し量の欄が足りない",
      env: {
        FAKE_REVIEWED: `2026-01-01T00:00:00Z\t${"b".repeat(40)}\n2026-01-02T00:00:00Z\t${"c".repeat(40)}`,
        FAKE_FIXUP: "10\t0",
      },
      marker: "レビュー",
    },
  ];

  for (const { name, env, marker } of cases) {
    it(`${name} → 非ゼロで、その行が FAIL になる`, () => {
      const result = runGate(env);

      expect(result.status).not.toBe(0);
      expect(result.stdout).toMatch(new RegExp(`\\[FAIL\\][^\\n]*${marker}`));
    });
  }
});

describe("bin/loop-gate の上限到達後の扱い", () => {
  /** 上限（既定 2 回）に達し、現 head は未レビューの状態。 */
  const exhausted = {
    FAKE_REVIEWED: `2026-01-01T00:00:00Z\t${"b".repeat(40)}\n2026-01-02T00:00:00Z\t${"c".repeat(40)}`,
  };

  it("手直しの範囲なら通す（上限がデッドロックにならない）", () => {
    const result = runGate({ ...exhausted, FAKE_FIXUP: "10\t0\t0" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("手直しの範囲");
  });

  it("上限を超えた手直しは人へ渡す", () => {
    const result = runGate({ ...exhausted, FAKE_FIXUP: "999\t0\t0" });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/\[FAIL\][^\n]*レビュー/);
  });

  it("最後にレビューされた commit と PR 番号を渡して数えさせる", () => {
    // **PR 番号を渡さないと、どのレビュースレッドを見ればよいか決まらない**
    // （要求された変更の範囲がそこから決まる）。
    // **最後の 1 件を基準にする。** 古いほうを渡すと手直し量を過大に見積もる
    const result = runGate({ ...exhausted, FAKE_FIXUP: "10\t0\t0" });

    expect(result.stderr).toContain(`fixup-args: 12 ${"c".repeat(40)} ${HEAD}`);
  });

  it("除外した行は、理由ごとに分けて出す", () => {
    // **人が読んで判断する材料になる。** 「0 行だから通した」とだけ出ると、
    // **数えなかったのか、本当に変更が無かったのか**が区別できない
    const result = runGate({ ...exhausted, FAKE_FIXUP: "7\t100\t89" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("テスト追加 100 行");
    expect(result.stdout).toContain("レビューが要求した 89 行");
  });

  it("止めるときも、除外した行を出す", () => {
    // **止めた理由を人が検算できるようにする。** 除外の内訳が出ないと、
    // 「数え方が間違っているのか、本当に多いのか」を人が判断できない
    const result = runGate({ ...exhausted, FAKE_FIXUP: "999\t100\t89" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("テスト追加 100 行");
    expect(result.stdout).toContain("レビューが要求した 89 行");
  });
});
