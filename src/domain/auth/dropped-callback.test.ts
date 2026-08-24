/**
 * **戻ってくるはずのものが、戻ってこなかった** (#455)。
 *
 * **戻り先が GoTrue の許可一覧に当たらないと、GoTrue は黙って `site_url` へ落として戻す。**
 * **`/auth/callback` が呼ばれない**ので、**ログインが落ちた段の記録**（#248）**も出ない**
 * ——**利用者に見えるのは「ログインすると並びます」の画面だけ**である。
 *
 * **こちらが落としたとは言えない。** **言えるのは「`code` が、来るはずのない場所へ来た」**まで。
 */

import { describe, expect, it } from "vitest";
import { looksLikeDroppedCallback } from "./dropped-callback";

describe("戻ってこなかったコールバック", () => {
  it("`/` に code が来たら、戻ってこなかったと読む", () => {
    // **2026-08-24 に実際にこうなった**——`GET /?code=7405c683-…` が 200 で返っている
    expect(looksLikeDroppedCallback({ pathname: "/", hasCode: true })).toBe(true);
  });

  it("`/auth/callback` の code は、戻ってきている", () => {
    // **正常な経路で鳴らさない**——**毎回出る案内は読まれなくなる**
    expect(looksLikeDroppedCallback({ pathname: "/auth/callback", hasCode: true })).toBe(false);
  });

  it("code が無ければ、何も言わない", () => {
    expect(looksLikeDroppedCallback({ pathname: "/", hasCode: false })).toBe(false);
  });

  it("`site_url` が `/` でなくても読める", () => {
    // **落ちる先は `site_url`** である——**`/` に決め打つと、設定を変えた日に黙る。**
    // **見るのは「`/auth/callback` ではないところへ来た」**ことのほうである
    expect(looksLikeDroppedCallback({ pathname: "/repos/acme/app", hasCode: true })).toBe(true);
  });
});
