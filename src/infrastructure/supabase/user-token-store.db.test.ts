/**
 * 置き場を、本物の Supabase に対して確かめる。
 *
 * **保存できたことを、保存できたことで確かめない。** **読み直して、同じ 1 組が
 * 返るところまで**を 1 つにする——**書けたのに読めない**は、**書いた瞬間には
 * 分からない**（**遅れて出る失敗**）。
 *
 * **他人として読んだときに返らないことも、ここで見る。** **RLS の試験
 * (`user-github-tokens.db.test.ts`) は生の HTTP で見ている**が、**製品コードが
 * 通る経路でも同じであること**は別の話である——**絞り込みを外した実装は、
 * ポリシーが緩んだ日に静かに他人の token を返す。**
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStackUser,
  deleteStackUser,
  readStackConnection,
  requestAs,
  type StackConnection,
  type StackUser,
} from "../../../test/supabase-stack";
import { type EncryptionKey, readEncryptionKey } from "../crypto/token-cipher";
import { createSupabaseUserTokenStore } from "./user-token-store";

/** 試験用の鍵。**32 バイトを base64 で。** */
const KEY = readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });

function storeFor(connection: StackConnection, user: StackUser, key: EncryptionKey = KEY) {
  return createSupabaseUserTokenStore({
    url: connection.url,
    publishableKey: connection.publishableKey,
    userId: user.id,
    userAccessToken: user.accessToken,
    key,
  });
}

const TOKENS = {
  accessToken: "gho_test-access",
  refreshToken: "ghr_test-refresh",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

describe("Supabase のユーザートークン置き場", () => {
  let connection: StackConnection;
  let owner: StackUser;
  let stranger: StackUser;

  beforeAll(async () => {
    connection = readStackConnection();
    [owner, stranger] = await Promise.all([
      createStackUser(connection),
      createStackUser(connection),
    ]);
  });

  afterAll(async () => {
    await Promise.all([deleteStackUser(connection, owner), deleteStackUser(connection, stranger)]);
  });

  it("まだ保存していない人には、何も返らない", async () => {
    expect(await storeFor(connection, stranger).load()).toBeUndefined();
  });

  it("保存したものを、読み直すと同じ 1 組が返る", async () => {
    const store = storeFor(connection, owner);
    await store.save(TOKENS);
    expect(await store.load()).toEqual(TOKENS);
  });

  it("2 度目の保存は、上書きになる", async () => {
    // **主キーは `user_id` なので、2 行にはならない。** **`merge-duplicates` を
    // 落とすと、ここが主キー衝突で落ちる**——**症状は「1 回目だけ動く」。**
    const store = storeFor(connection, owner);
    const renewed = { ...TOKENS, accessToken: "gho_renewed" };
    await store.save(renewed);
    expect(await store.load()).toEqual(renewed);
  });

  it("置き場には平文が入っていない", async () => {
    // **持ち主として、生の行を読む。** **封じずに入れていたら、ここに素の
    // token が見える**——**RLS が外れた日に、そのまま GitHub を叩ける。**
    const response = await requestAs(
      connection,
      owner,
      `user_github_tokens?select=access_token,refresh_token&user_id=eq.${owner.id}`,
    );
    const rows = (await response.json()) as { access_token: string; refresh_token: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.access_token).not.toContain("gho_");
    expect(rows[0]?.refresh_token).not.toContain("ghr_");
  });

  it("他人の置き場からは、その人の 1 組が読めない", async () => {
    // **他人の user_id を名乗っても返らない。** **絞り込みではなく、RLS が決める。**
    const asStranger = createSupabaseUserTokenStore({
      url: connection.url,
      publishableKey: connection.publishableKey,
      userId: owner.id,
      userAccessToken: stranger.accessToken,
      key: KEY,
    });
    expect(await asStranger.load()).toBeUndefined();
  });
});
