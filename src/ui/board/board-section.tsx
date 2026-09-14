/**
 * **節の器**（#713）。**見出しの見た目と、節の切れ目を、ここ 1 箇所が決める。**
 *
 * **人が見て言ったこと**（`./task board:sample` の見本を見て、いちばん最初に）:
 *
 * > まず気になったのが、どこに何が書いてあるか画面をみてパット見わからなかった。
 * > たぶん各セクションの区切りの強調が足りないんだと思う。例えば「推奨レビュー順」の
 * > セクションをみても、セクションタイトルは小さいし絵文字とかもないし彩りもない。
 *
 * **数えた**——**`推奨レビュー順`（`font-semibold`）・`PR の依存`（`text-lg font-bold`）・
 * `issue`（`font-semibold text-lg`）** で、**大きさが揃っていなかった。**
 * **揃え忘れではなく、決める場所が 3 つあった**（`AGENTS.md` §5）——**器にする。**
 *
 * **判定はしない。** **受け取った名前と印を、決まった見た目で描くだけ**である。
 */

import type { PropsWithChildren } from "react";

/**
 * **子は React の作法で受ける**（`PropsWithChildren`）——**prop として渡す形にすると、
 * `createElement` の第 2 引数に `children` を書くことになる**（`noChildrenProp`）。
 */
export type BoardSectionProps = PropsWithChildren<{
  /**
   * **節に付ける印**（絵文字）。**意味は持たせない**——**読み上げからは外す**ので、
   * **飛ばされても何も失われない形にする**（#713）。
   */
  readonly mark: string;
  /** **節の名前。** **文字で残す**——**印だけにすると、読み上げで何の節か消える。** */
  readonly title: string;
}>;

export function BoardSection({ mark, title, children }: BoardSectionProps) {
  return (
    // **切れ目を線で引く**（#713）。**色は `var(--…)` で受ける**——**明と暗の
    // 両方で定義されている**（`globals.css`。**片方にしか無いと透明で描かれる**）。
    //
    // **余白も器が持つ**——**preflight が `*` の margin を 0 にする**ので、
    // **書かなければ段落は詰まって出る**（#583 のレビュー）。
    <section className="flex flex-col gap-3 border-t border-[var(--node-stroke)] pt-4">
      {/* **preflight は `h1..h6` の大きさと太さを `inherit` へ落とす**（#583 の
          レビュー）——**書かなければ、見出しは本文と 1 ピクセルも違わない。** */}
      <h2 className="flex items-center gap-2 text-lg font-bold">
        {/* **印は読み上げから外す**（#713）——**見本の `／` と同じ扱い**である
            （`risk-tier-view.tsx`）。**名前は下に文字で残っている。** */}
        <span aria-hidden="true">{mark}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
