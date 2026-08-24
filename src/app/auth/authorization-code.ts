/**
 * **「`code` が届いた」の意味は、ここだけが持つ**（#461）。
 *
 * **前は 2 箇所にあった。** **本物の受け口は空を弾き**（`callback/route.ts`）、
 * **必ず通る境界は `searchParams.has("code")` で見ていた**（`src/middleware.ts`）
 * ——**`/?code=` にも `true`** なので、**交換できる値が届いていなくても
 * 「戻ってこなかった」が 1 行残る**（#450 と同じ形。**1 つの判定を 2 人が読んでいて、
 * 片方だけが規則を知っている**）。
 *
 * **クエリは外から来る値なので、Zod で確かめてから使う**（`AGENTS.md` §6）。
 * **domain には置けない**——**あちらは npm を import しない**ので、
 * **境界に置いて、両方がここを通る。**
 */

import { z } from "zod";

/** GitHub が返す認可コード。**空でない 1 語**だけを通す。 */
const codeSchema = z.string().trim().min(1);

/** 交換できる `code` が届いていれば、その値。**届いていなければ `undefined`。** */
export function receivedAuthorizationCode(raw: string | null): string | undefined {
  const parsed = codeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 交換できる `code` が届いているか。
 *
 * **値を返さない口を分けてある**——**呼ぶ側（`src/middleware.ts`）は、届いたことしか
 * 要らない**（**`code` は domain にも記録にも渡さない**。#455。§6）。
 */
export function hasReceivedAuthorizationCode(raw: string | null): boolean {
  return receivedAuthorizationCode(raw) !== undefined;
}
