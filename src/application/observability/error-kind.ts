/**
 * **例外の「種類」だけを言う** (#248 が置いた判断。#506 の 2-b で共有した)。
 *
 * **`message` を読まない。** **何が入るか保証できない**（**応答本文がそのまま
 * 入っていることがある**）——**`cause` も同じ**なので、**辿らない**（§6）。
 *
 * **`Error` 以外も投げられる**（`throw "文字列"` も `throw {token}` も書ける）。
 * **種類が分からないときこそ、中身を出さない**——**`typeof` までで止める。**
 *
 * **ここに置いたのは、握り潰した側でも同じことが要るから**である
 * ——**`src/infrastructure/observability/login-failure.ts` が持っていたものを、
 * application からも使えるところへ移した**（**同じものを 2 箇所に置かない**。§5）。
 * **純粋な関数**なので、**application に置いても外へ触らない。**
 */
/**
 * **HTTP の状態コードとして読めるか** (#516)。
 *
 * **範囲まで見る。** **「数値の欄がある」だけで通すと、別の意味の数**
 * （件数・時刻・識別子）**が status として記録に出る**——**読む人は status だと信じる。**
 *
 * **文字列は通さない**（§6）——**そこには何でも入れられる。**
 */
function httpStatusOf(error: Error): number | undefined {
  const status = (error as { readonly status?: unknown }).status;
  if (typeof status !== "number" || !Number.isInteger(status)) {
    return undefined;
  }
  return status >= 100 && status <= 599 ? status : undefined;
}

export function errorKind(error: unknown): string {
  if (error instanceof Error) {
    // **クラス名だけ。** `ZodError` / `TypeError` / `Error` のような、書いた人が付けた名前である
    //
    // **断られた状態コードは添える** (#516)——**`403` なら権限、`404` なら見えて
    // いない、`422` なら弾かれている**で、**「断られた」としか分からない状態を割る。**
    // **数字 1 つに持ち物は入らない**（**投げる側のコメントも、そう言っている**）。
    //
    // **投げる側のクラスは知らない**（§3。**infrastructure を import しない**）
    // ——**欄があるかどうかだけを見る。**
    const status = httpStatusOf(error);
    return status === undefined ? error.constructor.name : `${error.constructor.name}/${status}`;
  }
  return typeof error;
}
