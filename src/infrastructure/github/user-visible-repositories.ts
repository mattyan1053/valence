/**
 * `VisibleRepositories` の GitHub 実装。
 *
 * **ユーザートークンで解決する** (`AGENTS.md` §6)。**installation トークンで
 * 代用しない**——**あれは「リポジトリへの操作」**なので、**誰がログインしていても
 * 同じものが見える**（**この口が塞ごうとしている当の穴**である）。
 *
 * **installation を設定に置かない** (§1)。**どの installation を見るかは、
 * そのユーザーのトークンで GitHub に訊く**——**`/user/installations` が返すのは
 * 「その人が見られる、この App の installation」**である（**App 全体の一覧
 * `/app/installations` ではない**）。
 *
 * **引く向きは、小さいほうから** (#470)。**その人の全リポジトリを引いて絞ると、
 * 要求の数が「その人が持っている数」で決まる**——**200 個持っている人は 200 個ぶん
 * 待つ**（**入り口で人の体感 1 分**。**そこを通らないと、その先を見てもらえない**）。
 * **installation はたいてい数個**（§1。**アカウントごと**）なので、**そちらを起点にする。**
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

/**
 * 1 要求の上限 (ms)。**画面ごと止めない** (#120 / #158 と同じ考え方)。
 *
 * **返らない要求を待ち続けると、入り口が開かないまま**である——**上限を過ぎたら
 * 落とし**、**使う側は「いま取得できませんでした」へ倒す**（`visibleRepositoriesForCurrentUser`）。
 * **空を返して「1 件も見えない」に化けさせない**、はそのまま。
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 同時に投げる installation の数 (#472 のレビュー)。
 *
 * **「installation は数個」と仮定しない。** **`AGENTS.md` §1 が言っているのは
 * 「installation はアカウントごとにある」**であって、**数の話ではない**
 * ——**節の主旨は「インストール先は 1 つではない」**である。
 *
 * **GitHub の secondary rate limit は同時 100 件**。**超えると 403 / 429 が返り、
 * ここは 1 つでも落ちたら投げる**ので、**一覧が丸ごと出なくなる。**
 *
 * **100 には寄せない。** **同じ要求の中で、他の口も GitHub を叩く**（盤面は PR も
 * 引く）ので、**上限に張り付けると、その相乗りで超える。** **8 にしたのは、
 * 待ち時間の伸び方が緩いから**である——**installation が 40 あっても 5 波**で、
 * **1 波は 1 往復ぶん**（**上の 10 秒はその 1 往復に掛かる**）。
 */
const CONCURRENCY = 8;

