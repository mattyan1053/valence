/**
 * **マージしても完了しない Issue の、`in-progress` を外した先**（#332）。
 *
 * **外す判断は毎回正しい**——**実装している周回が無いのに `in-progress` のままだと
 * 嘘になる。** **問題は外した先が無かったこと**で、**`backlog` / `ready` /
 * `in-progress` / `blocked` のどれでもない open Issue は、ループのどの一覧にも
 * 出てこない**（#325）。**3 度起きた。3 度とも #319 である。**
 *
 * **ここは語を数えない。** **手順書に書いてある手をそのまま走らせ**、**そのあとで
 * 本物の `bin/loop-unlisted-issues` に訊く**——**「鳴らないこと」が完了条件**である。
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DETECTOR = join(REPO_ROOT, "bin/loop-unlisted-issues");
const ISSUE = "319";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * **マージ済みの PR を見つけたときに打つブロック。**
 *
 * **名指しの見出しで探さない**（#173 / head-wiring と同じ理由）——**節を割ったり
 * 文言を変えたりしただけで、試験が黙る。** **中身で見つける。**
 */
function mergedBlock(): string {
  const blocks = [...procedureText("worker").matchAll(/```bash\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
  const found = blocks.filter(
    (block) => block.includes("--remove-label in-progress") && block.includes("gh issue comment"),
  );

  expect(found, "マージ済みの Issue から label を動かすブロックが 1 つに絞れない").toHaveLength(1);
  return found[0] ?? "";
}

/**
 * label の状態を持つ偽の `gh` を置いた作業場。
 *
 * **`issue edit` は本物と同じように付け外しする**ので、**手順書の 1 行を走らせた結果が
 * そのまま検出器の入力になる**——**間に人の解釈が入らない。**
 */
function workspace(labels: string[]): { path: string; labelsFile: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), "merged-issue-"));
  sandboxes.push(dir);
  const path = join(dir, "path");
  mkdirSync(path, { recursive: true });
  // **走らせる場所も砂場にする** (#338)。**`bin/loop-unlisted-issues` は冒頭で
  // `bin/loop-lease check` を通す**ので、**cwd を継ぐと実物の共通 `.git` へ書く**
  // ——**人が診断に使う記録（上限 20 行）が、試験の雑音で押し出される**（#186 / #192）。
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  expect(spawnSync("git", ["init", "--quiet", repo]).status, "砂場を作れない").toBe(0);
  const labelsFile = join(dir, "labels");
  writeFileSync(labelsFile, `${labels.join("\n")}\n`);

  writeFileSync(
    join(path, "gh"),
    [
      "#!/usr/bin/env bash",
      `labels_file=${JSON.stringify(labelsFile)}`,
      'if [[ $* == *"issue edit"* ]]; then',
      '  args=("$@")',
      "  for ((i = 0; i < ${#args[@]}; i++)); do",
      '    case "${args[i]}" in',
      "      --remove-label)",
      '        grep -vxF "${args[i + 1]}" "$labels_file" >"$labels_file.tmp" || true',
      '        mv "$labels_file.tmp" "$labels_file"',
      "        ;;",
      "      --add-label)",
      '        grep -qxF "${args[i + 1]}" "$labels_file" || echo "${args[i + 1]}" >>"$labels_file"',
      "        ;;",
      "    esac",
      "  done",
      "  exit 0",
      "fi",
      'if [[ $* == *"issue comment"* ]]; then exit 0; fi',
      'if [[ $* == *"repo view"* ]]; then',
      '  echo "owner"',
      '  echo "repo"',
      "  exit 0",
      "fi",
      // **検出器が読む形**（`bin/loop-unlisted-issues` の `--jq` の後ろ）。
      // **label は 1 行ずつ、US 区切り**である
      'if [[ $* == *"api graphql"* ]]; then',
      `  printf 'issue\\037%s\\n' ${JSON.stringify(ISSUE)}`,
      "  while read -r label; do",
      "    [[ -n $label ]] || continue",
      `    printf 'label\\037%s\\n' "$label"`,
      '  done <"$labels_file"',
      "  exit 0",
      "fi",
      'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
      "exit 2",
      "",
    ].join("\n"),
  );
  chmodSync(join(path, "gh"), 0o755);
  return { path, labelsFile, repo };
}

/** その label のまま `bin/loop-unlisted-issues` に訊く。**exit 1 = 鳴った。** */
function detectorStatus(place: { path: string; repo: string }): number {
  const result = spawnSync(DETECTOR, [], {
    cwd: place.repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${place.path}:${process.env.PATH ?? ""}` },
  });
  return result.status ?? -1;
}

