/**
 * **押せなかった理由が、サーバ側の記録から分かること** (#506 の完了条件)。
 *
 * **画面には出せない**（4 つを 1 語にまとめてある。§6）——**残す先はここだけ**である。
 */

import { describe, expect, it } from "vitest";
import { reportBoardActionUnavailable } from "./board-action";

function lines(): { readonly write: (line: string) => void; readonly written: string[] } {
  const written: string[] = [];
  return { write: (line) => written.push(line), written };
}

describe("押せなかった理由を残す", () => {
  it("どの操作が、どの理由で押せなかったかを 1 行で残す", () => {
    const { write, written } = lines();

    reportBoardActionUnavailable("approve", "needs-login", write);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("approve");
    expect(written[0]).toContain("needs-login");
  });

  it("操作を取り違えない", () => {
    // **`approve` と `merge` を混ぜると、片方の理由がもう片方の調査に出る**
    const { write, written } = lines();

    reportBoardActionUnavailable("merge", "not-found", write);

    expect(written[0]).toContain("merge");
    expect(written[0]).not.toContain("approve");
  });
});
