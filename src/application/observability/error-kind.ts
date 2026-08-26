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
export function errorKind(error: unknown): string {
  if (error instanceof Error) {
    // **クラス名だけ。** `ZodError` / `TypeError` / `Error` のような、書いた人が付けた名前である
    return error.constructor.name;
  }
  return typeof error;
}
