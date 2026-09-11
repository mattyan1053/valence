/**
 * **誰の番かで絞る口**（#663）。
 *
 * **リンクで絞る。** **`?ball=` は、いま開いている画面の問い合わせだけを差し替える**
 * ので、**行き先をどこからも渡さずに済む**（**`urlOf` のような口が要らない**）。
 * **JavaScript も要らない**——**盤面は要求ごとに描いている**（`page.tsx`）。
 *
 * **口は絞っていなくても出す。** **無ければ、絞れることに気づけない。**
 *
 * **判定はしない**（`ballNote` と同じ）——**文言は `ball-filter.ts` が持つ。**
 */

import type { BallFilter } from "./ball-filter";
import { BALL_FILTERS, ballFilterLabel, ballFilterNote } from "./ball-filter";

/**
 * **いま選ばれているものは、リンクにしない。**
 *
 * **押しても何も起きない先を押せる形で出すと、効かなかったのか、
 * 既にそうなのかが分からない。**
 */
function FilterLink({
  href,
  active,
  children,
}: {
  readonly href: string;
  readonly active: boolean;
  readonly children: string;
}) {
  if (active) {
    return <strong className="font-bold">{children}</strong>;
  }
  return (
    <a className="underline" href={href}>
      {children}
    </a>
  );
}

export function BallFilterView({
  current,
  counts,
}: {
  /** いま選ばれている絞り込み。**絞っていなければ `undefined`。** */
  readonly current: BallFilter | undefined;
  /** 通った件数と、絞りで隠れた件数。 */
  /**
   * 通った件数と、絞りで隠れた件数と、**盤面に出ていない件数**（#694 のレビュー）。
   *
   * **`unread` は絞りの外**である——**読めなかったものは絞りに関係なく数える**
   * （**混ぜると、抜けが絞りのせいに見える**）。**言い切ってよいかの判定は
   * `ballFilterNote` が持つ**（2 箇所に置かない）。
   */
  readonly counts: {
    readonly shown: number;
    readonly hidden: number;
    readonly unread: number;
  };
}) {
  const note = ballFilterNote(current, counts);
  return (
    <section className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="text-[var(--muted)]">誰の番かで絞る:</span>
        {/* **「すべて」も選択肢として出す**——**絞りを外す手が無いと、戻れない** */}
        <FilterLink href="?" active={current === undefined}>
          すべて
        </FilterLink>
        {BALL_FILTERS.map((ball) => (
          <FilterLink key={ball} href={`?ball=${ball}`} active={current === ball}>
            {ballFilterLabel(ball)}
          </FilterLink>
        ))}
      </div>
      {/* **絞っているときだけ言う**（#248）——**平常時に鳴るものは読まれなくなる** */}
      {note === undefined ? undefined : <p className="text-[var(--muted)] text-sm">{note}</p>}
    </section>
  );
}
