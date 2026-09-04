/**
 * **GitHub 上の場所を指す URL**（#621）。
 *
 * **API ではなく、人が開く側**である（`src/infrastructure/github/repository-url.ts`
 * は `api.github.com` を組み立てる）。
 *
 * **ここに置いたのは、層の制約**である（`AGENTS.md` §3）——**盤面を描く `app` は
 * `infrastructure` を import できない**ので、**`segment` をそのまま呼べない。**
 * **`app` も `infrastructure` も `domain` を import できる**ので、**判定はここへ置き、
 * 両方から呼ぶ**（**写すと 2 箇所になる**。§5）。
 *
 * **owner / name は経路から来る自由な文字列**である——**`.` と `..` は包んでも
 * 安全にならない**（**URL の仕様が percent-encoded 形も dot segment として扱う**）。
 * **断る**——**包めないものを包んだ顔で通さない。**
 */

const WEB_ORIGIN = "https://github.com";

/**
 * 経路の 1 区切りへ入れられる形にする。
 *
 * **`.` と `..` は投げる。** **空も同じ**——**区切りが消えて、上の階層が繋がる。**
 */
export function pathSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded === "" || encoded === "." || encoded === "..") {
    throw new Error(`URL の経路へ入れられない値です: ${JSON.stringify(value)}`);
  }
  return encoded;
}

/** `https://github.com/<owner>/<name>/pull/<番号>` を返す。 */
export function pullRequestPageUrl(
  repository: { readonly owner: string; readonly name: string },
  pullRequestNumber: number,
): string {
  return `${WEB_ORIGIN}/${pathSegment(repository.owner)}/${pathSegment(repository.name)}/pull/${pullRequestNumber}`;
}
