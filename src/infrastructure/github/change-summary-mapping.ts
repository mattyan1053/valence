/**
 * GitHub の応答からリスク判定の材料（`ChangeSummary`）を組み立てる。
 *
 * **境界の仕事は 2 つだけ。** 応答を Zod で検証することと、ドメインの型へ移すこと。
 * **通信はここに置かない**（`pull-request-mapping` と同じ形）。
 *
 * **影響が大きいパスの判定は `domain` のものを呼ぶ。** ここで書き直すと、
 * 規則が 2 箇所になって片方だけ古くなる。**ここで呼ぶのは「材料にしてよいか」を
 * 決めるためだけ**で、**Tier の判定は domain が同じパスから導く。**
 */

import { z } from "zod";
import type { BaseCi, CheckSignal } from "../../domain/triage/ci-attribution";
import type { ChangeSummary, CiStatus } from "../../domain/triage/risk-tier";
import { touchesSensitivePath } from "../../domain/triage/sensitive-path";

/** 材料にできたか。**できなかった理由は捨てない**（画面が「材料が無い」と出す）。 */
export type ChangeSummaryResult =
  | { readonly ok: true; readonly summary: ChangeSummary }
  | { readonly ok: false; readonly reason: string };

export type ChangeSummaryInput = {
  /** `GET /repos/{owner}/{repo}/pulls/{number}` */
  readonly detail: unknown;
  /** `GET /repos/{owner}/{repo}/pulls/{number}/files`（読めたぶん） */
  readonly files: readonly unknown[];
  /** 上限に当たって**最後まで読んでいない**か。 */
  readonly filesTruncated: boolean;
  /** `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` */
  readonly checks: unknown;
  /**
   * `GET /repos/{owner}/{repo}/commits/{sha}/status`（Commit Status）
   *
   * **道具立てを前提にしない**（`AGENTS.md` §1）。Checks API を使わず
   * **Commit Status だけを登録する CI がある**ので、両方見て初めてどちらでも動く。
   */
  readonly statuses: unknown;
};

/**
 * **head の SHA も検証する。** これは URL のパスへ入る値なので、
 * 空でないだけでは足りない——`/` やドットセグメントが入れば、
 * **installation トークンを付けたまま別の endpoint を叩ける**（`AGENTS.md` §6）。
 * **40 桁の 16 進**に絞る。
 */
const headShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

const headSchema = z.object({ head: z.object({ sha: headShaSchema }) });

const commitSchema = z.object({ sha: headShaSchema });

/**
 * commit の SHA を取り出す。**マージ先のブランチ名を解決した結果**がここに来る。
 *
 * **枝の名前のまま 2 回読まない**（#638）——**間に push が入ると、
 * check と Commit Status が別々の commit を見る**（#652 と同じ形）。
 * **1 度だけ解決して、そこへ固定する。**
 */
export function toCommitSha(body: unknown): string | undefined {
  const parsed = commitSchema.safeParse(body);
  return parsed.success ? parsed.data.sha : undefined;
}

