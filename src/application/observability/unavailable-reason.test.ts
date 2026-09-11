/**
 * **出せなかった理由を、記録の側の語へ落とす**（#513 のレビュー。#690 で `app` から移した）。
 *
 * **押した経路と同じものが、見に来た経路にもある**——**GET で落ちても、画面には
 * 「いま見られません」しか出ない**（`AGENTS.md` §6）ので、**記録が要る。**
 *
 * **入口の画面（横断の一覧）も同じ判定を使う**ので、**片方のルートには置けない。**
 */

import { describe, expect, it } from "vitest";
import { unavailableReason } from "./unavailable-reason";

describe("unavailableReason", () => {
  it("落ちどころまで残す", () => {
    expect(unavailableReason({ kind: "unavailable", reason: "store/Error" })).toBe(
      "unavailable/store/Error",
    );
  });

  it("落ちどころが無ければ、まとめた語だけ残す", () => {
    expect(unavailableReason({ kind: "unavailable" })).toBe("unavailable");
  });

  it("出せたときは、残さない", () => {
    // **毎回鳴る記録は、そのうち読まれなくなる**（#248）
    expect(unavailableReason({ kind: "board" })).toBeUndefined();
  });

  it("ログインの状態は、この口では残さない", () => {
    // **`signed-out` / `needs-login` は画面に出ている**（ログインへの導線がある）
    expect(unavailableReason({ kind: "signed-out" })).toBeUndefined();
    expect(unavailableReason({ kind: "needs-login" })).toBeUndefined();
  });
});
