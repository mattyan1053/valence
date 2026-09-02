/**
 * 入口の画面。
 *
 * **出す前に 3 つへ倒し分ける**（#213）——**ログインしていない / 入り直してもらう /
 * 出す**。**「何も見えない画面」で終わらせない**ので、**前の 2 つは必ずログインへ誘う。**
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 */

import type { VisibleRepositoriesResult } from "../application/repositories/list-visible-repositories";
import { visibleRepositoriesForCurrentUser } from "../composition/auth";
import { SignOutButton, showsSignOut } from "../ui/auth/sign-out-button";
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
export function renderHome(result: VisibleRepositoriesResult) {
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
    </main>
  );
}

export default async function Home() {
  return renderHome(await visibleRepositoriesForCurrentUser());
}