const detailSchema = z.object({
  changed_files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

/**
 * 検証済みの head を取り出す。**読めなければ材料にしない**（推測で埋めない）。
 *
 * **材料の組み立てとは別にしてある。** head が要るのは**要求を組み立てる側**だけで、
 * `ChangeSummary` には入らない。
 */
export function toHeadSha(detail: unknown): string | undefined {
  const parsed = headSchema.safeParse(detail);
  return parsed.success ? parsed.data.head.sha : undefined;
}

/**
 * 変更ファイルの 1 件。
 *
 * **移す前のパスも読む** (#647 のレビュー)。**`previous_filename` を捨てると、
 * 実装を `docs/` へ移した PR が「ドキュメントだけです」になり**、
 * **元の場所から消えた事実が隠れる**（`change-kind.ts`）。
 *
 * **移していないファイルには付かない**ので、**任意**である。
 */
const filesSchema = z.array(
  z.object({
    filename: z.string().min(1),
    previous_filename: z.string().min(1).optional(),
  }),
);

/**
 * **`status` と `conclusion` の両方を見る。** `conclusion` は終わるまで `null` で、
 * そこだけ見ると**走っている途中を「落ちていない」と読む**。
 */
const checksSchema = z.object({
  check_runs: z.array(
    z.object({
      /**
       * **名前も読む**（#638）。**突き合わせるには名前が要る**ので、
       * **無いものを空文字で埋めない**——**無関係な失敗どうしが一致する。**
       *
       * **Checks API では必須**なので、**欠けている応答は「読めない」側**へ倒す
       * （`ciStatus` だけ拾って先へ進むと、**名前の無い失敗を持ったまま突き合わせる**）。
       */
      name: z.string().min(1),
      /**
       * **出した App も読む**（#610）。**同名の check を複数の App が出す**ので、
       * **名前だけでは「同じ check」と言えない。**
       *
       * **API の側で `null` になりうる**ので、**必須にしない**——**材料ごと捨てると、
       * その PR は Tier まで出なくなる。** **突き合わせが立たなくなるだけ**にする。
       */
      app: z.object({ id: z.number().int() }).nullish(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});

const statusesSchema = z.object({
  statuses: z.array(
    z.object({
      /** **`context` が Commit Status 側の名前**である。**こちらも必須。** */
      context: z.string().min(1),
      /**
       * **出したもの**（#610 と同じ話）。**同じ context を別の App / 人が出す**ので、
       * **名前だけでは「同じ check」と言えない。**
       *
       * **`app` と同じく、必須にしない**——**材料ごと捨てると Tier まで出なくなる。**
       */
      creator: z.object({ id: z.number().int() }).nullish(),
      state: z.string(),
    }),
  ),
});

/** Git が枝の名前として禁じている記号（`git check-ref-format`）。**空白も入る。** */
const FORBIDDEN_IN_REF = new Set([" ", "~", "^", ":", "?", "*", "[", "\\"]);

/**
 * 禁じられた文字を含むか。
 *
 * **符号位置で見る。** **正規表現の文字クラスに制御文字を書けない**（Biome が弾く）
 * ——**書けたとしても、範囲は読めない。**
 */
function hasForbiddenCharacter(ref: string): boolean {
  for (const character of ref) {
    const code = character.codePointAt(0) ?? 0;
    // **制御文字も禁じられている**——**URL のパスとしても危ない**（`AGENTS.md` §6）
    if (code <= 0x1f || code === 0x7f || FORBIDDEN_IN_REF.has(character)) {
      return true;
    }
  }
  return false;
}

/**
 * Git の枝の名前として妥当か（`git check-ref-format`）。
 *
 * **このリポジトリの枝の付け方を当てはめない**（`AGENTS.md` §1。**インストール先は
 * 1 つではない**）——**`release/2.0+hotfix` も `日本語の枝名` も Git では有効**である。
 * **許す文字を並べると、そういうインストール先では機能が丸ごと死ぬ**
 * ——**しかも「突き合わせられませんでした」と出るので、原因が分からない。**
 *
 * **弾くのは、Git が禁じているものだけ**である。**`..` と空の段は、
 * URL のパスとしても危ない**（`AGENTS.md` §6）ので、**ここが両方を兼ねる。**
 */
function isValidRef(ref: string): boolean {
  // **長さの上限を自前で置かない**（#654 のレビュー）——**`git check-ref-format` は
  // 全体の長さを見ない**ので、**200 文字 + 100 文字の段を繋いだ枝も作れる。**
  // **置くと、そういうインストール先では機能が丸ごと死ぬ。**
  if (ref.length === 0 || ref === "@") {
    return false;
  }
  if (hasForbiddenCharacter(ref) || ref.includes("..") || ref.includes("@{")) {
    return false;
  }
  // **段が空にならない**（`//`・頭と末尾の `/`）——**上の階層へ出る形も、ここで落ちる**
  return ref
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"),
    );
}

const baseRefSchema = z.object({ base: z.object({ ref: z.string() }) });

/**
 * マージ先のブランチ名を、**URL のパスの段として符号化して**返す。
 * **読めなければ突き合わせない**（`toHeadSha` と同じ形）。
 *
 * **符号化まで含めて 1 つの口にする**（`AGENTS.md` §6）——**生の名前を返すと、
 * 組み立てる側が包み忘れられる。**
 *
 * **`/` は段の区切りとして残し、段の中だけを包む。** **`%` は
 * `encodeURIComponent` が `%25` にする**ので、**`a%2Fb` という枝名が `/` に
 * 化けて別の段になることはない**（`bin/loop-ci-status` と同じ話）。
 */
export function toBaseRefPath(detail: unknown): string | undefined {
  const parsed = baseRefSchema.safeParse(detail);
  if (!parsed.success || !isValidRef(parsed.data.base.ref)) {
    return undefined;
  }
  return parsed.data.base.ref.split("/").map(encodeURIComponent).join("/");
}

/**
 * **通ったと見なす結末を挙げる。** 落ちたほうを挙げると、**知らない値が `passing` になる**。
 *
 * `conclusion` は GitHub が増やす値で、**増えたことを知る手立てがこちらに無い**
 * （`stale` を落としていて、実際に取りこぼした）。#114 で決めた
 * 「**列挙は必ず古くなり、古くなった先は取りこぼし側**」がここにも当てはまるので、
 * **古くなったときに安全な側へ落ちる向き**にしてある。
 */
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** Commit Status 側で「通った」と見なす値。**同じ理由で通ったほうを挙げる。** */
const PASSING_STATES = new Set(["success"]);

/** 検証済みの応答の形。**同じ組を 3 箇所で書き写さない。** */
type CheckRunResponse = z.infer<typeof checksSchema>["check_runs"][number];
type CommitStatusResponse = z.infer<typeof statusesSchema>["statuses"][number];

/**
 * 落ちている check を、名前と落ち方で挙げる（#638）。
 *
 * **`ciStatus` と同じ判定から作る。** **2 箇所で「落ちている」を決めると、
 * 片方が事実と違う日が来る**（このリポジトリが繰り返し塞いでいる形）。
 *
 * **終わっていない run は入れない。** **待てば済むものを「直さないと進まない」に
 * 混ぜない**——それは `pending` の側である。
 */
function failingChecksOf(
  runs: readonly CheckRunResponse[],
  states: readonly CommitStatusResponse[],
): readonly CheckSignal[] {
  return [
    ...runs
      .filter((run) => run.status === "completed" && !PASSING_CONCLUSIONS.has(run.conclusion ?? ""))
      // **`conclusion` が無いまま終わることは無い**が、**空文字で埋めない**
      // ——**空どうしが一致して「同じように落ちている」になる。**
      .map((run) => ({
        kind: "check-run" as const,
        name: run.name,
        outcome: run.conclusion ?? "unknown",
        issuer: run.app?.id,
      })),
    ...states
      .filter((status) => status.state === "failure" || status.state === "error")
      .map((status) => ({
        kind: "commit-status" as const,
        name: status.context,
        outcome: status.state,
        issuer: status.creator?.id,
      })),
  ];
}

/**
 * 突き合わせ先（マージ先ブランチの先端）の CI を組み立てる。
 *
 * **読めなければ `undefined`。** **「緑だった」へ倒さない**（#638）
 * ——**倒すと、マージ先から来た失敗まで全部この PR のせいに見える。**
 */
/**
 * CI が終わっているか。
 *
 * **`ciStatus` から導かない**——**あちらは落ちているものを先に返す**ので、
 * **走っている最中の run が混ざっていても「終わった」になる**（#654 のレビュー）。
 * **そうなると、マージ先でまだ走っている失敗が「この PR だけのもの」に化ける。**
 *
 * **信号が 1 つも無いのも「終わっていない」**である——**CI が動いていないマージ先を
 * 「緑だった」と読まない。**
 */
function isSettled(
  runs: readonly CheckRunResponse[],
  states: readonly CommitStatusResponse[],
): boolean {
  if (runs.length === 0 && states.length === 0) {
    return false;
  }
  return (
    runs.every((run) => run.status === "completed") &&
    states.every((status) => status.state !== "pending")
  );
}

export function toBaseCi(checks: unknown, statuses: unknown): BaseCi | undefined {
  const parsedChecks = checksSchema.safeParse(checks);
  const parsedStatuses = statusesSchema.safeParse(statuses);
  if (!parsedChecks.success || !parsedStatuses.success) {
    return undefined;
  }
  const runs = parsedChecks.data.check_runs;
  const states = parsedStatuses.data.statuses;
  return {
    // **走っている最中は「落ちていない」ではなく「まだ分からない」**である
    settled: isSettled(runs, states),
    failing: failingChecksOf(runs, states),
  };
}

/**
 * **3 つを潰さない。** `pending` は待てば済み、`failing` は直さないと進まない——
 * 表示側（#110）が分けている区別なので、ここで丸めると意味が無くなる。
 *
 * **1 件も無いものを `passing` にしない。** CI が動いていない PR が素通りする。
 */
function toCiStatus(
  runs: readonly CheckRunResponse[],
  states: readonly CommitStatusResponse[],
): CiStatus {
  // **「落ちている」を決めるのはここ 1 箇所**である（`failingChecksOf`）
  if (failingChecksOf(runs, states).length > 0) {
    return "failing";
  }
  // **信号が 1 つも無いものを `passing` にしない。** CI が動いていない PR が素通りする
  const running =
    runs.some((run) => run.status !== "completed") ||
    states.some((status) => !PASSING_STATES.has(status.state));
  if ((runs.length === 0 && states.length === 0) || running) {
    return "pending";
  }
  return "passing";
}

export function toChangeSummary(input: ChangeSummaryInput): ChangeSummaryResult {
  const detail = detailSchema.safeParse(input.detail);
  if (!detail.success) {
    return { ok: false, reason: `PR の詳細を読めません: ${z.prettifyError(detail.error)}` };
  }
  const files = filesSchema.safeParse(input.files);
  if (!files.success) {
    return { ok: false, reason: `変更ファイルの一覧を読めません: ${z.prettifyError(files.error)}` };
  }
  const checks = checksSchema.safeParse(input.checks);
  if (!checks.success) {
    return { ok: false, reason: `CI の状態を読めません: ${z.prettifyError(checks.error)}` };
  }
  const statuses = statusesSchema.safeParse(input.statuses);
  if (!statuses.success) {
    return { ok: false, reason: `CI の状態を読めません: ${z.prettifyError(statuses.error)}` };
  }

  // **移した先と、移す前の両方を載せる** (#647 のレビュー)。**件数は
  // `changed_files` が持っている**ので、**行が増えても数は狂わない。**
  //
  // **`touchesSensitivePath` にも効く**——**`.env` を移した PR は「機密パスに
  // 触れた」側になる。** **意識して、そう変えている**（`AGENTS.md` §5）：
  // **移した先の名前だけを見ると、触れていないことになる。**
  const paths = files.data.flatMap((file) =>
    file.previous_filename === undefined
      ? [file.filename]
      : [file.filename, file.previous_filename],
  );
  // **ここで判定するのは、材料にしてよいかどうかだけ**である。**Tier の判定は domain が
  // 同じパスから導く**ので、**真偽値を材料に載せない**（載せると、パスと食い違う値を
  // 持てる——**同じことを 2 箇所で言って、片方が事実と違う**）。
  const touches = touchesSensitivePath(paths);
  // **「触れていない」と「見ていない」を混同しない。** 見切れたうえで当たらなかったのは
  // 「無い」ではないので、**材料にしない**（画面は行を残して「材料が無い」と出す）。
  // 当たったほうは、残りを見なくても結論が変わらないので材料にしてよい。
  if (!touches && input.filesTruncated) {
    return {
      ok: false,
      reason: "変更ファイルが多すぎて最後まで見切れませんでした（影響の大きいパスの有無が不明）",
    };
  }

  return {
    ok: true,
    summary: {
      changedFileCount: detail.data.changed_files,
      // **追加と削除を足す。** 片方だけだと、消しただけの大きな変更が小さく見える
      changedLineCount: detail.data.additions + detail.data.deletions,
      // **見切れたことを一緒に運ぶ。** ここで落とすと、**途中までの一覧が
      // 「これが全部だ」に化ける**（`AGENTS.md` §5）
      changedPaths: { paths, truncated: input.filesTruncated },
      ciStatus: toCiStatus(checks.data.check_runs, statuses.data.statuses),
      failingChecks: failingChecksOf(checks.data.check_runs, statuses.data.statuses),
      // **突き合わせ先はここでは付けない。** **どの commit と比べるかを決めるのは、
      // 取りに行く側**である（`github-change-summary-source`）。
      // **付け忘れたときに倒れる先は「突き合わせられなかった」**——安全な側である。
      baseCi: undefined,
    },
  };
}
