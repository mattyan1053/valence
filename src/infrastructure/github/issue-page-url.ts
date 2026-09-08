/**
 * **人が開く GitHub の issue の場所**（#633）。
 *
 * **`pull-request-page-url.ts` と同じ形**である（**2 回目の重複は許容する**。
 * `AGENTS.md` §5）——**3 回目に抽象化すること。**
 *
 * **経路へ入れる判定は `repository-url.ts` が持つ**——**写さない。**
 */

import { pathSegment } from "./repository-url";

const WEB_ORIGIN = "https://github.com";

/** `https://github.com/<owner>/<name>/issues/<番号>` を返す。 */
export function issuePageUrl(
  repository: { readonly owner: string; readonly name: string },
  issueNumber: number,
): string {
  return `${WEB_ORIGIN}/${pathSegment(repository.owner)}/${pathSegment(repository.name)}/issues/${issueNumber}`;
}
