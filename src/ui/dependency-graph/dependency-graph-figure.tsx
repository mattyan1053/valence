/**
 * 依存グラフを図として描く（#471）。
 *
 * **箇条書きでは、深さも枝分かれも見えない。** **`← #456 の上` が並ぶだけ**なので、
 * **本数が増えると、どれがどれの上にあるかを追えない**——**このプロダクトが狙うのは
 * 「PR に溺れている」状況**である（README）。
 *
 * **置き場所は `graph-layout` が決める。** **ここは描くだけ**である。
 *
 * **図を、完全なものとして出さない。** **循環しているぶんと読めなかったぶんは
 * 図に出ない**ので、**その件数を図の脇に書く**——**欠けた図が完全な図の顔で出るのは、
 * このリポジトリが繰り返し塞いできた形**である。
 *
 * **箱には、決めるのに要ることを入れる**（#540 / #542）。**番号だけの箱は、読めても
 * 決められない**——**危なさも「何待ちか」も脇の文章にしか無いと、10 本並んだとき
 * 全部読むまで順番が決まらない。** **判定はしない**（下の `NodeMark` を受けるだけ）。
 */

import type { MergeBlock } from "../../domain/graph/merge-block";
import type { RiskTier } from "../../domain/triage/risk-tier";
import { fitLabel } from "./fit-label";
import type { GraphLayout } from "./graph-layout";

/** 図に出ていないもの。**0 件なら何も言わない。** */
export type MissingFromFigure = {
  /** 並べられなかった（循環、またはその先）。 */
  readonly unordered: number;
  /** 読めなかった。 */
  readonly unreadable: number;
};

/**
 * 箱 1 つに載せるもの。
 *
 * **判定をここで作らない。** **危なさは `classifyRiskTier`、何待ちかは `mergeBlockFor`**
 * が決めたものを、そのまま受ける——**書き写すと、Merge ボタンの側と食い違う。**
 */
export type NodeMark = {
  /**
   * 危なさ。**材料が届いていない PR は `undefined`。**
   *
   * **任意の項目にしない。** **書かない＝「危なくない」に倒れる**ので、
   * **「まだ分からない」を値として渡させる**（#348 の `unreadableCount` と同じ理由）。
   */
  readonly tier: RiskTier | undefined;
  /** いま押せるか、何を待っているか。 */
  readonly block: MergeBlock;
  /**
   * **見せている commit が分かっているか**（#541 のレビュー）。
   *
   * **`MergeBlock` が答えているのは依存の順序だけ**である。**`head.sha` が欠けた PR は
   * 図に残る**（`pull-request-mapping.ts`）が、**`MergeButton` はそれを無効にする**
   * ——**確かめられない対象をマージさせない**ため。**渡さないと、無効なボタンの隣に
   * 「押せる」と出る。**
   *
   * **任意にしない。** **既定を `true` にすると言い過ぎ**、**`false` にすると
   * どの PR も「commit 不明」になる**——**どちらへ倒しても嘘になる。**
   */
  readonly headKnown: boolean;
  /**
   * その PR のタイトル（#542）。**取れていないなら `undefined`。**
   *
   * **番号だけでは「どれか」が分からない**ので、**箱まで運ぶ。**
   *
   * **任意の項目にしない。** **書かない＝「タイトルが無い PR」に倒れる**
   * ——**取れなかったことは、取れなかったと分かる形で出す**（`tier` と同じ理由）。
   */
  readonly title: string | undefined;
};

/**
 * 箱に出す、危なさの札。
 *
 * **`RiskTierView` の言葉を使い回さない。** **あちらは「何をすべきか」を文で言う**
 * もので、**ここは一覧して比べるための札**である——**箱に入る長さでないと意味が無い。**
 *
 * **`Record` で持つ。** Tier を足したときにここへ書き忘れると**型検査が落ちる**。
 */
const TIER_LABEL: Record<RiskTier, string> = {
  "fast-track": "すぐ",
  "needs-review": "通常",
  "high-risk": "要注意",
};

