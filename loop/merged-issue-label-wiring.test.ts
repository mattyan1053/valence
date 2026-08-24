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
      // **番号を指した読み直し**（#487）。**検出器は出す直前にここを読む**
      // ——**索引（`api graphql`）と同じ 1 つの状態から答える**ので、
      // **手順書の 1 行を走らせた結果が、そのまま両方に効く。**
      'if [[ $* == *"issue view"* ]]; then',
      '  cat "$labels_file"',
      "  exit 0",
      "fi",
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

/** ステップ 2.2（自分の `in-progress` を見るところ）。**次の節まで。** */
function resumeSection(): string {
  const text = procedureText("worker");
  const from = text.indexOf("### 2.2");
  expect(from, "ステップ 2.2 が見つからない").toBeGreaterThanOrEqual(0);
  return text.slice(from).split("\n## ")[0] ?? "";
}

describe("PR を出さずに終わった Issue", () => {
  it("畳む道が書いてある", () => {
    // **#489 で踏んだ**（#491）。**「測って、変えないことが結論」で終わる Issue に
    // 畳み方が無く**、**worker は毎周回そこへ入る**——**master が閉じるまで
    // `ready` へ進めない。**
    //
    // **手は 1 つ**である（MERGED の分岐にあるもの）——**写さずに指す**ので、
    // **ここで見るのは「その道が書いてあるか」だけ。**
    const section = resumeSection();

    expect(section, "PR が要らなかった道が無い").toContain("変更が要らなかった");
    expect(section, "畳む手を指していない").toContain("MERGED の分岐と同じ 2 行");
  });

  it("`backlog` に意味が 2 つあることが読める", () => {
    // **`backlog` を避けたのは、「まだ着手していない」だけを読んだから**である
    // ——**「終わったが、閉じるのは master」でも同じ label を使う。**
    // **読み取れないなら、書き足りていない。**
    expect(procedureText("worker"), "backlog の 2 つ目の意味が書かれていない").toContain(
      "終わったが、閉じるのは master",
    );
  });
});

/**
 * **worker が畳むときに足す印**（#492 のレビュー）。**手順書から取り出す**——
 * **写すと、名前を変えた側だけが緑になる。**
 */
function foldMarker(): string {
  const found = [...resumeSection().matchAll(/gh issue edit <Issue番号> --add-label (\S+)/g)].map(
    (match) => match[1] ?? "",
  );

  expect(found, "畳むときに足す印が 1 つに絞れない").toHaveLength(1);
  return found[0] ?? "";
}

/** master の手順で、その label を読む行。**両側を突き合わせるために取り出す。** */
function masterMentions(label: string): string[] {
  return procedureText("master")
    .split("\n")
    .filter((line) => line.includes(label));
}

describe("PR を出さずに終わった Issue を、master が閉じられる", () => {
  it("畳んだ印を、master の昇格が除いている", () => {
    // **`backlog` は昇格の候補**である (#492 のレビュー)——**印が無ければ、master は
    // `ready` へ戻し**、**同じ調査がもう一度取られる。** **書いてあるかではなく、
    // 除く側に同じ名前が入っているか**を見る。
    // **`select(` で探さない**（変異が素通りした）——**閉じる側の行も `select(` を
    // 使う**ので、**除く側を消しても、拾う側の行が当たって緑のまま**だった。
    // **絞る行そのものの目印**（`waiting-condition` を `| not)` で外している）**で探す。**
    const marker = foldMarker();
    const promotion = procedureText("master")
      .split("\n")
      .filter((line) => line.includes("waiting-condition") && line.includes("| not)"));

    expect(promotion, "昇格の候補を絞る行が見つからない").not.toEqual([]);
    expect(promotion.join("\n"), `昇格の候補から ${marker} を除いていない`).toContain(marker);
  });

  it("畳んだ印を、master が閉じる側で読んでいる", () => {
    // **閉じる経路は `bin/loop-close-candidates` だけ**で、**あれは PR 番号を取る**
    // ——**PR の無い完了 Issue を拾う口が要る。**
    const marker = foldMarker();
    const closing = masterMentions(marker).filter((line) => line.includes("gh issue"));

    expect(closing, `${marker} を読んで閉じる道が master に無い`).not.toEqual([]);
  });

  it("印を足しても、どの一覧にも出てくる", () => {
    // **`backlog` は残す**（#325 の検出器は `backlog` / `ready` / `in-progress` /
    // `blocked` のどれかを見る）——**印だけにすると、この検出器が鳴る。**
    const place = workspace(["in-progress"]);

    runBlock(mergedBlock(), place);
    runBlock(`gh issue edit ${ISSUE} --add-label ${foldMarker()}`, place);

    const labels = readFileSync(place.labelsFile, "utf8").split("\n").filter(Boolean);
    expect(labels, "backlog を外している").toContain("backlog");
    expect(labels, "印が付いていない").toContain(foldMarker());
    expect(detectorStatus(place), "検出器が鳴っている").toBe(0);
  });
});

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
