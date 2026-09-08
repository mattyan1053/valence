import { describe, expect, it } from "vitest";
import { toBaseCi, toBaseRefPath, toChangeSummary, toCommitSha } from "./change-summary-mapping";

const DETAIL = { changed_files: 3, additions: 10, deletions: 4 };
const FILES = [{ filename: "src/ui/button.tsx" }];
const PASSING = { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] };
/** Commit Status しか登録しないリポジトリもある。**既定は「信号なし」。** */
const NO_STATUSES = { state: "pending", statuses: [] };

describe("toChangeSummary", () => {
  it("実データの形から材料を組み立てる", () => {
    const result = toChangeSummary({
      detail: DETAIL,
      files: FILES,
      filesTruncated: false,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    expect(result).toEqual({
      ok: true,
      summary: {
        changedFileCount: 3,
        // **追加と削除を足す。** 片方だけだと、消しただけの大きな変更が小さく見える
        changedLineCount: 14,
        changedPaths: { paths: ["src/ui/button.tsx"], truncated: false },
        ciStatus: "passing",
        failingChecks: [],
        baseCi: undefined,
      },
    });
  });

  it("移す前のパスも、材料に載せる", () => {
    // **`previous_filename` を捨てると、実装を `docs/` へ移した PR が
    // 「ドキュメントだけです」になる**（#647 のレビュー）——**元の場所から
    // 消えた事実が隠れる。**
    //
    // **件数は `changed_files` が持っている**ので、**行が増えても数は狂わない。**
    const result = toChangeSummary({
      detail: DETAIL,
      files: [{ filename: "docs/foo.ts", previous_filename: "src/domain/foo.ts" }],
      filesTruncated: false,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    expect(result.ok && result.summary.changedPaths.paths).toEqual([
      "docs/foo.ts",
      "src/domain/foo.ts",
    ]);
    expect(result.ok && result.summary.changedFileCount, "件数まで増えている").toBe(3);
  });

  it("移していないファイルに、余分な行を作らない", () => {
    const result = toChangeSummary({
      detail: DETAIL,
      files: FILES,
      filesTruncated: false,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    expect(result.ok && result.summary.changedPaths.paths).toEqual(["src/ui/button.tsx"]);
  });

  it("移す前が影響の大きいパスなら、そちらでも当てる", () => {
    // **`.env` を移した PR は「機密パスに触れた」側である**（#647 のレビュー）
    // ——**移した先の名前だけを見ると、触れていないことになる。**
    const result = toChangeSummary({
      detail: DETAIL,
      files: [{ filename: "config/example", previous_filename: ".env" }],
      filesTruncated: true,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    // **見切れていても、当たれば材料にしてよい**（残りを見ても結論は変わらない）
    expect(result.ok).toBe(true);
  });

  it("変更ファイルのパスを、そのまま材料に載せる", () => {
    // **件数だけにしない。** 取得の段階ではパスが在るので、**捨てずに渡す**
    const result = toChangeSummary({
      detail: DETAIL,
      files: [{ filename: "src/ui/button.tsx" }, { filename: "src/domain/triage/risk-tier.ts" }],
      filesTruncated: false,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    expect(result.ok && result.summary.changedPaths).toEqual({
      paths: ["src/ui/button.tsx", "src/domain/triage/risk-tier.ts"],
      truncated: false,
    });
  });

  describe("CI の 3 状態", () => {
    it.each([
      [{ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] }, "passing"],
      [{ check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] }, "failing"],
      [{ check_runs: [{ name: "test", status: "in_progress", conclusion: null }] }, "pending"],
      // **終わっているものと落ちているものが混ざれば落ちている**
      [
        {
          check_runs: [
            { name: "test", status: "completed", conclusion: "success" },
            { name: "test", status: "completed", conclusion: "failure" },
          ],
        },
        "failing",
      ],
      // **走っている途中で 1 つ落ちていれば、待っても直らない**
      [
        {
          check_runs: [
            { name: "test", status: "in_progress", conclusion: null },
            { name: "test", status: "completed", conclusion: "failure" },
          ],
        },
        "failing",
      ],
      // **1 件も無いのを passing にしない**（CI が動いていない PR が素通りする）
      [{ check_runs: [] }, "pending"],
      // **知らない結末を passing にしない。** `conclusion` は GitHub が増やす値で、
      // 増えたことを知る手立てがない（#114 の「列挙は必ず古くなる」と同じ）
      [{ check_runs: [{ name: "test", status: "completed", conclusion: "stale" }] }, "failing"],
      [
        { check_runs: [{ name: "test", status: "completed", conclusion: "これから増える値" }] },
        "failing",
      ],
      // **通ったと見なすものは明示する**
      [{ check_runs: [{ name: "test", status: "completed", conclusion: "skipped" }] }, "passing"],
      [{ check_runs: [{ name: "test", status: "completed", conclusion: "neutral" }] }, "passing"],
    ])("%o は %s", (checks, expected) => {
      const result = toChangeSummary({
        detail: DETAIL,
        files: FILES,
        filesTruncated: false,
        checks,
        statuses: NO_STATUSES,
      });

      expect(result.ok && result.summary.ciStatus).toBe(expected);
    });
  });

  describe("Commit Status しか使わないリポジトリ", () => {
    // **道具立てを前提にしない**（`AGENTS.md` §1）。Checks API を使わず
    // Commit Status だけを登録する CI がある。**両方見て初めてどちらでも動く**
    function ciOf(checks: unknown, statuses: unknown): string | false {
      const result = toChangeSummary({
        detail: DETAIL,
        files: FILES,
        filesTruncated: false,
        checks,
        statuses,
      });
      return result.ok && result.summary.ciStatus;
    }

    it("check run が無くても、Commit Status が通っていれば passing", () => {
      expect(
        ciOf(
          { check_runs: [] },
          { state: "success", statuses: [{ context: "ci", state: "success" }] },
        ),
      ).toBe("passing");
    });

    it("Commit Status が落ちていれば failing", () => {
      expect(
        ciOf(PASSING, { state: "failure", statuses: [{ context: "ci", state: "failure" }] }),
      ).toBe("failing");
    });

    it("Commit Status が走っていれば pending", () => {
      expect(
        ciOf(PASSING, { state: "pending", statuses: [{ context: "ci", state: "pending" }] }),
      ).toBe("pending");
    });

    it("どちらにも信号が無ければ pending", () => {
      // **1 つも無いのを passing にしない**（CI が動いていない PR が素通りする）
      expect(ciOf({ check_runs: [] }, NO_STATUSES)).toBe("pending");
    });
  });

  describe("見ていないものを「無い」にしない", () => {
    it("見切れていて、影響が大きいパスが見つからなければ材料にしない", () => {
      // **「触れていない」と「見ていない」を混同しない**（#107 / #114 と同じ考え方）。
      // false を入れると、**見ていないだけの PR に「読まずにマージしてよい」と出る**
      const result = toChangeSummary({
        detail: DETAIL,
        files: FILES,
        filesTruncated: true,
        checks: PASSING,
        statuses: NO_STATUSES,
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/見切れ|多すぎ/);
    });

    it("見切れていても、見えた範囲で当たっていれば材料になる", () => {
      // **当たったことは確かである。** 残りを見なくても結論は変わらない
      const result = toChangeSummary({
        detail: DETAIL,
        files: [{ filename: ".env" }],
        filesTruncated: true,
        checks: PASSING,
        statuses: NO_STATUSES,
      });

      // **見切れたことを、材料の側にも残す**（**部分の一覧を全部だと読ませない**）
      expect(result.ok && result.summary.changedPaths).toEqual({
        paths: [".env"],
        truncated: true,
      });
    });
  });

  it.each([
    ["詳細が読めない", { detail: { additions: 1 }, files: FILES, checks: PASSING }],
    ["ファイル一覧が読めない", { detail: DETAIL, files: [{ name: "x" }], checks: PASSING }],
    ["CI の応答が読めない", { detail: DETAIL, files: FILES, checks: { check_runs: "?" } }],
  ])("%s なら材料にしない", (_name, input) => {
    // **読めなかったものを推測で埋めない。** 埋めると、誤った Tier が理由つきで出る
    const result = toChangeSummary({ statuses: NO_STATUSES, ...input, filesTruncated: false });

    expect(result.ok).toBe(false);
  });
});

describe("落ちている check を名前で残す", () => {
  // **突き合わせるには名前が要る**（#638）。**3 値に潰れた `ciStatus` は
  // 「どれが落ちたか」を持っていない**ので、マージ先と比べられない。
  function failingOf(checks: unknown, statuses: unknown) {
    const result = toChangeSummary({
      detail: DETAIL,
      files: FILES,
      filesTruncated: false,
      checks,
      statuses,
    });
    return result.ok ? result.summary.failingChecks : undefined;
  }

  it("落ちた check run を、名前と落ち方と発行元で残す", () => {
    // **発行元まで残す**（#610）——**同名の check を複数の App が出す**
    expect(
      failingOf(
        {
          check_runs: [
            { name: "test", status: "completed", conclusion: "failure", app: { id: 15368 } },
            { name: "lint", status: "completed", conclusion: "success", app: { id: 15368 } },
          ],
        },
        NO_STATUSES,
      ),
    ).toEqual([{ kind: "check-run", name: "test", outcome: "failure", appId: 15368 }]);
  });

  it("発行元を持たない応答でも、材料にはする", () => {
    // **`app` は API の側で null になりうる。** **材料ごと捨てると、
    // その PR は Tier まで出なくなる**——**突き合わせが立たないだけにする**
    expect(
      failingOf(
        { check_runs: [{ name: "test", status: "completed", conclusion: "failure", app: null }] },
        NO_STATUSES,
      ),
    ).toEqual([{ kind: "check-run", name: "test", outcome: "failure", appId: undefined }]);
  });

  it("落ちた Commit Status も、同じ形で残す", () => {
    // **道具立てを前提にしない**（`AGENTS.md` §1）。Commit Status だけの CI がある
    expect(
      failingOf(
        { check_runs: [] },
        { state: "failure", statuses: [{ context: "ci/travis", state: "error" }] },
      ),
    ).toEqual([{ kind: "commit-status", name: "ci/travis", outcome: "error" }]);
  });

  it("通っている PR には、落ちている check が 1 件も無い", () => {
    // **`ciStatus` と食い違わせない。** 同じ材料から作るので、
    // **「落ちているのに 1 件も挙がらない」は起きない**
    expect(failingOf(PASSING, NO_STATUSES)).toEqual([]);
  });

  it("走っている途中のものは、落ちている側に入れない", () => {
    // **待てば済むものを「直さないと進まない」に混ぜない**
    expect(
      failingOf(
        { check_runs: [{ name: "test", status: "in_progress", conclusion: null }] },
        NO_STATUSES,
      ),
    ).toEqual([]);
  });

  it("名前を読めない応答は、材料にしない", () => {
    // **名前は Checks API / Commit Status のどちらでも必須**である。
    // **無いものを空文字で埋めると、無関係な失敗どうしが一致する**
    expect(
      failingOf({ check_runs: [{ status: "completed", conclusion: "failure" }] }, NO_STATUSES),
    ).toBeUndefined();
  });

  it("突き合わせ先は、ここでは付けない", () => {
    // **付けるのは、どの commit と比べるかを決める側**（infrastructure）である。
    // **付け忘れたときに倒れる先は「突き合わせられなかった」**——安全な側である
    const result = toChangeSummary({
      detail: DETAIL,
      files: FILES,
      filesTruncated: false,
      checks: PASSING,
      statuses: NO_STATUSES,
    });

    expect(result.ok && result.summary.baseCi).toBeUndefined();
  });
});

describe("toBaseRefPath", () => {
  it("マージ先のブランチ名を、URL の段として返す", () => {
    expect(toBaseRefPath({ base: { ref: "main" } })).toBe("main");
  });

  it("`/` は段の区切りとして残す", () => {
    expect(toBaseRefPath({ base: { ref: "feat/638-ci-blame" } })).toBe("feat/638-ci-blame");
  });

  it.each([
    // **インストール先は 1 つではない**（`AGENTS.md` §1）——**このリポジトリの
    // 枝の付け方を、他所の枝にも当てはめない。** **Git で有効なものは通す。**
    ["release/2.0+hotfix", "release/2.0%2Bhotfix"],
    ["_private", "_private"],
    ["fix/#123", "fix/%23123"],
    ["100%-done", "100%25-done"],
    ["日本語の枝名", "%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%81%AE%E6%9E%9D%E5%90%8D"],
    // **自分が置いた `%` を二重に包む**（`bin/loop-ci-status` と同じ話）
    // ——**包まないと、`%2F` を含む枝名が `/` に化けて別の段になる**
    ["a%2Fb", "a%252Fb"],
  ])("Git で有効な %s は通す", (ref, expected) => {
    expect(toBaseRefPath({ base: { ref } })).toBe(expected);
  });

  it.each([
    ["読めない", {}],
    ["空", { base: { ref: "" } }],
    ["上の階層へ出る", { base: { ref: "../../../orgs/other/secrets" } }],
    ["段の途中に上がある", { base: { ref: "main/../../orgs" } }],
    // **段の中の `..` も Git が禁じている**（段の頭の `.` とは別の規則）
    ["段の中に `..` がある", { base: { ref: "feat/a..b" } }],
    ["段が空", { base: { ref: "feat//x" } }],
    ["段の頭が `/`", { base: { ref: "/main" } }],
    ["段の末尾が `/`", { base: { ref: "main/" } }],
    ["段が `.` で始まる", { base: { ref: "feat/.hidden" } }],
    ["段が `.` で終わる", { base: { ref: "main." } }],
    ["段が `.lock` で終わる", { base: { ref: "main.lock" } }],
    ["制御文字を含む", { base: { ref: "ma\u0000in" } }],
    ["空白を含む", { base: { ref: "my branch" } }],
    ["Git が禁じる記号を含む", { base: { ref: "feat/x?y" } }],
    ["`@{` を含む", { base: { ref: "main@{1}" } }],
    ["`@` だけ", { base: { ref: "@" } }],
    // **長すぎるものは弾く。** **URL のパスへ入る値**なので、上限を持たせておく
    ["長すぎる", { base: { ref: "a".repeat(256) } }],
  ])("%s ものは URL に入れない", (_name, detail) => {
    // **未検証の値を URL のパスへ入れない**（`AGENTS.md` §6）。
    // **installation トークンが付いている**ので、別の endpoint を叩けてしまう
    expect(toBaseRefPath(detail)).toBeUndefined();
  });
});

describe("toBaseCi", () => {
  it("マージ先で落ちている check を、同じ形で残す", () => {
    expect(
      toBaseCi(
        { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] },
        NO_STATUSES,
      ),
    ).toEqual({
      settled: true,
      failing: [{ kind: "check-run", name: "test", outcome: "failure" }],
    });
  });

  it("CI が終わっていなければ、そう言う", () => {
    // **走っている最中は「落ちていない」ではなく「まだ分からない」**
    expect(
      toBaseCi({ check_runs: [{ name: "test", status: "queued", conclusion: null }] }, NO_STATUSES),
    ).toEqual({
      settled: false,
      failing: [],
    });
  });

  it("読めなければ、突き合わせ先にしない", () => {
    // **「マージ先は緑」へ倒さない**——**読めなかったことを残す**
    expect(toBaseCi({ check_runs: "?" }, NO_STATUSES)).toBeUndefined();
  });
});

describe("toCommitSha", () => {
  it("commit の SHA を取り出す", () => {
    expect(toCommitSha({ sha: "a".repeat(40) })).toBe("a".repeat(40));
  });

  it.each([
    ["読めない", {}],
    ["40 桁でない", { sha: "abc" }],
    ["16 進でない", { sha: "z".repeat(40) }],
    ["上の階層へ出る", { sha: "../../../orgs/other/secrets" }],
  ])("%s ものは URL に入れない", (_name, body) => {
    // **未検証の値を URL のパスへ入れない**（`AGENTS.md` §6）
    expect(toCommitSha(body)).toBeUndefined();
  });
});
