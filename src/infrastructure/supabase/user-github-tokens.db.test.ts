/**
 * **他人として読むと、行が返らないこと**を、本物の Postgres で確かめる。
 *
 * **「RLS を有効にした」では足りない** (#210)。**有効でもポリシーが 1 つも無ければ
 * 本人も読めず**、**`using (true)` を書けば全員が読める**——**どちらも
 * 「有効にした」で通ってしまう。** **見るのは、返ってきた行である。**
 *
 * **service_role では試さない。** **あれは RLS を素通りする**ので、
 * **ポリシーを消しても緑のままになる。**
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

const TABLE = "user_github_tokens";

/** 封じた値の代わり。**ここで見たいのは暗号ではなく、行が誰に見えるか**である。 */
function sealedRow(user: StackUser) {
  return {
    user_id: user.id,
    access_token: `sealed-access-${user.id}`,
    refresh_token: `sealed-refresh-${user.id}`,
    expires_at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
  };
}

type Row = { user_id: string; access_token: string };

async function rowsVisibleTo(
  connection: StackConnection,
  user: StackUser,
  ownerId: string,
): Promise<Row[]> {
  const response = await requestAs(
    connection,
    user,
    `${TABLE}?select=user_id,access_token&user_id=eq.${ownerId}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Row[];
}

describe("user_github_tokens は、持ち主にしか見えない", () => {
  let connection: StackConnection;
  let owner: StackUser;
  let stranger: StackUser;

  beforeAll(async () => {
    connection = readStackConnection();
    // **2 人を別々に作る。** **同じ人で試すと、ポリシーが `auth.uid()` を見ていなくても
    // 通る**——**入力が経路を選んでしまう。**
    [owner, stranger] = await Promise.all([
      createStackUser(connection),
      createStackUser(connection),
    ]);

    const inserted = await requestAs(connection, owner, TABLE, {
      method: "POST",
      body: JSON.stringify(sealedRow(owner)),
    });
    expect(inserted.status).toBe(201);
  });

  afterAll(async () => {
    // **消せなかったら落とす。** 残ると次の周回の前提が変わる。
    await Promise.all([deleteStackUser(connection, owner), deleteStackUser(connection, stranger)]);
  });

  it("持ち主として読むと、自分の行が返る", async () => {
    const rows = await rowsVisibleTo(connection, owner, owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.access_token).toBe(`sealed-access-${owner.id}`);
  });

  it("他人として読むと、行が返らない", async () => {
    const rows = await rowsVisibleTo(connection, stranger, owner.id);
    expect(rows).toEqual([]);
  });

  it("他人の user_id では保存できない", async () => {
    const response = await requestAs(connection, stranger, TABLE, {
      method: "POST",
      body: JSON.stringify(sealedRow(owner)),
    });
    expect(response.status).toBe(403);
  });

  it("他人の行は更新できない", async () => {
    // **PostgREST は「見えない行を 0 件更新した」を成功として返す。**
    // **状態コードだけを見ると、拒否と区別が付かない**ので、**持ち主として読み直す。**
    await requestAs(connection, stranger, `${TABLE}?user_id=eq.${owner.id}`, {
      method: "PATCH",
      body: JSON.stringify({ access_token: "書き換えられた" }),
    });
    const rows = await rowsVisibleTo(connection, owner, owner.id);
    expect(rows[0]?.access_token).toBe(`sealed-access-${owner.id}`);
  });

  it("他人の行は削除できない", async () => {
    await requestAs(connection, stranger, `${TABLE}?user_id=eq.${owner.id}`, {
      method: "DELETE",
    });
    const rows = await rowsVisibleTo(connection, owner, owner.id);
    expect(rows).toHaveLength(1);
  });
});
