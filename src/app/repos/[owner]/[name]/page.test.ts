/**
 * **1 つのリポジトリの盤面を出す画面**（#314）。
 *
 * **見られないリポジトリでは、存在も漏らさない**——**画面は `not-found` を
 * 404 へ倒す**ので、**「権限がありません」と「ありません」が区別できない。**
 * **判定そのものは `viewRepositoryBoard` が持っている**（ここに書き写さない）。
 *
 * **この画面も静的に焼けない。** **出すのは「いまログインしている人に何が見えるか」**
 * で、**焼き付けたら全テナントに同じものが出る**（`AGENTS.md` §1 の逆）。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PullRequestApprovalListing } from "../../../../application/ports/pull-request-approvals";
import type { RepositoryBoardResult } from "../../../../application/review-order/view-repository-board";
import { mergeBlockFor } from "../../../../domain/graph/merge-block";
import { showsSignOut } from "../../../../ui/auth/sign-out-button";
import {
  approvalDisplay,
  approveNoticeKind,
  boardUnavailableReason,
  dynamic,
  mergeButtonBlock,
  mergeNoticeKind,
  renderRepositoryBoard,
  unreadableNote,
} from "./page";

describe("リポジトリの盤面", () => {
  it("要求ごとに描く（静的に生成させない）", () => {
    // **次に誰かが「静的にすれば速い」と外したら、ここで赤くなる。**
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("読めなかった PR を画面から消さない", () => {
  // **port が `invalid` を残しているのは、この最後の 1 歩のため**である
  // ——**捨てると「読めなかった」が「依存が無かった」に化ける。**
  it("読めなかったものがあれば、件数が出る", () => {
    expect(unreadableNote(2)).toContain("2");
  });

  it("無ければ、何も出さない", () => {
    expect(unreadableNote(0)).toBeUndefined();
  });

  it("理由は画面へ出さない", () => {
    // **Zod のメッセージには値が入りうる**（`app-credentials.ts` と同じ理由）
    expect(unreadableNote(1)).not.toMatch(/expected|received|invalid_type/i);
  });
});

describe("直前の承認の結果を出す", () => {
  // **`?approve=` は URL に載っている**ので、**誰でも好きな文字列を入れられる**
  // ——**並べたものだけを通す**（#330）
  it("知っている理由だけを通す", () => {
    for (const kind of ["forbidden", "self-approval", "unavailable"] as const) {
      expect(approveNoticeKind(kind)).toBe(kind);
    }
  });

  it("成功は、クエリ文字列から出さない", () => {
    // **`?approve=approved` を開くだけで「承認しました」と出てはならない**
    // （#342 のレビュー）——**利用者が任意に作れる値から、成功を断言しない。**
    expect(approveNoticeKind("approved")).toBeUndefined();
  });

  it("知らない値は通さない", () => {
    // **通すと、こちらが言っていないことを画面に言わせられる**
    for (const value of ["", "ok", "承認しました", 1, null, undefined, ["forbidden"]]) {
      expect(approveNoticeKind(value), String(value)).toBeUndefined();
    }
  });
});

describe("直前にマージできなかった理由を出す", () => {
  it("知っている理由だけを通す", () => {
    for (const kind of ["forbidden", "not-mergeable", "unavailable"] as const) {
      expect(mergeNoticeKind(kind)).toBe(kind);
    }
  });

  it("成功は、クエリ文字列から出さない", () => {
    // **`?merge=merged` を開くだけで「マージしました」と出てはならない**（#342 と同じ）
    expect(mergeNoticeKind("merged")).toBeUndefined();
  });

  it("依存の理由も通す", () => {
    for (const kind of ["dependency-pending", "not-orderable"] as const) {
      expect(mergeNoticeKind(kind)).toBe(kind);
    }
  });

  it("知らない値は通さない", () => {
    for (const value of ["", "ok", "マージしました", 1, null, undefined, ["forbidden"]]) {
      expect(mergeNoticeKind(value), String(value)).toBeUndefined();
    }
  });
});

/**
 * **承認済みかどうかを盤面に出す**（#343）。
 *
 * **押した結果は、盤面そのもので確かめる**——**成功はクエリ文字列に載らない**
 * （#342 のレビュー）。**この関数が読むのは、GitHub から引いた状態だけ**である
 * ——**引数に検索文字列が無いので、URL からは作れない。**
 */
