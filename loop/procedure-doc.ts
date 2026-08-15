/**
 * **手順書は、入口と本体に分かれている**（#319）。
 *
 * `/loop <間隔> /loop-worker` は**登録した時点の本文を cron で再生する**ので、
 * **手順書を直すたびに、走っているセッションの本文が古くなる**——
 * **実測で 1 日 5 回、版ずれで周回が捨てられた。** **入口だけを運ばせ、
 * 本体は毎周回ディスクから読む**ことで、**運ばれる本文が変わる頻度を下げる。**
 *
 * **読む側は、1 つの手順として見たい。** **どの節がどちらのファイルに載っているかは
 * 移し替えのたびに変わる**ので、**試験がパスを直接書くと、移すたびに全部書き換わる**
 * ——**置き場所を知っているのはここ 1 つ**にする。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export type LoopRole = "master" | "worker";

/**
 * 役ごとの、手順書を構成するファイル（**読む順**）。
 *
 * **master はまだ移していない**ので入口だけである。**移したら、ここへ本体を足す**
 * ——**分岐ではなく一覧にしてあるのは、「まだ移していない」を条件文で表すと、
 * 移し終えたあとも残るから**である。
 */
const PARTS: Record<LoopRole, readonly string[]> = {
  master: [".claude/commands/loop-master.md"],
  worker: [".claude/commands/loop-worker.md", "loop/procedure/worker.md"],
};

/** その役が 1 周で読むものを、続けて 1 つの文書として返す。 */
export function procedureText(role: LoopRole): string {
  return PARTS[role].map((path) => readFileSync(join(REPO_ROOT, path), "utf8")).join("\n");
}
