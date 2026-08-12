import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 列区切り。**タブは IFS の空白に畳まれる**ので US を使う（スクリプトと同じ）。 */
const FIELD = "\u001f";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 理由の無い保留が、**人の目に触れる場所へ出るか**（#163）。
 *
 * **拾い手は 1 つに決まらない。** `bin/loop-handoff` は**毎周回通る**が、
 * **送るのは相手役が動けるときだけ**で、**同じ状態では 2 通目を送らない**。
 * `./task loop:status` は**人が読む場所**だが、**読むのは人が思い出したとき**である。
 * **#161 と同じ判断**で、**触りうるものすべてに置く**——判定は 1 つ、呼ぶ場所は 2 つ。
 */
describe("理由の無い保留", () => {
  /** `./task loop:status` の該当箇所だけを、偽の `gh` で走らせる。 */
  function statusWith(rows: string[]): string {
    const workspace = mkdtempSync(join(tmpdir(), "silent-park-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/usr/bin/env bash",
          'if [[ $* == *"repo view"* ]]; then printf "owner\\nrepo\\n"; exit 0; fi',
          // **区切りは生のまま埋める**（`JSON.stringify` の `` は bash が戻せない）
          ...rows.map((row) => `printf '%s\\n' '${row}'`),
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return execFileSync(
        "bash",
        [
          "-c",
          // **`task` は読み込むと自分でリポジトリ根へ移動する。** 実物の
          // `bin/loop-silent-park` がそのまま走り、**偽の `gh` だけを見る**
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `PATH=${JSON.stringify(stub)}:$PATH show_silent_park`,
        ],
        { encoding: "utf8" },
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("./task loop:status が、理由の無い保留を見せる", () => {
    // **番号だけでは足りない。** 見た人が**「人待ちが 1 件ある」と読んで終わる**ので、
    // **理由が投稿されていないこと**まで出す
    const shown = statusWith([
      ["42", "parked,awaiting-human", "2026-08-12T04:00:00Z", ""].join(FIELD),
    ]);

    expect(shown, "どの PR かが出ていない").toContain("42");
    expect(shown, "何が起きているのかが出ていない").toMatch(/理由/);
  });

  it("正常な人待ちでは、何も足さない", () => {
    // **うるさくしない。** ここが毎回鳴ると、**本当に拾ってほしいものが埋もれる**
    const shown = statusWith([
      ["42", "parked,awaiting-human", "2026-08-12T04:00:00Z", "2026-08-12T04:00:01Z"].join(FIELD),
    ]);

    expect(shown).toBe("");
  });

  it("読めなければ、黙って 0 件にしない", () => {
    // **「0 件」と「読めなかった」を同じ静けさにしない**（`show_missing_lease` と同じ形）
    const workspace = mkdtempSync(join(tmpdir(), "silent-park-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `PATH=${JSON.stringify(stub)}:$PATH show_silent_park`,
        ],
        { encoding: "utf8" },
      );

      expect(shown, "読めないのに何も言わない").not.toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("投稿と戻しが続けて落ちた状態を、実際に作って拾う", () => {
    // **二重に落とさないと、この直しは 1 度も通らない**（master の完了条件）。
    // **片方だけ落とすと、既にある経路（`|| true` の手前）で拾われて終わる**。
    //
    // **偽の GitHub を持たせる**——label と発言をファイルに持ち、
    // **`pr comment` と `pr edit --remove-label` だけを落とす**（同じ API 障害）。
    // **並びは master の手順書と同じ**（そちらの形は
    // `loop/awaiting-human-wiring.test.ts` が文面で押さえている）。
    const workspace = mkdtempSync(join(tmpdir(), "silent-park-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      const labeledAt = join(workspace, "labeled_at");
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/usr/bin/env bash",
          'if [[ $* == *"repo view"* ]]; then printf "owner\nrepo\n"; exit 0; fi',
          // **保留にするのは成功する**（label だけは付く）
          `if [[ $* == *"pr edit"* && $* == *"--add-label"* ]]; then`,
          `  date -u +%Y-%m-%dT%H:%M:%SZ > ${JSON.stringify(labeledAt)}`,
          "  exit 0",
          "fi",
          // **理由の投稿が落ちる**（API 障害）
          'if [[ $* == *"pr comment"* ]]; then echo "API 障害" >&2; exit 1; fi',
          // **戻すのも同じ理由で落ちる**（相関する）
          `if [[ $* == *"pr edit"* && $* == *"--remove-label"* ]]; then`,
          '  echo "API 障害" >&2',
          "  exit 1",
          "fi",
          // **障害が明けたあと、GitHub から見える状態**——label はあるが、発言は無い
          'if [[ $* == *"api graphql"* ]]; then',
          `  labeled="$(cat ${JSON.stringify(labeledAt)} 2>/dev/null || true)"`,
          "  [[ -z $labeled ]] || printf '42\\u001fparked,awaiting-human\\u001f%s\\u001f\\n' \"$labeled\"",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const sequence = spawnSync(
        "bash",
        [
          "-c",
          [
            "gh pr edit 42 --add-label parked --add-label awaiting-human; echo add=$?",
            "gh pr comment 42 --body-file /dev/null; echo comment=$?",
            "gh pr edit 42 --remove-label parked --remove-label awaiting-human || true",
            "echo remove=${PIPESTATUS[0]}",
          ].join("\n"),
        ],
        {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
        },
      );

      // **落ちた理由が、狙ったものと一致すること**（完了条件）
      expect(sequence.stdout, "保留にできていない").toContain("add=0");
      expect(sequence.stdout, "投稿が落ちていない").toContain("comment=1");
      expect(sequence.stderr, "落ちた理由が違う").toContain("API 障害");

      const found = spawnSync(join(REPO_ROOT, "bin/loop-silent-park"), [], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });

      expect(found.status, "二重に落ちた保留を拾えていない").toBe(1);
      expect(found.stdout).toContain("42");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("master のステップ 2 が、自分で見つけて直す", () => {
    // **`bin/loop-handoff` だけでは、master が見つけたときに誰も送らない。**
    // `to == ROLE` で exit 1、**そのとき STATE は全役ぶん記録済み**なので、
    // **次の worker の周回も「送信済み」で exit 1** になる（master が手元で追った）。
    //
    // **「全役ぶん先に記録する」は正しい**（通らなかった分岐の記録が古くなる）ので
    // そこは変えない。**噛み合っていないのは「自分へは送らない」（#92）と
    // 「master にしか直せない」が同時に立っていること**である。
    //
    // **`parked` を選ばないのはステップ 2 の決め事**なので、**例外もそこに置く**——
    // `bin/loop-handoff` を触らずに済み、**#92 の線も覆さない**。
    const step2 =
      read(".claude/commands/loop-master.md").split("## 2. open PR を見て、見る順番を決める")[1] ??
      "";
    const section = step2.split(/\n## /)[0] ?? "";

    expect(section, "ステップ 2 が理由の無い保留を見ていない").toContain("bin/loop-silent-park");
    expect(section, "見つけたあと何をするのかが書かれていない").toMatch(/投稿し直す|保留を戻す/);
  });

  it("./task loop:status から呼ばれている", () => {
    // **関数を直接呼んで確かめない。** それだと**呼び出しを外しても緑のまま**になる
    // （`loop/lease-missing-wiring.test.ts` で 1 度踏んだ）——
    // **見たいのは「配線されていること」**である
    const status = read("task").split("cmd_loop_status()")[1]?.split("\n}")[0] ?? "";

    expect(status, "loop:status が理由の無い保留を見ていない").toContain("show_silent_park");
  });

  it("判定は 1 箇所に置く", () => {
    // **同じ判定を 2 箇所に持つと、片方だけ直して食い違う**（#159 で踏んだ）。
    // **`task` も `bin/loop-handoff` も、同じスクリプトを呼ぶ**
    for (const path of ["task", "bin/loop-handoff"]) {
      expect(read(path), `${path} が自前で判定していない`).toContain("loop-silent-park");
    }
    // **label と時刻の突き合わせは、スクリプトの中だけにある**
    expect(read("task"), "task が自前で保留を判定している").not.toContain("LABELED_EVENT");
  });
});
