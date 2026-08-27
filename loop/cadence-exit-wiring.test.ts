/**
 * **予定表が空になったことを、手順で見つける**（#530）。
 *
 * **1 日に 3 回踏み、3 回とも誰かの気まぐれで見つかった**——**`bin/loop-cadence` は
 * 正しく読んでいた**（#498 / #500 で 4 通りに割ってある）**が、打つ手順が無かった。**
 *
 * **両方の役の出口に置く。** **master が止まっているときは master が読めない**
 * ——**実際にそうなった日がある**（**worker 側が見つけた**）。
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const ROLES: LoopRole[] = ["worker", "master"];

/** その役の「周回の出口」。**次の見出しまで。** */
function exitSection(role: LoopRole): string {
  const text = procedureText(role);
  // **見出しで切る** (`AGENTS.md` §4)——**本文にも「周回の出口」は出てくる**
  // （**「通知は出口で送る（「周回の出口」を参照）」**）。**そこで切ると、
  // 節に届く前に終わる**（**実際に踏んだ**）。
  const from = text.indexOf("### 周回の出口");
  expect(from, `${role} の出口が見つからない`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from);
  const end = rest.slice(1).search(/\n#{2,4} /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/**
 * **その語が節にちょうど 1 回だけ出ることを見る**（`AGENTS.md` §4）。
 *
 * **`toContain` では足りない**——**この節は理由を厚く書く**ので、**指示の行を
 * 消しても、説明の散文に当たって緑になる**（**実際にそうなっていた**：
 * **「他の役なら、突く」を消しても、次の行の「できるのは突くことだけ」に当たった**）。
 * **1 回しか出ない語を選び、その 1 回を数える**——**指示を消せば 0 になる。**
 */
function expectOnce(section: string, phrase: string, role: LoopRole): void {
  expect(section.split(phrase).length - 1, `${role} の出口で「${phrase}」が 1 回ではない`).toBe(1);
}

describe("周回の出口が、予定表を見ている", () => {
  for (const role of ROLES) {
    it(`${role} の出口が、止まっている行だけを引く`, () => {
      // **平常時に鳴る検査は、そのうち読まれなくなる**（#248）——**`--quiet` で引く。**
      // **絞りはスクリプトが持つ**ので、**ここで `grep` しない**（`AGENTS.md` §5）。
      expect(exitSection(role), "出口で予定表を見ていない").toContain("bin/loop-cadence --quiet");
    });

    it(`${role} は、止まっていたときに何をするかを持っている`, () => {
      // **見つけるだけでは終わらない**——**自分のぶんは確かめて直し、他は突く。**
      // **他のセッションの予定表は入れ直せない**ので、**そこを取り違えない。**
      const section = exitSection(role);

      expectOnce(section, "CronList", role);
      expectOnce(section, "突く", role);
    });

    it(`${role} は、止まっている作業場を役で分けていない`, () => {
      // **worker は何人居てもよい**（入口 1.0）——**「他の役なら」で分けると、
      // 別の worker の行はどちらの分岐にも当たらない**（`workspace=` は自分のもの
      // ではなく、役は同じ `worker` である）。**分けるのは作業場である。**
      const section = exitSection(role);

      expectOnce(section, "自分の作業場なら", role);
      expectOnce(section, "自分の作業場でないなら", role);
    });

    it(`${role} は、突くことを引き継ぎと切り離している`, () => {
      // **`bin/loop-handoff` は、渡すものが無ければ exit 1 で「送らない」**——
      // **そこへ添えると決めると、止まっている作業場を見つけた周回が黙る。**
      // **止まっているかどうかは、渡すものの有無と関係がない。**
      expectOnce(exitSection(role), "引き継ぎではない", role);
    });
  }
});
