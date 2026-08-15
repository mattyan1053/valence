/**
 * **`worker` へ渡すときは、空いている側に届くまで決める**（#302 / #303 のレビュー）。
 *
 * **`bin/loop-handoff` が返すのは役名（`worker`）だけ**で、**どの作業場が空いているかは
 * 出てこない。** **出口が `ListAgents` から 1 つ選んで送ると、塞がっているほうを
 * 選んだ周回は目的を果たさない**——**手が 2 本なら確率は半分**である。
 *
 * **そこから先に逃げ道が無い。** **受け取った worker は自分の作業を続け、その出口では
 * 自己通知が抑止される**ので**空いている側へ回らず**、**送った側には指紋が残る**ので
 * **同じ状態で 2 通目が出ない**——**空いている worker は次の cron まで起きない。**
 *
 * **測るのは文面である。** **送るのはエージェントの操作**で、`bin/loop-handoff` は
 * 「送るべきか」と「送ったか」しか持っていない（#293 と同じ理由）。
 *
 * **語を数えない**（#300 のレビュー）。**判定を関数へ出し、実物と、手で書いた変異の
 * 両方を食わせる。** **実物の手順書は壊さない**——**配られている手順書を書き換えると、
 * 走っている周回と競る**（#186 の形）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROCEDURES = [{ role: "master" }, { role: "worker" }] as const;

/** 出口の節。**送る手順が書いてあるのはここだけ**である。 */
function exitSection(role: LoopRole): string {
  const doc = procedureText(role);
  return doc.split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
}

/** 文に割る。**改行は跨ぐ**（手順書は 1 文を複数行に折り返している）。 */
function sentences(section: string): string[] {
  return section.replace(/\n/g, "").split("。");
}

type FanoutRule = {
  /** **`worker` へ渡すときは、出ている worker 全員へ送る**と読めるか。 */
  sendsToEveryWorkerSession: boolean;
  /** **1 つ選んで送る形になっていない**か。 */
  doesNotPickOneSession: boolean;
};

/**
 * 出口の節を読んで、**宛先の決め方**を返す。
 *
 * **語の有無ではなく、1 文の中で「worker」「全員」「送る」が揃うことを見る**
 * ——**別々の文に散らばっていると、片方を反転させても気づけない。**
 */
function readFanoutRule(section: string): FanoutRule {
  const lines = sentences(section);

  return {
    sendsToEveryWorkerSession: lines.some(
      (line) => /worker/.test(line) && /全員|すべて|全部/.test(line) && /送/.test(line),
    ),
    // **「1 つ / 1 人だけ選んで送る」が無いこと。** **足されたら崩れる**
    doesNotPickOneSession: !lines.some((line) =>
      /(1 つ|1 人|どれか|いちばん上)[^。]*選[^。]*送/.test(line),
    ),
  };
}

const SATISFIED: FanoutRule = {
  sendsToEveryWorkerSession: true,
  doesNotPickOneSession: true,
};

/**
 * **手で書いた変異。** **実物を壊さず、読み取った写しの上で当てる。**
 */
const MUTATIONS: {
  name: string;
  apply: (section: string) => string;
  breaks: keyof FanoutRule;
}[] = [
  {
    name: "宛先の決め方を書いた段落を消す",
    apply: (section) =>
      section
        .split(/\n\s*\n/)
        .filter((block) => !(/worker/.test(block) && /全員|すべて|全部/.test(block)))
        .join("\n\n"),
    breaks: "sendsToEveryWorkerSession",
  },
  {
    name: "1 つ選んで送る形にする",
    apply: (section) =>
      section.replace(
        /worker のセッション\*\*全員\*\*へ送る/g,
        "worker のセッションから **1 つ選んで**送る",
      ),
    breaks: "sendsToEveryWorkerSession",
  },
  {
    name: "「どれか 1 つを選んで送る」を足す",
    apply: (section) => `${section}\n\n**混んでいるときは、どれか 1 つを選んで送ればよい。**\n`,
    breaks: "doesNotPickOneSession",
  },
];

describe("worker へ渡すときは、空いている側に届くまで決める", () => {
  it.each(PROCEDURES)("$role の出口が、条件をすべて満たしている", ({ role }) => {
    expect(readFanoutRule(exitSection(role))).toEqual(SATISFIED);
  });

  describe.each(PROCEDURES)("$role の出口を壊すと落ちる", ({ role }) => {
    it.each(MUTATIONS)("$name", ({ apply, breaks }) => {
      const mutated = apply(exitSection(role));

      // **変異が当たっていること。** **置換が空振りすると、緑のまま何も試していない**
      expect(mutated, "変異が当たっていない（手順書の文面が変わった）").not.toBe(exitSection(role));
      expect(readFanoutRule(mutated)[breaks], `${breaks} が壊れたと言えていない`).toBe(false);
    });
  });
});
