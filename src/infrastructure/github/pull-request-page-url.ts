/**
 * **人が開く GitHub の場所**（#621）。
 *
 * **`repository-url.ts` は `api.github.com` を組み立てる**——**あちらは道具が叩く側**、
 * **こちらは人が押す側**である。**`https://github.com` は外部サービスの詳細**なので、
 * **どちらも `infrastructure` に置く**（#622 のレビュー 2 周目。**一度 `domain` へ
 * 置いたが、ドメインが GitHub の Web UI の仕様を知ることになる**）。
 *
 * **盤面を描く `app` は `infrastructure` を import できない**が、**`composition` は
 * できる**——**そちらを経由して渡す**（`AGENTS.md` §3 の表）。
 *
 * **経路へ入れる判定は `repository-url.ts` が持つ**——**写さない**（§5）。
 */

import { pathSegment } from "./repository-url";

const WEB_ORIGIN = "https://github.com";

/** `https://github.com/<owner>/<name>/pull/<番号>` を返す。 */
export function pullRequestPageUrl(
  repository: { readonly owner: string; readonly name: string },
  pullRequestNumber: number,
): string {
  return `${WEB_ORIGIN}/${pathSegment(repository.owner)}/${pathSegment(repository.name)}/pull/${pullRequestNumber}`;
}