describe("承認の状態を盤面へ出す", () => {
  const listing = (
    overrides: Partial<PullRequestApprovalListing> = {},
  ): PullRequestApprovalListing => ({
    approved: new Set(),
    unavailable: [],
    ...overrides,
  });

  it("承認済みの PR は、承認済みとして出す", () => {
    // **これが無いと、押した人は「何も起きなかった」と読んでもう一度押す**
    expect(approvalDisplay(7, listing({ approved: new Set([7]) }))).toBe("approved");
  });

  it("承認されていない PR は、承認済みに見せない", () => {
    // **全部を承認済みにする実装でも、上の 1 件だけなら緑になる**
    expect(approvalDisplay(8, listing({ approved: new Set([7]) }))).toBeUndefined();
  });

  it("読めなかった PR は、承認されていないと混ぜない", () => {
    // **同じ見た目にすると、押した人は「承認されていない」と読む**
    // ——**実際には、こちらが見ていないだけ**である
    expect(
      approvalDisplay(
        8,
        listing({ unavailable: [{ pullRequestNumber: 8, reason: "読めません" }] }),
      ),
    ).toBe("unknown");
  });

  it("読めなかった理由は、盤面へ出さない", () => {
    // **理由には値が入りうる**（`unreadableNote` と同じ理由）——**種別だけを返す**
    const display = approvalDisplay(
      8,
      listing({ unavailable: [{ pullRequestNumber: 8, reason: "secret-repository-name" }] }),
    );

    expect(String(display)).not.toContain("secret-repository-name");
  });
});

describe("依存の判定を、ボタンへ詰め替える", () => {
  // **判定そのものは domain が持つ**（#345）——**ここは詰め替えるだけ**
  it("土台が残っていれば、番号を渡す", () => {
    expect(mergeButtonBlock({ kind: "depends-on", numbers: [8] })).toEqual({ blockedBy: [8] });
  });

  it("順序が決められなければ、そう渡す", () => {
    expect(mergeButtonBlock({ kind: "not-orderable" })).toEqual({ notOrderable: true });
  });

  it("依存が無ければ、何も渡さない", () => {
    // **渡すと、押せる PR まで閉じる**
    expect(mergeButtonBlock({ kind: "ready" })).toEqual({});
  });

  it("読めなかった PR があれば、押させない側へ倒す", () => {
    // **図に抜けがあるなら「依存なし」を信じられない**（#348 のレビュー）——
    // **判定は domain が持つ**ので、ここは詰め替えるだけ
    const edges = [{ dependent: 9, dependsOn: 8 }];
    const order = { ordered: [8, 9], cyclic: [] };

    expect(mergeButtonBlock(mergeBlockFor(8, edges, order, 0))).toEqual({});
    expect(mergeButtonBlock(mergeBlockFor(8, edges, order, 1))).toEqual({ notOrderable: true });
  });
});

describe("盤面を出せなかった理由を、サーバ側へ残す（#513 のレビュー）", () => {
  // **押した経路と同じものが、見に来た経路にもある**——**GET で落ちても、
  // 画面には「いま見られません」しか出ない**（§6）ので、**記録が要る。**

  it("落ちどころまで残す", () => {
    expect(boardUnavailableReason({ kind: "unavailable", reason: "store/Error" })).toBe(
      "unavailable/store/Error",
    );
  });

  it("落ちどころが無ければ、まとめた語だけ残す", () => {
    expect(boardUnavailableReason({ kind: "unavailable" })).toBe("unavailable");
  });

  it("見られたときは、残さない", () => {
    // **毎回鳴る記録は、そのうち読まれなくなる**（#248）
    expect(boardUnavailableReason({ kind: "board" })).toBeUndefined();
  });

  it("ログインの状態は、この口では残さない", () => {
    // **`signed-out` / `needs-login` は画面に出ている**（ログインへの導線がある）
    expect(boardUnavailableReason({ kind: "signed-out" })).toBeUndefined();
    expect(boardUnavailableReason({ kind: "needs-login" })).toBeUndefined();
  });
});

/**
 * **記録の口を呼んでいること**（#519）。
 *
 * **`boardUnavailableReason`（何を残すか）は上で測れている**が、**それが GET の
 * 経路から呼ばれること**は測れていなかった——**呼び出しの 1 行を消しても緑**だった。
 *
 * **受け口を引数で渡す**（#510 で POST を割ったのと同じ形）——**モックは使わない**
 * （`AGENTS.md` §4）。**判定は `boardUnavailableReason` のまま 1 箇所**である（§5）。
 */
