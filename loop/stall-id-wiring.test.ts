import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 手順書が実際に打つ停止識別子。
 *
 * **引用符の有無で取りこぼさない。** 手順書は `bin/loop-stall "…"` とも
 * `bin/loop-stall pr-lookup-failed` とも書く——**片方だけ見ると、
 * 打っているのに「誰も打たない」に見える**
 */
const STALL_CALL = /bin\/loop-stall (?:"([^"]+)"|([a-z][\w:<>-]*))/g;

function identifiersIn(role: LoopRole): string[] {
  return [...procedureText(role).matchAll(STALL_CALL)].map((match) => match[1] ?? match[2] ?? "");
}

/** 節ごとに、そこで打つ識別子を並べる。**絞らずに全部出す**（列挙が主題である）。 */
function identifiersWithSection(role: LoopRole): [string, string][] {
  const pairs: [string, string][] = [];
  let section = "";
  for (const line of procedureText(role).split("\n")) {
    if (/^#{2,4} /.test(line)) {
      section = line.trim();
    }
    const found = new RegExp(STALL_CALL.source).exec(line);
    const id = found?.[1] ?? found?.[2];
    if (id !== undefined) {
      pairs.push([section, id]);
    }
  }
  return pairs;
}

/** `bin/loop-stall --list` が持つ書式（一覧の正）。 */
function listedSpecs(): string[] {
  return execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.trim().split(/\s+/)[0] ?? "");
}

/**
 * **1 つの状態に、1 つの名前。**
 *
 * 第 4 層は**文字列一致**で数えるので、**識別子が揺れた時点で沈黙する**——
 * **呼ぶべきときに呼ばない**（#128）。実測では、**同じ膠着に 2 周続けて別の名前**が
 * 当たった。**変わったのは状態ではなく、master が label を付けたこと**である。
 */
