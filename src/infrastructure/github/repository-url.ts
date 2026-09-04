/**
 * **リポジトリを指す GitHub API の URL**（#353）。
 *
 * **owner / name だけを包む。** **この 2 つは URL の経路から来る**
 * （`src/app/repos/[owner]/[name]/`）——**Next.js の動的区間は 1 区切りに当たるが、
 * `%2F` は当たったあとに `/` へ戻る**ので、**`/` や `..` を含む値が届きうる。**
 * **そのまま繋ぐと、`fetch` が経路を正規化して別の API を叩く。**
 *
 * **PR 番号は包まない。** **ドメイン型と境界の Zod で正の整数だと保証されている**
 * ——**包むと「どこが危ないか」がコードから読めなくなる**（#353 の指示）。
 * **危ないのは自由な文字列だけ**である。
 *
 * **`new URL()` では守れない。** **あれは経路を正規化する**ので、
 * **`/repos/a/../b/web` は `/repos/b/web` になる**——**包んでから組み立てるしかない。**
 * **どちらかに決める**という指示に対して、**`encodeURIComponent` を選んだ理由がこれ**である。
 *
 * **ただし包むだけでは足りない。** **`encodeURIComponent` は `.` を包まない**ので、
 * **`..` はそのまま残り、やはり正規化で消える。** **`%2E%2E` にしても同じ**である
 * ——**URL の仕様が「`.` と `..` の percent-encoded 形も dot segment として扱う」
 * と決めている**（実測で確かめた: `/repos/%2E%2E/web` → `/repos` が消えて `/web`）。
 *
 * **したがって `.` と `..` は、URL の経路に安全な形で置けない。** **断る**
 * ——**包めないものを包んだ顔で通さない。** **どちらも GitHub の owner / name
 * としては有り得ない**ので、**断って困る利用者はいない。**
 *
 * **同じ危険は #342 で 1 度直してある**（盤面へ戻す URL）——**外へ出す側は直っていて、
 * GitHub へ出す側が残っていた。**
 */

import type { VisibleRepository } from "../../application/ports/visible-repositories";

const API_ORIGIN = "https://api.github.com";

/**
 * `https://api.github.com/repos/<owner>/<name>` を返す。
 *
 * **続きは呼ぶ側が繋ぐ**（`/pulls/42` など）——**番号のように、
 * 危なくないと分かっているものを、この関数の中へ隠さない。**
 */
export function repositoryUrl(repository: VisibleRepository): string {
  return `${API_ORIGIN}/repos/${pathSegment(repository.owner)}/${pathSegment(repository.name)}`;
}

/**
 * 経路の 1 区切りへ入れられる形にする。
 *
 * **`.` と `..` は包んでも安全にならない**（上記）ので、**投げる。**
 * **空も同じ**——**区切りが消えて、上の階層が繋がる。**
 *
 * **`pull-request-page-url.ts` も同じものを使う** (#622)——**写すと 2 箇所になる。**
 */
export function pathSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded === "" || encoded === "." || encoded === "..") {
    throw new Error(`URL の経路へ入れられない値です: ${JSON.stringify(value)}`);
  }
  return encoded;
}
