/**
 * **出せなかった理由を、記録の側の語へ落とす** (#513 のレビュー。#690)。
 *
 * **押した経路と同じものが、見に来た経路にもある**——**`store` / `list` /
 * `token` / `board` / `pull-requests` で落ちると、画面には「いま見られません」しか
 * 出ない**（`AGENTS.md` §6）ので、**サーバ側に残さないと、どこで落ちたかが消える。**
 *
 * **画面に出す語は変えない。** **残すのは記録だけ**である。
 *
 * **`app` の外に置く**（#690）。**リポジトリ別の盤面と入口の画面が、どちらも要る**
 * ——**片方のルートに置くと、ルート同士が import し合う**（§3 は「`app` は
 * ルーティングと配線のみ」）。
 *
 * **純粋である。** **npm も Node も要らない**ので、**`application` に置ける**
 * （§3 の表）。
 */

/**
 * **落ちどころの種類を 1 つの語にする。** **出せていれば `undefined`。**
 *
 * **`kind` だけの日と、`reason` が付いた日を分けない**——**同じ語の前半で
 * 揃えておくと、記録を読む側が絞り込める**（`unavailable/pull-requests/timedout`）。
 */
export function unavailableReason(result: {
  readonly kind: string;
  readonly reason?: string;
}): string | undefined {
  if (result.kind !== "unavailable") {
    return undefined;
  }
  return result.reason === undefined ? result.kind : `${result.kind}/${result.reason}`;
}