export type UserVisibleRepositoriesOptions = {
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
  /** 1 要求の上限。**試験は本物の時間を回さない**（#131 / #137 と同じ）。 */
  readonly timeoutMs?: number;
  /** 同時に投げる数の上限。**試験が上限そのものを見る**ため。 */
  readonly concurrency?: number;
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
 * installation の一覧。**丸ごと検証する。**
 *
 * **1 件ずつ拾って落ちたぶんを捨てる形にしない**——**捨てた installation の
 * リポジトリは、そもそも引きに行かない**ので、**「読めなかった」が「見えなかった」に
 * 化ける**（**しかも件数では気づけない**）。**読めない形が返ったら、そこで落とす。**
 */
const installationsSchema = z.object({
  installations: z.array(z.object({ id: z.number().int().nonnegative() })),
});

/** installation ごとのリポジトリ。**1 件ずつは、下で仕分ける。** */
const repositoriesSchema = z.object({ repositories: z.array(z.unknown()) });

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
  timeoutMs: number,
): Promise<{ body: unknown; next: string | undefined; status: number }> {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${userAccessToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    // **1 要求ずつ上限を持つ** (#470)。**待ち切らずに落とす**ので、**入り口が
    // 開かないまま**にはならない。
    signal: AbortSignal.timeout(timeoutMs),
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

  return {
    body,
    next: nextPageUrl(response.headers.get("link"), "見られるリポジトリ"),
    status: response.status,
  };
}

/** その人が見られる installation の id。**続きも読む。** */
async function fetchInstallationIds(
  fetchImpl: typeof fetch,
  userAccessToken: string,
  timeoutMs: number,
): Promise<number[]> {
  const ids: number[] = [];
  let url: string | undefined = `${API_ORIGIN}/user/installations?per_page=${PER_PAGE}`;
  while (url !== undefined) {
    const page = await fetchPage(fetchImpl, userAccessToken, url, timeoutMs);
    const parsed = installationsSchema.safeParse(page.body);
    if (!parsed.success) {
      throw responseError(page.status);
    }
    ids.push(...parsed.data.installations.map((installation) => installation.id));
    url = page.next;
  }
  return ids;
}

/** その installation で、その人が見られるリポジトリ。**続きも読む。** */
async function fetchInstallationRepositories(
  fetchImpl: typeof fetch,
  userAccessToken: string,
  installationId: number,
  timeoutMs: number,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let url: string | undefined =
    `${API_ORIGIN}/user/installations/${installationId}/repositories?per_page=${PER_PAGE}`;
  // **`Link` の `next` が無くなるまで読む。** **固定のページ上限を置かない**
  // ——**置くと、それを超えて見られる人は一覧を一切使えない**（#245 のレビュー）。
  // **歯止めはここに置かない。** **必要になったら、共有した `nextPageUrl` の側に
  // 1 つだけ置く**——**ここにも足すと、また 2 つになる**（**PR 一覧も同じ前提で
  // 動いている**）。
  while (url !== undefined) {
    const page = await fetchPage(fetchImpl, userAccessToken, url, timeoutMs);
    const parsed = repositoriesSchema.safeParse(page.body);
    if (!parsed.success) {
      throw responseError(page.status);
    }
    items.push(...parsed.data.repositories);
    url = page.next;
  }
  return items;
}

/**
 * **上限つきで、順に走らせる** (#472 のレビュー)。**返す並びは入力の順。**
 *
 * **落ちたら、そこで新しく投げない。** **1 つでも落ちたら投げる**（**半分だけ返すと、
 * 足りないことに気づけない**）ので、**残りを投げ続けても捨てるだけ**である
 * ——**403 / 429 を余計に踏むぶん、次の要求まで悪くする。**
 *
 * **最初に落ちたものを投げる。** **あとから落ちたものを握り潰さない**ため、
 * **全部が畳まれてから投げ直す。**
 */
async function runWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (failure === undefined) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      try {
        results[index] = await run(item);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) {
    throw failure;
  }
  return results;
}

/** 仕分ける。**読めなかったものは黙って捨てない。** */
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
  timeoutMs = REQUEST_TIMEOUT_MS,
  concurrency = CONCURRENCY,
}: UserVisibleRepositoriesOptions = {}): VisibleRepositories {
  return {
    async list(userAccessToken: string): Promise<VisibleRepositoryListing> {
      const ids = await fetchInstallationIds(fetchImpl, userAccessToken, timeoutMs);

      // **installation ごとの往復は、上限つきで同時に投げる**（#472 のレビュー）。
      // **直列にすると、その数だけ待ち時間が積み上がる**——**入り口の話**である。
      // **上限を置くのは、数を仮定しないため**（`CONCURRENCY` の理由を読むこと）。
      //
      // **1 つでも落ちたら投げる。** **半分だけ返すと、「見えるべきものが返らない」が
      // 正常な顔で出る**——**足りないことに気づけるのは、返らなかったときだけ。**
      const perInstallation = await runWithLimit(ids, concurrency, (id) =>
        fetchInstallationRepositories(fetchImpl, userAccessToken, id, timeoutMs),
      );

      const repositories: VisibleRepository[] = [];
      const invalid: InvalidVisibleRepository[] = [];
      let seen = 0;
      // **並びは installation の順**である（**同時に投げても、結果は順に並べる**
      // ——**`invalid` の位置が、要求の終わる順で変わらない**）。
      for (const items of perInstallation) {
        collect(items, seen, repositories, invalid);
        seen += items.length;
      }

      return { repositories, invalid };
    },
  };
}