describe("盤面（GET）で落ちたことを、記録の口へ渡す", () => {
  const recorder = () => {
    const recorded: string[] = [];
    return {
      recorded,
      report: (action: "view", kind: string) => {
        recorded.push(`${action}=${kind}`);
      },
    };
  };

  it("出せなかったときは、落ちどころまで渡る", async () => {
    const { recorded, report } = recorder();

    await renderRepositoryBoard(
      { owner: "acme", name: "web" },
      {},
      { board: async () => ({ kind: "unavailable", reason: "store/Error" }), report },
    );

    expect(recorded).toEqual(["view=unavailable/store/Error"]);
  });

  it("ログインの状態は、この口では残さない", async () => {
    // **毎回鳴る記録は、そのうち読まれなくなる**（#248）——**画面に出ているものは残さない**
    const { recorded, report } = recorder();

    await renderRepositoryBoard(
      { owner: "acme", name: "web" },
      {},
      { board: async () => ({ kind: "signed-out" }), report },
    );

    expect(recorded).toEqual([]);
  });

  it("どのリポジトリを見るかは、要求ごとに渡す", async () => {
    // **設定に固定しない**（§1）——**受け取ったものがそのまま内側へ渡ること**
    const asked: string[] = [];
    const { report } = recorder();

    await renderRepositoryBoard(
      { owner: "acme", name: "web" },
      {},
      {
        board: async (repository) => {
          asked.push(`${repository.owner}/${repository.name}`);
          return { kind: "signed-out" };
        },
        report,
      },
    );

    expect(asked).toEqual(["acme/web"]);
  });
});

/**
 * **箱の札と、その隣のボタンが食い違わない**（#541 のレビュー）。
 *
 * **`head.sha` が欠けた応答は、意図して正常な PR として図に残す**
 * （`pull-request-mapping.ts`）。**そのとき `MergeButton` は無効になる**
 * （**確かめられない対象をマージさせない**）が、**`MergeBlock` は依存の順序しか
 * 知らない**ので `ready` を返す——**無効なボタンの隣に「押せる」と出ていた。**
 *
 * **#345 が閉じたのは「規則の写し」で、ここは「語の広さ」**である——**入り口が違う。**
 *
 * **踏む形を入力に置いて測る**（#505）——**両方を同じ描画から読む**ので、
 * **片方だけ直しても緑にならない。**
 */
