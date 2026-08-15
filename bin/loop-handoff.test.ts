import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-handoff", import.meta.url));
/** **本物の `bin/`。** **写して隣を差し替える試験**が使う（#310）。 */
const BIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const STAMP = fileURLToPath(new URL("./loop-procedure-stamp", import.meta.url));
const LEASE = fileURLToPath(new URL("./loop-lease", import.meta.url));

/**
 * レビュー用の bot（**GraphQL の形**。`author.login` に `[bot]` は付かない）。
 *
 * **値をここに書き写さない**——`bin/loop-review-commits` が正で、**写しを持つと
 * 出所を変えても緑のまま**になり、**追随を確かめられない**（#135）。
 */
const BOT_GRAPHQL = execFileSync(fileURLToPath(new URL("./loop-review-commits", import.meta.url)), [
  "--bot",
])
  .toString()
  .trim()
  .replace(/\[bot\]$/, "");

/**
 * 必須チェックの一覧（**GitHub の check 名**）。
 *
 * **ここにも書き写さない**——`bin/loop-gate` が正で、**写しを持つと出所を変えても
 * 緑のまま**になる（#135 と同じ理由）。
 */
const REQUIRED = execFileSync(fileURLToPath(new URL("./loop-gate", import.meta.url)), [
  "--required-checks",
])
  .toString()
  .trim()
  .split("\n");

type Run = { status: number; stdout: string; stderr: string };

/**
 * 列の区切り。**スクリプトと同じ US を使う**（タブは連続すると畳まれる）。
 *
 * **`printf '%b'` が読む形で書く。** ここに実物の制御文字を置くと、
 * 偽の `gh` を書き出すときにエスケープされ、**`%b` が戻せない形**になる。
 */
const FIELD = "\\0037";

/** スレッドが立った既定の時刻。**label より前**（master が見てから付けた形）。 */
const THREAD_AT = "2026-01-01T00:00:00Z";
/** `changes-requested` を付けた既定の時刻。**スレッドより後**。 */
const LABELED_AT = "2026-06-01T00:00:00Z";

/** 役の印。**書く側から引く**（試験にも写さない。#174）。 */
function markOf(role: string): string {
  const result = spawnSync(fileURLToPath(new URL("./loop-review-reply", import.meta.url)), [
    "--mark",
    role,
  ]);
  return (result.stdout ?? "").toString().trim();
}

/**
 * 最後の発言の本文。**印の有無で「誰が書いたか」が決まる** (#174)。
 *
 * **`us` は印の無い発言**（**この仕組みより前のコメント / 人が手で書いたもの**）。
 */
function bodyOf(who: "bot" | "us" | "worker" | "master"): string {
  if (who === "worker" || who === "master") {
    return `直しました。 ${markOf(who)}`;
  }
  return "印のない発言";
}

/** GitHub の状態。**偽の `gh` はこれを返すだけ**にして、判断だけを試す。 */
type State = {
  /** open PR。`labels` は付いている label 名。 */
  prs?: {
    number: number;
    /** `Closes #N` を含む本文。**保留した PR の Issue を数えるのに使う。** */
    body?: string;
    labels?: string[];
    /** 未解決スレッドの最後の発言。**件数だけでは持ち手が決まらない。** */
    unresolvedBy?: ("bot" | "us" | "worker" | "master")[];
    /**
     * スレッドが立った時刻（`unresolvedBy` と同じ並び）。
     *
     * **label より後に立ったかどうかで、当否が判断済みかが決まる。**
     * 既定は label より前。
     */
    threadsAt?: string[];
    /**
     * `changes-requested` を最後に付けた時刻。
     *
     * **既定は label の有無から決まる**——付いていればスレッドより後（master が
     * 指摘を見てから付けた、いつもの順序）、付いていなければ**記録なし**。
     * **外したあとも記録は残る**ので、その形を作るときはここへ明示する。
     */
    labeledAt?: string;
    /** 最後の発言の ID。**返信だけでも動く値**である。 */
    lastComment?: number;
    head?: string;
    /**
     * CI の結果（check 名 → bucket）。**書かなかったものは pass** とみなす。
     *
     * **ゲートはここで落とすのに、handoff からは見えていなかった** (#125)。
     * **必須でないチェックも混ざる**ので、**集約値ではなく必須チェックごとに見る**
     * （#173 のレビュー）。
     */
    checks?: Record<string, string>;
  }[];
  /**
   * 理由の無い保留（人待ちにしたが、理由を投稿できていない PR）。
   *
   * **`bin/loop-silent-park` が挙げるもの**を、そのまま並べる。
   */
  silentPark?: number[];
  /** 索引が返す件数。**番号は 901.. / 951.. で作られる**（下記 `nowLabelsOf`）。 */
  ready?: number;
  inProgress?: number;
  backlog?: number;
  /**
   * **いま直接読んだら返る label**（番号ごと）。省くと索引と同じものが返る。
   *
   * **索引は遅れる** (#285)。**label を外した直後でも、一覧はまだ返す**——
   * **そこで数えると「手が埋まっている」と読み、渡すものがあるのに黙る。**
   */
  nowLabelsOf?: Record<number, string[]>;
  /** `gh` が失敗する（判定不能）。 */
  fails?: boolean;
  /** その取得だけが失敗する。**最初の 1 つだけを試すと、後ろの取得を試せない。** */
  failsOn?: string;
};

