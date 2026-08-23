/**
 * 入口に並べる、見えるリポジトリの一覧。
 *
 * **表示に専念する**（`AGENTS.md` §3）。**取得も、経路の組み立てもしない**
 * ——**`ui` が import してよいのは `domain` / 他の `ui` / React だけ**なので、
 * **行き先（`href`）は渡してもらう**（**経路は `app` の話である**）。
 *
 * **1 件も無いときに、何が無いのか・次に何をすればよいのかを出す**（#415）。
 * **#213 が倒し分けたのは 3 つ**（**ログインしていない / 入り直してもらう / 出す**）で、
 * **「並べたが 0 件」はそのどれでもない**——**「出す」に入っていて、出すものが無い。**
 *
 * **初めて使う人がいちばん最初に当たる形**である（**App がどこにもインストール
 * されていない**とき、**ログインは通り、見えるリポジトリは 0 件になる**）。
 *
 * **「無い」と「読めなかった」を同じ静けさにしない**（§5。**盤面の側（#410）と
 * 同じ倒し方**）——**読めなかったせいで 0 件なら、「インストールしてください」とは
 * 言わない**（**インストール済みでも起きる**）。
 */

/** 並べる 1 件と、その行き先。**経路の組み立ては `app` が持つ。** */
export type RepositoryLink = {
  readonly owner: string;
  readonly name: string;
  readonly href: string;
};

/**
 * 読めなかったものの注記。**件数だけを出す** (#213 のレビュー)。
 *
 * **理由は画面へ出さない**——**Zod のメッセージには値が入りうる**
 * （`app-credentials.ts` が「Zod のエラーを持ち上げない」としているのと同じ理由）。
 */
export function invalidNote(count: number): string | undefined {
  return count === 0 ? undefined : `${count} 件は読めませんでした。`;
}

export function RepositoryList({
  repositories,
  unreadable,
}: {
  readonly repositories: readonly RepositoryLink[];
  readonly unreadable: number;
}) {
  if (repositories.length === 0) {
    return (
      <p className="text-sm">
        {unreadable > 0
          ? // **件数は続けて出す**ので、ここでは何が起きたかだけを言う
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
            <a className="underline" href={repository.href}>
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
