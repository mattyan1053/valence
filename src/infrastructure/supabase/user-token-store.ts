/**
 * ユーザートークンの置き場（Supabase）。
 *
 * **RLS と暗号の 2 枚で守る。** **どちらか片方では足りない**——
 * **RLS は「誰の行が誰に見えるか」しか決めない**ので、**バックアップ・移行・
 * 監査ログのように RLS の外を通る経路**では中身がそのまま出る。逆に、
 * **暗号だけでは「他人の行を上書きする」を止められない。**
 *
 * **本人の access token で叩く。** **secret キーを使わない**——**あれは RLS を
 * 素通りする**ので、**誰がログインしていても同じものが見えてしまう**
 * (`AGENTS.md` §6)。**この置き場の隔離は、行を返す側が決めている。**
 */

import { z } from "zod";
import type { UserTokenStore, UserTokens } from "../../application/ports/user-token-store";
import { decryptToken, type EncryptionKey, encryptToken } from "../crypto/token-cipher";

const TABLE = "user_github_tokens";

/** 差し替えられる `fetch`。**通信そのものは薄く保つ**（`user-token.ts` と同じ形）。 */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * **1 往復に使ってよい上限** (#255)。
 *
 * **返ってこない置き場は、落ちた置き場より悪い。** **失敗はどこにも出ず、
 * 待っている画面だけが残る**——**時間制限が無ければ、そこから出る道が無い。**
 *
 * **DB へ 1 往復ぶんの長さである。** **短くしすぎると、遅いだけの日に
 * ログインが壊れる**ので、**普通の往復より十分長く採る**——
 * **守りたいのは「いつか返る」ではなく「必ず終わる」**である。
 */
const DEFAULT_TIMEOUT_MS = 3_000;

export type SupabaseUserTokenStoreInput = {
  readonly url: string;
  readonly publishableKey: string;
  /** ログインしている本人。**行の持ち主であり、封じるときの相手でもある。** */
  readonly userId: string;
  /** 本人としての access token。**RLS はこれを見て `auth.uid()` を決める。** */
  readonly userAccessToken: string;
  readonly key: EncryptionKey;
  readonly fetcher?: Fetcher;
  readonly now?: () => Date;
  /** 1 往復に使ってよい上限。 */
  readonly timeoutMs?: number;
  /**
   * **待つ側と分け合う予算の残り** (#255)。**始まっていなければ `undefined`。**
   *
   * **短いほうを採る。** **待ちの上限は、待ちだけでは守れない**——
   * **止まっているのは「間合い + その間に挟まる往復」**なので、
   * **往復のほうも残りを見なければ、上限が上限にならない。**
   */
  readonly remainingMs?: () => number | undefined;
};

/**
 * 置き場のエラー。
 *
 * **応答の中身を載せない。** **行には封じた token が入る**ので、
 * そのまま文面にすると置き場の中身がログへ流れる (`AGENTS.md` §6)。
 */
function storeError(what: string, status: number): Error {
  return new Error(`保存されているトークンを${what}できません (HTTP ${status})`);
}

/**
 * 時間制限に当たったときのエラー。
 *
 * **HTTP の失敗と文面を分ける。** **返らなかったのか、断られたのか**で
 * **手当てが違う**——**混ぜると、置き場が遅いだけの日に権限を疑う。**
 */
function timeLimitError(what: string, limitMs: number): Error {
  return new Error(`保存されているトークンを${what}できません (${limitMs} ms で諦めました)`);
}

/**
 * **決めた時間で諦める。**
 *
 * **中断の口も渡す。** **投げるだけでは往復は生きたまま**で、
 * **応答を待つ socket が残る**——**諦めたなら、繋がっている口も閉じる。**
 *
 * **それでも競走で切る。** **`signal` を見ない `fetcher` は在りうる**ので、
 * **口を渡しただけでは「必ず終わる」を言えない**（**渡す側と切る側は 1 組**）。
 */
async function withinTimeLimit<T>(
  what: string,
  limitMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeLimitError(what, limitMs));
    }, limitMs);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    // **必ず止める。** **残した timer は、返ったあとの process を起こし続ける。**
    clearTimeout(timer);
  }
}