describe("bin/loop-handoff", () => {
  let repo: string;
  let path: string;
  /** 足した作業場。**worktree なので、消し忘れると次の試験へ漏れる。** */
  let workspaces: string[];

  /**
   * **本物の `gh` を呼ばない。** 見たいのは「GitHub の状態から誰へ渡すか」であって、
   * 取得の仕方ではない。PATH を絞って偽物だけを置く。
   */
  /** 落ち方の指定。**最初の 1 つだけを試すと、後ろの取得を試せない。** */
  function failureLines(state: State): string[] {
    return [
      ...(state.fails === true ? ['echo "gh が落ちた" >&2', "exit 1"] : []),
      ...(state.failsOn === undefined
        ? []
        : [
            `if [[ $* == *${JSON.stringify(state.failsOn)}* ]]; then`,
            '  echo "gh が落ちた" >&2',
            "  exit 1",
            "fi",
          ]),
    ];
  }

  /** 1 行 1 件で返すだけの分岐。**空のときに余計な改行を足さない。** */
  function answerLines(match: string, payload: string): string[] {
    return [
      `if [[ $* == *${JSON.stringify(match)}* ]]; then`,
      // **`%b` で出す。** `%s` だと `\t` がリテラルのまま出て、列が壊れる
      // （`bin/loop-await-review` のテストで 1 度踏んだ）
      `  printf '%b' ${JSON.stringify(payload)}`,
      `  [[ -n ${JSON.stringify(payload)} ]] && echo`,
      "  exit 0",
      "fi",
    ];
  }

  /**
   * `changes-requested` を付けた時刻。**付いていない PR には記録が無い**のが既定である。
   *
   * **一律に時刻を返さない。** label の無い PR にまで「付けた記録」を与えると、
   * **付けたことが 1 度も無い PR を「判断済み」に見せる**——**試験のほうが
   * 起こりえない状態を作って、実装の誤りを隠す**ことになる。
   */
  function labeledAtOf(pr: NonNullable<State["prs"]>[number]): string {
    if (pr.labeledAt !== undefined) {
      return pr.labeledAt;
    }
    return (pr.labels ?? []).includes("changes-requested") ? LABELED_AT : "";
  }

  /**
   * その PR の CI の状態に答える分岐（`bin/loop-ci-status --fingerprint` が引く口）。
   *
   * **`status` と `conclusion` の両方を返す** (#206)。**`bucket` を返す口ではない**——
   * **`conclusion` が出ているのに `status` が戻らない**状態を、ここで作れる。
   */
  function checkLines(pr: NonNullable<State["prs"]>[number]): string[] {
    const buckets = { ...Object.fromEntries(REQUIRED.map((name) => [name, "pass"])), ...pr.checks };
    const rows = Object.entries(buckets).map(([name, bucket]) => {
      const encoded = Buffer.from(name, "utf8").toString("base64");
      const [status, conclusion] =
        bucket === "pending"
          ? ["in_progress", ""]
          : ["completed", bucket === "pass" ? "success" : "failure"];
      return `${encoded}\\u001f${status}\\u001f${conclusion}\\u001f2026-01-01T00:00:00Z`;
    });
    return [
      `if [[ $* == *"pull/${pr.number}"* || $* == *"pr view ${pr.number}"* ]]; then`,
      `  printf '%s\\n' "head-of-${pr.number}"`,
      "  exit 0",
      "fi",
      `if [[ $* == *"commits/head-of-${pr.number}/check-runs"* ]]; then`,
      `  printf '%b' ${JSON.stringify([...rows, ""].join("\\n"))}`,
      "  exit 0",
      "fi",
    ];
  }

  /** 索引が「ready」として返す番号。**件数から作る**（試験ごとに書き分けない）。 */
  function readyNumbers(state: State): number[] {
    return Array.from({ length: state.ready ?? 0 }, (_, index) => 901 + index);
  }

  /** 索引が「in-progress」として返す番号。 */
  function progressNumbers(state: State): number[] {
    return Array.from({ length: state.inProgress ?? 0 }, (_, index) => 951 + index);
  }

  function withState(state: State): void {
    // **本文は最後に置く。** 途中に置くと、本文に混じった空白で列がずれる
    const prs = (state.prs ?? [])
      .map(
        (pr) =>
          `${pr.number}${FIELD}${(pr.labels ?? []).join(",")}${FIELD}${pr.head ?? "a".repeat(40)}${FIELD}${labeledAtOf(pr)}${FIELD}${pr.body ?? ""}`,
      )
      .join("\n");
    // **一覧（検索）は古い値を返しうる。** ここでは**わざと古い値**を返させ、
    // **新しい口だけを見ていること**を確かめる（#101。実測で 4 秒ほど遅れる）
    const staleCounts = "0";
    // **ゲートと同じものを見る。** 未解決スレッドは GraphQL からしか取れない。
    // 1 行 1 スレッドで、**最後の発言の ID と書いた人**を返す
    const threads = (state.prs ?? [])
      .flatMap((pr) =>
        (pr.unresolvedBy ?? []).map(
          (who, index) =>
            `${pr.lastComment ?? 100 + index}${FIELD}${who === "bot" ? BOT_GRAPHQL : "mattyan1053"}${FIELD}${pr.threadsAt?.[index] ?? THREAD_AT}${FIELD}${bodyOf(who)}`,
        ),
      )
      .join("\n");

    writeFileSync(
      join(path, "gh"),
      [
        "#!/usr/bin/env bash",
        ...failureLines(state),
        ...answerLines("repo view", "owner\nrepo"),
        // **理由の無い保留の問い合わせ**（`bin/loop-silent-park`）。**PR 一覧より先に置く**——
        // どちらも `pullRequests(states:OPEN` を含むので、後ろだと一覧の行を渡してしまう
        ...answerLines(
          "awaiting-human",
          (state.silentPark ?? [])
            .map(
              (number) =>
                `${number}${FIELD}parked,awaiting-human${FIELD}2026-08-12T04:00:00Z${FIELD}`,
            )
            .join("\n"),
        ),
        // **件数は検索を通さない口から取る。** 一覧側（下）はわざと 0 を返すので、
        // ここを見ていなければ「ready が 1 件ある」に到達しない
        //
        // **番号も返す** (#285)。**件数だけでは、報告の直前に確かめ直せない**
        ...answerLines(
          "totalCount",
          [
            readyNumbers(state).join(","),
            progressNumbers(state).join(","),
            String(state.backlog ?? 0),
          ].join(FIELD),
        ),
        // **直接読んだ label。** **索引と食い違わせられる**ようにしてある
        ...[...readyNumbers(state), ...progressNumbers(state)].flatMap((number) =>
          answerLines(
            `issue view ${number}`,
            (
              state.nowLabelsOf?.[number] ?? [
                readyNumbers(state).includes(number) ? "ready" : "in-progress",
              ]
            ).join("\n"),
          ),
        ),
        // **CI は PR ごとに引く**（判定は `bin/loop-ci-status` が持つ）。
        // **名前は @base64 で受け渡す**——区切りを含む job 名で行を増やされないため
        ...(state.prs ?? []).flatMap((pr) => checkLines(pr)),
        // **PR 一覧も検索を通さない口から取る。** label を付けた直後は一覧が古い
        ...answerLines("pullRequests(states:OPEN", prs),
        // **ゲートと同じ読み方をしているか。** スレッド自体をページングしていないと、
        // 101 件目以降にだけ未解決が残る PR を 0 件と数える
        'if [[ $* == *"api graphql"* ]]; then',
        '  if [[ $* != *"pageInfo"* || $* != *"after: $endCursor"* ]]; then',
        '    echo "スタブ: reviewThreads をページングしていない" >&2',
        "    exit 1",
        "  fi",
        "fi",
        ...answerLines("api graphql", threads),
        // **ここから下は「古い一覧」である。** 検索の索引を経由する口は、
        // 付け替えた直後に古い値を返す。**これを見ていたら通知が落ちる**
        ...answerLines("pr list", ""),
        `if [[ $* == *"--label"* ]]; then echo ${staleCounts}; exit 0; fi`,
        'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  function runIn(cwd: string, args: string[], env: Record<string, string> = {}): Run {
    const result = spawnSync(SCRIPT, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: path, ...env },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function runWith(args: string[], env: Record<string, string> = {}): Run {
    return runIn(repo, args, env);
  }

  function run(role: string, env: Record<string, string> = {}): Run {
    return runWith(role === "" ? [] : [role], env);
  }

  /** 送信が成功したことを伝える口。**呼んだ側にしか分からない。** */
  function sent(role: string, env: Record<string, string> = {}): Run {
    return runWith([role, "--sent"], env);
  }

  /**
   * **2 つ目の作業場を足す。**
   *
   * **worktree なので、git の共通ディレクトリは同じ**——**`informed` の記録は
   * わざと共有されている**（重複抑止はループ全体で 1 つ）。**分かれていなければ
   * ならないのは、まだ届いていない「送ると決めた」ぶんだけ**である。
   */
  function addWorkspace(): string {
    expect(
      spawnSync(
        "git",
        [
          "-C",
          repo,
          "-c",
          "user.email=loop@example.invalid",
          "-c",
          "user.name=loop",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "根",
        ],
        { encoding: "utf8" },
      ).status,
      "worktree を足すための commit が作れない",
    ).toBe(0);
    const other = `${repo}-b`;
    expect(
      spawnSync("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", other, "HEAD"], {
        encoding: "utf8",
      }).status,
      "2 つ目の作業場を作れない",
    ).toBe(0);
    workspaces.push(other);
    return other;
  }

  /**
   * **送信まで成功した周回。**
   *
   * **判断だけでは「送った」にならない**（#258）。実際に送るのは呼んだ側なので、
   * **`--sent` を通ったときにだけ記録が `informed` へ上がる**。
   * 重複抑止を見る試験は、この形で 1 周を回す。
   */
  function cycle(role: string, env: Record<string, string> = {}): Run {
    const handoff = run(role, env);
    if (handoff.stdout !== "") {
      const confirmed = sent(role, env);
      expect(confirmed.status, `--sent が落ちた: ${confirmed.stderr}`).toBe(0);
    }
    return handoff;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-handoff-"));
    workspaces = [];
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    path = join(repo, "path");
    mkdirSync(path, { recursive: true });
    for (const command of [
      "bash",
      "git",
      "flock",
      "cat",
      "mkdir",
      "rm",
      "printf",
      "date",
      // parked な PR の Issue を数えるのに使う
      "grep",
      "sort",
      "wc",
      // **必須チェック名を `@base64` と同じ形に揃える**のに使う（`bin/loop-gate` と同じ）
      "base64",
      "tr",
      // **作業場ぶんの識別子を固定長にするのに使う**（`bin/loop-lease`。#99）。
      // **無いと `bin/loop-lease check` が「読めない」へ倒れ、飛ばした周回を記録しない**
      // ——**この一覧は本物の依存そのもの**なので、増えたら足す
      "sha256sum",
      // **`dirname` はここに無い** (#304)。**足すと、生きている作業場の数え方が
      // 外の道具に依存して戻っても緑のまま**である——**この一覧は「本物の依存そのもの」**
      // なので、**引けなくても数えられることを、無いままで確かめる。**
    ]) {
      const found = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (found !== "") {
        symlinkSync(found, join(path, command));
      }
    }
    chmodSync(path, 0o755);
  });

  afterEach(() => {
    for (const workspace of workspaces) {
      rmSync(workspace, { recursive: true, force: true });
    }
    rmSync(repo, { recursive: true, force: true });
  });

  describe("理由の無い保留", () => {
    // **二重に落ちたときだけ静かに残る**（#163）。`gh pr comment` が落ちて label を
    // 戻そうとしたら、**戻す側も同じ API 障害で落ちる**——**label は残り、
    // 理由はどこにも無い**。**ステップ 2 は `parked` を選ばない**ので、
    // **次の周回はその PR を見ず、停止も 1 回しか積まれない**（3 周に届かない）。
    //
    // **拾い手は 1 つに決まらない**（#161 と同じ判断）ので、**毎周回通るここ**と
    // **人が読む `./task loop:status`** の両方から、同じ判定を呼ぶ。
    it("持ち物より先に、master へ渡す", () => {
      withState({
        prs: [{ number: 42, labels: ["parked", "awaiting-human"] }],
        silentPark: [42],
        ready: 1,
      });

      const handoff = run("worker");

      expect(handoff.status).toBe(0);
      expect(handoff.stdout, "master へ渡していない").toMatch(/^master\t/);
      expect(handoff.stdout, "どの PR かが出ていない").toContain("42");
    });

    it("理由を投稿し直したら、次の周回は送れる", () => {
      // **「直したら止まる」がいちばん悪い形**である。**理由を投稿し直しても
      // `prs` にも `details` にも現れない**（issue コメントはどちらにも入らない）ので、
      // **指紋に入れないと「送信済み」のまま**になる——**その PR の話だけでなく、
      // `ready` を worker へ渡す通知も同じ指紋で止まる**（master の指摘）。
      withState({
        prs: [{ number: 42, labels: ["parked", "awaiting-human"] }],
        silentPark: [42],
        ready: 1,
      });
      expect(cycle("worker").status, "1 周目で渡せていない").toBe(0);

      // 理由を投稿し直した（**label も PR の中身も変わらない**）
      withState({
        prs: [{ number: 42, labels: ["parked", "awaiting-human"] }],
        silentPark: [],
        ready: 1,
      });

      const second = run("master");

      expect(second.status, "指紋が変わらず、直したのに黙っている").toBe(0);
      expect(second.stdout).toMatch(/^worker\t/);
    });

    it("索引が遅れていても、いま着手中でなければ数えない", () => {
      // **これが本題** (#285)。**マージした周回の出口で起きる**——**閉じた Issue から
      // `in-progress` を外した数コマンド後**に打つと、**索引はまだ返す。**
      // **そこで「手が埋まっている」と読むと、渡すものがあるのに黙る**——
      // **worker は次の cron まで動かない**（実測で同じ日に 3 回）。
      withState({ ready: 1, inProgress: 1, nowLabelsOf: { 951: [] } });

      const handoff = run("master");

      expect(handoff.status, "渡すものがあるのに送らないと判定している").toBe(0);
      expect(handoff.stdout, "worker へ渡していない").toMatch(/^worker\t/);
    });

    it("label を読み直せなければ、送らない側へ倒さない", () => {
      // **「0 件」に倒さない**（#281 と同じ判断）——**読めないあいだ黙る**
      withState({ ready: 1, inProgress: 1, failsOn: "issue view" });

      expect(run("master").status).toBe(2);
    });

    it("理由が投稿されている保留では、何も言わない", () => {
      // **うるさくしない。** 正常な人待ちは**そのままにしておくもの**である
      withState({
        prs: [{ number: 42, labels: ["parked", "awaiting-human"] }],
        silentPark: [],
        ready: 1,
      });

      const handoff = run("master");

      expect(handoff.stdout, "正常な保留を持ち物にしている").not.toContain("42");
    });
  });

  describe("入口を飛ばした周回を、出口で見つける", () => {
    // **入口は散文の指示のままだった。** 「冒頭で `acquire` を呼べ」と書いてあるだけで、
    // **呼ばずに進める**——実際に飛ばした（通知で始めた周回で 2 回中 2 回）。
    // **飛ばしても何も起きない**ので、並行したときにだけ壊れ、そのときの症状は
    // **「レビュー要求が 2 件で枠を使い切った」**——**原因が入口だと分からない**。
    //
    // **出口に置く理由。** 周回の中で**必ず呼ばれるもの**が要るが、
    // `bin/loop-gate` は **open PR が 0 件の周回では呼ばれない**（master の周回の多くが
    // それだった）。`bin/loop-stall` は止まるときだけである。**出口は #92 で 1 本に
    // してあり、「何もしなかった場合も含めて必ず通す」**と両方の手順書に書いてある
    // （`loop/handoff-wiring.test.ts` が押さえている）。
    //
    // **「必ず呼ばれる」が保証されているわけではない。** 保証できるのは
    // **通ったときに分かる**ことまでで、そこは正直に扱う。

    /** 飛ばした記録。**git の共通ディレクトリに置く**（作業場をまたいで 1 つ）。 */
    function missingRecord(): string {
      const record = join(repo, ".git", "valence-loop-lease-missing");
      return existsSync(record) ? readFileSync(record, "utf8") : "";
    }

    it("lease を持っていなければ、警告して記録する", () => {
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

      const handoff = run("master");

      expect(handoff.stderr, "飛ばしたことが出力に残らない").toContain("lease");
      // **役は記録しない。** ここは `$ROLE` を知っているが、**役を書き固めた記録は
      // 両方の役が使うスクリプトで偽になる**ので、`bin/loop-lease` は
      // **何が起きていたか**を書く（#161 の差し戻し）
      expect(missingRecord(), "飛ばしたことが記録に残らない").toContain("誰も持っていない");
    });

    it("持っていれば、何も言わない", () => {
      // **ループと関係なく叩く場合に邪魔しない**、の裏でもある——
      // 持っている周回には何も足さない
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
      expect(
        spawnSync(
          LEASE,
          ["acquire", "master", spawnSync(STAMP, ["master"], { encoding: "utf8" }).stdout.trim()],
          { cwd: repo, encoding: "utf8" },
        ).status,
      ).toBe(0);

      const handoff = run("master");

      expect(handoff.stderr).not.toContain("lease");
      expect(missingRecord()).toBe("");
    });

    it("渡すものが無い周回でも見つける", () => {
      // **open PR が 0 件で終わる周回**でも通る。**ゲートを置き場所にできない理由**が
      // これで、**master の周回はしばしばゲートを呼ばない**
      withState({});

      const handoff = run("master");

      expect(handoff.status, "持ち物が無い周回である").toBe(1);
      expect(missingRecord()).toContain("誰も持っていない");
    });

    it("持ち手を決める仕事は、これまでどおり行う", () => {
      // **止めない。** 飛ばしたことは記録するが、**この周回の結論は変えない**——
      // 変えると、**入口の見落としが出口の沈黙になる**（#92 が消した形が戻る）
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

      const handoff = run("master");

      expect(handoff.status).toBe(0);
      expect(handoff.stdout).toMatch(/^worker\t/);
    });

    it("判定できないときは、飛ばした扱いにしない", () => {
      // **「読めない」と「持っていない」は別である。** 設定を間違えている間ずっと
      // 1 件ずつ積むと、**本物の飛ばしと混ざって記録が読めなくなる**——
      // この記録は**「同じ癖が続いていること」を読むためのもの**なので、
      // **誤警告より記録が汚れるほうが痛い**。
      //
      // **標準エラーも捨てない。** 捨てると、**直すべき当のもの（設定の誤り）が
      // 人からも記録からも消える**
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

      const handoff = run("master", { LOOP_LEASE_TTL_SEC: "abc" });

      expect(missingRecord(), "判定できない周回を飛ばしとして記録している").toBe("");
      expect(handoff.stderr, "設定の誤りが握り潰されている").toContain("LOOP_LEASE_TTL_SEC");
    });

    it("記録を残せなければ、そう言う", () => {
      // **書けなければ、探し方を知っていても分からない。** `loop:status` は
      // **「0 件」と「書けなかった」を区別しない**ので、**壊れた環境で静かに無効**になる——
      // **気づけることを作る仕組みの中で、気づけなくなる形**である。
      //
      // **`|| true` は「失敗してよい」ではなく「失敗しても続ける」の意味**だった。
      // **続けることと黙ることは別**なので、**続けたまま言う**
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
      const record = join(repo, ".git", "valence-loop-lease-missing");
      writeFileSync(record, "");
      chmodSync(record, 0o444);

      const handoff = run("master");

      // **シェルの失敗メッセージに相乗りしない。** `>>file 2>/dev/null` は
      // **開くのに失敗した時点ではまだ標準エラーを捨てていない**ので、
      // **たまたま bash の 1 行が出る**——**並びを変えれば消える**し、
      // **それが何を意味するか（記録が残らない）は誰も言っていない**
      expect(handoff.stderr, "書けなかったことに気づいていない").toMatch(/記録を残せません/);
      expect(handoff.stderr, "何が失われるのかが書かれていない").toMatch(/loop:status/);
      // **止めない。** 記録できないことと、持ち手が決まらないことは別である
      expect(handoff.status).toBe(0);
      expect(handoff.stdout).toMatch(/^worker\t/);
    });

    it("記録は積み上がる", () => {
      // **1 回で止めない。** 同じ癖が続いていることは、**回数でしか分からない**
      withState({});

      run("master");
      run("worker");

      expect(missingRecord().split("\n").filter(Boolean)).toHaveLength(2);
    });
  });

  it("changes-requested の PR があれば worker へ渡す", () => {
    // **相手に具体的な持ち物があるときだけ送る。** 「暇そうだから起こす」は送らない
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

    const handoff = run("master");

    expect(handoff.status).toBe(0);
    expect(handoff.stdout).toMatch(/^worker\t/);
    expect(handoff.stdout).toContain("12");
  });

  it("ゲートを回せる PR があれば master へ渡す", () => {
    withState({ prs: [{ number: 12 }] });

    const handoff = run("worker");

    expect(handoff.status).toBe(0);
    expect(handoff.stdout).toMatch(/^master\t/);
  });

  it("ready が 1 件で着手されていなければ worker へ渡す", () => {
    withState({ ready: 1 });

    expect(run("master").stdout).toMatch(/^worker\t/);
  });

  describe("ready が 2 件のとき", () => {
    /**
     * **いちばん渡したい瞬間に落ちていた**（#267）。
     *
     * **条件が `ready == 1` の等号**だったので、**2 件だとどの枝にも入らず exit 1**
     * ——**「相手に持ち物が無い」と読まれて終わる。**
     *
     * **`in-progress` が 0 になるのは「実装が終わった直後」**で、
     * **そのとき `ready` が 2 件溜まっているのは普通**である（master は 2 件まで満たす）。
     * **2026-08-14 に実測した**——**worker は手が空き、渡す仕事は 2 件あり、
     * それでも誰も起こさなかった。**
     *
     * **件数で絞る必要は無い。** **重複の抑止は指紋が別に持っている。**
     */
    it("着手されていなければ worker へ渡す", () => {
      withState({ ready: 2 });

      expect(run("master").stdout, "2 件だと誰も起こさない").toMatch(/^worker\t/);
    });

    it("同じ状態で 2 通目を送らない", () => {
      // **緩めた瞬間に送り合いへ倒れても気づけない**ので、ここを見る（master の指摘）。
      // **抑止は指紋（`informed`）が持っている**ので、**`>= 1` にしても増えない**
      withState({ ready: 2 });
      expect(cycle("master").status).toBe(0);

      expect(run("master").status, "件数を緩めたら重複が増えた").toBe(1);
    });

    it("着手中があれば、作業場が 1 つのあいだは送らない", () => {
      // **手が 1 本しか無ければ、着手中 1 件で塞がっている**（#302 でもここは変えない）
      withState({ ready: 2, inProgress: 1 });

      expect(run("master").status).toBe(1);
    });
  });

  /**
   * **`in-progress == 0` は「worker が 1 人」を前提にした条件だった**（#302）。
   *
   * **1 人なら「着手中が 1 件ある＝その 1 人は塞がっている」で正しい。**
   * **2 人いると、着手中 1 件は「片方が塞がっている」でしかない**——
   * **空いた側は `ready` に仕事があっても起こされず、自分の cron まで動かない。**
   *
   * **#267 が `ready` の側を件数で絞るのをやめたとき、`in-progress` はそのまま残した。**
   * **そのときはまだ 1 人**で、**#241 で 2 人になったが数え直していない**——
   * **worker を増やした diff に、この行は出てこない**（`AGENTS.md` §5）。
   */
  /** その作業場が周回を回している状態にする。**印を書くのは `acquire`** である。 */
  function beginCycleIn(workspace: string): void {
    const stamp = spawnSync(STAMP, ["worker"], { encoding: "utf8" }).stdout.trim();
    const acquired = spawnSync(LEASE, ["acquire", "worker", stamp], {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(acquired.status, `周回を始められない: ${acquired.stderr}`).toBe(0);
    const released = spawnSync(LEASE, ["release", "worker", acquired.stdout.trim()], {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(released.status, `周回を返せない: ${released.stderr}`).toBe(0);
  }

  /** **手を 2 本にする。** 両方の作業場が周回を回している形にする。 */
  function twoHands(): void {
    const other = addWorkspace();
    beginCycleIn(repo);
    beginCycleIn(other);
  }

  describe("作業場が 2 つ動いているとき", () => {
    it("着手が 1 件でも、空いている側へ渡す", () => {
      // **実測の形**（2026-08-15 08:14Z。`ready=1` / `in-progress=1` / 手は 2 本）
      twoHands();
      withState({ ready: 1, inProgress: 1 });

      expect(run("master").stdout, "空いている worker を起こしていない").toMatch(/^worker\t/);
    });

    it("全員が塞がっていれば、これまでどおり送らない", () => {
      // **緩めすぎない。** **渡す相手が居ないのに起こすと、騒いでいるのが普通になる**
      twoHands();
      withState({ ready: 1, inProgress: 2 });

      expect(run("master").status, "全員塞がっているのに起こしている").toBe(1);
    });

    it("同じ状態で 2 通目を送らない", () => {
      // **緩めた瞬間に送り合いへ倒れても気づけない**ので、ここを見る
      twoHands();
      withState({ ready: 1, inProgress: 1 });
      expect(cycle("master").status).toBe(0);

      expect(run("master").status, "条件を緩めたら重複が増えた").toBe(1);
    });
  });

  /**
   * **数えられなかった理由を、唯一の読み手が捨てていた**（#310）。
   *
   * **#304 / #308 で `bin/loop-stall` は「数えられなかった」と言うようにした**が、
   * **その声を受け取るのはここだけ**で、**`2>/dev/null` で捨てていた。**
   * **倒す向き（`hands=1`）は正しい**——**問題は、静かなこと**である：
   * **worker が 2 人いるのに 1 本として扱われても、周回の出力に何も出ない**
   * （**#302 が消しに来た沈黙が戻る**）。
   */
  describe("生きている作業場を数えられなかったとき", () => {
    /** スタブが出す理由。**そのまま流れてくるか**を、この文字列で見る。 */
    const REASON = "[WARN] alive-workers=unknown 生きている作業場を数えられません（試験）";

    /**
     * **`bin/loop-stall --alive-workers` が数えられない周回を走らせる。**
     *
     * **隣の `bin/` ごと写して、`loop-stall` だけを差し替える**——**本物は
     * `${BASH_SOURCE[0]%/*}` で隣を引く**ので、**写したほうを走らせれば、
     * 本物のスクリプトを壊さずに「数えられない」を作れる**（#186）。
     */
    function runWithUncountableStall(role: string): Run {
      const bin = join(repo, "copied-bin");
      cpSync(BIN_DIR, bin, { recursive: true });
      writeFileSync(
        join(bin, "loop-stall"),
        [
          "#!/usr/bin/env bash",
          'if [[ ${1-} == "--alive-workers" ]]; then',
          `  echo '${REASON}' >&2`,
          "  exit 2",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(join(bin, "loop-handoff"), [role], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    }

    it("数えられなかった理由が、周回の出力に出る", () => {
      twoHands();
      withState({ ready: 1, inProgress: 1 });

      const handoff = runWithUncountableStall("master");

      expect(handoff.stderr, "理由が捨てられている").toContain("alive-workers=unknown");
      // **写しではなく、受け取ったものを流していること**（**二重に言わない**）
      expect(handoff.stderr, "自分で書いた文言に置き換わっている").toContain("試験");
    });

    it("数えられなくても、手は 1 本のままにする", () => {
      // **本当は 2 本ある**が、**判定不能を 2 本へ倒すと渡しすぎになる**
      // ——**`in_progress == 0` と同じ側に残す**（#302 でもここは変えない）
      twoHands();
      withState({ ready: 1, inProgress: 1 });

      const handoff = runWithUncountableStall("master");

      expect(handoff.stdout, "判定不能を 2 本へ倒している").not.toMatch(/^worker\t/);
      expect(handoff.status, "塞がっているのに起こしている").toBe(1);
    });

    it("数えられた周回では、何も増えない", () => {
      // **毎周回鳴る警告にしない**（#148 と同じ判断）。**鳴りっぱなしは黙るのと同じ**
      withState({ ready: 1, inProgress: 1 });

      const handoff = run("master");

      expect(handoff.stderr, "正常な周回でも鳴っている").not.toMatch(/alive-workers|1 本として扱/);
    });
  });

  it("手の数を、ここで数え直さない", () => {
    // **同じ生死を 2 箇所で数えない**（#302）。**`bin/loop-stall` が既に持っている**
    // ——**写しを持つと、片方だけ直したときに食い違う**（`AGENTS.md` §5）
    const body = readFileSync(SCRIPT, "utf8");

    expect(body, "周回の印を自分で走査している").not.toContain("valence-loop-rounds");
  });

  it("backlog はあるが ready が 0 なら master へ渡す（昇格の番）", () => {
    withState({ backlog: 3 });

    expect(run("worker").stdout).toMatch(/^master\t/);
  });

  it("自分自身へは渡さない", () => {
    // **自分が動けるなら次の周回でやればよい。** 自己通知は ping-pong の入口になる
    withState({ ready: 1 });

    const handoff = run("worker");

    expect(handoff.status).toBe(1);
    expect(handoff.stdout).toBe("");
  });

  it.each(["master", "worker"])("誰も動けなければ %s からも渡さない", (role) => {
    // ここは `bin/loop-stall` が `no-work` として数える領域である。
    // **両方の役から見る。** 片方だけだと「自分自身へは送らない」に吸われて、
    // **持ち物が無いのに起こす**変異を捕まえられない
    withState({});

    expect(run(role).status).toBe(1);
  });

  it("同じ状態で 2 通目を送らない", () => {
    // **ping-pong を作らない。** 送った状態を覚えておき、変わっていなければ黙る
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

    expect(cycle("master").status).toBe(0);
    expect(run("master").status).toBe(1);
  });

  it("状態が変われば、また送る", () => {
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
    expect(cycle("master").status).toBe(0);

    withState({ prs: [{ number: 13, labels: ["changes-requested"] }] });

    expect(run("master").status).toBe(0);
  });

  describe("同じ理由は、無関係な数では立ち上がらない", () => {
    // **指紋が「その周回が見た世界のほぼ全部」だった** (#274)。**PR の一覧・head・本文、
    // スレッドの数、検査 7 件の状態、`ready` / `in-progress` / `backlog` の件数**——
    // **どれか 1 つでも動けば、理由が同じでも「新しい状態」として送られる。**
    //
    // **害は「うるさい」だけではない。** **毎回同じ理由が届くと、受け取る側は本文を
    // 読まなくなる**——**本当に新しい状態のときの 1 通が、その中に埋もれる。**
    //
    // **狭めすぎない**ことが同じくらい大事である（#258 が塞いだのは逆向き）ので、
    // **「状況が変われば必ず送る」側も、下で同じだけ押さえる。**

    it("backlog が動いただけでは、2 通目を送らない", () => {
      // **master が別の Issue を起票／昇格しただけ**で、**worker 宛ての同じ理由が
      // もう一度立ち上がっていた**（実測。14 → 13）
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }], backlog: 14 });
      expect(cycle("master").status).toBe(0);

      withState({ prs: [{ number: 12, labels: ["changes-requested"] }], backlog: 13 });

      expect(run("master").status, "無関係な件数で 2 通目が出た").toBe(1);
    });

    it("CI が進んだだけでは、2 通目を送らない", () => {
      // **`checks=` が動いた**——**CI が pending から success へ変わっただけ**で
      // 再送されていた（実測）。**worker から見た「やること」は 1 文字も変わっていない**
      withState({
        prs: [
          { number: 12, labels: ["changes-requested"], checks: { [REQUIRED[0] ?? ""]: "pending" } },
        ],
      });
      expect(cycle("master").status).toBe(0);

      withState({
        prs: [
          { number: 12, labels: ["changes-requested"], checks: { [REQUIRED[0] ?? ""]: "pass" } },
        ],
      });

      expect(run("master").status, "CI が進んだだけで 2 通目が出た").toBe(1);
    });

    it("その PR が動いたら、これまでどおり送る", () => {
      // **狭めた結果、状況が変わったのに黙るようになってはいけない**（#274 の動かせない 1 点）。
      // **worker が push すれば head は変わる**——**同じ理由の文面でも、別の状況である**
      withState({ prs: [{ number: 12, labels: ["changes-requested"], head: "a".repeat(40) }] });
      expect(cycle("master").status).toBe(0);

      withState({ prs: [{ number: 12, labels: ["changes-requested"], head: "b".repeat(40) }] });

      expect(run("master").status, "push したのに黙った").toBe(0);
    });

    it("新しい指摘が付いたら、これまでどおり送る", () => {
      // **文面は同じでも、スレッドが増えれば別の状況である**——
      // **理由だけを鍵にすると、ここで黙る**（それが「同じ文面になる別の状況」）
      withState({
        prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot"], lastComment: 1 }],
      });
      expect(cycle("master").status).toBe(0);

      withState({
        prs: [
          {
            number: 12,
            labels: ["changes-requested"],
            unresolvedBy: ["bot", "bot"],
            lastComment: 2,
          },
        ],
      });

      expect(run("master").status, "新しい指摘が付いたのに黙った").toBe(0);
    });

    it("ゲートは CI で動く（狭めすぎない）", () => {
      // **枝ごとに、見ているものが違う。** **ゲートを回せるかどうかは CI で決まる**
      // ので、**そこでは checks が動いたら送る**——**一律に外すと、マージできるように
      // なった、まさにその瞬間に黙る** (#125 / #173 のレビュー)
      withState({ prs: [{ number: 12, checks: { [REQUIRED[0] ?? ""]: "pending" } }] });
      expect(cycle("worker").status).toBe(0);

      withState({ prs: [{ number: 12, checks: { [REQUIRED[0] ?? ""]: "pass" } }] });

      expect(run("worker").status, "ゲートが回せるようになったのに黙った").toBe(0);
    });

    it.each([12, 13])("同じ枝の PR #%i が動けば送る（選ばれた 1 件だけを見ない）", (moved) => {
      // **選ぶのは 1 件でも、指紋はその枝の候補ぜんぶから作る** (#292 のレビュー)。
      //
      // **選ばれた 1 件ぶんだけを指紋にすると、もう 1 件の head が動いても
      // 指摘が増えても `STATE` は同じ**——**送らない。** **選ばれている側が動かない
      // かぎり、もう 1 件はずっと指紋に現れない**（**`changes-requested` は
      // master 待ちで何日でも止まりうる**）。
      //
      // **踏む一歩手前にいる**——**#80（worker 2 セッション）が入れば、
      // 「同じ枝に 2 件」が普通の状態になる。**
      //
      // **倒れる向きで決める**（#124 / #125 / #258）——**送りすぎは読み飛ばされるだけ**
      // だが、**黙るほうは誰も気づけない。** **#274 は前者を減らす Issue で、
      // 後者を作ってよい理由にはならない。**
      withState({
        prs: [
          { number: 12, labels: ["changes-requested"], head: "a".repeat(40) },
          { number: 13, labels: ["changes-requested"], head: "b".repeat(40) },
        ],
      });
      expect(cycle("master").status, "worker へ渡せていない").toBe(0);

      // **どちらが動いても送る。** **「先頭だけ」「最後だけ」のどちらへ寄せても
      // 捕まえられるように、両方を試す**（**片方だけだと、寄せた変異が生き残る**）
      withState({
        prs: [
          {
            number: 12,
            labels: ["changes-requested"],
            head: moved === 12 ? "c".repeat(40) : "a".repeat(40),
          },
          {
            number: 13,
            labels: ["changes-requested"],
            head: moved === 13 ? "c".repeat(40) : "b".repeat(40),
          },
        ],
      });

      expect(run("master").status, `PR #${moved} が動いても黙る`).toBe(0);
    });

    it("並びが変わっただけでは、2 通目を送らない", () => {
      // **`gh` の返す順に依存しない** (#292 のレビュー)。**並び順で別状態になると、
      // 何も変わっていないのに通知が飛ぶ**——**#274 が減らそうとした側へ戻る**
      withState({
        prs: [
          { number: 12, labels: ["changes-requested"], head: "a".repeat(40) },
          { number: 13, labels: ["changes-requested"], head: "b".repeat(40) },
        ],
      });
      expect(cycle("master").status).toBe(0);

      withState({
        prs: [
          { number: 13, labels: ["changes-requested"], head: "b".repeat(40) },
          { number: 12, labels: ["changes-requested"], head: "a".repeat(40) },
        ],
      });

      expect(run("master").status, "並びが変わっただけで 2 通目が出た").toBe(1);
    });

    it("いちど作業が尽きたあと、同じ理由が戻ってきたら送る", () => {
      // **狭めた指紋では、記録が古くならないと黙る** (#274)。
      //
      // **`ready` を渡す → worker が取る → 作業が尽きる → また `ready` が 2 件**
      // という並びは普通に起きる。**間に挟まる「何もしない周回」で記録を置き直さないと、
      // 最後に送った `ready` の記録がそのまま残り**、**同じ状態として黙る**——
      // **worker は起こされない。**
      withState({ ready: 2 });
      expect(cycle("master").status, "worker へ渡せていない").toBe(0);

      // worker が取った（`ready` が減り、着手中になった）→ 渡すものが無い周回
      withState({ ready: 0, inProgress: 1 });
      expect(run("master").status, "渡すものがあると読んでいる").toBe(1);

      // また 2 件溜まり、手も空いた（**前と同じ状態だが、間に別の状態を挟んでいる**）
      withState({ ready: 2 });

      expect(run("master").status, "作業が尽きた周回を挟んだのに黙った").toBe(0);
    });

    it("送っていなければ、次の周回で同じ状態にまた送る", () => {
      // **#258 の向きは変えない。** **`--sent` を通していない周回は、記録が上がらない**
      // ので、**同じ状態でもう一度立ち上がる**
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }], backlog: 14 });
      expect(run("master").status).toBe(0);

      withState({ prs: [{ number: 12, labels: ["changes-requested"] }], backlog: 13 });

      expect(run("master").status, "送っていないのに抑止された").toBe(0);
    });
  });

  it("送り合いにならない", () => {
    // **これが本体。** 「暇 → 起こす → 暇 → 起こす」で焼き切れた事故と同じ形を作らない。
    // 交互に呼び続けても、送るのは持ち物がある側への 1 通だけである
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

    const delivered = ["master", "worker", "master", "worker", "master", "worker"]
      .map((role) => cycle(role))
      .filter((handoff) => handoff.status === 0);

    expect(delivered).toHaveLength(1);
  });

  it.each([
    { name: "すべて", state: { fails: true } },
    // **後ろの取得だけが落ちる場合も試す。** 最初の 1 つだけだと、
    // **2 つ目以降で握り潰していても気づけない**
    { name: "件数の取得だけ", state: { failsOn: "totalCount" } },
  ])("状態を読めなければ 2 で落ちる（$name）", ({ state }) => {
    // **判定不能を「送らない」に倒さない。** 倒すと、止まっていることに気づけない
    withState(state);

    expect(run("master").status).toBe(2);
  });

  it("役の綴りを固定する", () => {
    withState({});

    expect(run("workers").status).toBe(2);
    expect(run("").status).toBe(2);
  });

  it("途中で自己宛てになっても、戻ったらまた送る", () => {
    // **記録の更新が自己宛ての分岐より後だと、B で更新されずに A の記録が残る。**
    // どの分岐を通っても更新済みになっていること
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker
    expect(cycle("master").status).toBe(0);

    withState({ prs: [{ number: 12 }] }); // → master。**master から見ると自己宛て**
    expect(run("master").status).toBe(1);

    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker（再発）

    expect(run("master").status).toBe(0);
  });

  it("行き先が入れ替わって戻ったら、また送る", () => {
    // **記録を受け手のぶんしか更新しないと、A→B→A の 3 通目が出ない**
    // （worker の記録が A のままなので「送信済み」と読む）。
    // **評価するたびに、すべての役の記録を更新する**
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker
    expect(cycle("master").status).toBe(0);

    withState({ prs: [{ number: 12 }] }); // → master
    expect(cycle("worker").status).toBe(0);

    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker（戻る）

    expect(run("master").status).toBe(0);
  });

  describe("送っていない周回", () => {
    /**
     * **記録が「送った」を意味していないのに、「送った」として使われていた**（#125）。
     *
     * `bin/loop-handoff` は**分岐の前に両方の記録を更新する**ので、
     * **送らずに終わった周回でも「この状態は配った」ことになる**。
     *
     * ```
     * worker  push → 自分宛て → exit 1（送らない）→ **両方の記録に状態を書く**
     * master  CI の失敗を見つける → 記録と同じ状態 → exit 1（送信済みとして抑止）
     * ```
     *
     * **倒れる向きが悪い。** **送っていないのに「送信済み」**なので、
     * **同じ状態が続く限りずっと届かない**。**正常に周回しているので、
     * 停止として数える経路にも乗らない**（#124 で実際に起きた）。
     */
    it("自分宛てで終わった周回は、「送信済み」を作らない", () => {
      // **実際に 2 回呼んで見る。** 記録を読むだけの検査にしない（master の指摘）
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker
      expect(run("worker").status, "自分宛てなのに送っている").toBe(1);

      const second = run("master");

      expect(second.status, "誰も送っていないのに 2 通目として弾かれた").toBe(0);
      expect(second.stdout, "持ち手が変わっている").toMatch(/^worker\t/);
    });

    it("逆向きも同じ（master の自分宛て周回が、worker を黙らせない）", () => {
      // **記録は受け手ごとにある**ので、**自分宛てで終わった周回は 2 つとも汚す**——
      // **自分の記録**（次に自分が受け取れなくなる）と**相手の記録**の両方。
      // **片側だけ直すと、向きを変えただけで同じ沈黙が残る**
      withState({ prs: [{ number: 12 }] }); // → master（ゲートを回せる）
      expect(run("master").status, "自分宛てなのに送っている").toBe(1);

      const second = run("worker");

      expect(second.status, "誰も送っていないのに 2 通目として弾かれた").toBe(0);
      expect(second.stdout, "持ち手が変わっている").toMatch(/^master\t/);
    });

    it("送ったあとは、受け取った側が回しても送り直さない", () => {
      // **「送信済み」を消してしまうと、逆向きの壊れ方（送り合い）になる。**
      // **受け取った側が自分の周回で同じ状態を見ても、記録は informed のまま**
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker
      expect(cycle("master").status).toBe(0);
      expect(run("worker").status, "worker から送っている").toBe(1);

      expect(run("master").status, "同じ状態で 2 通目を送っている").toBe(1);
    });
  });

  describe("送信に失敗した周回", () => {
    /**
     * **送ろうとして失敗した周回が「送信済み」を作っていた**（#258）。
     *
     * **判断するのはこのスクリプトだが、実際に送るのは呼んだ側**である。
     * **判断した時点で `informed` を書いていた**ので、**送信が失敗しても記録だけが残る**——
     * **同じ状態では 2 通目を送らない**ので、**その状態では二度と送られない**。
     * **記録には `informed` と書いてあるので、落ちたことがどこにも残らない。**
     *
     * **#173 が直したのは「送らないと決めた周回が記録を書く」**で、
     * **こちらは「送ろうとして失敗した周回が記録を書く」**——**別の入口で、同じ結果**である。
     *
     * 2026-08-14 に実際に起きた（セッションの表示名が変わり、**送信が明確に失敗した**）。
     */
    it("記録を書かないので、次の周回で同じ状態にまた送る", () => {
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
      // **送信に失敗した周回**——判断は出たが、`--sent` は通っていない
      expect(run("master").status, "1 通目が出ていない").toBe(0);

      const second = run("master");

      expect(second.status, "送っていないのに「送信済み」になっている").toBe(0);
      expect(second.stdout, "持ち手が変わっている").toMatch(/^worker\t/);
    });

    it("送れた周回は、これまでどおり 2 通目を送らない", () => {
      // **ただ再送を増やすだけにしない。** 送れているなら相手はもう知っている
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
      expect(cycle("master").status).toBe(0);

      expect(run("master").status, "送れているのに送り直している").toBe(1);
    });

    it("--sent は、送ると決めたときの状態を書く（引き直さない）", () => {
      // **再計算すると、送っている間に状態が変わった場合に
      // 「まだ送っていない状態」を送信済みで塞ぐ**——**いま塞ごうとしている穴が、
      // 逆向きに開く**。**判断に使った状態そのものを書く**
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
      expect(run("master").status).toBe(0);

      // **GitHub を読めない**。引き直していれば、ここで落ちる
      withState({ fails: true });
      expect(sent("master").status, "送信のあとに GitHub を読み直している").toBe(0);

      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
      expect(run("master").status, "送った状態が記録されていない").toBe(1);
    });

    it("送らないと決めた周回のあとに --sent を通しても、記録を作らない", () => {
      // **自分宛てで終わった周回は、誰にも配っていない**（#125 の本体）。
      // **送信待ちを残すと、次の `--sent` が配っていない状態を送信済みにする**
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker
      expect(run("worker").status, "自分宛てなのに送っている").toBe(1);

      expect(sent("worker").status, "配っていない状態を送信済みにしている").not.toBe(0);
      expect(run("master").status, "誰も送っていないのに 2 通目として弾かれた").toBe(0);
    });

    it("判断を通さずに --sent だけ呼んだら、2 で落ちる", () => {
      // **「送った」を無から作らせない。** 何を送ったのかが分からない
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

      const confirmed = sent("master");

      expect(confirmed.status).toBe(2);
      expect(confirmed.stderr, "何が足りないのかが書かれていない").toMatch(/bin\/loop-handoff/);
    });

    it("状態が矛盾した周回でも、送れなければまた送る", () => {
      // **exit 3 も「送る」経路**である（出力があれば 1 通送る）。
      // **こちらだけ古い形が残ると、食い違いの通知だけが二度と出ない**
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] }); // → master（食い違いあり）
      expect(run("worker").stdout, "1 通目が出ていない").toMatch(/^master\t/);

      expect(run("worker").stdout, "送っていないのに黙った").toMatch(/^master\t/);
    });

    it("状態が矛盾した周回でも、送れたら 2 通目は出さない", () => {
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });
      expect(cycle("worker").stdout).toMatch(/^master\t/);

      const second = run("worker");

      expect(second.stdout, "同じ指紋で送り返している").toBe("");
      // **記録は毎周回する。** 送らないことと、食い違いを数えないことは別である
      expect(second.status).toBe(3);
    });

    it("使い方の誤りは 2 で落ちる", () => {
      withState({});

      expect(runWith(["master", "--sent-ish"]).status).toBe(2);
      expect(runWith(["master", "--sent", "extra"]).status).toBe(2);
    });

    describe("送っている間に、相手が先に記録したとき", () => {
      /**
       * **`--sent` は、自分より新しい記録を巻き戻してはいけない**（#265 のレビュー）。
       *
       * **役が違えば lease は直列化しない。** **判断してから送るまでには、
       * その周回で分かったことを本文へ書く時間がある**（出口がそう求めている）ので、
       * **窓は小さくない**——**master が S1 で決めて送っている間に、worker が S2 で
       * 決めて `--sent` まで通す**と、**あとから来た master の `--sent` が
       * `informed(S2)` を `informed(S1)` へ戻す**。**次の周回は同じ通知を送り直す。**
       *
       * **順序を決める材料は、時刻ではなく「自分が見た値のままか」から取る**——
       * **指紋は状態の記述で順序を持たない**が、**変わったかどうかなら比べられる**。
       * **違っていたら書かずに終えるのが正しい。** **抑止が答える問いは
       * 「いまの状態は既に伝えたか」**で、**後から書かれたほうが、いまの状態に近い。**
       */
      it("新しい記録を、古い --sent で巻き戻さない", () => {
        // master が S1 で送ると決めた（**まだ本文を書いている**）
        withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker
        expect(run("master").status, "master が渡せていない").toBe(0);

        // その間に worker が S2 で決めて送り、`--sent` まで通した
        withState({ prs: [{ number: 13 }] }); // → master
        expect(cycle("worker").status, "worker が渡せていない").toBe(0);

        // master が送り終えた。**S1 は確かに送っている**
        expect(sent("master").status, "送れたのに落ちている").toBe(0);

        expect(run("worker").status, "巻き戻して、同じ通知を送り直している").toBe(1);
      });

      it("誰も書き換えていなければ、これまでどおり記録する", () => {
        // **止めすぎていないこと。** 送れた周回は、これまでどおり 2 通目を出さない
        withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

        expect(cycle("master").status).toBe(0);
        expect(run("master").status, "送れているのに送り直している").toBe(1);
      });
    });

    describe("作業場が 2 つあるとき", () => {
      /**
       * **送ると決めたぶんは、決めた作業場のものである**（#265 のレビュー）。
       *
       * **`informed` の記録は、役だけをキーに共有されているのが正しい**——
       * 表すのは「この状態は既に伝えた」で、**指紋は全体の状態**だからである
       * （どの作業場から伝えたかは関係ない）。
       *
       * **送信待ちは違う。** 表すのは**「いま投げている 1 件」**なので、
       * **共有すると別の作業場の判断で入れ替わる**——
       * **A が S1 を置いて送る → 確認の前に B が S2 を置く → A の `--sent` が
       * S2 を `informed` へ上げる → B の送信が落ちても S2 は抑止される。**
       * **この PR が塞いだ穴が、塞いだ仕組みの中に開く。**
       *
       * **周回は初めから作業場ごと**である（`bin/loop-lease` が直列化する単位）。
       */
      /** どちらの状態も master 宛て（ゲートを回せる）。**両方の作業場が worker** である。 */
      const s1: State = { prs: [{ number: 12 }] };
      const s2: State = { prs: [{ number: 13 }] };

      it("別の作業場の判断が、こちらの送信待ちを乗っ取らない", () => {
        const other = addWorkspace();

        withState(s1);
        expect(run("worker").status, "1 つ目の作業場が渡せていない").toBe(0);

        // **確認の前に、別の作業場が自分の判断を置く**
        withState(s2);
        expect(runIn(other, ["worker"]).status, "2 つ目の作業場が渡せていない").toBe(0);

        // 1 つ目の作業場は、送信に成功した
        withState(s1);
        expect(sent("worker").status, "--sent が落ちた").toBe(0);

        // **2 つ目の作業場は送信に失敗した**（`--sent` を通していない）ので、また送る。
        // **共有していると、A の `--sent` が B の判断（S2）を `informed` へ上げる**ので、
        // **B は二度と送れない**——**送信待ちを読み違えていることが、ここに出る**
        withState(s2);
        expect(
          runIn(other, ["worker"]).status,
          "別の作業場の確認で「送信済み」にされ、二度と送られない",
        ).toBe(0);
      });

      it("別の作業場が送らないと決めても、こちらの送信待ちは消えない", () => {
        // **上書きだけでなく、消す側も見る。** **判断のたびに前の送信待ちを消す**
        // ので、**共有していると、送らないと決めた B の周回が A の送信待ちを消し**、
        // **A の `--sent` が「送ると決めた記録がありません」で落ちる**——
        // **送れているのに記録できない**（次の周回でもう 1 通出る）
        const other = addWorkspace();

        withState(s1);
        expect(run("worker").status, "1 つ目の作業場が渡せていない").toBe(0);

        // **B から見ると自分宛て**なので、送らずに終わる
        withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
        expect(runIn(other, ["worker"]).status, "自分宛てなのに送っている").toBe(1);

        withState(s1);
        const confirmed = sent("worker");

        expect(confirmed.status, "別の作業場に送信待ちを消された").toBe(0);
        expect(confirmed.stderr, "送ると決めた記録そのものが消えている").not.toContain(
          "送ると決めた記録がありません",
        );
      });
    });
  });

  describe("CI の状態", () => {
    // **ゲートは CI で落とすのに、handoff からは同じ状態に見えていた**（#125）。
    // **#115 で head SHA と未解決スレッドを足したときと同じ形が、CI に残っていた**。
    //
    // **見るのはゲートを回せる PR である** (#274)。**以前はどの枝でも CI を指紋に
    // 入れていた**ので、**`changes-requested` の PR でも CI が進んだだけで再送されていた**
    // ——**worker から見た「やること」は 1 文字も変わっていない。**
    // **枝ごとに、読んだものだけを指紋にする**ようにしたので、**CI を確かめるのは
    // 「CI で決まる枝」で行う**（狙いは #125 / #173 のまま）。
    const first = REQUIRED[0] ?? "";

    it("pass から fail に変われば、また送る", () => {
      withState({ prs: [{ number: 12 }] });
      expect(cycle("worker").status).toBe(0);

      // **label も head も未解決スレッドも動かない。** 動いたのは CI だけである
      withState({ prs: [{ number: 12, checks: { [first]: "fail" } }] });

      expect(run("worker").status, "ゲートが落とす条件が指紋に入っていない").toBe(0);
    });

    it("CI が同じままなら、2 通目を送らない", () => {
      // **毎回変わる値を入れない**（`bin/loop-stall` の識別子と同じ制約）。
      // **CI の状態は「変われば前へ進んだ」を表す**ので、その条件を満たす
      withState({ prs: [{ number: 12, checks: { [first]: "pending" } }] });
      expect(cycle("worker").status).toBe(0);

      expect(run("worker").status, "同じ CI で送っている").toBe(1);
    });

    it("必須でないチェックが落ちていても、必須が pass に変われば送る", () => {
      // **ここが本命**（#173 のレビュー）。**集約値を指紋にすると、必須でないものが
      // 落ちている間は `FAILURE` のまま**なので、**必須が pending → pass に変わって
      // ゲートが不合格 → 合格になっても、指紋が動かない**——
      // **マージできるようになった、まさにその瞬間に黙る**
      const optional = "CodeQL"; // **必須の一覧に無い**チェック
      withState({
        prs: [{ number: 12, checks: { [optional]: "fail", [first]: "pending" } }],
      });
      expect(cycle("worker").status).toBe(0);

      // 必須だけが pass に変わった（**必須でないものは落ちたまま**）
      withState({ prs: [{ number: 12, checks: { [optional]: "fail" } }] });

      expect(run("worker").status, "集約値を見ていて、合格に変わった瞬間に黙る").toBe(0);
    });

    it("必須でないチェックだけが変わっても、2 通目を送らない", () => {
      // **逆向きも見る。** ゲートの合否が動かないものを指紋に入れると、
      // **無関係な揺れで通知が飛ぶ**（`bin/loop-stall` の識別子と同じ制約）
      withState({ prs: [{ number: 12, checks: { CodeQL: "pass" } }] });
      expect(cycle("worker").status).toBe(0);

      withState({ prs: [{ number: 12, checks: { CodeQL: "fail" } }] });

      expect(run("worker").status, "必須でないチェックで指紋が動いている").toBe(1);
    });

    it("必須の一覧は、ゲートから取る", () => {
      // **書き写さない**（#159 と同じ理由）。**上書きした環境で、そちらへ追随するか**を見る
      const env = { LOOP_REQUIRED_CHECKS: "CodeQL" };
      withState({ prs: [{ number: 12, checks: { CodeQL: "pending" } }] });
      expect(cycle("worker", env).status).toBe(0);

      // **上書きした一覧の外**（既定では必須）だけが動いた
      withState({ prs: [{ number: 12, checks: { CodeQL: "pending", [first]: "fail" } }] });

      expect(run("worker", env).status, "自前の一覧で見ている").toBe(1);
    });

    it("CI を読めなければ、送らない側へ倒さない", () => {
      // **判定不能を「送らない」に倒さない**（このスクリプトの原則）
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }], failsOn: "check-runs" });

      expect(run("master").status).toBe(2);
    });

    it("必須チェックの名前も、決着の読み方も、書き写さない", () => {
      // **写しを持つと、判定を変えても緑のまま**になる（#135 の家族）。
      // **`bucket` を自分で読むと、ゲートが `conclusion` で成功へ変わっても
      // 指紋が動かない**——**マージできるようになった、まさにその瞬間に黙る**（#207）
      const script = readFileSync(SCRIPT, "utf8");

      for (const name of REQUIRED) {
        expect(script, `${name} を書き写している`).not.toContain(name);
      }
      // **理由を書くのは構わない。** **自分で引いていないこと**を見る
      expect(script, "自分で CI を読んでいる").not.toContain("gh pr checks");
      expect(script, "判定を持つところから取っていない").toContain("loop-ci-status");
      expect(script, "指紋を尋ねていない").toContain("--fingerprint");
    });
  });

  describe("誰が書いたかを、印で読む", () => {
    // **master と worker は同じ GitHub アカウントで動く** (#174)。**発言から役を
    // 見分けられない**ので、**ここは「呼んだ側は書き終えている」で代用していた**
    // ——**前提であって事実ではない。** **worker の返信を master の判断として読むと、
    // 当否が判断されていない指摘が「判断済み」に落ちる**（**通す側へ倒れる**）。
    //
    // **印は `bin/loop-review-reply` が必ず付ける。** **ここは読むだけ。**

    it("worker の返信なら、確認するのは master である", () => {
      withState({ prs: [{ number: 12, unresolvedBy: ["worker"] }] });

      const handoff = run("worker");

      expect(handoff.status, handoff.stderr).toBe(0);
      expect(handoff.stdout).toMatch(/^master\t/);
    });

    it("worker の返信なら、master から見ても worker へは渡さない", () => {
      // **呼んだ役で反転しない**のが要点である（**代用をやめた**）。
      // **master から見れば自分宛て**なので、**渡さないのが正しい**
      // ——**前は「相手役へ」で worker へ返していた**（**直す番ではないのに起こす**）
      withState({ prs: [{ number: 12, unresolvedBy: ["worker"] }] });

      const handoff = run("master");

      expect(handoff.stdout, "worker を起こしている").not.toMatch(/^worker\t/);
      expect(handoff.status, "自分宛てなので渡さない").toBe(1);
    });

    it("master の発言なら、直すのは worker である", () => {
      withState({ prs: [{ number: 12, unresolvedBy: ["master"] }] });

      const handoff = run("master");

      expect(handoff.status, handoff.stderr).toBe(0);
      expect(handoff.stdout).toMatch(/^worker\t/);
    });

    it("master の発言なら、worker から見ても master へは渡さない", () => {
      // **こちらも反転しない。** **前は worker から呼ぶと master へ返していた**
      // ——**master は自分が書いたばかりのものを見に行くことになる**
      withState({ prs: [{ number: 12, unresolvedBy: ["master"] }] });

      const handoff = run("worker");

      expect(handoff.stdout, "master を起こしている").not.toMatch(/^master\t/);
      expect(handoff.status, "自分宛てなので渡さない").toBe(1);
    });

    it("印の無い発言は、worker の返信として扱う", () => {
      // **どちらかへ倒す必要がある**（#174 の完了条件）。**master 扱いにすると、
      // まさにこの Issue が挙げた誤認——「worker の返信を master の判断として読む」
      // ——を既定にしてしまう。** **worker 扱いなら、倒れる先は「master が確認する」**
      // で、**止まる側**である（**通す側へ倒さない**）。
      withState({ prs: [{ number: 12, unresolvedBy: ["us"] }] });

      expect(run("worker").stdout, "印が無いときに worker へ返している").toMatch(/^master\t/);
    });
  });

  describe("役で反転する宛先", () => {
    it("同じ指紋で 2 通目を送らない", () => {
      // **`informed` を宛先だけに書くと、同じ指紋のまま master→worker→master と
      // 2 通出る**（#173 のレビュー）。
      //
      // **送った側は、その状態を知っている**——**自分で見て、自分で配った**のだから、
      // **もう一度知らせても新しいことは何も無い**。
      //
      // **宛先が呼んだ役で反転しなくなっても**（#174。**印で決める**）、
      // **ここは残る**——**worker が受け取ったあと、同じ状態のまま出口を通る**
      withState({ prs: [{ number: 12, unresolvedBy: ["master"] }] });
      expect(cycle("master").status, "worker へ渡せていない").toBe(0);

      expect(run("worker").status, "同じ指紋で送り返している").toBe(1);
    });

    it("何も書いていない周回が、書いたことにしない", () => {
      // **出口は「何もしなかった場合も含めて必ず通す」**ので、
      // **「呼んだ側はその周回で書き終えている」という前提は成り立たない**。
      // **状態から読めることだけを言う**（master の指摘）
      withState({ prs: [{ number: 12, unresolvedBy: ["us"] }] });

      expect(run("worker").stdout, "していないことを言っている").not.toContain("対応が返っている");
    });
  });

  it("parked の PR に紐づく Issue は着手中に数えない", () => {
    // **保留は「先行 PR を先に通す」ための正常な流れ**である。生の `in-progress` を
    // 見ると「渡すものが無い」と答えてしまい、**#92 がいちばん埋めたかった沈黙**になる
    // （master のステップ 6 も同じ理由で除いている）
    withState({
      prs: [{ number: 12, labels: ["parked"], body: "Closes #7" }],
      ready: 1,
      inProgress: 1,
    });

    expect(run("master").stdout).toMatch(/^worker\t/);
  });

  describe("一覧が古くても取りこぼさない", () => {
    it("`ready` を付けた直後でも、worker へ渡る", () => {
      // **一覧（検索）は付け替えた直後に古い値を返す**（実測で 4 秒ほど 0 件のまま）。
      // **昇格させた直後は必ず 0 件に見える**ので、
      // **`ready` を付けて通知する、というもっとも普通の受け渡しがもっとも落ちやすい**。
      // 偽の `gh` は**一覧では 0 件**、**検索を通さない口では 1 件**を返す
      withState({ ready: 1 });

      const handoff = run("master");

      expect(handoff.status).toBe(0);
      expect(handoff.stdout).toMatch(/^worker\t/);
    });

    it("PR の label も、古い一覧から読まない", () => {
      // 同じ遅れは PR 側にもある（実測）。`changes-requested` を付けた直後に
      // **古い一覧を見ると、要求が残っているのに「ゲートを回せる」と読む**
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

      expect(run("master").stdout).toMatch(/^worker\t/);
    });
  });

  describe("ゲートと同じものを見る", () => {
    it("未解決スレッドが残る PR を、ゲートを回せる側へ渡さない", () => {
      // **ゲートは未解決スレッドを見て落とすのに、handoff は label だけを見ていた。**
      // label が 0 件だと「master がゲートを回せる」と読み、**自分宛なので黙る**
      // （#103 と #107 で実際に起きた。手順書どおりに進んでも label は付かない）
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });

      expect(run("worker").stdout).not.toContain("ゲート");
    });

    it("未解決が無ければ、これまでどおり master がゲートを回す", () => {
      withState({ prs: [{ number: 12, unresolvedBy: [] }] });

      expect(run("worker").stdout).toMatch(/^master\t/);
    });

    it("label と実態が食い違っていたら、別の終了コードで知らせる", () => {
      // **「送るものが無い」と「状態が矛盾している」を混ぜない**（#105）。
      // 未解決があるのに `changes-requested` が無いのは、運用が壊れている
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });

      expect(run("master").status).toBe(3);
    });

    it("同じ状態が続く間も、毎周知らせる", () => {
      // **記録が 1 回で止まると、3 周に到達しない。** 食い違いを気づかせるための
      // 仕組みが、**気づかせたい状態でだけ黙る**（#115 のレビュー指摘）。
      // 「送るかどうか」と「記録するかどうか」は別の判断である
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });

      expect(run("master").status).toBe(3);
      expect(run("master").status).toBe(3);
    });

    it("送らない周回でも知らせる", () => {
      // **自己宛てでも重複でも通る。** その状態が続いていること自体が、記録したい事実。
      // **当否がまだ判断されていない指摘の持ち手は master** なので、
      // **master から呼んだ周回が自己宛て**になる
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });

      const handoff = run("master");

      expect(handoff.status).toBe(3);
      expect(handoff.stdout).toBe("");
    });

    it("label が付いていれば矛盾ではない", () => {
      withState({ prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot"] }] });

      expect(run("master").status).toBe(0);
    });

    it("未解決スレッドを読めなければ 2 で落ちる", () => {
      // **落とす場所を絞る。** 「GraphQL なら落ちる」にすると、
      // **PR 一覧の取得で先に落ちて、スレッドを取りに行く前に終わる**——
      // 名前は「未解決スレッド」なのに、**そこへ届いていない**（#123 のレビュー指摘）
      withState({ prs: [{ number: 12 }], failsOn: "reviewThreads" });

      expect(run("master").status).toBe(2);
    });

    it("PR の一覧を読めなければ 2 で落ちる", () => {
      // **手前で落ちる経路も、名前を付けて別に持つ。**
      // 相乗りさせると、**片方が壊れてももう片方の名前で緑になる**
      withState({ prs: [{ number: 12 }], failsOn: "pullRequests(states:OPEN" });

      expect(run("master").status).toBe(2);
    });
  });

  describe("レビュー対応の復路", () => {
    it("worker が返信し終えた周回は master へ渡す", () => {
      // **resolve できるのは master だけ**なので、直して返信し終えても未解決は残る。
      // ここで宛先を worker にすると**自分宛て → exit 1 → 沈黙**で、
      // **この PR が塞ごうとした穴を復路に作る**（#115 のレビュー指摘）
      withState({ prs: [{ number: 12, unresolvedBy: ["us"] }] });

      expect(run("worker").stdout).toMatch(/^master\t/);
    });

    it("master が返した周回は worker へ渡す", () => {
      // **件数は同じで、変わるのは「最後に誰が書いたか」**である。
      // **「誰が」は発言の印で読む** (#174)——**呼んだ役では決めない**
      withState({ prs: [{ number: 12, unresolvedBy: ["master"] }] });

      expect(run("master").stdout).toMatch(/^worker\t/);
    });

    it("誰も答えていない指摘は、label が付いていれば worker の持ち物", () => {
      // レビューの bot が最後なら、**まだ誰も答えていない**。
      // **当否の判断は済んでいる**（master が label を付けている）ので、直すのは worker
      withState({ prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot"] }] });

      expect(run("master").stdout).toMatch(/^worker\t/);
      // **worker から呼べば自分宛てなので送らない**
      expect(run("worker").stdout).toBe("");
    });

    it("返信だけでも、また送る", () => {
      // **コードを変えずに理由だけ返信できる**（手順書 238 行目）。
      // head も件数も label も動かないので、**指紋が最後の発言を持っていないと黙る**
      // label は付いている状態から始める（付いていない件は別の試験で見る）
      const requested = ["changes-requested"];
      withState({
        prs: [{ number: 12, labels: requested, unresolvedBy: ["bot"], lastComment: 100 }],
      });
      expect(cycle("master").status).toBe(0);

      withState({
        prs: [{ number: 12, labels: requested, unresolvedBy: ["us"], lastComment: 200 }],
      });

      expect(run("worker").status).toBe(0);
    });
  });

  describe("当否がまだ判断されていない指摘", () => {
    /** #152 と同じ形。**指摘が返ってきて、worker がまだ返信していない瞬間。** */
    const untriaged = { prs: [{ number: 12, unresolvedBy: ["bot"] as ("bot" | "us")[] }] };

    it("持ち手は master である（付けられるのは master だけ）", () => {
      // **`changes-requested` を付け外しできるのは master だけ**なので、
      // **当否が判断されるまで worker には持ち物が無い**。ここを worker 宛にすると、
      // **worker から呼んだ周回は自分宛て → 沈黙**になり、**master は自分の周回まで気づけない**。
      // その間 `handoff-mismatch` が積まれ、**PR が健全でも 3 周で `loop/STOP`** に達する（#152 で 1/3）
      withState(untriaged);

      const handoff = run("worker");

      expect(handoff.stdout).toMatch(/^master\t/);
      expect(handoff.stdout).toContain("12");
    });

    it("label が付けば、持ち手は worker へ移る", () => {
      // **当否の判断が済めば、次に動けるのは直す側である。**
      // ここが動かないと、label を付けても worker が呼ばれない
      withState({ prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot"] }] });

      expect(run("master").stdout).toMatch(/^worker\t/);
    });

    it.each(["master", "worker"])("%s から見ても、同じ状態には同じ終了コードを返す", (role) => {
      // **両側で別々の判定が同時に成り立つ形にしない。**
      // 片方が「対応が返っている」、もう片方が「label が無い」を返すと、
      // **どちらの記録が本当かを人が突き合わせる**ことになる
      withState(untriaged);

      expect(run(role).status).toBe(3);
    });

    it("別のスレッドへ返信しても、答えの無い指摘は隠れない", () => {
      // **PR ごとに「いちばん新しい発言」だけで決めると、答えの無いスレッドが隠れる。**
      // 新しいほうへ返信しただけで「対応が返っている」に落ち、**master は当否を
      // 判断しないまま resolve の確認へ進む**——**指摘が 1 つ、誰にも拾われずに消える**
      withState({ prs: [{ number: 12, unresolvedBy: ["bot", "us"] }] });

      const handoff = run("worker");

      expect(handoff.stdout).toMatch(/^master\t/);
      expect(handoff.status).toBe(3);
    });

    it("label が付いていても、あとから届いた指摘は master の持ち物", () => {
      // **`changes-requested` は PR 全体の状態**であって、**個別の指摘を見た証拠ではない。**
      // CI の失敗・規模超過・前の指摘で既に付いていることがあり、
      // **その label を「当否は判断済み」と読むと、あとから届いた指摘が
      // 当否の判断を経ないまま worker の持ち物になる**——
      // **worker の周回は自分宛て → 沈黙**なので、master は気づけない
      withState({
        prs: [
          {
            number: 12,
            labels: ["changes-requested"],
            unresolvedBy: ["bot"],
            labeledAt: "2026-08-01T00:00:00Z",
            threadsAt: ["2026-08-02T00:00:00Z"],
          },
        ],
      });

      expect(run("worker").stdout).toMatch(/^master\t/);
    });

    it("label より前からある指摘は、これまでどおり worker の持ち物", () => {
      // **付けた時点で見えていたものは、当否が判断されている。**
      // ここまで master 宛にすると、**label を付けても worker が呼ばれない**
      withState({
        prs: [
          {
            number: 12,
            labels: ["changes-requested"],
            unresolvedBy: ["bot"],
            labeledAt: "2026-08-02T00:00:00Z",
            threadsAt: ["2026-08-01T00:00:00Z"],
          },
        ],
      });

      expect(run("master").stdout).toMatch(/^worker\t/);
    });

    it("label が 1 つも無い PR でも、列がずれない", () => {
      // **タブは IFS の空白なので、連続すると 1 区切りに畳まれる。**
      // label を外した PR——`LABELED_EVENT` は残る——でここを踏むと**列が左へずれ**、
      // **`labeled_at` に PR 本文が入る**。数字は英字より前に並ぶので時刻の比較は
      // **必ず偽**になり、**「判断済み」の枝 → worker 宛 → 自分宛て → 沈黙**。
      // しかも食い違いの記録は untriaged の枝でしか立たないので、**記録も残らない**。
      //
      // **本文を空にしない。** 空だと**ずれた先も空**になって、
      // **畳まれたままでも同じ答えが出る**——**確認そのものが空振りする**
      withState({
        prs: [
          {
            number: 12,
            labels: [],
            body: "本文がある",
            labeledAt: "2026-08-01T00:00:00Z",
            unresolvedBy: ["bot"],
            threadsAt: ["2026-08-02T00:00:00Z"],
          },
        ],
      });

      const handoff = run("worker");

      expect(handoff.stdout).toMatch(/^master\t/);
      // label が 1 つも無いまま答えの無い指摘が残る形は、これまでどおり記録される
      expect(handoff.status).toBe(3);
    });

    it("すべて答えてあれば、これまでどおり復路になる", () => {
      // **答えの無いものが 1 つも無い**なら、確かめる対象がある
      withState({ prs: [{ number: 12, unresolvedBy: ["us", "us"] }] });

      const handoff = run("worker");

      expect(handoff.stdout).toMatch(/^master\t/);
      expect(handoff.status).toBe(0);
    });
  });

  describe("push した周回", () => {
    it("head が変われば、また送る", () => {
      // **指紋が PR の中身を持たないと、往復して元の値へ戻る**（#105 の 3 回目）。
      // 直して push しても「同じ状態」と読まれ、**master へ届かない**
      withState({ prs: [{ number: 12, labels: ["changes-requested"], head: "a".repeat(40) }] });
      expect(cycle("master").status).toBe(0);

      withState({ prs: [{ number: 12, labels: ["changes-requested"], head: "b".repeat(40) }] });

      expect(run("master").status).toBe(0);
    });

    it("head が同じなら 2 通目を送らない", () => {
      // **送り合いを作らない。** head SHA は「変われば前へ進んだ」を表す値である
      withState({ prs: [{ number: 12, labels: ["changes-requested"], head: "a".repeat(40) }] });
      expect(cycle("master").status).toBe(0);

      expect(run("master").status).toBe(1);
    });

    it("未解決スレッドが増えれば、また送る", () => {
      // **push が無くても master が指摘を返せば状態は動く。** SHA だけでは足りない
      withState({ prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot"] }] });
      expect(cycle("master").status).toBe(0);

      withState({
        prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot", "bot"] }],
      });

      expect(run("master").status).toBe(0);
    });
  });

  it("最後の parked PR に Closes が無くても、数えたぶんは残る", () => {
    // **`grep` の exit 1 は「無かった」であって「読めなかった」ではない。**
    // 最後の反復の終了コードで全体を捨てると、**取れていたぶんまで 0 になる**——
    // そのとき `parked` の Issue が引かれず、**保留がいちばん埋めたかった沈黙**が戻る。
    // **一致しないほうを最後に置く**（順番が効く）
    withState({
      prs: [
        { number: 12, labels: ["parked"], body: "Closes #7" },
        { number: 13, labels: ["parked"], body: "本文だけで Closes が無い" },
      ],
      ready: 1,
      inProgress: 1,
    });

    expect(run("master").stdout).toMatch(/^worker\t/);
  });

  it("parked でない着手中があれば渡さない", () => {
    // worker が動いている。**起こす必要は無い**
    withState({ ready: 1, inProgress: 1 });

    expect(run("master").status).toBe(1);
  });
});
