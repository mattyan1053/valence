/**
 * **イメージが古いことを、使う前に知らせる**（#380）。
 *
 * **`Dockerfile` に何かを足した PR がマージされても、走っている作業場は
 * 古いイメージのまま動き続ける**——**気づくのは、そのぶんが要る検査が落ちたとき**である
 * （#379 で ShellCheck を `./task check` へ入れなかったのは、まさにこれが無いため）。
 *
 * **比べるのは、イメージに焼き込まれるファイルの内容**である。**指紋はイメージの
 * ラベルに残す**——**残る側はイメージ**（`AGENTS.md` §5）。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./image-drift", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 写した checkout を作る。**実物の `Dockerfile` を触らない。**
 *
 * `label` は偽の `docker` が返す値。`null` なら「そのイメージは無い」。
 */
function checkout(
  options: {
    dockerfile?: string;
    /** タグのラベル。`null` なら「そのイメージは無い」。 */
    label?: string | null;
    /** 走っているコンテナのイメージのラベル。**渡すと、コンテナがある状態**になる。 */
    runningLabel?: string;
    /** もう 1 つのサービスのイメージのラベル（`<project>-supabase-cli` 相当）。 */
    otherLabel?: string;
    /**
     * **ラベルが 1 つも無いイメージ**（`.Config.Labels` が `null`）。
     *
     * **版によっては `{{index …}}` がそこで落ちる**——**落ちる docker を作る。**
     */
    labelsNull?: boolean;
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "image-drift-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "bin", "image-drift"));
  chmodSync(join(dir, "bin", "image-drift"), 0o755);
  writeFileSync(join(dir, "Dockerfile"), options.dockerfile ?? "FROM node:24\n");
  writeFileSync(join(dir, "docker-entrypoint.sh"), '#!/usr/bin/env bash\nexec "$@"\n');
  const stub = join(dir, "stub");
  mkdirSync(stub, { recursive: true });
  // **偽の `docker`。** **コンテナの image id を引く口**（`docker inspect <cid>`）と、
  // **イメージのラベルを引く口**（`docker image inspect <ref>`）を分けて答える。
  const running = options.runningLabel;
  writeFileSync(
    join(stub, "docker"),
    [
      "#!/usr/bin/env bash",
      // コンテナ → そのコンテナが使っているイメージ（id は "走っているイメージ"）
      'if [[ $1 == "inspect" ]]; then',
      running === undefined
        ? '  echo "No such object" >&2; exit 1'
        : "  printf '%s\\n' \"走っているイメージ\"; exit 0",
      "fi",
      // イメージ → ラベル
      'if [[ $1 == "image" ]]; then',
      // **ラベルが 1 つも無いイメージ**。**古い docker は index でここが落ちる**
      ...(options.labelsNull === true
        ? [
            '  if [[ $* != *"if .Config.Labels"* ]]; then',
            '    echo "template: :1:2: executing … index of untyped nil" >&2; exit 1',
            "  fi",
            "  printf '\\n'; exit 0",
          ]
        : []),
      '  if [[ $3 == "もう一つ" ]]; then',
      options.otherLabel === undefined
        ? '    echo "No such image" >&2; exit 1'
        : `    printf '%s\\n' ${JSON.stringify(options.otherLabel)}; exit 0`,
      "  fi",
      '  if [[ $3 == "走っているイメージ" ]]; then',
      running === undefined
        ? '    echo "No such image" >&2; exit 1'
        : `    printf '%s\\n' ${JSON.stringify(running)}; exit 0`,
      "  fi",
      options.label === null
        ? '  echo "No such image" >&2; exit 1'
        : `  printf '%s\\n' ${JSON.stringify(options.label ?? "")}; exit 0`,
      "fi",
      'echo "スタブ: 想定外の docker 呼び出し: $*" >&2',
      "exit 2",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

function run(
  dir: string,
  args: string[],
  withDocker = true,
): { status: number; stderr: string; stdout: string } {
  const result = spawnSync(join(dir, "bin", "image-drift"), args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "stub")}:${process.env.PATH ?? ""}`,
      // **呼ぶものを差し替える**（PATH を壊すと、bash も見つからなくなる）
      LOOP_DOCKER: withDocker ? "docker" : "docker-does-not-exist",
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

describe("bin/image-drift", () => {
  it("同じ入力なら、同じ指紋になる", () => {
    const a = checkout();
    const b = checkout();

    expect(run(a, ["digest"]).stdout).toBe(run(b, ["digest"]).stdout);
  });

  it("Dockerfile が変われば、指紋も変わる", () => {
    const a = checkout();
    const b = checkout({ dockerfile: "FROM node:24\nRUN apt-get install -y shellcheck\n" });

    expect(run(a, ["digest"]).stdout).not.toBe(run(b, ["digest"]).stdout);
  });

  it("指紋が同じなら、何も言わない", () => {
    const dir = checkout();
    const digest = run(dir, ["digest"]).stdout.trim();
    const same = checkout({ label: digest });

    const result = run(same, ["check", "valence-app"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr, "同じなのに鳴っている").toBe("");
  });

  it("指紋が違えば、作り直し方を出す", () => {
    const dir = checkout({ label: "前の指紋" });

    const result = run(dir, ["check", "valence-app"]);

    expect(result.status).toBe(1);
    expect(result.stderr, "作り直し方が出ていない").toContain("./task build");
  });

  it("ラベルが無いイメージも、古い側へ倒す", () => {
    // **この仕組みより前に作られたイメージ**——**「分からない」は「新しい」ではない**
    const dir = checkout({ label: "" });

    const result = run(dir, ["check", "valence-app"]);

    expect(result.status).toBe(1);
    expect(result.stderr, "いつの build か分からないことを言っていない").toContain("分かりません");
  });

  it("そのイメージがまだ無ければ、何も言わない", () => {
    // **これから compose が作る**——**「古い」ではない**（**毎周回鳴らせない**）
    const dir = checkout({ label: null });

    const result = run(dir, ["check", "valence-app"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("docker が無ければ、分からないと言う", () => {
    // **「古くない」へ倒さない**（#210 の向き）
    const dir = checkout();

    expect(run(dir, ["check", "valence-app"], false).status).toBe(2);
  });

  it("使い方の誤りは、緑にしない", () => {
    const dir = checkout();

    expect(run(dir, []).status).toBe(2);
    expect(run(dir, ["check"]).status).toBe(2);
    expect(run(dir, ["digest", "余計"]).status).toBe(2);
  });

  it("走っているコンテナが古ければ、タグが新しくても鳴る", () => {
    // **これが本題** (#382 のレビュー)。**`./task build` はタグを作り直すだけ**で、
    // **走っているコンテナは古いイメージ ID のまま**——**タグだけを見ると、
    // 案内どおりに打った直後に「直った」と嘘をつく。**
    const dir = checkout({ runningLabel: "前の指紋" });
    const digest = run(dir, ["digest"]).stdout.trim();
    const same = checkout({ label: digest, runningLabel: "前の指紋" });

    const result = run(same, ["check", "--container", "コンテナ", "valence-app"]);

    expect(result.status, "タグが新しいだけで黙っている").toBe(1);
    expect(result.stderr, "入れ替えまで案内していない").toContain("./task up");
    expect(dir).toBeTruthy();
  });

  it("使いうるものが全部新しければ、何も言わない", () => {
    // **タグも見る** (#382 のレビュー)——**コンテナが新しくても、タグが古ければ、
    // 次に作り直した（入れ替えた）ときに古いほうが使われる。**
    const dir = checkout();
    const digest = run(dir, ["digest"]).stdout.trim();
    const same = checkout({ label: digest, runningLabel: digest });

    const result = run(same, ["check", "--container", "コンテナ", "valence-app"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr, "全部新しいのに鳴っている").toBe("");
  });

  it("sha256sum が無くても、指紋を出せる", () => {
    // **`sha256sum` はホスト標準ではない** (#195 のレビュー)——**`git hash-object` で取る**
    const dir = checkout();
    writeFileSync(join(dir, "stub", "sha256sum"), "#!/usr/bin/env bash\nexit 127\n", {
      mode: 0o755,
    });

    const result = run(dir, ["digest"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim(), "git の hash になっていない").toMatch(/^[0-9a-f]{40}$/);
  });

  it("ラベルが 1 つも無いイメージでも、鳴る", () => {
    // **いちばん鳴らせたい相手**（**この仕組みより前に作られたイメージ**）である
    // ——**版によっては `{{index …}}` がそこで落ち**、**「イメージが無い」に化ける。**
    const dir = checkout({ labelsNull: true });

    const result = run(dir, ["check", "valence-app"]);

    expect(result.status, "いちばん鳴らせたい相手が、いちばん静かになっている").toBe(1);
    expect(result.stderr).toContain("分かりません");
  });

  it("もう 1 つのサービスのイメージが古ければ、鳴る", () => {
    // **compose はサービスごとに別のタグを作る**（`image:` が無い）——
    // **`app` だけを見ると、`./task db:*` が古いイメージのまま走る**
    const dir = checkout();
    const digest = run(dir, ["digest"]).stdout.trim();
    const mixed = checkout({ label: digest, otherLabel: "前の指紋" });

    const result = run(mixed, ["check", "valence-app", "もう一つ"]);

    expect(result.status, "もう 1 つのイメージを見ていない").toBe(1);
    expect(result.stderr, "どのイメージが古いのか読めない").toContain("もう一つ");
  });

  it("どちらのイメージも新しければ、何も言わない", () => {
    const dir = checkout();
    const digest = run(dir, ["digest"]).stdout.trim();
    const fresh = checkout({ label: digest, otherLabel: digest });

    const result = run(fresh, ["check", "valence-app", "もう一つ"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("実物の checkout でも、指紋を出せる", () => {
    const result = spawnSync(SCRIPT, ["digest"], { cwd: REPO_ROOT, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim(), "指紋の形が違う").toMatch(/^[0-9a-f]{40}$/);
  });
});
