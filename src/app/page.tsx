/**
 * 入口の画面。
 *
 * **出す前に 3 つへ倒し分ける**（#213）——**ログインしていない / 入り直してもらう /
 * 出す**。**「何も見えない画面」で終わらせない**ので、**前の 2 つは必ずログインへ誘う。**
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 */

import type { VisibleRepositoriesResult } from "../application/repositories/list-visible-repositories";
import type { CrossRepositoryBoardResult } from "../application/review-order/view-cross-repository-board";
import { homeForCurrentUser, pullRequestPageUrl } from "../composition/auth";
import { SignOutButton, showsSignOut } from "../ui/auth/sign-out-button";
import { BoardFreshness } from "../ui/board/board-freshness";
import type { CrossRepositoryRow } from "../ui/cross-repository/cross-repository-board";
import { CrossRepositoryBoard } from "../ui/cross-repository/cross-repository-board";
import { RepositoryList } from "../ui/repository-list/repository-list";

/**
 * **要求ごとに描く。静的に生成させない** (#213 のレビュー)。
 *
 * **出すのは「いまログインしている人に何が見えるか」**である——**ビルドした瞬間の
 * 状態を焼き付けたら、全テナントに同じものが出る**（`AGENTS.md` §1 の
 * 「実行時に解決する。設定に固定しない」の逆）。
 *
 * **`next build` が落ちていたのは、env が足りないからではない。** **prerender が
 * ビルド時に走り、合成ルートが秘密を読みに行っていた**——**環境変数をビルドへ渡すと
 * 通るが、直っていない。** **直すべきは「このページが静的でよい」という前提である。**
 *
 * **外さないこと。** **速くはなるが、その速さは「誰にとっても同じ画面」と引き換え**である。
 */
export const dynamic = "force-dynamic";

/**
 * 盤面への行き先 (#314)。
 *
 * **名前をそのまま繋がない。** **owner / name は GitHub から来た値**で、
 * **`/` や `..` が入っていれば別の経路を指す**——**セグメントとして符号化する**
 * （**取り違えた先を、リンクの側から作らない**）。
 */
export function boardPath(repository: { readonly owner: string; readonly name: string }): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/**
 * **引いた結果を、画面にする**（#563）。
 *
 * **取ってくる側と分ける**——**画面から呼ぶと composition が本物を掴む**ので、
 * **「ログアウトを出していること」を試験から見られない**（**盤面が #519 で
 * 同じ形にしている**）。**判断はここに無い**——**受けた結果を出すだけ**である。
 */
/**
 * **横断の一覧を、画面の行へ**（#682）。
 *
 * **行き先はここで組む**（#417 のレビュー）——**経路は `app` の話**で、
 * **表示の部品は `app` を import できない**（§3 の表）。
 *
 * **読めなかった材料は、`undefined` のまま渡す**（#681）——**既定値を埋めると、
 * 「分からない」が「依頼なし」「マージできる」に化ける。**
 */
export function crossRepositoryRows(
  result: CrossRepositoryBoardResult,
): readonly CrossRepositoryRow[] {
  if (result.kind !== "board") {
    return [];
  }
  return result.listing.pullRequests.map((pullRequest) => ({
    repository: pullRequest.repository,
    number: pullRequest.number,
    title: pullRequest.title,
    updatedAt: pullRequest.updatedAt,
    href: pullRequestPageUrl(pullRequest.repository, pullRequest.number),
    ...(pullRequest.opinion === undefined ? {} : { opinion: pullRequest.opinion }),
    ...(pullRequest.assignment === undefined ? {} : { assignment: pullRequest.assignment }),
    ...(pullRequest.mergeStatus === undefined ? {} : { mergeStatus: pullRequest.mergeStatus }),
  }));
}

