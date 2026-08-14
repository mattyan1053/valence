/**
 * 入口の画面。
 *
 * **出す前に 3 つへ倒し分ける**（#213）——**ログインしていない / 入り直してもらう /
 * 出す**。**「何も見えない画面」で終わらせない**ので、**前の 2 つは必ずログインへ誘う。**
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 */

import { visibleRepositoriesForCurrentUser } from "../composition/auth";

export default async function Home() {
  const result = await visibleRepositoriesForCurrentUser();

  return (
    <main className="mx-auto flex max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="font-mono text-3xl font-bold tracking-tight">Valence</h1>
      <p className="text-lg">AI 時代の PR コントロールセンター</p>
      {result.kind === "listed" ? (
        <ul className="flex flex-col gap-1 text-sm">
          {result.listing.repositories.map((repository) => (
            <li key={`${repository.owner}/${repository.name}`}>
              {repository.owner}/{repository.name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">
          {result.kind === "signed-out"
            ? "GitHub でログインすると、見られるリポジトリが並びます。"
            : "ログインの期限が切れました。入り直してください。"}{" "}
          <a className="underline" href="/auth/login">
            ログインへ
          </a>
        </p>
      )}
    </main>
  );
}
