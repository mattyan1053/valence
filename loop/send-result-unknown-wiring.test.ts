/**
 * **送信の戻り値では、届いたかどうか分からない**（#727）。
 *
 * **手順書は 1 回の実測を根拠にしていた**（#293。**`Failed to send` が返り、直後に
 * 同じ宛先で送り直すと通った**）。**そのあと、逆向きの実測が 3 件出ている**
 * （2026-09-14）。
 *
 * - **`Failed to send` が返った 1 通目が、受け手には届いていた**
 *   （**受け手の作業場で数えた**——**transcript に配送が 1 通在る**）
 * - **`success: true` が返ったほうが、「前のメッセージの繰り返し」として
 *   相手の inbox で落とされた**
 * - **送り直しが必ず落とされるわけでもない**——**同じ本文が 31 秒あいて 2 通届いた回**
 *   （**これも受け手の作業場で数えた**）
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
 * **肯定のまま文が終わるものだけを当てる**（#730 のレビュー 1 周目 / 2 周目）。
 *
 * **語の有無で見ると、打ち消しが素通りする**——**「通さないとは限らない」
 * 「届いていなかった」「落とされなかった」「分からないとは限らない」は、
 * どれも守りたい語をそのまま含んだまま、意味だけを反転させる。**
 *
 * **この口の判定は、全部この形で建てる** (#730 のレビュー 2 周目)。
 * **1 つ直して残りを語のままにすると、同じ穴が次の周回でもう 1 つ出てくる**
 * ——**指摘は 3 件だったが、終端で絞っていなかった判定がちょうど 3 つだった。**
 *
 * **終端で絞ると、指しているだけの言い回しも外れる**——**「`--sent` を通すかどうか」は
 * 見出しの言い方**で、**判断そのものではない。** **以前はこれが身代わりになり、
 * 「通す側だけを別の節へ出す」変異が緑へ戻った**（**実際にそうなった**）。
 *
 * **言い回しを変えると赤くなる。** **それでよい**——**意味が変わっていないかを、
 * 人がそこで見る**（`AGENTS.md` §4）。
 */
function ends(phrase: string): RegExp {
  return new RegExp(`${phrase}[*\\s]*$`);
}

/** **結論**: 届いたかどうかは分からない。 */
const CANNOT_TELL = ends("(?:分からない|見分けられない)");
/** **実測**: `Failed to send` でも届いていた。 */
const DELIVERED = ends("届いていた");
/** **実測**: `success` でも落とされた。 */
const DROPPED = ends("落とされた");
/** **判断**: `--sent` を通す。 */
const PASSES = ends("`--sent` を通す");
/** **判断**: `--sent` を通さない。 */
const WITHHOLDS = ends("`--sent` を通さない");

/**
 * 判断そのものが書いてある塊。**「通す」と「通さない」が揃っている塊を数える**
 * ——**`decision.length === 1` まで見る**（#730 のレビュー。**`some` は「少なくとも
 * 1 つ」で、「1 箇所」ではない**）。
 */
function decisionBlocks(section: string): string[] {
  return blocks(section).filter((block) => {
    const lines = sentences(block);

    return lines.some((line) => PASSES.test(line)) && lines.some((line) => WITHHOLDS.test(line));
  });
}

function readSendResultRule(section: string): SendResultRule {
  const lines = sentences(section);
  const decision = decisionBlocks(section);
  const only = decision.length === 1 ? decision[0] : undefined;

  return {
    saysReturnValueCannotTellDelivery: lines.some(
      (line) => /戻り値/.test(line) && /届いた/.test(line) && CANNOT_TELL.test(line),
    ),
    keepsFailedButDeliveredEvidence: lines.some(
      (line) => /`Failed to send`/.test(line) && DELIVERED.test(line),
    ),
    keepsSucceededButDroppedEvidence: lines.some(
      (line) => /`success`/.test(line) && DROPPED.test(line),
    ),
    // **通す側と通さない側が、ただ 1 つの塊で決まっていること。**
    // **片方を別の節へ出しても、塊ごと複製しても false**
    decidesSentInOneBlock:
      only !== undefined &&
      sentences(only).some((line) => /`success`/.test(line) && PASSES.test(line)),
    // **守りたいのは「どれも失敗したとき」**である——**全称だけでなく、
    // その条件（`Failed to send`）まで同じ文で照合する** (#730 のレビュー 2 周目)
    leavesSentUnrecordedWhenEverySendFailed: lines.some(
      (line) =>
        /どの宛先|どれも|全部/.test(line) && /`Failed to send`/.test(line) && WITHHOLDS.test(line),
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
  {
    // **規則を打ち消しても、語はそのまま残る**（#730 のレビュー）——**`通さない` の
    // 有無だけを見ると、**いちばん自然な反転**が素通りする。
    name: "規則を打ち消す（通さないとは限らない）",
    apply: (section) =>
      section.replace(/(`Failed to send` だったら `--sent` を通さない)\*\*/g, "$1とは限らない**"),
    breaks: "leavesSentUnrecordedWhenEverySendFailed",
  },
  {
    // **打ち消しは、守りたい語をそのまま含む**（#730 のレビュー 2 周目）
    // ——**下の 3 つは、どれも「語が在るか」しか見ていなかった側**である。
    name: "結論を打ち消す（分からないとは限らない）",
    apply: (section) =>
      section.replace(/届いたかどうかが分からない/g, "届いたかどうかが分からないとは限らない"),
    breaks: "saysReturnValueCannotTellDelivery",
  },
  {
    name: "実測を打ち消す（届いていなかった）",
    apply: (section) => section.replace(/受け手には届いていた/g, "受け手には届いていなかった"),
    breaks: "keepsFailedButDeliveredEvidence",
  },
  {
    name: "実測を打ち消す（落とされなかった）",
    apply: (section) =>
      section.replace(/相手の inbox で落とされた/g, "相手の inbox で落とされなかった"),
    breaks: "keepsSucceededButDroppedEvidence",
  },
  {
    // **終端を絞っても、条件を見ていなければ通る**——**守りたいのは
    // 「どれも失敗したとき」**であって、**「どの宛先も」で終わる文**ではない。
    name: "条件を入れ替える（どの宛先も success だったら通さない）",
    apply: (section) =>
      section.replace(/どの宛先も `Failed to send` だったら/g, "どの宛先も `success` だったら"),
    breaks: "leavesSentUnrecordedWhenEverySendFailed",
  },
  {
    // **`some` は「1 箇所」を測らない**（#730 のレビュー）——**同じ判断を別の塊へ
    // 増やしても、元が残っていれば緑**である。**#727 が求めたのは「1 箇所にある」**。
    name: "判断の塊を別の場所へ複製する",
    apply: (section) => {
      const decision = blocks(section).find((block) => /1 通でも `success`/.test(block));

      return decision === undefined ? section : `${section}\n\n${decision}`;
    },
    breaks: "decidesSentInOneBlock",
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
