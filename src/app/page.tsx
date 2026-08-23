/**
 * 入口の画面。
 *
 * **出す前に 3 つへ倒し分ける**（#213）——**ログインしていない / 入り直してもらう /
 * 出す**。**「何も見えない画面」で終わらせない**ので、**前の 2 つは必ずログインへ誘う。**
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 */

import { visibleRepositoriesForCurrentUser } from "../composition/auth";

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
 * 読めなかったものの注記。**件数だけを出す** (#213 のレビュー)。
 *
 * **理由は画面へ出さない**——**Zod のメッセージには値が入りうる**
 * （`app-credentials.ts` が「Zod のエラーを持ち上げない」としているのと同じ理由）。
 */
export function invalidNote(count: number): string | undefined {
  return count === 0 ? undefined : `${count} 件は読めませんでした。`;
}

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
 * 見えたものを並べる（#415）。
 *
 * **`Home` から切り出してある。** **`Home` は非同期のサーバコンポーネントで、
 * 描いて確かめる手立てが無い**——**倒し分けをここへ置くと、描いた本文で判定できる**
 * （**#410 では、判定が見出し（`<h2>`）に当たったまま緑になっていた**）。
 *
 * **1 件も無いときに、何が無いのか・次に何をすればよいのかを出す。**
 * **#213 が倒し分けたのは 3 つ**（**ログインしていない / 入り直してもらう / 出す**）で、
 * **「並べたが 0 件」はそのどれでもない**——**「出す」に入っていて、出すものが無い。**
 *
 * **「無い」と「読めなかった」を同じ静けさにしない**（`AGENTS.md` §5。
 * **盤面の側と同じ倒し方**である）——**読めなかったせいで 0 件なら、
 * 「インストールしてください」とは言わない**（**インストール済みでも起きる**）。
 */
export function RepositoryListing({
  repositories,
  unreadable,
}: {
  readonly repositories: readonly { readonly owner: string; readonly name: string }[];
  readonly unreadable: number;
}) {
  if (repositories.length === 0) {
    return (
      <p className="text-sm">
        {unreadable > 0
          ? // **件数は下の注記が出す**ので、ここでは何が起きたかだけを言う
            "読めたリポジトリが 1 件もありません。"
          : "見られるリポジトリが 1 件もありません。GitHub App をリポジトリにインストールすると、ここに並びます。"}{" "}
        {invalidNote(unreadable)}
      </p>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-1 text-sm">
        {repositories.map((repository) => (
          <li key={`${repository.owner}/${repository.name}`}>
            {/* **並べるだけでは、盤面へ行けない** (#314)。**名前を入力させない** */}
            <a className="underline" href={boardPath(repository)}>
              {repository.owner}/{repository.name}
            </a>
          </li>
        ))}
      </ul>
      {/* **黙って捨てない。** **消すと「読めなかった」が「見えなかった」に化ける** */}
      {unreadable > 0 ? <p className="text-sm opacity-70">{invalidNote(unreadable)}</p> : undefined}
    </>
  );
}

export default async function Home() {
  const result = await visibleRepositoriesForCurrentUser();

  return (
    <main className="mx-auto flex max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="font-mono text-3xl font-bold tracking-tight">Valence</h1>
      <p className="text-lg">AI 時代の PR コントロールセンター</p>
      {result.kind === "listed" ? (
        <RepositoryListing
          repositories={result.listing.repositories}
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
