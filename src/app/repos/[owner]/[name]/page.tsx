/**
 * 1 つのリポジトリの盤面——**依存グラフとリスク Tier を出す**（#314）。
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 *
 * **見られないリポジトリは 404 へ倒す。** **「権限がありません」と「ありません」を
 * 区別できる応答にしない**（§6）——**分けた瞬間に、見えないほうの存在を教える。**
 * **判定は `viewRepositoryBoard` が持っている**ので、**ここには書き写さない。**
 */

import { notFound } from "next/navigation";
import { repositoryBoardForCurrentUser } from "../../../../composition/auth";
import { ReviewBoard } from "../../../../ui/review-board/review-board";

/**
 * **要求ごとに描く。静的に生成させない**（入口の画面と同じ理由）。
 *
 * **出すのは「いまログインしている人に何が見えるか」**である——**ビルドした瞬間の
 * 状態を焼き付けたら、全テナントに同じものが出る**（`AGENTS.md` §1 の
 * 「実行時に解決する。設定に固定しない」の逆）。
 */
export const dynamic = "force-dynamic";

/**
 * 読めなかった PR の注記。**件数だけを出す**（入口の画面と同じ理由）。
 *
 * **理由は画面へ出さない**——**Zod のメッセージには値が入りうる。**
 */
export function unreadableNote(count: number): string | undefined {
  return count === 0 ? undefined : `${count} 件の PR は読めませんでした。図には抜けがあります。`;
}

/** 出せなかったときの案内。**行き先が違うので、文面も分ける。** */
function notice(kind: "signed-out" | "needs-login" | "unavailable"): string {
  switch (kind) {
    case "signed-out":
      return "GitHub でログインすると、このリポジトリのレビュー状況が見られます。";
    case "needs-login":
      return "ログインの期限が切れました。入り直してください。";
    case "unavailable":
      // **入り直しても直らない。** **再ログインへ案内すると、故障を認証切れとして隠す**
      return "いま取得できませんでした。しばらくしてから読み込み直してください。";
  }
}

export default async function RepositoryBoardPage({
  params,
}: {
  readonly params: Promise<{ readonly owner: string; readonly name: string }>;
}) {
  const { owner, name } = await params;
  const result = await repositoryBoardForCurrentUser({ owner, name });

  if (result.kind === "not-found") {
    // **存在も漏らさない。** **見えない人には、無いのと同じに見える**
    notFound();
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-1 flex-col gap-4 px-6 py-12">
      <h1 className="font-mono text-2xl font-bold tracking-tight">
        {owner}/{name}
      </h1>
      {result.kind === "board" ? (
        <>
          <ReviewBoard
            pullRequests={result.plan.pullRequests}
            edges={result.plan.edges}
            order={result.plan.order}
            invalid={result.plan.invalid}
            changes={result.plan.changes}
          />
          {/* **黙って捨てない。** **消すと「読めなかった」が「無かった」に化ける** */}
          {result.plan.invalid.length > 0 ? (
            <p className="text-sm opacity-70">{unreadableNote(result.plan.invalid.length)}</p>
          ) : undefined}
        </>
      ) : (
        <p className="text-sm">
          {notice(result.kind)}{" "}
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
