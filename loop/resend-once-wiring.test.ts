/**
 * **出口の 1 通が落ちたら、その周回のうちに 1 回だけ送り直す**（#293）。
 *
 * **セッション間の送信は失敗する。** **2026-08-15 の午後だけで 2 回**
 * （`Failed to send to loop-master.`）——**宛先は `ListAgents` から取ったもので、
 * 名前は合っていた。** **直後に同じ宛先で送り直すと通る**ので、**一時的なもの**である。
 *
 * **記録の側は既に正しい**（#258。**送れたときだけ `--sent` を通す**）ので、
 * **失敗した状態は次の周回でもう一度立ち上がる。** **問題は、その「次の周回」が
 * 次の cron だということ**である——**出口の 1 通は相手を起こすためのもの**なので、
 * **落ちると相手はそこまで動かない。**
 *
 * **手順書は master と worker の両方にある。** **片方だけ直すと食い違う**ので、
 * **両方を同じ走査で見る。**
 *
 * ## 語を数えない（#300 のレビュー）
 *
 * **最初の版は「段落のどこかに `引き直` がある」「どこかに `2 回目` がある」しか
 * 見ていなかった**——**順序を逆に書いても、`--sent` を「通す」へ反転させても緑**である。
 * **「待ってから送り直すとは書かない」に至っては negative しか無く、段落を丸ごと
 * 消しても緑**だった。**名前が言っていることと、実際に測っているものが違う。**
 *
 * **判定を関数へ出し、実物と変異の両方を食わせる。** **変異は手で書く**——
 * **壊れた形はコードのどこにも残らず、書いた本人しか知らない**（`AGENTS.md` §5）。
 *
 * **実物の手順書は壊さない。** **配られている手順書を書き換えると、走っている周回と
 * 競る**（#186 の形）——**読み取った文字列の写しの上で変異させる。**
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

/**
 * **落ちたときの送り直しを説明している段落**（空行で区切られた塊）。
 *
 * **`[ref]` の言い換えと混ざらないよう、「落ちた / 失敗した」と同じ塊にあるものだけを取る**
 * ——**出口には前から「同名が複数あるときは `[ref]` を付けて送り直す」がある。**
 */
function resendBlocks(section: string): string[] {
  return section
    .split(/\n\s*\n/)
    .filter((block) => /送り直/.test(block) && /落ち|失敗/.test(block));
}

/** 文に割る。**改行は跨ぐ**（手順書は 1 文を複数行に折り返している）。 */
function sentences(text: string): string[] {
  return text.replace(/\n/g, "").split("。");
}

type ResendRule = {
  /** 落ちたときに送り直すと書いてあるか。 */
  resendsWhenSendFails: boolean;
  /** 送り直しは 1 回だけか。 */
  onlyOnce: boolean;
  /** **送り直す前に**宛先を引き直すか（**順序まで見る**）。 */
  refetchesBeforeResend: boolean;
  /** **2 回目も落ちたら `--sent` を通さない**か（**反転を弾く**）。 */
  leavesSentUnrecordedOnSecondFailure: boolean;
  /** **待ってから送り直す形になっていない**か。 */
  doesNotWaitBeforeResend: boolean;
  /** **引き直した結果が 1 通目と同じ名前でも送る**か（#300 のレビュー）。 */
  sendsEvenWhenNameIsUnchanged: boolean;
};

/**
 * 出口の節を読んで、#293 の完了条件を満たしているかを返す。
 *
 * **語の有無ではなく、順序と行き先を読む。** **一致させるのは 1 文の中**である
 * ——**別々の文に散らばっていると、片方を反転させても気づけない。**
 */
