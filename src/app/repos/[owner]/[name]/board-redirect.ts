/**
 * **盤面へ戻す応答**（#342 が置いたもの。#331 で共有した）。
 *
 * **303 で戻す。** **`next/navigation` の `redirect()` は Route Handler では 307** で、
 * **ブラウザはメソッドと本文を保持したまま再送する**——**盤面に POST handler は無い**
 * ので、**操作が成功しても 405 で終わり**、**盤面にも、押せなかった理由にも
 * 到達できない。** **POST-Redirect-GET にする**（`src/app/auth/logout/route.ts` と同じ形）。
 *
 * **ここに置いたのは、status を 1 箇所にするため**である（#331 の指示）。
 * **経路ごとに書くと、次に増えた経路が既定の 307 のまま出ていく**
 * ——**そのとき赤くなる試験は、その経路には無い。**
 *
 * **戻り先は、開いたオリジンの上に組み立てる**（`src/app/auth/urls.ts` と同じ理由）
 * ——**設定へ書き固めると、`localhost` と `127.0.0.1` で食い違う。**
 *
 * **`request.url` は「開いたオリジン」ではない** (#506。#451 と同じ形)——**dev サーバは
 * `--hostname 0.0.0.0` で待ち受けている**ので、**`127.0.0.1:3940` から押しても
 * `http://0.0.0.0:3000/…` へ戻し**、**`ERR_ADDRESS_INVALID` で終わる**（実測）。
 * **#451 は `auth/` 側だけを直していた**——**判定は `originFrom` の 1 箇所に置く。**
 *
 * **owner / name は経路の 1 区切りとして入れる**——**そのまま繋ぐと、
 * `..` や `?` を含む名前で別の場所へ戻せる。**
 */

import { NextResponse } from "next/server";
import { openedOrigin } from "../../../auth/urls";

/**
 * 盤面に載せる注記。**押せなかった理由**である。
 *
 * **成功を渡さない。** **これは URL に載る**ので、**利用者が任意に作れる**
 * ——**成功を載せると、操作していない人が「した」と出せる**（#342 のレビュー）。
 * **語彙から外すのは各機能の側**で、**ここはその値を運ぶだけ**である。
 */
export type BoardNotice = {
  /** クエリの名前（`approve` / `merge`）。 */
  readonly param: string;
  readonly value: string;
};

export function boardRedirect(
  request: Request,
  repository: { readonly owner: string; readonly name: string },
  notice: BoardNotice | undefined,
): NextResponse {
  const board = new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
    openedOrigin(request),
  );
  if (notice !== undefined) {
    board.searchParams.set(notice.param, notice.value);
  }
  return NextResponse.redirect(board, { status: 303 });
}
