/**
 * **URL とフォームから来る値の受け口**（#696）。
 *
 * **`AGENTS.md` §6 は「外部入力（Webhook ペイロード、API レスポンス、クエリ
 * パラメータ）は Zod で検証してから使う」**と書いている。**画面はここを通す。**
 *
 * **決めた根拠**（#696。**読んで数えたうえで、走らせて確かめた**）:
 *
 * - **同じ規則の実装が、既に app に 2 つある**——**`?code=` は
 *   `src/app/auth/authorization-code.ts` が Zod で見ており**、**その但し書きは
 *   §6 を名指ししている。** **PR の番号も `approve` / `merge` の受け口が Zod で
 *   見ている**（**フォームの側**）。**規則は既に一度、この形で実装されている**
 * - **規則の側に例外を書く案は採らなかった**——**例外の文言（「1 つの語で、
 *   許可した並びとの一致だけ」）では `?plan-at=` が覆えない**（**語ではなく番号**）。
 *   **覆えないものが残ると、クエリの受け方が 3 通りになる**
 * - **通り抜けは、どちらの形でも無かった**（**一致で絞る形も `as` を使っていない**）
 *   ——**選んだ理由は厳密さではなく、規則との一致である**
 *
 * **`ui` には置けない**（§3 の表。**npm を import しない**）——**語彙の並びは
 * `ui` が持ったまま**で、**確かめるのはここ**である。
 */

import { z } from "zod";

/**
 * **並べたものだけを通す。**
 *
 * **知らない値は `undefined` へ落ちる**——**画面に無いものを URL で選ばせない**
 * （#330 / #663 の線）。**同じ鍵が 2 つ載っていたら通さない**（**配列で来る**）
 * ——**片方を選ぶと、URL と画面が食い違う。**
 *
 * **並びは呼ぶ側が持つ**——**画面によって出す選択肢が違う**（#694）。
 */
export function allowedValueFrom<Value extends string>(
  value: unknown,
  options: readonly [Value, ...Value[]] | readonly Value[],
): Value | undefined {
  // **`z.enum` は 1 つ以上を要る**——**空の並びは「何も通さない」で正しい**
  const [first, ...rest] = options;
  if (first === undefined) {
    return undefined;
  }
  const parsed = z.enum([first, ...rest]).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * PR の番号。
 *
 * **`Number()` に通しただけで使わない**——**`""` は `0` に、空白は無視され**、
 * **どの PR とも違う相手を指す。** **`1e3` も `0x2a` も `Number()` は受ける**ので、
 * **形で確かめてから数にする**（#90 と同じ形）。
 *
 * **1 以上・安全に扱える整数だけを通す**（**PR 番号がそれ以外になることは無い**）。
 */
const pullRequestNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export function pullRequestNumberFrom(value: unknown): number | undefined {
  const parsed = pullRequestNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