describe("停止識別子", () => {
  it("master の操作で名前が変わる組み合わせが残っていない", () => {
    // **`changes-requested` は「待っている状態の性質」ではなく、
    // 「master がその周回までに何をしたか」**である。**同じ「worker の対応待ち」に
    // 2 つの名前があると、label を付けた瞬間に別状態として数え直される**。
    //
    // **選び方を自動化しても、選ぶ対象が 2 つあることは変わらない**——
    // **名前を 1 つにすれば、そもそも割れない**
    const specs = listedSpecs().map((spec) => spec.split(":")[0]);

    expect(specs, "worker の対応待ちに 2 つの名前がある").not.toContain("changes-requested");
    expect(specs, "worker の対応待ちに 2 つの名前がある").not.toContain("blocking-findings");
    expect(specs, "worker の対応待ちを表す名前が無い").toContain("awaiting-worker");
  });

  it("手順書は、一覧にある識別子だけを打つ", () => {
    // **綴りが 1 文字違うだけで、別状態として数え直される**（3 周続いても止まらない）
    const specs = new Set(listedSpecs());
    const used = [...identifiersIn("master"), ...identifiersIn("worker")];

    expect(used.filter((id) => !specs.has(id))).toEqual([]);
  });

  it("どの節で何を打つかを、列挙して突き合わせる", () => {
    // **絞ってから見ない。** 前の版は `awaiting-worker` で始まるものだけを集めてから
    // 「1 つか」を見ていたので、**別の名前へ変えたものは集合から抜けるだけ**で、
    // **残ったぶんで両方の条件が満たされた**——**割れたことを、割れた側を見ずに
    // 判定していた**。**この PR が塞ごうとしている壊れ方そのもの**である。
    //
    // **列挙すれば、書く人がここで必ず立ち止まる。** 主体（worker / 人 / Codex）が
    // 違うものを同じ名前で打っていないかも、並べれば目に入る——
    // **`awaiting-worker` は `WORKER_FIXES` に入る**ので、**worker が解けない状態に
    // 打つと、worker の周回が動いている間ずっと数えられない**。
    expect(identifiersWithSection("master")).toEqual([
      // **配られた手順書がディスクより古い**（#241 / #243）。**入口の `acquire` が受ける**
      ["### 1.0 同じ役の周回が走っていないか確かめる", "procedure-stale"],
      ["### 1.0 同じ役の周回が走っていないか確かめる", "wrong-worktree"],
      ["### 1.1 手順とスクリプトを最新にする", "main-sync-failed"],
      // **1 つは散文、1 つはブロックの中**（先に変数へ受ける形。#136）——
      // **同じ状態を 2 度書いているのではなく、読む場所と打つ場所**である
      ["## 2. open PR を見て、見る順番を決める", "pr-lookup-failed"],
      ["## 2. open PR を見て、見る順番を決める", "pr-lookup-failed"],
      // **保留の一覧**（#70。ここが 0 件に化けると、外の著者の保留が永久に残る）
      ["## 2. open PR を見て、見る順番を決める", "pr-lookup-failed"],
      // **ずれたときの行き先は、ここに 1 つだけ置く**（各所に書き写さない。#145）。
      // **主体が違うので名前も分ける**——動かすのは worker、読めない原因は
      // gh / 認証 / GitHub で、**後者は worker が何周まわしても解けない**
      ["### 3.1 ゲート", "head-moved:<PR番号>"],
      ["### 3.1 ゲート", "head-lookup-failed:<PR番号>"],
      ["### exit 0 — マージする", "merge-failed:<PR番号>@<SHA>"],
      ["### exit 0 — マージする", "merge-failed:<PR番号>@<SHA>"],
      // **マージした後の取り直し**（#226 のレビュー）。**生の fetch だと、落ちても
      // 次の行が走り、古い `FETCH_HEAD` と比べて「変わっていない」と答える**
      // ——**正常な答えの顔をしているので、赤くならないまま古い手順で進む**
      ["### exit 0 — マージする", "main-sync-failed"],
      ["### exit 1 — 何が足りないかで分ける", "deferred-overflow"],
      // **CI が決着しないまま予算を超えた**（#206）。**worker には渡さない**——
      // **`conclusion` が出ないまま止まるのは GitHub 側の状態**で、
      // **PR に足すもので直る保証が無い**（**実測でも、直したのは人の `gh run rerun`**）。
      // **`awaiting-worker` にすると、worker の周回が動いている間ずっと数えられない**
      ["#### 予算を超えたとき", "ci-pending:<PR番号>@<SHA>"],
      // **「決着しない」と「そもそも作られていない」は別の状態**（#297）。
      // **予算は「始まった時刻」から測る**ので、**始まっていないものは永久に
      // 超えない**——**混ぜると、原因の違う 2 つが 1 つのカウンタで 3 周に届く**
      ["#### 1 件も作られていないとき", "ci-missing:<PR番号>@<SHA>"],
      // **4 つあるのは、経路が 4 つあるため**（#70）——**理由を投稿できなかった**・
      // **保留にした head を記録できなかった**・**保留の失敗**・
      // **ループのアカウント（または読めない）**。
      // **ループの外の著者を待つ経路だけが、ここを通らない**
      ["### 要求が満たされたか確かめる（`changes-requested`）", "awaiting-worker:<PR番号>@<SHA>"],
      ["### 要求が満たされたか確かめる（`changes-requested`）", "awaiting-worker:<PR番号>@<SHA>"],
      ["### 要求が満たされたか確かめる（`changes-requested`）", "awaiting-worker:<PR番号>@<SHA>"],
      ["### 要求が満たされたか確かめる（`changes-requested`）", "awaiting-worker:<PR番号>@<SHA>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-unanswered:<PR番号>@<SHA>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      ["### exit 2 — 設定か使い方の誤り", "gate-misconfigured:<PR番号>"],
      // 上と同じ 4 つの経路（#70）
      ["#### rework — worker へ差し戻す", "awaiting-worker:<PR番号>@<SHA>"],
      ["#### rework — worker へ差し戻す", "awaiting-worker:<PR番号>@<SHA>"],
      ["#### rework — worker へ差し戻す", "awaiting-worker:<PR番号>@<SHA>"],
      ["#### rework — worker へ差し戻す", "awaiting-worker:<PR番号>@<SHA>"],
      // **人を呼ぶ側は worker 待ちではない。** triage が `human` を返した状態は
      // **worker には解けない**——`bin/loop-stall` 自身が
      // 「**主体が違うものに worker の周回を効かせない**」と書いている
      // （`awaiting-worker` は `WORKER_FIXES` に入るので、**worker の周回が動いている
      // 間ずっと数えられない**）。**2 つあるのは、保留の失敗と投稿の失敗で経路が違う**ため
      // **3 つあるのは、経路が 3 つあるため**——**記録を消せなかった**（#70 の保留と
      // 同じ label を使うので、**古い記録が残ると人待ちが自動で外れる**）・
      // **保留の失敗**・**理由の投稿の失敗**
      ["#### human — 人を呼ぶ", "review-exhausted:<PR番号>@<SHA>"],
      ["#### human — 人を呼ぶ", "review-exhausted:<PR番号>@<SHA>"],
      ["#### human — 人を呼ぶ", "review-exhausted:<PR番号>@<SHA>"],
      ["#### defer — Issue へ外出ししてマージする", "deferred-overflow"],
      ["## 6. 着手順を決める（`ready` を 2 件までに保つ）", "issue-lookup-failed"],
      ["## 6. 着手順を決める（`ready` を 2 件までに保つ）", "issue-lookup-failed"],
      // **保留した PR の一覧も、落ちたら止める**——**0 件と読むと `in-progress` を
      // 引きすぎず、次の 1 件を `ready` へ昇格させられない**（worker が止まる）
      ["## 6. 着手順を決める（`ready` を 2 件までに保つ）", "pr-lookup-failed"],
      ["## 6. 着手順を決める（`ready` を 2 件までに保つ）", "too-many-ready:<件数>"],
      ["### 作業が尽きたとき", "no-work"],
      ["### 周回の出口", "claim-mismatch:<Issue番号>"],
      // **着手したまま実装が出ていない**（#264）。**どの検査も健全と答える状態**なので、
      // **何もしなかった周回も必ず通るここで見る**（`audit` と同じ理由）。
      // **一覧を読めなかったときと、状態そのものは分ける**——**前者は master の観測が
      // 落ちた**ので、**「動いている」とも「止まっている」とも言えない**
      ["### 周回の出口", "implementation-stalled:<Issue番号>"],
      // **測れないほうは、別の名前で数える**（#281 のレビュー）。**`take` が label を
      // 付けた直後に落ちた形**で、**尽きた worker とは人がやることが違う**
      ["### 周回の出口", "claim-record-missing:<Issue番号>"],
      ["### 周回の出口", "issue-lookup-failed"],
      // **push されたのに PR が無いブランチ**（#148）。**救うか捨てるかは
      // ループでは判定できない**ので**人へ渡す**——**消し残りはここで数えない**
      // （そちらは master がその周回で消せる。**同じ名前にすると、消せるものが人を呼ぶ**）
      // **2 つあるのは、人へ渡す種類が 2 つあるため**（#177）——**PR が 1 件も無い**
      // （`no-pr`）と、**終わった PR の先に積まれている**（`beyond-pr`）。
      // **どちらも「救うか捨てるかは中身を見ないと決まらない」**ので、同じ名前で数える
      ["### 周回の出口", "stray-branch:<ブランチ>"],
      ["### 周回の出口", "stray-branch:<ブランチ>"],
      ["### 周回の出口", "handoff-mismatch:<PR番号>"],
    ]);
  });

  it("一覧にあるのに、誰も打たない識別子が無い", () => {
    // **打つ場所が消えても、一覧だけが残る**（#162 で `review-exhausted` の分岐が
    // 括弧書きへ落ち、**いつ使うのかが消えた**）。**一覧は「使える識別子」の正**なので、
    // **誰も打たないものが混ざると、読む人は「まだ使うのだろう」と思う**
    const used = new Set([...identifiersIn("master"), ...identifiersIn("worker")]);
    // **`used` に worker のぶんは既に入っている。** 同じものをもう一度除いても
    // **後半は常に true** で、**「worker 側も見ている」ように読めるぶん、
    // 次に触る人が二重に守られていると思う**（#164 のレビューで見送ったもの）
    const unused = listedSpecs().filter((spec) => !used.has(spec));

    expect(unused, "打つ場所が無い識別子が一覧に残っている").toEqual([]);
  });
});

describe("止められなかったときの終了コード", () => {
  // **手順書は「exit 1 → 全ループが停止済み」と読ませる** (#191 のレビュー)。
  // **止められなかったときに同じ値を返すと、その行が嘘になる**——
  // **読む側（master / worker の手順）は標準エラーではなく終了コードで分岐する。**
  //
  // **スクリプトだけ直しても契約にならない。** **値を書き写さず、本物に返させて、
  // その値が両方の手順書に載っていることを見る。**

  /** 止められない `task` を持つ使い捨てリポジトリで、上限まで走らせたときの終了コード。 */
  function statusWhenStopFails(): number {
    const repo = mkdtempSync(join(tmpdir(), "loop-stall-exit-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    mkdirSync(join(repo, "bin"));
    copyFileSync(join(REPO_ROOT, "bin", "loop-stall"), join(repo, "bin", "loop-stall"));
    // **`bin/loop-lease` も要る** (#239)。**カウンタを分ける単位を持っている**
    copyFileSync(join(REPO_ROOT, "bin", "loop-lease"), join(repo, "bin", "loop-lease"));
    chmodSync(join(repo, "bin", "loop-lease"), 0o755);
    chmodSync(join(repo, "bin", "loop-stall"), 0o755);
    writeFileSync(
      join(repo, "task"),
      '#!/usr/bin/env bash\nif [[ $1 == "loop:stop" ]]; then exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    let result = spawnSync(join(repo, "bin", "loop-stall"), ["dirty"], {
      cwd: repo,
      encoding: "utf8",
    });
    for (let index = 0; index < 2; index += 1) {
      result = spawnSync(join(repo, "bin", "loop-stall"), ["dirty"], {
        cwd: repo,
        encoding: "utf8",
      });
    }
    rmSync(repo, { recursive: true, force: true });
    return result.status ?? -1;
  }

  it("止まった／止まらなかったで、値が違う", () => {
    // **同じ値だと、読む側は区別できない**——**標準エラーは分岐に使われない**
    expect([0, 1, 2]).not.toContain(statusWhenStopFails());
  });

  it("その値が、両方の手順書に載っている", () => {
    // **スクリプトだけ直すと「入れたが誰も見ていない」**になる。
    // **値は写さず、本物に返させたものを探す**
    const status = statusWhenStopFails();

    for (const role of ["master", "worker"] as const) {
      expect(procedureText(role), `${role} に exit ${status} が無い`).toContain(
        `- exit ${status} →`,
      );
    }
  });
});
