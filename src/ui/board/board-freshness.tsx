/**
 * **いつ取ったものかと、引き直す手**（#664）。
 *
 * **盤面は開いた瞬間のスナップショット**である。**開いたまま置いておくと古くなる**が、
 * **サーバは、その画面がまだ開いていることを知らない。**
 *
 * **押す側（webhook）ではなく、開いている側が引き直す道を採った**
 * ——**測った結果は PR に残してある**（**1 往復およそ 1.2 秒**、
 * **盤面 1 枚は PR 1 本あたり 3 往復を順に叩く**ので、**引き直しは開き直すのと同じ費用**である。
 * **押す側は、受け口・署名の検証・保存・配信が丸ごと要る**）。
 *
 * **「新しい」とは言わない**——**文言は `fetchedAtNote` が持つ。**
 */

import { fetchedAtNote } from "./fetched-at-note";

export function BoardFreshness({
  at,
  reloadHref,
}: {
  /** **その盤面を取った時刻。** */
  readonly at: Date;
  /**
   * **引き直す先。**
   *
   * **いまの絞りを持ったまま開き直す**（#663）——**引き直したら全部出てきた、では
   * 絞った意味が消える。**
   */
  readonly reloadHref: string;
}) {
  return (
    <p className="flex flex-wrap items-baseline gap-2 text-[var(--muted)] text-sm">
      <span>{fetchedAtNote(at)}</span>
      <a className="underline" href={reloadHref}>
        引き直す
      </a>
    </p>
  );
}
