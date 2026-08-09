import { spawnSync } from "node:child_process";
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
      echo "スタブ: 想定外の gh 呼び出し (\$frag が無い): $args" >&2
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
printf '%s\\n' "\${FAKE_REVIEWED-2026-01-01T00:00:00Z$'\\t'${HEAD}}"
exit \${FAKE_REVIEWED_EXIT:-0}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "loop-fixup-lines"),
    `#!/usr/bin/env bash
printf '%s\\n' "\${FAKE_FIXUP-10$'\\t'0}"
exit \${FAKE_FIXUP_EXIT:-0}
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

describe("bin/loop-gate の合格", () => {
  it("6 条件すべて成立なら exit 0 で、検証した head SHA を出す", () => {
    const result = runGate();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`GATE PASS pr=12 head=${HEAD}`);
    // マージの実行方法まで案内する（案内が古いとラッパーが呼ばれない）
    expect(result.stdout).toContain(`bin/loop-merge 12 ${HEAD}`);
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
        FAKE_FIXUP: "x\ty",
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
    const result = runGate({ ...exhausted, FAKE_FIXUP: "10\t0" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("手直しの範囲");
  });

  it("上限を超えた手直しは人へ渡す", () => {
    const result = runGate({ ...exhausted, FAKE_FIXUP: "999\t0" });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/\[FAIL\][^\n]*レビュー/);
  });
});