function readResendRule(section: string): ResendRule {
  const blocks = resendBlocks(section);
  const joined = blocks.join("\n");
  const lines = blocks.flatMap((block) => sentences(block));

  return {
    resendsWhenSendFails: blocks.length > 0,
    onlyOnce: /1 回だけ[^。]*送り直/.test(joined.replace(/\n/g, "")),
    // **「送り直す前に…引き直す」か「引き直して(から)…送り直す」**のどちらかであること。
    // **「送り直したあとに引き直す」は弾く**
    refetchesBeforeResend: lines.some(
      (line) =>
        (/送り直[^。]*前に[^。]*引き直/.test(line) ||
          /引き直[^。]*(てから|たうえで|た上で)[^。]*送り直/.test(line)) &&
        !/送り直[^。]*(あと|後)に[^。]*引き直/.test(line),
    ),
    // **同じ文の中で「2 回目」と `--sent` と「通さない」が揃うこと。**
    // **「通す」へ反転させると崩れる**
    leavesSentUnrecordedOnSecondFailure: lines.some(
      (line) => /2 回目/.test(line) && /--sent/.test(line) && /通さ(ず|ない)/.test(line),
    ),
    // **待ってから送り直す形が無いこと**（「送り直さない」は未然形なので当たらない）
    doesNotWaitBeforeResend: !lines.some((line) => /待って(から)?[^。]*送り直[すし]/.test(line)),
    // **同じ名前でも送ると読めること**、**かつ「同じ名前は避ける」が無いこと**。
    // **根拠にした実測は「名前は合っていたのに落ち、直後に同じ宛先で通った」**なので、
    // **同じ名前を避ける形にすると、いちばん多い経路で送り直しに行けない**
    sendsEvenWhenNameIsUnchanged:
      lines.some((line) => /同じ(名前|宛先)[^。]*(でも|であっても)[^。]*送/.test(line)) &&
      !lines.some((line) =>
        /同じ(名前|宛先)[^。]*(使い回さない|避ける|使わない|送らない)/.test(line),
      ),
  };
}

/** すべて満たしている状態。 */
const SATISFIED: ResendRule = {
  resendsWhenSendFails: true,
  onlyOnce: true,
  refetchesBeforeResend: true,
  leavesSentUnrecordedOnSecondFailure: true,
  doesNotWaitBeforeResend: true,
  sendsEvenWhenNameIsUnchanged: true,
};

/**
 * **手で書いた変異。** **実物を壊さず、読み取った写しの上で当てる。**
 *
 * `expect` は「その変異で false に倒れる項目」。**どこか 1 つでも false になれば、
 * この走査は壊れたことに気づける。**
 */
const MUTATIONS: {
  name: string;
  apply: (section: string) => string;
  breaks: keyof ResendRule;
}[] = [
  {
    name: "送り直しの段落を丸ごと消す",
    apply: (section) =>
      section
        .split(/\n\s*\n/)
        .filter((block) => !(/送り直/.test(block) && /落ち|失敗/.test(block)))
        .join("\n\n"),
    breaks: "resendsWhenSendFails",
  },
  {
    name: "回数を「何度でも」にする",
    apply: (section) => section.replace(/1 回だけ送り直す/g, "落ちなくなるまで送り直す"),
    breaks: "onlyOnce",
  },
  {
    name: "順序を逆にする（送り直したあとに引き直す）",
    apply: (section) =>
      section.replace(
        /\*\*送り直す前に `ListAgents` を引き直す。\*\*/g,
        "**送り直したあとに `ListAgents` を引き直す。**",
      ),
    breaks: "refetchesBeforeResend",
  },
  {
    name: "2 回目でも --sent を通す形に反転させる",
    apply: (section) =>
      section.replace(/`--sent` を通さずに終える/g, "`--sent` を通してから終える"),
    breaks: "leavesSentUnrecordedOnSecondFailure",
  },
  {
    name: "待ってから送り直す形にする",
    apply: (section) =>
      section.replace(/\*\*待ってから送り直さない\*\*/g, "**少し待ってから送り直す**"),
    breaks: "doesNotWaitBeforeResend",
  },
  {
    name: "同じ名前を避ける形にする（根拠と食い違う）",
    apply: (section) =>
      section.replace(
        /\*\*引き直した結果をそのまま使う。\*\*/g,
        "**引き直した結果が 1 通目と同じ名前なら、その宛先には送らない。**",
      ),
    breaks: "sendsEvenWhenNameIsUnchanged",
  },
];

describe("落ちたら、その周回のうちに 1 回だけ送り直す", () => {
  it.each(PROCEDURES)("$role の出口が、条件をすべて満たしている", ({ role }) => {
    expect(readResendRule(exitSection(role))).toEqual(SATISFIED);
  });

  describe.each(PROCEDURES)("$role の出口を壊すと落ちる", ({ role }) => {
    it.each(MUTATIONS)("$name", ({ apply, breaks }) => {
      const mutated = apply(exitSection(role));

      // **変異が当たっていること。** **置換が空振りすると、緑のまま何も試していない**
      expect(mutated, "変異が当たっていない（手順書の文面が変わった）").not.toBe(exitSection(role));
      expect(readResendRule(mutated)[breaks], `${breaks} が壊れたと言えていない`).toBe(false);
    });
  });
});
