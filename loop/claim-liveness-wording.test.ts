/**
 * **手順書が、引き継ぎの判定と同じことを言っていること**（#306 のレビュー）。
 *
 * **`bin/loop-claim pr` は `bin/loop-lease alive` へ寄せた**ので、**周回の印の窓の
 * 内側なら「寝ているだけ」と分かる**——**見分けたうえで取らない。** **それなのに
 * ステップ 2.1 は「寝ているのと落ちたのは区別が付かないので、見分けようとしない」
 * と書いたままだった。**
 *
 * **worker はこの本文を読んで判断する。** **実装は取らない、手順書は「見分けるな」**
 * では、**次に読んだ者がどちらに従えばよいか分からない。**
 *
 * **この PR で 2 回目である**——**1 回目は `bin/loop-claim` の「解放は要らない。
 * 記録は期限で切れる」**だった。**判定を変えたとき、その判定について書いてあるものを
 * 全部数えていない**（`AGENTS.md` §5「変えた側ではなく残る側を数える」）。
 * **`busy` → `alive` の diff に、この段落は出てこない。**
 *
 * **語を数えない**（#300 のレビュー）。**判定を関数へ出し、実物と、手で書いた変異の
 * 両方を食わせる。** **実物の手順書は壊さない**——**読み取った写しの上で変異させる。**
 */

import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

/**
 * 引き継ぎの持ち主について書いてある節（ステップ 2.1）。
 *
 * **入口と本体のどちらに載っているかを、ここでは決めない** (#319)——
 * **節を移すたびにパスを書き換えることになる。** **置き場所は
 * `loop/procedure-doc.ts` が 1 つだけ知っている。**
 */
function ownershipSection(): string {
  return procedureText("worker").split("### 2.1 master へ知らせる")[1]?.split("\n### ")[0] ?? "";
}

/** 文に割る。**改行は跨ぐ**（手順書は 1 文を複数行に折り返している）。 */
function sentences(text: string): string[] {
  return text.replace(/\n/g, "").split("。");
}

type LivenessWording = {
  /** **見分けたうえで取らない**、と読めるか。 */
  tellsSleepingFromDead: boolean;
  /** **「見分けようとしない」が残っていない**か。 */
  doesNotSayItCannotTell: boolean;
  /** **窓を過ぎたら引き継げる**（「必ず誰かが拾う」）と読めるか。 */
  keepsHandoverAfterWindow: boolean;
};

/**
 * 節を読んで、**引き継ぎの生死について何を言っているか**を返す。
 *
 * **一致させるのは 1 文の中**である——**別々の文に散らばっていると、片方を反転させても
 * 気づけない。**
 */
function readLivenessWording(section: string): LivenessWording {
  const lines = sentences(section);

  return {
    tellsSleepingFromDead: lines.some(
      (line) => /寝てい|周回の印|窓/.test(line) && /見分け|引き継がない|取らない/.test(line),
    ),
    doesNotSayItCannotTell: !lines.some((line) => /区別が付かない|見分けようとしない/.test(line)),
    keepsHandoverAfterWindow: lines.some(
      (line) => /窓/.test(line) && /過ぎ/.test(line) && /引き継/.test(line),
    ),
  };
}

const SATISFIED: LivenessWording = {
  tellsSleepingFromDead: true,
  doesNotSayItCannotTell: true,
  keepsHandoverAfterWindow: true,
};

/** **手で書いた変異。** **実物を壊さず、読み取った写しの上で当てる。** */
const MUTATIONS: {
  name: string;
  apply: (section: string) => string;
  breaks: keyof LivenessWording;
}[] = [
  {
    name: "「見分けようとしない」を書き戻す",
    apply: (section) =>
      `${section}\n\n**寝ているのと落ちたのは区別が付かない**ので、**見分けようとしない。**\n`,
    breaks: "doesNotSayItCannotTell",
  },
  {
    name: "窓を過ぎたら引き継ぐ、を消す",
    apply: (section) =>
      section
        .split(/\n\s*\n/)
        .filter((block) => !(/窓/.test(block) && /過ぎ/.test(block) && /引き継/.test(block)))
        .join("\n\n"),
    breaks: "keepsHandoverAfterWindow",
  },
];

describe("引き継ぎの生死について、手順書と実装が同じことを言う", () => {
  it("実物の手順書が、条件をすべて満たしている", () => {
    expect(readLivenessWording(ownershipSection())).toEqual(SATISFIED);
  });

  it.each(MUTATIONS)("壊すと落ちる: $name", ({ apply, breaks }) => {
    const mutated = apply(ownershipSection());

    // **変異が当たっていること。** **置換が空振りすると、緑のまま何も試していない**
    expect(mutated, "変異が当たっていない（手順書の文面が変わった）").not.toBe(ownershipSection());
    expect(readLivenessWording(mutated)[breaks], `${breaks} が壊れたと言えていない`).toBe(false);
  });
});