describe("commit が分からない PR", () => {
  const pullRequest = (number: number, base: string, head: string) => ({
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  });

  /** **#1 は commit が分かる。#2 は分からない。** どちらも依存は残っていない。 */
  async function board(): Promise<string> {
    return renderToStaticMarkup(
      await renderRepositoryBoard(
        { owner: "acme", name: "web" },
        {},
        {
          board: async () => ({
            kind: "board",
            plan: {
              pullRequests: [pullRequest(1, "main", "feat/a"), pullRequest(2, "main", "feat/b")],
              edges: [],
              order: { ordered: [1, 2], cyclic: [] },
              invalid: [],
              changes: new Map(),
              changesUnavailable: [],
              heads: new Map([[1, "abc1234"]]),
              titles: new Map([[1, "依存グラフを図にする"]]),
            },
            approvals: { approved: new Set<number>(), unavailable: [] },
          }),
          report: () => {},
        },
      ),
    );
  }

  /** 箱 1 つぶんの文字。**番号は箱の先頭にある。** */
  function boxOf(markup: string, number: number): string {
    const found = [...markup.matchAll(/<g>([\s\S]*?)<\/g>/g)]
      .map(([, inner]) =>
        (inner ?? "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((box) => box.startsWith(`#${number} `));
    expect(found, `#${number} の箱が 1 つに定まらない`).toHaveLength(1);
    return found[0] ?? "";
  }

  /** その PR の Merge ボタンが無効か。**`number` を持つ form の中だけを見る。** */
  function mergeDisabled(markup: string, number: number): boolean {
    const forms = [...markup.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)]
      .map(([, inner]) => inner ?? "")
      .filter((inner) => inner.includes(`value="${number}"`) && inner.includes("Merge"));
    expect(forms, `#${number} の Merge が 1 つに定まらない`).toHaveLength(1);
    return (forms[0] ?? "").includes("disabled=");
  }

  it("押せないボタンの隣に「押せる」と出さない", async () => {
    const markup = await board();

    expect(mergeDisabled(markup, 2), "commit が分からないのに押せてしまう").toBe(true);
    expect(boxOf(markup, 2), "無効なボタンの隣で「押せる」と言っている").not.toContain("押せる");
  });

  it("commit が分かる PR は、これまでどおり押せると出る", async () => {
    // **片側だけを見ると、全部に「押せない」と出しても緑になる**
    const markup = await board();

    expect(mergeDisabled(markup, 1), "押せるはずのボタンが無効になっている").toBe(false);
    expect(boxOf(markup, 1)).toContain("押せる");
  });

  /**
   * **盤面が持っているタイトルが、箱まで届く**（#542）。
   *
   * **画面の側で渡し忘れると、どの箱も「タイトル不明」になる**——**取れているのに
   * 取れていないと言う**ので、**配線をここで押さえる。**
   */
  it("取れているタイトルが、箱に出る", async () => {
    const markup = await board();

    expect(boxOf(markup, 1), "箱にタイトルが届いていない").toContain("依存グラフを図にする");
    expect(boxOf(markup, 2), "取れていないタイトルを、空欄で出している").toContain("タイトル不明");
  });
});

describe("盤面からログアウトできる", () => {
  // **入れるが出られない**（#563）——**GitHub の token は 8 時間で切れる**が、
  // **Supabase のセッションはもっと長く生きる。** **その差の間、盤面は
  // 「入り直してください」と言うのに、いまのセッションを捨てる手が無かった。**
  async function markup(result: RepositoryBoardResult): Promise<string> {
    return renderToStaticMarkup(
      await renderRepositoryBoard(
        { owner: "acme", name: "web" },
        {},
        { board: async () => result, report: () => {} },
      ),
    );
  }

  it("期限が切れている画面から、POST で出せる", async () => {
    // **この Issue が塞ぎに来た場面そのもの**である
    const html = await markup({ kind: "needs-login" });

    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain('method="post"');
  });

  it("ログインしていない画面には出さない", async () => {
    expect(await markup({ kind: "signed-out" })).not.toContain("/auth/logout");
  });

  it("判定は書き写さない", async () => {
    // **出す・出さないを決めるのは `showsSignOut` ひとつ**である（§5）
    // ——**入口の画面と 2 箇所に置くと、片方だけが直る**
    expect(showsSignOut("needs-login")).toBe(true);
    expect(showsSignOut("signed-out")).toBe(false);
  });
});

describe("材料が出せなかったことを、サーバ側に残す（#573）", () => {
  /**
   * **`changesUnavailable` は計算されていたのに、どこへも渡っていなかった**
   * ——**画面は「まだ取得できていません」と出し、記録には 1 行も出ない。**
   * **だから、誰も理由を answer できなかった**（#573 の「最初の一手」が空振りする）。
   *
   * **実測（2026-09-02）**: **取得は成功していて 5627 ms**、**期限は 5000 ms**。
   * **毎回打ち切られていた**——**記録があれば `timedout` の 1 行で分かった。**
   */
  function recorder() {
    const recorded: string[] = [];
    return {
      recorded,
      report: (action: "view", kind: string) => recorded.push(`${action}=${kind}`),
    };
  }

  const plan = (unavailable: { pullRequestNumber: number; kind: string; reason: string }[]) => ({
    kind: "board" as const,
    plan: {
      pullRequests: [],
      edges: [],
      order: { ordered: [], cyclic: [] },
      invalid: [],
      changes: new Map(),
      changesUnavailable: unavailable,
      heads: new Map(),
      titles: new Map(),
    },
    approvals: { approved: new Set<number>(), unavailable: [] },
  });

  it("打ち切られたことが、記録に残る", async () => {
    const { recorded, report } = recorder();

    await renderRepositoryBoard(
      { owner: "acme", name: "web" },
      {},
      {
        board: async () =>
          plan([
            { pullRequestNumber: 1, kind: "timedout", reason: "期限までに材料が返りませんでした" },
          ]) as never,
        report,
      },
    );

    expect(recorded, "材料が出せなかったことが残っていない").toContain("view=changes/timedout");
  });

  it("同じ理由は 1 行にまとめる", async () => {
    // **毎回鳴る記録は、そのうち読まれなくなる**（#248）——**PR の本数ぶん出さない**
    const { recorded, report } = recorder();

    await renderRepositoryBoard(
      { owner: "acme", name: "web" },
      {},
      {
        board: async () =>
          plan([
            { pullRequestNumber: 1, kind: "timedout", reason: "x" },
            { pullRequestNumber: 2, kind: "timedout", reason: "x" },
          ]) as never,
        report,
      },
    );

    expect(recorded.filter((line) => line === "view=changes/timedout")).toHaveLength(1);
  });

  it("理由そのものは残さない", async () => {
    // **`reason` には応答の値が入りうる**（`AGENTS.md` §6）——**残すのは `kind` だけ**
    const { recorded, report } = recorder();

    await renderRepositoryBoard(
      { owner: "acme", name: "web" },
      {},
      {
        board: async () =>
          plan([
            { pullRequestNumber: 1, kind: "unreadable", reason: "PR の詳細を読めません: 秘密" },
          ]) as never,
        report,
      },
    );

    expect(recorded.join(" ")).not.toContain("秘密");
  });

  it("材料が揃っていれば、何も残さない", async () => {
    // **平常時に鳴る記録は読まれなくなる**（#248）
    const { recorded, report } = recorder();

    await renderRepositoryBoard(
      { owner: "acme", name: "web" },
      {},
      { board: async () => plan([]) as never, report },
    );

    expect(recorded).toEqual([]);
  });
});

describe("盤面が、理由を部品まで渡す（#577 のレビュー 2 周目）", () => {
  /**
   * **`page.tsx` の `changeUnavailableOf` を消しても、全試験が通っていた。**
   *
   * - **`plan()` は `pullRequests: []`** ——**行を 1 度も描かない**
   * - **`review-board.test.ts` は `ReviewBoard` へ直接渡している**
   *   ——**部品は押さえたが、page からの配線は誰も見ていない**
   *
   * **本番だけが「まだ取得できていません」に戻る**——**この Issue の元の症状**である。
   *
   * **守りたいのは 1 行**である（`page.tsx` の `changeUnavailableOf`）。
   * **変異は、その 1 行だけを消して打つ**——**前の周回は周りごと消していて、
   * `headKnown` が落ちた別の理由で赤くなっていた**（**当たっていない変異**）。
   */
  async function markup(
    unavailable: { pullRequestNumber: number; kind: string; reason: string }[],
  ) {
    return renderToStaticMarkup(
      await renderRepositoryBoard(
        { owner: "acme", name: "web" },
        {},
        {
          board: async () =>
            ({
              kind: "board",
              plan: {
                // **行を描く**——**空だと、配線を消しても気づけない**
                pullRequests: [
                  {
                    number: 1,
                    base: { repository: "r", branch: "main" },
                    head: { repository: "r", branch: "feat/a" },
                  },
                ],
                edges: [],
                order: { ordered: [1], cyclic: [] },
                invalid: [],
                // **材料は無い**——**理由の側だけを変える**
                changes: new Map(),
                changesUnavailable: unavailable,
                heads: new Map([[1, "a".repeat(40)]]),
                titles: new Map(),
              },
              approvals: { approved: new Set<number>(), unavailable: [] },
            }) as never,
          report: () => {},
        },
      ),
    );
  }

  it("打ち切られたことが、行に出る", async () => {
    const html = await markup([
      { pullRequestNumber: 1, kind: "timedout", reason: "期限までに材料が返りませんでした" },
    ]);

    expect(html, "page から部品へ理由が渡っていない").toContain("時間内に返りませんでした");
  });

  it("読めなかったことも、行に出る", async () => {
    const html = await markup([
      { pullRequestNumber: 1, kind: "unreadable", reason: "PR の詳細を読めません" },
    ]);

    expect(html).toContain("読めませんでした");
  });

  it("理由が無ければ、これまでどおり", async () => {
    // **上の判定が空でないことを、ここが支えている**
    const html = await markup([]);

    expect(html).toContain("まだ取得できていません");
    expect(html).not.toContain("時間内に返りませんでした");
  });

  it("別の PR の理由を、この行に出さない", async () => {
    // **番号で引いている**ことを見る——**`find` が最初の 1 件を返すだけだと、
    // どの行にも同じ理由が出る**
    const html = await markup([{ pullRequestNumber: 999, kind: "timedout", reason: "別の PR" }]);

    expect(html).toContain("まだ取得できていません");
    expect(html).not.toContain("時間内に返りませんでした");
  });
});
