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
import { nextPageUrl } from "./link-pagination";

const API_ORIGIN = "https://api.github.com";

/** 1 ページの件数。**GitHub の上限**である（**読み切る責務は変わらない**）。 */
const PER_PAGE = 100;

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

/**
 * 1 ページ取ってくる。**持って行くのはユーザートークンだけ。**
 *
 * **続きは `Link` が教える** (#245 のレビュー)——**件数で当てない。**
 */
async function fetchPage(
  fetchImpl: typeof fetch,
  userAccessToken: string,
  url: string,
): Promise<{ items: unknown[]; next: string | undefined }> {
  const response = await fetchImpl(url, {
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
  return {
    items: items.data,
    next: nextPageUrl(response.headers.get("link"), "見られるリポジトリ"),
  };
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

      // **`Link` の `next` が無くなるまで読む。** **固定のページ上限を置かない**
      // ——**置くと、それを超えて見られる人は一覧を一切使えない**（#245 のレビュー）。
      // **歯止めはここに置かない。** **必要になったら、共有した `nextPageUrl` の側に
      // 1 つだけ置く**——**ここにも足すと、また 2 つになる**（**PR 一覧も同じ前提で
      // 動いている**）。
      let url: string | undefined = `${API_ORIGIN}/user/repos?per_page=${PER_PAGE}`;
      while (url !== undefined) {
        const page = await fetchPage(fetchImpl, userAccessToken, url);
        collect(page.items, seen, repositories, invalid);
        seen += page.items.length;
        url = page.next;
      }

      return { repositories, invalid };
    },
  };
}