/**
 * 危なさを、**色でも出す**（#583）。**読まずに拾えるのは、札より先にこちら**である。
 *
 * **濃さだけでは並ぶと拾えなかった**（0.2 / 0.5 / 1 の 3 段。利用者の言葉）——
 * **色を足す**が、**色だけに頼らない**（**札は `TIER_LABEL` が残す**）。
 *
 * **値はここで決めない**（#505）。**`var(--…)` はテーマが決める**ので、
 * **部品はテーマの決められない色を抱え込まない**——**不変条件はそのままである。**
 * **参照した変数が明・暗の両方で定義されていることは、試験が見る。**
 */
const TIER_COLOR: Record<RiskTier, string> = {
  "fast-track": "var(--tier-fast)",
  "needs-review": "var(--tier-normal)",
  "high-risk": "var(--tier-risk)",
};

/** **材料が届いていない。** **空欄にすると `fast-track` と見分けが付かない。** */
const UNKNOWN_LABEL = "未判定";

/**
 * **タイトルが取れていない**（#542）。
 *
 * **空欄にしない**——**「タイトルが空の PR」と見分けが付かない**（`UNKNOWN_LABEL` と
 * 同じ向き）。**取れない形は実在する**（`pull-request-mapping.ts` は必須にしていない）。
 */
const UNKNOWN_TITLE = "タイトル不明";

/** 箱の左の余白。**危なさの帯（幅 6）を避けた位置**である。 */
const TEXT_INSET = 18;

/** 箱の右の余白。 */
const TEXT_RIGHT_INSET = 10;

/** タイトルの文字の大きさ。**切る幅を数えるのにも使う。** */
const TITLE_FONT_SIZE = 11;

/**
 * **何を待っているか。** **番号まで出す**——**「押せない」だけでは次の手が分からない。**
 *
 * **「押せる」と言うのは、ボタンが押せるときだけ**である（#541 のレビュー）。
 * **依存が残っているほうを先に出す**——**そちらは先に入れれば解ける**が、
 * **commit が分からないのは、盤面を読み込み直すまで変わらない。**
 */
function markLabel({ block, headKnown }: NodeMark): string {
  switch (block.kind) {
    case "ready":
      // **ボタンと同じ条件**（`MergeButton` の `headSha === undefined`）
      return headKnown ? "押せる" : "commit 不明";
    case "depends-on": {
      const [first, ...rest] = block.numbers;
      // **`mergeBlockFor` は空なら `ready` を返す**ので実際には来ないが、**型は許す**
      // ——**「押せる」へ倒すと、依存を壊す側へ倒れる。**
      if (first === undefined) {
        return "順序不明";
      }
      return rest.length === 0 ? `待ち: #${first}` : `待ち: #${first} ほか${rest.length} 件`;
    }
    case "not-orderable":
      // **原因は言い分けない**（`mergeNotice` と同じ理由。#348 のレビュー）
      return "順序不明";
  }
}

function MissingNote({ missing }: { missing: MissingFromFigure }) {
  const parts: string[] = [];
  if (missing.unordered > 0) {
    parts.push(`並べられなかった ${missing.unordered} 件`);
  }
  if (missing.unreadable > 0) {
    parts.push(`読めなかった ${missing.unreadable} 件`);
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <p className="text-sm text-[var(--muted)]">
      この図には出ていないものがあります: {parts.join("、")}。下に並べてあります。
    </p>
  );
}