/** **読めなかったリポジトリの数**（#681 が分けて返したものを、そのまま数える）。 */
export function crossRepositoryUnavailable(result: CrossRepositoryBoardResult) {
  if (result.kind !== "board") {
    return { unreadable: 0, truncated: 0, repositories: 0, pullRequests: 0 };
  }
  const kinds = result.listing.unavailable;
  return {
    unreadable: kinds.filter((one) => one.kind === "unreadable").length,
    truncated: kinds.filter((one) => one.kind === "truncated").length,
    repositories: result.unreadableRepositories,
    // **形を読み取れなかった PR も運ぶ**（#686 のレビュー）——**画面の手前で消すと、
    // 全部が検証で落ちた盤面が「open な PR はありません」になる**
    pullRequests: result.listing.invalid.length,
  };
}

/**
 * **横断の一覧の節**（#682）。
 *
 * **渡されなければ、これまでどおりの画面である**——**足すだけ**にしてある。
 * **引けなかったときは、黙って空を出さない**（**故障が「open PR が 0 本」に化ける**）。
 */
function CrossRepositorySection({
  result,
  at,
}: {
  readonly result?: CrossRepositoryBoardResult;
  readonly at?: Date;
}) {
  if (result === undefined) {
    return null;
  }
  if (result.kind === "unavailable") {
    return <p className="text-sm">横断の一覧は、いま取得できませんでした。</p>;
  }
  if (result.kind !== "board") {
    // **ログインしていない / 入り直す**は、上の案内と重ねない
    return null;
  }
  return (
    <>
      {/* **「新しい」とは言わない**（#664）——**取りに行った時刻を出す** */}
      {at === undefined ? undefined : <BoardFreshness at={at} reloadHref="/" />}
      <CrossRepositoryBoard
        rows={crossRepositoryRows(result)}
        unavailable={crossRepositoryUnavailable(result)}
      />
    </>
  );
}

export function renderHome(
  result: VisibleRepositoriesResult,
  cross?: CrossRepositoryBoardResult,
  at?: Date,
) {
  return (
    <main className="mx-auto flex max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-16">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Valence</h1>
        {/* **期限が切れた画面からも出られること**（#563）。
         **判定は `showsSignOut` が持つ**（盤面と 2 箇所に置かない） */}
        {showsSignOut(result.kind) ? <SignOutButton action="/auth/logout" /> : undefined}
      </div>
      <p className="text-lg">AI 時代の PR コントロールセンター</p>
      {result.kind === "listed" ? (
        <RepositoryList
          // **行き先はここで組む** (#417 のレビュー)。**経路は `app` の話**で、
          // **表示の部品は `app` を import できない**（`AGENTS.md` §3 の表）
          repositories={result.listing.repositories.map((repository) => ({
            ...repository,
            href: boardPath(repository),
          }))}
          unreadable={result.listing.invalid.length}
        />
      ) : (
        <p className="text-sm">
          {result.kind === "signed-out"
            ? "GitHub でログインすると、見られるリポジトリが並びます。"
            : result.kind === "unavailable"
              ? // **入り直しても直らない。** **再ログインへ案内すると、故障を認証切れとして隠す**
                "いま取得できませんでした。しばらくしてから読み込み直してください。"
              : "ログインの期限が切れました。入り直してください。"}{" "}
          {result.kind === "unavailable" ? undefined : (
            <a className="underline" href="/auth/login">
              ログインへ
            </a>
          )}
        </p>
      )}
      {/* **横断の一覧**（#682）。**1 つが読めなくても、他を出す**
          ——**「読めなかった」は数と一緒に残る**（#681 が分けて返している） */}
      <CrossRepositorySection at={at} result={cross} />
    </main>
  );
}

export default async function Home() {
  // **取りに行く前に読む**（#664）——**遅い日に、実際より新しく見えることが無い**
  const at = new Date();
  // **見えるリポジトリは 1 度だけ引く**（#686 のレビュー）——**2 つを別々に呼ぶと、
  // 同じ `/user/repos` が二重になる**
  const { repositories, cross } = await homeForCurrentUser();
  return renderHome(repositories, cross, at);
}