function runBlock(block: string, place: { path: string; repo: string }): void {
  // **穴埋めをそのまま置き換える**（`loop/worker-open-pr-owner-wiring.test.ts` と同じ）
  const body = join(REPO_ROOT, "package.json");
  const filled = block.replaceAll("<Issue番号>", ISSUE).replaceAll("<file>", body);
  const result = spawnSync("bash", ["-c", filled], {
    cwd: place.repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${place.path}:${process.env.PATH ?? ""}` },
  });
  expect(result.status, result.stderr).toBe(0);
}

describe("マージしたのに閉じない Issue の行き先", () => {
  it("手順書のとおりに打つと、どの一覧にも出てこない状態にならない", () => {
    // **完了条件そのもの。** **`Closes` の無い PR がマージされたあと、
    // その Issue が label 0 件で残らないこと**
    const place = workspace(["in-progress"]);
    const { labelsFile } = place;

    runBlock(mergedBlock(), place);

    const labels = readFileSync(labelsFile, "utf8").split("\n").filter(Boolean);
    expect(labels, "着手中のまま残っている").not.toContain("in-progress");
    // **行き先まで見る** (#334 のレビュー)。**「空でない」だけだと、`ready` や
    // `blocked` へ付け替わっても緑になる**——**前者は master の着手順を飛ばし**、
    // **後者は止まっていない Issue を止める**
    expect(labels, "backlog へ戻していない").toContain("backlog");
    expect(detectorStatus(place), "検出器が鳴っている（label が 0 件になった）").toBe(0);
  });

  it("外すだけに戻すと、検出器が鳴る", () => {
    // **試験が測っているのは語ではなく振る舞いである。** **前の手順書は
    // 「`in-progress` を外す」しか言っていなかった**——**その形に戻すと、
    // ここが赤くなる**（3 度とも、それで label が 0 件になった）
    const place = workspace(["in-progress"]);
    const { labelsFile } = place;

    runBlock(`gh issue edit ${ISSUE} --remove-label in-progress`, place);

    expect(readFileSync(labelsFile, "utf8").split("\n").filter(Boolean)).toEqual([]);
    expect(detectorStatus(place), "label が 0 件なのに鳴っていない").toBe(1);
  });

  it("入口確認の記録は、走らせた砂場に残る", () => {
    // **実物の共通 `.git` に書かない** (#338)。**`bin/loop-unlisted-issues` は
    // 冒頭で `bin/loop-lease check` を通す**ので、**cwd を継ぐと実物へ書く**——
    // **上限 20 行の記録が試験の雑音で埋まり、本物の行が押し出される**（#186 / #192）。
    //
    // **見るのは砂場の側である。** **「実物が増えないこと」で測ると、
    // 他の周回が同時に書きうる**——**合否が他人の持ち物で決まる。**
    const place = workspace(["in-progress"]);

    detectorStatus(place);

    expect(
      readdirSync(join(place.repo, ".git")).some(
        (name) => name.startsWith("valence-loop-lease-missing") && !name.endsWith(".lock"),
      ),
      "入口確認の記録が砂場に無い（実物の共通 .git へ書いている）",
    ).toBe(true);
  });

  it("付け替えは 1 回の編集で行う", () => {
    // **外してから足すと、その間に落ちた周回が label 0 件の Issue を残す**
    // ——**この Issue が消しに来た状態を、直した経路自身が作りうる**
    const block = mergedBlock();
    const edits = [...block.matchAll(/gh issue edit/g)];

    expect(edits, "編集が 2 回に割れている").toHaveLength(1);
  });

  it("閉じる判断は master に残っている", () => {
    // **完了条件を読むのは master の仕事**（Issue の「やること」）——
    // **worker が閉じると、完了していない Issue が閉じられる**
    expect(mergedBlock(), "worker が Issue を閉じている").not.toContain("gh issue close");
  });
});
