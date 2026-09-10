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
import type { BallFilter } from "../../../../ui/ball/ball-filter";
import { ballFilterOf } from "../../../../ui/ball/ball-filter";
import { openedOrigin } from "../../../auth/urls";

/**
 * 盤面に載せる注記。**押せなかった理由**である。
 *
 * **成功を渡さない。** **これは URL に載る**ので、**利用者が任意に作れる**
 * ——**成功を載せると、操作していない人が「した」と出せる**（#342 のレビュー）。
 * **語彙から外すのは各機能の側**で、**ここはその値を運ぶだけ**である。
 */
export type BoardNotice = {
  /** クエリの名前（`approve` / `merge` / `plan`）。 */
  readonly param: string;
  readonly value: string;
  /**
   * **どの PR で止まったか**（#661）。**あれば `<param>-at` に載る。**
   *
   * **載せてよいのは、これが「入らなかった」の側だから**である
   * ——**「入った」は盤面が示す**（**消えている**）。**数を載せると、
   * 操作していない人が「N 本入りました」と出せる**（#342 のレビューと同じ形）。
   */
  readonly at?: number;
};

/**
 * **送られてきた絞りを読む**（#667）。**画面に無い絞りは通さない。**
 *
 * **フォームから来る値は、利用者が任意に作れる**——**そのまま戻り先へ載せると、
 * 画面に出していない絞りを URL 経由で選べる**（**その逆も起きる**）。
 * **通してよいものは `BALL_FILTERS` が並べている**——**判定を写さない。**
 *
 * **同じ鍵が 2 つ載っていたら絞らない**（`ballFilterOf` と同じ判断）
 * ——**片方を選ぶと、URL と画面が食い違う。**
 */
export function submittedBallFilter(form: FormData | undefined): BallFilter | undefined {
  const values = (form?.getAll("ball") ?? []).filter(
    (value): value is string => typeof value === "string",
  );
  return values.length === 1 ? ballFilterOf(values[0]) : undefined;
}

export function boardRedirect(
  request: Request,
  repository: { readonly owner: string; readonly name: string },
  notice: BoardNotice | undefined,
  /**
   * **いま絞っているもの**（#667）。**あれば `?ball=` に載る。**
   *
   * **注記とは別に受ける**——**押せたときは注記が無い**ので、
   * **注記に相乗りさせると、成功したときだけ絞りが解ける。**
   */
  ball?: BallFilter,
): NextResponse {
  const board = new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
    openedOrigin(request),
  );
  if (notice !== undefined) {
    board.searchParams.set(notice.param, notice.value);
    if (notice.at !== undefined) {
      board.searchParams.set(`${notice.param}-at`, String(notice.at));
    }
  }
  if (ball !== undefined) {
    board.searchParams.set("ball", ball);
  }
  return NextResponse.redirect(board, { status: 303 });
}
