/**
 * `VisibleRepositories` の GitHub 実装。
 *
 * **ユーザートークンで解決する** (`AGENTS.md` §6)。**installation トークンで
 * 代用しない**——**あれは「リポジトリへの操作」**なので、**誰がログインしていても
 * 同じものが見える**（**この口が塞ごうとしている当の穴**である）。
 *
 * **installation を設定に置かない** (§1)。**ここは installation を一切見ない**
 * ——**「そのユーザーが見られるもの」は GitHub 側が持っている**ので、
 * **持って行くのはユーザートークンだけ**でよい。
 *
 * **境界で Zod 検証し、ドメイン型へ変換してから内側へ渡す** (§3)。
 */

import { z } from "zod";
import type {
  InvalidVisibleRepository,
  VisibleRepositories,
  VisibleRepository,
  VisibleRepositoryListing,
} from "../../application/ports/visible-repositories";

const API_ORIGIN = "https://api.github.com";

/** 1 ページの件数。**満たなければ最後のページ**である（Link ヘッダを解析しない）。 */
const PER_PAGE = 100;

/**
 * **際限なく取りに行かない。** **GitHub が毎回満杯を返す**（あるいは応答が
 * 壊れている）とき、**止まらないループは「遅い」ではなく「終わらない」**になる。
 */
const MAX_PAGES = 20;

export type UserVisibleRepositoriesOptions = {
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
};

/**
 * 使う項目だけを検証する。
 *
 * **全部を写さない。** **応答には見せる必要のないものまで並ぶ**ので、
 * **内側へ渡すのは「どのリポジトリか」だけ**にする。
 */
const repositorySchema = z.object({
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});

/**
 * 断られたときのエラー。
 *
 * **応答の中身を載せない** (§6「出力に何が含まれうるかで判断する」)——
 * **この要求の応答には、そのユーザーの持ち物が並ぶ**。**載せるのは状態コードだけ。**
 */
function requestError(status: number): Error {
  return new Error(`見られるリポジトリを取得できませんでした (HTTP ${status})`);
}

/** 応答は返ってきたが読めなかったときのエラー。**「断られた」と別の文面にする。** */
function responseError(status: number): Error {
  return new Error(`見られるリポジトリの応答を読めませんでした (HTTP ${status})`);
}

/** 1 ページ取ってくる。**持って行くのはユーザートークンだけ。** */
async function fetchPage(
  fetchImpl: typeof fetch,
  userAccessToken: string,
  page: number,
): Promise<unknown[]> {
  const response = await fetchImpl(`${API_ORIGIN}/user/repos?per_page=${PER_PAGE}&page=${page}`, {
    headers: {
      authorization: `Bearer ${userAccessToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    // **空を返さない。** **「取得できなかった」が「1 件も見えない」に化ける**
    throw requestError(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw responseError(response.status);
  }

  const items = z.array(z.unknown()).safeParse(body);
  if (!items.success) {
    throw responseError(response.status);
  }
  return items.data;
}

/** 1 ページぶんを仕分ける。**読めなかったものは黙って捨てない。** */
function collect(
  items: readonly unknown[],
  offset: number,
  repositories: VisibleRepository[],
  invalid: InvalidVisibleRepository[],
): void {
  for (const [index, item] of items.entries()) {
    const parsed = repositorySchema.safeParse(item);
    if (parsed.success) {
      repositories.push({ owner: parsed.data.owner.login, name: parsed.data.name });
      continue;
    }
    invalid.push({
      index: offset + index,
      reason: parsed.error.issues[0]?.message ?? "読めません",
    });
  }
}

export function createUserVisibleRepositories({
  fetchImpl = fetch,
}: UserVisibleRepositoriesOptions = {}): VisibleRepositories {
  return {
    async list(userAccessToken: string): Promise<VisibleRepositoryListing> {
      const repositories: VisibleRepository[] = [];
      const invalid: InvalidVisibleRepository[] = [];
      let seen = 0;

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const items = await fetchPage(fetchImpl, userAccessToken, page);
        collect(items, seen, repositories, invalid);
        seen += items.length;

        // **満たなければ最後のページ**である
        if (items.length < PER_PAGE) {
          return { repositories, invalid };
        }
      }

      // **上限に当たったことを黙らない。** **「全部読んだ」と見分けが付かなくなる**
      throw new Error(`見られるリポジトリが多すぎます (${MAX_PAGES} ページで打ち切りました)`);
    },
  };
}
