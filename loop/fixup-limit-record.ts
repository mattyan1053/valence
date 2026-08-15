/**
 * 手直しの上限の根拠として、`bin/loop-gate` のコメントに置いた実例の記録。
 *
 * **正は `bin/loop-gate` のコメント 1 箇所**である（#242。**手順書と 2 箇所に書かない**）。
 * ここにあるのは**読み方**だけで、**値も列の意味もあちらが持っている。**
 *
 * **読む側が 2 つある**（形を見る試験と、**実際に測り直して突き合わせる側**）ので、
 * **読み方を写さずに 1 つにしてある**——**書式は両方向に壊れる**（`AGENTS.md` §5）ので、
 * **列を足した日に、片方だけ古い読み方で解釈するのを避ける。**
 */

/** 記録の 1 行。列の意味は `bin/loop-gate` のコメントにある。 */
export type Example = {
  pr: string;
  /** `bin/loop-fixup-lines` の 3 列（数える行 / 除外したテスト追加行 / 除外した要求ぶん）。 */
  measured: [string, string, string];
  reviewed: string;
  head: string;
  verdict: string;
  merge: string;
};

/** 記録を囲む目印（**`bin/loop-fixup-basis` の `sed` と同じものを見る**）。 */
export const EXAMPLES_START = "---8<--- いまの数え方で測った実例 ---";
export const EXAMPLES_END = "---8<--- ここまで ---";

/** `bin/loop-gate` の中身から、記録した実例を列のまま取り出す。 */
export function readExamples(gate: string): Example[] {
  const body = gate.split(EXAMPLES_START)[1]?.split(EXAMPLES_END)[0] ?? "";
  return body
    .split("\n")
    .map((line) => line.replace(/^#\s?/, "").trim())
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const [
        pr = "",
        counted = "",
        tests = "",
        requested = "",
        reviewed = "",
        head = "",
        verdict = "",
        merge = "",
      ] = line.split("\t");
      return { pr, measured: [counted, tests, requested], reviewed, head, verdict, merge };
    });
}