export function DependencyGraphFigure({
  layout,
  missing,
  markOf,
}: {
  readonly layout: GraphLayout;
  readonly missing: MissingFromFigure;
  /**
   * 箱 1 つぶんの中身。
   *
   * **任意にしない。** **渡さなければ番号だけに戻る**が、**それは #540 が消しに来た
   * 状態**である——**合成で渡し忘れた日から、静かに元へ戻る。**
   */
  readonly markOf: (pullRequestNumber: number) => NodeMark;
}) {
  if (layout.nodes.length === 0) {
    return <MissingNote missing={missing} />;
  }
  return (
    // **図の外にも見た目を当てる**（#583 のレビュー）——**説明文が本文と地続きだと、
    // どこまでが図の話か分からない。**
    <figure className="flex flex-col gap-2">
      {/*
       **横へ溢れさせる。** **深く積まれた列は右へ伸びる**ので、
       **縮めて読めなくするより、そのまま置いてスクロールさせる。**
       */}
      <div style={{ overflowX: "auto" }}>
        <svg
          role="img"
          aria-label="PR の依存グラフ。左が土台で、右へ行くほど上に積まれている。各箱に番号・タイトル・危なさ・何待ちかが入っている"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
        >
          <title>PR の依存グラフ</title>
          {layout.links.map((link) => (
            <line
              key={`${link.from}-${link.to}`}
              x1={link.fromX}
              y1={link.fromY}
              x2={link.toX}
              y2={link.toY}
              stroke="var(--link)"
              strokeWidth={1.5}
            />
          ))}
          {layout.nodes.map((node) => {
            const mark = markOf(node.number);
            const { tier } = mark;
            return (
              <g key={node.number}>
                <rect
                  x={node.x}
                  y={node.y}
                  width={layout.nodeWidth}
                  height={layout.nodeHeight}
                  rx={6}
                  // **枠だけの箱は背景と地続きに見える**（#583）——**並ぶと、
                  // どこまでが 1 件か分からない。** **色はテーマが決める。**
                  fill="var(--node-fill)"
                  stroke="var(--node-stroke)"
                  // **判定できていない箱を、判定済みと同じ形にしない**
                  strokeDasharray={tier === undefined ? "3 3" : undefined}
                />
                {/*
                 **危なさを、濃さの帯で出す**（#540）。**札より先に目に入るのはここ**
                 で、**10 本並んだときに拾えるのは形と濃さである。**
                 **材料が無いなら帯を出さない**——**薄い帯は「危なくない」に見える。**
                 */}
                {tier === undefined ? undefined : (
                  <rect
                    x={node.x + 1}
                    y={node.y + 1}
                    width={6}
                    height={layout.nodeHeight - 2}
                    fill={TIER_COLOR[tier]}
                  />
                )}
                {/*
                 **色は親から受け取る** (#505)。**SVG の既定の `fill` は黒**なので、
                 **書かないと暗いテーマで背景と同じ色になる**——**枠だけが
                 `currentColor` で追随し**、**四角は見えるのに文字が見えなかった。**
                 */}
                <text
                  x={node.x + TEXT_INSET}
                  y={node.y + 18}
                  dominantBaseline="middle"
                  fill="currentColor"
                  fontSize={13}
                  fontWeight="bold"
                >
                  #{node.number}
                </text>
                <text
                  x={node.x + layout.nodeWidth - TEXT_RIGHT_INSET}
                  y={node.y + 18}
                  textAnchor="end"
                  dominantBaseline="middle"
                  // **札にも同じ色を当てる**（#583）——**帯と札が同じことを言う。**
                  // **判定できていないものは、色を持たない側**（`var(--muted)`）。
                  fill={tier === undefined ? "var(--muted)" : TIER_COLOR[tier]}
                  fontSize={11}
                  fontWeight="bold"
                >
                  {tier === undefined ? UNKNOWN_LABEL : TIER_LABEL[tier]}
                </text>
                {/*
                 **タイトルは切る**（#542）。**長さが青天井**なので、**そのまま置くと
                 隣の箱と重なって、どちらも読めなくなる**——**切ったことは印で出す。**
                 **幅は箱から数える**ので、**箱を狭めた日にも付いてくる。**
                 */}
                <text
                  x={node.x + TEXT_INSET}
                  y={node.y + 38}
                  dominantBaseline="middle"
                  fill="currentColor"
                  fontSize={TITLE_FONT_SIZE}
                >
                  {mark.title === undefined
                    ? UNKNOWN_TITLE
                    : fitLabel(mark.title, {
                        maxWidth: layout.nodeWidth - TEXT_INSET - TEXT_RIGHT_INSET,
                        fontSize: TITLE_FONT_SIZE,
                      })}
                </text>
                <text
                  x={node.x + TEXT_INSET}
                  y={node.y + 58}
                  dominantBaseline="middle"
                  // **強弱を付ける**（#583）——**番号 > タイトル > 状態**。
                  // **同じ太さ・同じ濃さで 3 行並ぶと、どれが見出しか分からない。**
                  fill="var(--muted)"
                  fontSize={11}
                >
                  {markLabel(mark)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="text-sm text-[var(--muted)]">
        左が土台、右へ行くほど上に積まれている。箱には番号・タイトル・危なさ・何待ちかが入っている。
        <MissingNote missing={missing} />
      </figcaption>
    </figure>
  );
}