/**
 * 読む列だけを検証する。
 *
 * **`expires_at` は文字列で返る。** **`Date` へ直してから内側へ渡す**——
 * **文字列のまま渡すと、比較が辞書順になり、失効の判断が静かに壊れる。**
 */
const rowSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
});

const rowsSchema = z.array(rowSchema);

export function createSupabaseUserTokenStore({
  url,
  publishableKey,
  userId,
  userAccessToken,
  key,
  fetcher = fetch,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  remainingMs,
}: SupabaseUserTokenStoreInput): UserTokenStore {
  const endpoint = `${url.replace(/\/+$/, "")}/rest/v1/${TABLE}`;
  const headers = {
    apikey: publishableKey,
    authorization: `Bearer ${userAccessToken}`,
    "content-type": "application/json",
  };

  /** **短いほうを採る。** **分け合う予算が始まっていなければ、自分の制限だけ。** */
  function limitMs(): number {
    const shared = remainingMs?.();
    return shared === undefined ? timeoutMs : Math.min(timeoutMs, Math.max(shared, 0));
  }

  /** 1 往復ぶんを、決めた時間で切る。 */
  function limited<T>(what: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withinTimeLimit(what, limitMs(), run);
  }

  return {
    load(): Promise<UserTokens | undefined> {
      return limited("取得", async (signal) => {
        // **自分の行だけを取りに行く。** **RLS が同じ絞り込みをする**ので二重だが、
        // **絞りを外すと「他人の行が返ってこないこと」に頼った実装になる**——
        // **ポリシーが緩んだ日に、静かに他人の token を使い始める。**
        const query = `?select=access_token,refresh_token,expires_at&user_id=eq.${encodeURIComponent(userId)}`;
        const response = await fetcher(`${endpoint}${query}`, {
          method: "GET",
          headers,
          signal,
        });
        if (!response.ok) {
          throw storeError("取得", response.status);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw storeError("取得", response.status);
        }

        const parsed = rowsSchema.safeParse(payload);
        if (!parsed.success) {
          throw storeError("取得", response.status);
        }
        const row = parsed.data[0];
        if (row === undefined) {
          // **無いことは失敗ではない。** まだ 1 度も保存していない人がここへ来る。
          return undefined;
        }

        // **復号に失敗したら投げる。** **`undefined` へ倒さない**——
        // **「まだ保存していない」と読まれると、書き換えられた行が黙って上書きされる。**
        return {
          accessToken: decryptToken(key, userId, row.access_token),
          refreshToken: decryptToken(key, userId, row.refresh_token),
          expiresAt: new Date(row.expires_at),
        };
      });
    },

    save(tokens: UserTokens): Promise<void> {
      return limited("保存", async (signal) => {
        // **1 人 1 行なので、書くのは常に上書きである** (`user_id` が主キー)。
        // **`merge-duplicates` を落とすと、2 度目の保存が主キー衝突で落ちる**
        // ——**更新のたびに失敗する**ので、**症状は「1 回目だけ動く」**になる。
        const response = await fetcher(endpoint, {
          method: "POST",
          headers: { ...headers, prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            user_id: userId,
            access_token: encryptToken(key, userId, tokens.accessToken),
            refresh_token: encryptToken(key, userId, tokens.refreshToken),
            expires_at: tokens.expiresAt.toISOString(),
            updated_at: now().toISOString(),
          }),
          signal,
        });
        if (!response.ok) {
          throw storeError("保存", response.status);
        }
      });
    },

    clear(): Promise<void> {
      // **自分の行だけを狙う。** **絞りを外すと、行が返らないことに頼った実装になる**
      // ——**ポリシーが緩んだ日に、他人の行を消しに行く**（`load` と同じ判断だが、
      // **こちらは読むのではなく壊す**ので、外れたときの傷が深い）。
      //
      // **消す行が無くても成功する。** **PostgREST は 0 件の削除を 204 で返す**ので、
      // **ログアウトを 2 度押しても失敗にならない**——**失敗にすると
      // 「消えていない」と読めてしまう。**
      return limited("削除", async (signal) => {
        const query = `?user_id=eq.${encodeURIComponent(userId)}`;
        const response = await fetcher(`${endpoint}${query}`, {
          method: "DELETE",
          headers,
          signal,
        });
        if (!response.ok) {
          throw storeError("削除", response.status);
        }
      });
    },
  };
}
