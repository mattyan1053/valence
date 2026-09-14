/**
 * **送信の戻り値では、届いたかどうか分からない**（#727）。
 *
 * **手順書は 1 回の実測を根拠にしていた**（#293。**`Failed to send` が返り、直後に
 * 同じ宛先で送り直すと通った**）。**そのあと、逆向きの実測が 2 件出ている**
 * （master の作業場、2026-09-14）。
 *
 * - **`Failed to send` が返った 1 通目が、受け手には届いていた**
 *   （**受け手の作業場で数えた**——**loop-worker-1 の transcript に 1 通在る**）
 * - **`success: true` が返ったほうが、「前のメッセージの繰り返し」として
 *   相手の inbox で落とされた**
 *
 * **どちらが起きたかは送信側から見分けられない。** **だから `--sent` を通すかどうかを、
 * 戻り値の「成功／失敗」だけで決められない**——**判断を 1 箇所に置き、
 * そこに「分からない」と書いておく。**
 *
 * ## 語を数えない
 *
 * **`resend-once-wiring.test.ts` が #300 で踏んだ形**である——**語の有無だけを見ると、
 * 向きを反転させても緑になる。** **判定を関数へ出し、実物と変異の両方を食わせる。**
 *
 * **実物の手順書は壊さない**（#186 の形）——**読み取った写しの上で変異させる。**
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const PROCEDURES = [{ role: "master" }, { role: "worker" }] as const;

/** 出口の節。**送る手順が書いてあるのはここだけ**である。 */
function exitSection(role: LoopRole): string {
  return procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
}

/** 空行で区切られた塊。**判断が 1 つに集まっているかを、塊で見る。** */
function blocks(section: string): string[] {
  return section.split(/\n\s*\n/);
}

/** 文に割る。**改行は跨ぐ**（手順書は 1 文を複数行に折り返している）。 */
function sentences(text: string): string[] {
  return text.replace(/\n/g, "").split("。");
}

type SendResultRule = {
  /** **戻り値では届いたか分からない**と言っているか。 */
  saysReturnValueCannotTellDelivery: boolean;
  /** **`Failed to send` でも届いていた**実測が在るか。 */
  keepsFailedButDeliveredEvidence: boolean;
  /** **`success` でも落とされた**実測が在るか。 */
  keepsSucceededButDroppedEvidence: boolean;
  /** **通す側と通さない側が、同じ塊の中で決まっている**か（**判断が 1 箇所**）。 */
  decidesSentInOneBlock: boolean;
  /** **どれも失敗なら通さない**（**分からないときは安い側へ倒す**）か。 */
  leavesSentUnrecordedWhenEverySendFailed: boolean;
};

/**
 * **「通す」と書いてある文だけを当てる。** **「`--sent` を通すかどうか」は見出しの
 * 言い回し**で、**判断そのものではない**——**指しているだけの段落まで「判断がある」と
 * 数えると、変異で 1 行消しても別の段落が身代わりになる**（**実際にそうなった**）。
 */
const PASSES = /`--sent` を通す(?!か)/;
const WITHHOLDS = /`--sent` を通さない/;

function readSendResultRule(section: string): SendResultRule {
  const lines = sentences(section);
  const decision = blocks(section).filter((block) => PASSES.test(block) && WITHHOLDS.test(block));

  return {
    // **「分からない」と書いてあること。** **断定（「1 通目は届いている」）に
    // 直されたら false へ倒れる**
    saysReturnValueCannotTellDelivery: lines.some(
      (line) =>
        /戻り値/.test(line) &&
        /届いた/.test(line) &&
        /分からない|見分けられない/.test(line) &&
        !/分かる(?!ように)/.test(line),
    ),
    keepsFailedButDeliveredEvidence: lines.some(
      (line) => /Failed to send/.test(line) && /届いて/.test(line),
    ),
    keepsSucceededButDroppedEvidence: lines.some(
      (line) => /success/.test(line) && /落と(さ|し)/.test(line),
    ),
    // **通す側と通さない側が同じ塊にあること。** **片方を別の節へ出すと false**
    decidesSentInOneBlock: decision.some(
      (block) =>
        sentences(block).some((line) => /success/.test(line) && PASSES.test(line)) &&
        sentences(block).some((line) => WITHHOLDS.test(line)),
    ),
    leavesSentUnrecordedWhenEverySendFailed: lines.some(
      (line) => /どの宛先|どれも|全部/.test(line) && /--sent/.test(line) && /通さない/.test(line),
    ),
  };
}

const SATISFIED: SendResultRule = {
  saysReturnValueCannotTellDelivery: true,
  keepsFailedButDeliveredEvidence: true,
  keepsSucceededButDroppedEvidence: true,
  decidesSentInOneBlock: true,
  leavesSentUnrecordedWhenEverySendFailed: true,
};

/** **手で書いた変異。** **壊れた形はコードのどこにも残らない**（`AGENTS.md` §5）。 */
const MUTATIONS: {
  name: string;
  apply: (section: string) => string;
  breaks: keyof SendResultRule;
}[] = [
  {
    name: "推論を断定に直す（分からない → 分かる）",
    apply: (section) => section.replace(/届いたかどうかが分からない/g, "1 通目は届いている"),
    breaks: "saysReturnValueCannotTellDelivery",
  },
  {
    name: "`Failed to send` でも届いていた実測を消す",
    apply: (section) => section.replace(/受け手には届いていた/g, "受け手にも渡っていなかった"),
    breaks: "keepsFailedButDeliveredEvidence",
  },
  {
    name: "`success` でも落とされた実測を消す",
    apply: (section) => section.replace(/相手の inbox で落とされた/g, "相手へ渡った"),
    breaks: "keepsSucceededButDroppedEvidence",
  },
  {
    name: "通す側だけを別の節へ出す（判断が 2 箇所になる）",
    apply: (section) => section.replace(/- \*\*1 通でも `success`[\s\S]*?\n(?=- )/, ""),
    breaks: "decidesSentInOneBlock",
  },
  {
    name: "どれも失敗でも通す形に反転させる",
    apply: (section) =>
      section.replace(
        /どの宛先も `Failed to send` だったら `--sent` を通さない/g,
        "どの宛先も `Failed to send` でも `--sent` を通す",
      ),
    breaks: "leavesSentUnrecordedWhenEverySendFailed",
  },
];

describe("送信の戻り値では、届いたかどうか分からない", () => {
  it.each(PROCEDURES)("$role の出口が、条件をすべて満たしている", ({ role }) => {
    expect(readSendResultRule(exitSection(role))).toEqual(SATISFIED);
  });

  describe.each(PROCEDURES)("$role の出口を壊すと落ちる", ({ role }) => {
    it.each(MUTATIONS)("$name", ({ apply, breaks }) => {
      const mutated = apply(exitSection(role));

      expect(mutated, "変異が当たっていない（手順書の文面が変わった）").not.toBe(exitSection(role));
      expect(readSendResultRule(mutated)[breaks], `${breaks} が壊れたと言えていない`).toBe(false);
    });
  });
});
