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
 */

import type { GraphLayout } from "./graph-layout";

/** 図に出ていないもの。**0 件なら何も言わない。** */
export type MissingFromFigure = {
  /** 並べられなかった（循環、またはその先）。 */
  readonly unordered: number;
  /** 読めなかった。 */
  readonly unreadable: number;
};

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
  return <p>この図には出ていないものがあります: {parts.join("、")}。下に並べてあります。</p>;
}

export function DependencyGraphFigure({
  layout,
  missing,
}: {
  readonly layout: GraphLayout;
  readonly missing: MissingFromFigure;
}) {
  if (layout.nodes.length === 0) {
    return <MissingNote missing={missing} />;
  }
  return (
    <figure>
      {/*
       **横へ溢れさせる。** **深く積まれた列は右へ伸びる**ので、
       **縮めて読めなくするより、そのまま置いてスクロールさせる。**
       */}
      <div style={{ overflowX: "auto" }}>
        <svg
          role="img"
          aria-label="PR の依存グラフ。左が土台で、右へ行くほど上に積まれている"
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
              stroke="currentColor"
              strokeWidth={1}
            />
          ))}
          {layout.nodes.map((node) => (
            <g key={node.number}>
              <rect
                x={node.x}
                y={node.y}
                width={layout.nodeWidth}
                height={layout.nodeHeight}
                rx={4}
                fill="none"
                stroke="currentColor"
              />
              <text
                x={node.x + layout.nodeWidth / 2}
                y={node.y + layout.nodeHeight / 2}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                #{node.number}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption>
        左が土台、右へ行くほど上に積まれている。
        <MissingNote missing={missing} />
      </figcaption>
    </figure>
  );
}
