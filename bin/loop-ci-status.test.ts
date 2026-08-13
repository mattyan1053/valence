import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-ci-status", import.meta.url));

/** `check-runs` が返す 1 件。 */
type Check = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string;
  /** 何秒前に始まったか。 */
  startedAgo?: number;
};

/**
 * **CI の検査が決着したかを、`status` と `conclusion` の両方で見る** (#206)。
 *
 * **実物が 105 分止まった。** **`conclusion=success` なのに `status=in_progress` のまま**で、
 * **`gh pr checks` の `bucket` は `status` から導かれる**ので **pending と読まれた**——
 * **master は毎周回「正しく何もしない」を選び、そのたびに永久へ近づいた。**
 *
 * **止めるだけにしない。** **本当に走っている CI を止めると、#47 で塞いだ
 * 「正常に動きながら何も進まない」の逆側**——**健全な待ちを壊す**——へ倒れる。
 */
describe("bin/loop-ci-status", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-ci-status-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
    workflowJobs = undefined;
    unreadableWorkflow = undefined;
    oddlyNamedWorkflow = undefined;
    headScriptBody = undefined;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const REQUIRED = "alpha\nbeta";

  /**
   * **その PR の head にある** `.github/workflows/` を答えさせる。**閾値の出所はここ**。
   *
   * **master は PR を checkout しない**ので、**手元の作業ツリーを読むと `main` の値**に
   * なる——**PR が timeout を伸ばしていると、正当に走っているジョブを止める**
   *（#207 のレビュー）。
   */
  /** workflow ごとの job の `timeout-minutes`。`null` は**宣言していない job**。 */
  let workflowJobs: (number | null)[][] | undefined;
  /** 中身を取れない workflow（添字）。 */
  let unreadableWorkflow: number | undefined;
  /** 名前で弾かれる workflow（添字）。**ファイル名に規則は無い**（空白も置ける）。 */
  let oddlyNamedWorkflow: number | undefined;
  function workflowsWithJobs(
    jobs: (number | null)[][],
    broken: { unreadable?: number; oddlyNamed?: number } = {},
  ): void {
    workflowJobs = jobs;
    unreadableWorkflow = broken.unreadable;
    oddlyNamedWorkflow = broken.oddlyNamed;
  }

  /** workflow 1 本につき job 1 つ、いずれも宣言あり。 */
  function workflows(
    timeouts: number[],
    broken: { unreadable?: number; oddlyNamed?: number } = {},
  ): void {
    workflowsWithJobs(
      timeouts.map((minutes) => [minutes]),
      broken,
    );
  }

  /**
   * PR の head にある `bin/loop-ci-status` の中身。`undefined` は**読めない**。
   *
   * **必須の一覧は、`main` と head の**和**である** (#219)。**足す側はすぐ効き、
   * 減らす側は効かない**——**head をそのまま使うと、名前を消した PR が自分の
   * ゲートを通る。**
   */
  let headScriptBody: string | undefined;

  /** head の版が、その一覧を持っている状態にする。 */
  function headRequires(names: string[], extra: string[] = []): void {
    headScriptBody = [
      "#!/usr/bin/env bash",
      ...extra,
      `readonly DEFAULT_REQUIRED_CHECKS="${names.join("\n")}"`,
      'echo "ここから先は実行されてはならない"',
    ].join("\n");
  }

  /** その workflow の中身（`gh api` の raw が返すもの）。 */
  function workflowBody(jobs: (number | null)[]): string {
    return [
      "name: w",
      "on:",
      "  pull_request:",
      "jobs:",
      ...jobs.flatMap((minutes, index) => [
        `  job${index}:`,
        "    runs-on: ubuntu-latest",
        ...(minutes === null ? [] : [`    timeout-minutes: ${minutes}`]),
        "    steps:",
        "      - run: true",
      ]),
    ].join("\n");
  }

  /**
   * head にある `bin/loop-ci-status` を返す枝（#219）。
   *
   * **中身はファイルから流す。** **スタブへ埋め込むと、`$` や `` ` `` が
   * シェルに展開される**——**本物のスクリプトを食わせた瞬間に別物になる。**
   */
  function headScriptBranch(path: string): string[] {
    return [
      'if [[ $args == *"contents/bin/loop-ci-status?ref=deadbeef"* ]]; then',
      ...(headScriptBody === undefined
        ? ["  exit 1"]
        : [`  cat ${JSON.stringify(path)}`, "  exit 0"]),
      "fi",
    ];
  }

  /**
   * `.github/workflows/` の一覧と中身を返す枝。
   *
   * **head を指して問い合わせているか**を見る（`?ref=<sha>`）——
   * **手元の作業ツリーを読む実装では、この分岐に来ない。**
   */
  function workflowBranches(): string[] {
    const names = (workflowJobs ?? []).map((_jobs, index) =>
      index === oddlyNamedWorkflow ? `w${index} と 名前.yml` : `w${index}.yml`,
    );
    return [
      'if [[ $args == *"contents/.github/workflows?ref=deadbeef"* ]]; then',
      ...(workflowJobs === undefined
        ? ["  exit 1"]
        : [...names.map((name) => `  printf '%s\\n' ".github/workflows/${name}"`), "  exit 0"]),
      "fi",
      ...(workflowJobs ?? []).map((jobs, index) =>
        index === unreadableWorkflow
          ? `if [[ $args == *"contents/.github/workflows/w${index}.yml?ref=deadbeef"* ]]; then exit 1; fi`
          : `if [[ $args == *"contents/.github/workflows/w${index}.yml?ref=deadbeef"* ]]; then printf '%b\\n' ${JSON.stringify(workflowBody(jobs))}; exit 0; fi`,
      ),
    ];
  }

  /**
   * check-runs を返す枝。
   *
   * **`--jq` の式まで見る**（#135 と同じ理由）——**スタブが「取り出し済みの値」を
   * 返すだけだと、問い合わせる列を変えても緑のまま**になる。
   *
   * **符号化するのは gh 側の `--jq` である。** **スタブが常に符号化すると、
   * 実装から `@base64` を外す変異が緑のまま通る**——**式に `@base64` があるかを
   * 見て、無ければ生の名前を返す。**
   */
  function checkRunsBranch(checks: Check[], fails: boolean): string[] {
    const now = Math.floor(Date.now() / 1000);
    const tail = (check: Check) =>
      [
        check.status,
        check.conclusion ?? "",
        check.startedAgo === undefined
          ? ""
          : new Date((now - check.startedAgo) * 1000).toISOString(),
      ].join("\\u001f");
    const row = (name: string, check: Check) =>
      `    printf '%b\\n' ${JSON.stringify(`${name}\\u001f${tail(check)}`)}`;
    return [
      'if [[ $args == *"check-runs"* ]]; then',
      ...(fails ? ["  exit 1"] : []),
      '  if [[ $args != *".conclusion"* ]]; then',
      '    echo "スタブ: conclusion を問い合わせていない: $args" >&2',
      "    exit 1",
      "  fi",
      '  if [[ $args != *".status"* ]]; then',
      '    echo "スタブ: status を問い合わせていない: $args" >&2',
      "    exit 1",
      "  fi",
      '  if [[ $args == *"@base64"* ]]; then',
      ...checks.map((check) => row(Buffer.from(check.name, "utf8").toString("base64"), check)),
      "  else",
      ...checks.map((check) => row(check.name, check)),
      "  fi",
      "  exit 0",
      "fi",
    ];
  }

  function run(options: {
    checks?: Check[];
    /** `gh` が落ちる。 */
    ghFails?: boolean;
    /** head を読めない。 */
    headFails?: boolean;
    /** 指紋だけを尋ねる（`bin/loop-handoff` が使う）。 */
    fingerprint?: boolean;
  }): { status: number; stdout: string; stderr: string } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    const headScriptPath = join(sandbox, "head-script");
    if (headScriptBody !== undefined) {
      writeFileSync(headScriptPath, headScriptBody);
    }
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        'args="$*"',
        // **何を尋ねたかを残す。** **尋ねていないことを確かめる**のに要る
        `printf '%s\\n' "$args" >> ${JSON.stringify(join(sandbox, "gh.calls"))}`,
        'if [[ $args == *"headRefOid"* ]]; then',
        ...(options.headFails === true ? ["  exit 1"] : []),
        `  printf '%s\\n' "deadbeef"`,
        "  exit 0",
        "fi",
        ...headScriptBranch(headScriptPath),
        ...workflowBranches(),
        ...checkRunsBranch(options.checks ?? [], options.ghFails === true),
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const copied = join(sandbox, "loop-ci-status");
    writeFileSync(copied, "");
    rmSync(copied);
    const bin = join(sandbox, "bin");
    mkdirSync(bin, { recursive: true });
    const target = join(bin, "loop-ci-status");
    writeFileSync(target, "");
    rmSync(target);
    spawnSync("cp", [SCRIPT, target]);
    chmodSync(target, 0o755);
    const result = spawnSync(
      target,
      options.fingerprint === true ? ["--fingerprint", "42"] : ["42"],
      {
        cwd: sandbox,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stub}:${process.env.PATH}`,
          LOOP_REQUIRED_CHECKS: REQUIRED,
        },
      },
    );
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("conclusion が出ていれば、status が in_progress でも決着として扱う", () => {
    // **実物がこれである**（105 分）。**`status` と `conclusion` は別の軸**なので、
    // **片方に丸めない**（#90「並べ忘れた値がどの分岐にも入らない」と同族）
    workflows([5, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", conclusion: "success", startedAgo: 6300 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 6300 },
      ],
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("本当に走っている検査は、これまでどおり待つ", () => {
    // **止める側だけ見ると、健全な CI を止める形でも緑になる**
    //（#200 で 3 回出た「倒す先は 2 つある」）
    workflows([5, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 60 },
      ],
    });

    expect(result.status, "走っている CI を止めている").toBe(3);
  });

  it("決着しないまま予算を超えたら、人を呼ぶ", () => {
    // **ジョブ自身が諦める時間より長く待つ理由が無い**（閾値の根拠）
    workflows([5, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 21 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 21 * 60 },
      ],
    });

    expect(result.status, "永久に待っている").toBe(4);
  });

  it("予算は、いちばん長い timeout-minutes に合わせる", () => {
    // **短いほうに合わせると、長い CI を持つ検査で誤って止める**（master の指摘）。
    // **16 分は `ci.yml` の 15 分を超えるが、`codeql.yml` の 20 分の内**である
    workflows([5, 15, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 16 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 16 * 60 },
      ],
    });

    expect(result.status, "短いほうの timeout で止めている").toBe(3);
  });

  it("1 本でも読めなければ、予算を捨てる", () => {
    // **部分的に集めた最大は、最大ではない**（#207 のレビュー 2 周目）。
    // **飛ばして残りの最大を使うと、予算が黙って縮む**——**縮んだ予算は、
    // そのまま誤停止になる**（`ci-pending` が 3 周続けば `loop/STOP`）。
    //
    // **一覧が読めないときは止めない**と書いてあるのに、**1 本のときだけ
    // 止める側へ倒れていた**——**散文にはあるが、実行されるものには無い。**
    workflows([15, 20], { unreadable: 1 });

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 16 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 16 * 60 },
      ],
    });

    expect(result.status, "縮んだ予算で止めている").toBe(3);
  });

  it("名前で弾いた 1 本があっても、予算を捨てる", () => {
    // **`.github/workflows/` のファイル名に規則は無い**（空白も日本語も置ける）ので、
    // **弾いた 1 本が最大だったときに同じことが起きる**。**弾くこと自体は正しい**
    //（外部由来の文字列を経路に組み立てない）——**弾いたあとの倒し方だけが違う。**
    workflows([15, 20], { oddlyNamed: 1 });

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 16 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 16 * 60 },
      ],
    });

    expect(result.status, "弾いた 1 本を無かったことにしている").toBe(3);
    // **弾いた名前を、経路へ組み立てない**（外部由来の文字列をそのまま送らない）
    expect(
      readFileSync(join(sandbox, "gh.calls"), "utf8"),
      "弾いたはずの名前を問い合わせている",
    ).not.toContain("と 名前");
  });

  it("宣言しない job があれば、GitHub の既定（360 分）で測る", () => {
    // **宣言しない job の「諦める時間」は、無いのではなく 360 分**である（#207 の
    // レビュー 3 周目）。**数えないと、別の workflow の 20 分で 21 分目に止める**——
    // **いま直したのと同じ「小さい予算で止める」形。**
    //
    // **破棄はしない。** **破棄するとその PR では `exit 4` が二度と出ない**——
    // **それは #206 そのもの**で、**この PR はそれを直すために立っている。**
    workflowsWithJobs([[20], [15, null]]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 21 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 21 * 60 },
      ],
    });

    expect(result.status, "宣言しない job を数えずに止めている").toBe(3);
  });

  it("宣言しない job があっても、360 分を超えたら人を呼ぶ", () => {
    // **破棄との違いはここだけ**である——**この 1 本が無いと、破棄に戻しても緑のまま。**
    workflowsWithJobs([[20], [15, null]]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 361 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 361 * 60 },
      ],
    });

    expect(result.status, "宣言しない job があると、検出が消えている").toBe(4);
  });

  it("どの job も宣言していなくても、既定で測る", () => {
    // **最後の条件が 2 つの意味を兼ねていた**（#207 のレビュー 4 周目）——
    // **「workflow を読めた」を `budget_min` の有無で見ていた**ので、
    // **どの job も宣言していないと、読めているのに空**になり、**既定へ倒れなかった。**
    //
    // **「全部が宣言しない」は恒久的**である（**直すまで毎周回そこに在る**）のに、
    // **一時的の側（捨てる）へ落ちていた**——**自分で書いた軸が、そのまま当たっていた。**
    workflowsWithJobs([[null], [null]]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 361 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 361 * 60 },
      ],
    });

    expect(result.status, "どの job も宣言していないと、検出が消えている").toBe(4);
  });

  it("どの job も宣言していなくても、既定の内なら待つ", () => {
    // **360 へ倒しすぎない**（既定は「諦める時間」であって、止める合図ではない）
    workflowsWithJobs([[null], [null]]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 21 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 21 * 60 },
      ],
    });

    expect(result.status, "既定の内なのに止めている").toBe(3);
  });

  it("読めない 1 本があれば、既定へも倒さない", () => {
    // **「1 本でも読めなければ捨てる」は、既定へ倒す側にも効く**——
    // **読めなかった 1 本が 500 分を宣言していたら、360 は根拠にならない。**
    // **読めた側に宣言しない job がある**入力でないと、この経路に入らない
    workflowsWithJobs([[null], [15]], { unreadable: 1 });

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 361 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 361 * 60 },
      ],
    });

    expect(result.status, "読めていないのに既定を名乗っている").toBe(3);
  });

  it("全部の job が宣言していれば、その最大で測る", () => {
    // **360 へ倒しすぎない。** **宣言してあるなら、それが「諦める時間」である。**
    workflowsWithJobs([[20], [15, 10]]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 21 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 21 * 60 },
      ],
    });

    expect(result.status, "宣言があるのに 360 で測っている").toBe(4);
  });

  it("予算を読めなければ、待つ側へ倒す", () => {
    // **判定不能を「止める」へ倒さない**（完了条件）
    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 100000 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 100000 },
      ],
    });

    expect(result.status, "根拠が無いまま止めている").toBe(3);
  });

  it("始まった時刻を読めなければ、待つ側へ倒す", () => {
    workflows([5]);

    const result = run({
      checks: [
        { name: "alpha", status: "queued" },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "経過を測れないのに止めている").toBe(3);
  });

  it("決着して失敗なら、待たずに失敗を返す", () => {
    workflows([5]);

    const result = run({
      checks: [
        { name: "alpha", status: "completed", conclusion: "failure", startedAgo: 10 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "失敗を待ちに混ぜている").toBe(1);
  });

  it("知らない conclusion は、成功に数えない", () => {
    // **並べ忘れた値がどの分岐にも入らない**を避ける（#90）——
    // **成功の側を並べ、それ以外は失敗**へ倒す
    workflows([5]);

    const result = run({
      checks: [
        { name: "alpha", status: "completed", conclusion: "timed_out", startedAgo: 10 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "知らない値を成功として通している").toBe(1);
  });

  it("区切りを含む名前で、必須の検査を偽装できない", () => {
    // **チェック名は PR 側で決められる**（pull_request で走る job 名）。
    // **生のまま並べる実装では、名前 1 つで行を増やし、実在しない必須チェックを
    // 成功に見せられる**——**符号化した名前で突き合わせる。**
    workflows([5]);

    const result = run({
      checks: [
        {
          // **生のまま並べる実装では、この名前 1 つで `alpha` の行が増える**
          name: "dummy\nalpha\u001fcompleted\u001fsuccess\u001f2026-01-01T00:00:00Z",
          status: "completed",
          conclusion: "success",
          startedAgo: 10,
        },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "名前で必須チェックを偽装できている").toBe(1);
  });

  it("必須の検査が無ければ、待たずに失敗を返す", () => {
    // **ワークフローが起動しなかった PR を、0 件で通さない**
    workflows([5]);

    const result = run({
      checks: [{ name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 }],
    });

    expect(result.status, "必須が欠けたまま通している").toBe(1);
  });

  it("取得できなければ、止める側へ倒さない", () => {
    workflows([5]);

    const result = run({ ghFails: true });

    expect(result.status, "読めないのに人を呼んでいる").toBe(2);
  });

  it("指紋は、必須の並び順で決着の別を返す", () => {
    // **`bin/loop-handoff` は指紋で「同じ状態か」を見る**（#173）。**`bucket` のままだと、
    // ゲートが `conclusion` で成功へ変わっても指紋が動かない**——
    // **マージできるようになった、まさにその瞬間に黙る**（#207 のレビュー）。
    workflows([5]);

    const result = run({
      fingerprint: true,
      checks: [
        { name: "alpha", status: "in_progress", conclusion: "success", startedAgo: 6300 },
        { name: "beta", status: "in_progress", startedAgo: 10 },
      ],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim(), "決着の別を、必須の並び順で返していない").toBe("ok,pending");
  });

  it("指紋は、workflow を読みに行かない", () => {
    // **指紋は「同じ状態か」だけを表す。** **予算は要らない**ので、
    // **尋ねない**——**尋ねると、その PR ごとに余計な往復が増える。**
    workflows([5]);

    expect(
      run({
        fingerprint: true,
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "in_progress", startedAgo: 10 },
        ],
      }).status,
    ).toBe(0);

    expect(
      readFileSync(join(sandbox, "gh.calls"), "utf8"),
      "指紋なのに workflow を読んでいる",
    ).not.toContain("workflows");
  });

  it("指紋は、予算を見ない", () => {
    // **指紋は「同じ状態か」だけを表す。** **予算を見ると、時間の経過だけで指紋が動き、
    // 何も変わっていないのに通知が飛ぶ**——**workflow を読む必要も無い。**
    const result = run({
      fingerprint: true,
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 100000 },
        { name: "beta", status: "completed", conclusion: "failure", startedAgo: 10 },
      ],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("pending,bad");
  });

  it("指紋でも、必須が無ければ分かる形で返す", () => {
    const result = run({
      fingerprint: true,
      checks: [{ name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 }],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("ok,none");
  });

  it("指紋でも、取得できなければ止める側へ倒さない", () => {
    const result = run({ fingerprint: true, ghFails: true });

    expect(result.status).toBe(2);
  });

  it("head を読めなければ、止める側へ倒さない", () => {
    workflows([5]);

    const result = run({ headFails: true });

    expect(result.status).toBe(2);
  });

  /**
   * **必須の一覧を `main` と head の**和**で決める** (#219)。
   *
   * **#218 で踏んだ。** **master は checkout しない**ので一覧はいつでも `main` の版で、
   * **PR が足した名前は入っていない**——**その検査が赤でも「必須はすべて成功」と言う。**
   *
   * **#207（予算）と同じ「head から読む」だが、向きが逆である。**
   * **予算は最大を取るので head 側が短くても安全側**だが、**一覧は head をそのまま
   * 使うと、名前を消した PR が自分のゲートを通る**——**和にする。**
   */
  describe("必須の一覧は main と head の和", () => {
    it("PR が足した必須チェックが赤なら、その PR のゲートが落ちる", () => {
      headRequires(["alpha", "beta", "gamma"]);

      const result = run({
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "gamma", status: "completed", conclusion: "failure", startedAgo: 10 },
        ],
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stdout).toContain("gamma");
    });

    it("PR が一覧から名前を消しても、その PR では必須のまま", () => {
      // **置き換えにすると、ここが緑になる。** **減らす側は、マージされて
      // `main` に入って初めて効く。**
      headRequires(["alpha"]);

      const result = run({
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "failure", startedAgo: 10 },
        ],
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stdout).toContain("beta");
    });

    it("head は取れたのに一覧が見つからなければ、止める", () => {
      // **一時的か恒久的かで分ける**（#207 で決めた形）。**取れなかったのは次の周回で
      // 直りうる**が、**書式が変わったのなら次も読めない**——**待っても解けないものを
      // 「待つ」側へ倒すと、`main` の一覧だけで「必須はすべて成功」と言い続ける。**
      // **この PR が直しに来た形が、そのまま戻る。**
      headScriptBody = ["#!/usr/bin/env bash", "declare -r CHECKS=(alpha beta)", ""].join("\n");

      const result = run({
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
        ],
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(2);
    });

    it("一覧の引用符が閉じていなければ、止める", () => {
      // **途中で切れた応答を「そこまで」で拾わない。** **拾うと名前が黙って減る。**
      headScriptBody = ['readonly DEFAULT_REQUIRED_CHECKS="alpha', "beta"].join("\n");

      const result = run({
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
        ],
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(2);
    });

    it("head を読めなければ、main の一覧で判定する", () => {
      // **判定不能を「通す」へ倒さない**が、**読めないだけで全部止めるのも違う**
      //（#207 の「読めなければ止めない」と揃える）。**gamma は `main` の一覧に
      // 無いので、赤くても必須ではない。**
      const result = run({
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "gamma", status: "completed", conclusion: "failure", startedAgo: 10 },
        ],
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    });

    it("指紋も、和で数える", () => {
      // **指紋がゲートより短いと、ゲートを決めている検査が動いても指紋は動かない**
      // ——**マージできるようになった瞬間に黙る**（#173 / #207 と同じ形）。
      headRequires(["alpha", "beta", "gamma"]);

      const result = run({
        fingerprint: true,
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "gamma", status: "in_progress", startedAgo: 10 },
        ],
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("ok,ok,pending");
    });

    it("本物の `bin/loop-ci-status` から、一覧を取り出せる", () => {
      // **作り物だけで試すと、書式や置き場が変わったときに気づけない**——
      // **黙って `main` の一覧へ落ちる**ので、**#218 の穴がそのまま戻る。**
      // **本物を head の中身として食わせ、その名前が必須になることを見る。**
      headScriptBody = readFileSync(SCRIPT, "utf8");
      const names = spawnSync(SCRIPT, ["--required-checks"], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((line) => line !== "");
      expect(names.length).toBeGreaterThan(1);

      const result = run({
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
        ],
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      for (const name of names) {
        expect(result.stdout, `${name} が必須になっていない`).toContain(name);
      }
    });

    it("head の中身を実行しない", () => {
      // **一覧だけを取り出す。** **実行すると、PR の中身を master が走らせる**
      // ——**ゲートを持つ側で、レビュー前のコードが動くことになる。**
      const marker = join(sandbox, "executed");
      headRequires(["alpha", "beta"], [`touch ${JSON.stringify(marker)}`]);

      const result = run({
        checks: [
          { name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 },
          { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
        ],
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(existsSync(marker), "head の版が実行された").toBe(false);
    });
  });
});
