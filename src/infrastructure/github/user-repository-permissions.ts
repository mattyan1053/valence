/**
 * `RepositoryPermissions` の GitHub 実装（#317 のレビュー）。
 *
 * **ユーザートークンで引く**（`AGENTS.md` §6）。**installation トークンで代用しない**
 * ——**あれは「リポジトリへの操作」**なので、**誰がログインしていても同じ答えになり、
 * この口の意味がまるごと消える。**
 *
 * **答えるのは「その人が何をしてよいか」だけ。** **応答には他の項目も並ぶ**が、
 * **内側へ渡すのは高さ 1 つ**である（§3 / §6）。
 *
 * **書ける側を並べ、それ以外は下へ倒す** (#90)——**GitHub が権限の種類を増やしても、
 * 知らない値が「書ける」にはならない。**
 */

import { z } from "zod";
import type {
  RepositoryAccessLevel,
  RepositoryPermissions,
} from "../../application/ports/repository-permissions";
import type { VisibleRepository } from "../../application/ports/visible-repositories";
import { repositoryUrl } from "./repository-url";

/**
 * 使う項目だけを検証する。
 *
 * **`permissions` はユーザートークンで引いたときだけ載る**——**載っていなければ
 * 「読めた」とは言えない**ので、**検証に落として投げる**（**`none` へ倒すと、
 * 判定不能が「権限が無い」に化ける**）。
 */
const repositorySchema = z.object({
  permissions: z.object({
    admin: z.boolean(),
    push: z.boolean(),
    pull: z.boolean(),
  }),
});

/**
 * 断られたときのエラー。
 *
 * **応答の中身を載せない**（§6「出力に何が含まれうるかで判断する」）——
 * **この要求の応答には、そのユーザーの持ち物が並ぶ。** **載せるのは状態コードだけ。**
 */
class PermissionLookupFailed extends Error {
  constructor(status: number) {
    super(`GitHub がリポジトリの権限を返しませんでした (status ${status})`);
    this.name = "PermissionLookupFailed";
  }
}

export type UserRepositoryPermissionsOptions = {
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
};

export function createUserRepositoryPermissions({
  fetchImpl = fetch,
}: UserRepositoryPermissionsOptions = {}): RepositoryPermissions {
  return {
    async levelFor(
      userAccessToken: string,
      repository: VisibleRepository,
    ): Promise<RepositoryAccessLevel> {
      const response = await fetchImpl(`${repositoryUrl(repository)}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${userAccessToken}`,
        },
      });
      if (!response.ok) {
        // **投げる。** **`none` を返すと、判定不能が「権限が無い」に化ける**
        // ——**押した人には嘘の理由が伝わる。**
        throw new PermissionLookupFailed(response.status);
      }

      const parsed = repositorySchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new PermissionLookupFailed(response.status);
      }

      const { admin, push, pull } = parsed.data.permissions;
      if (admin) {
        return "admin";
      }
      if (push) {
        return "write";
      }
      return pull ? "read" : "none";
    },
  };
}
