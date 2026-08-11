import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
const LEASE = fileURLToPath(new URL("./loop-lease", import.meta.url));

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

/** GitHub の状態。**偽の `gh` はこれを返すだけ**にして、判断だけを試す。 */
type State = {
  /** open PR。`labels` は付いている label 名。 */
  prs?: {
    number: number;
    /** `Closes #N` を含む本文。**保留した PR の Issue を数えるのに使う。** */
    body?: string;
    labels?: string[];
    /** 未解決スレッドの最後の発言。**件数だけでは持ち手が決まらない。** */
    unresolvedBy?: ("bot" | "us")[];
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
  }[];
  ready?: number;
  inProgress?: number;
  backlog?: number;
  /** `gh` が失敗する（判定不能）。 */
  fails?: boolean;
  /** その取得だけが失敗する。**最初の 1 つだけを試すと、後ろの取得を試せない。** */
  failsOn?: string;
};

describe("bin/loop-handoff", () => {
  let repo: string;
  let path: string;

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
            `${pr.lastComment ?? 100 + index}${FIELD}${who === "bot" ? "chatgpt-codex-connector" : "mattyan1053"}${FIELD}${pr.threadsAt?.[index] ?? THREAD_AT}`,
        ),
      )
      .join("\n");

    writeFileSync(
      join(path, "gh"),
      [
        "#!/usr/bin/env bash",
        ...failureLines(state),
        ...answerLines("repo view", "owner\nrepo"),
        // **件数は検索を通さない口から取る。** 一覧側（下）はわざと 0 を返すので、
        // ここを見ていなければ「ready が 1 件ある」に到達しない
        ...answerLines(
          "totalCount",
          `${state.ready ?? 0}${FIELD}${state.inProgress ?? 0}${FIELD}${state.backlog ?? 0}`,
        ),
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

  function run(role: string, env: Record<string, string> = {}): Run {
    const result = spawnSync(SCRIPT, role === "" ? [] : [role], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: path, ...env },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-handoff-"));
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
    ]) {
      const found = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (found !== "") {
        symlinkSync(found, join(path, command));
      }
    }
    chmodSync(path, 0o755);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
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
      expect(missingRecord(), "飛ばしたことが記録に残らない").toContain("master");
    });

    it("持っていれば、何も言わない", () => {
      // **ループと関係なく叩く場合に邪魔しない**、の裏でもある——
      // 持っている周回には何も足さない
      withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
      expect(spawnSync(LEASE, ["acquire", "master"], { cwd: repo, encoding: "utf8" }).status).toBe(
        0,
      );

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
      expect(missingRecord()).toContain("master");
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

    expect(run("master").status).toBe(0);
    expect(run("master").status).toBe(1);
  });

  it("状態が変われば、また送る", () => {
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
    expect(run("master").status).toBe(0);

    withState({ prs: [{ number: 13, labels: ["changes-requested"] }] });

    expect(run("master").status).toBe(0);
  });

  it("送り合いにならない", () => {
    // **これが本体。** 「暇 → 起こす → 暇 → 起こす」で焼き切れた事故と同じ形を作らない。
    // 交互に呼び続けても、送るのは持ち物がある側への 1 通だけである
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

    const sent = ["master", "worker", "master", "worker", "master", "worker"]
      .map((role) => run(role))
      .filter((handoff) => handoff.status === 0);

    expect(sent).toHaveLength(1);
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
    expect(run("master").status).toBe(0);

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
    expect(run("master").status).toBe(0);

    withState({ prs: [{ number: 12 }] }); // → master
    expect(run("worker").status).toBe(0);

    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] }); // → worker（戻る）

    expect(run("master").status).toBe(0);
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
      // **件数は同じで、変わるのは「最後に誰が書いたか」**である
      withState({ prs: [{ number: 12, unresolvedBy: ["us"] }] });

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
      expect(run("master").status).toBe(0);

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
      expect(run("master").status).toBe(0);

      withState({ prs: [{ number: 12, labels: ["changes-requested"], head: "b".repeat(40) }] });

      expect(run("master").status).toBe(0);
    });

    it("head が同じなら 2 通目を送らない", () => {
      // **送り合いを作らない。** head SHA は「変われば前へ進んだ」を表す値である
      withState({ prs: [{ number: 12, labels: ["changes-requested"], head: "a".repeat(40) }] });
      expect(run("master").status).toBe(0);

      expect(run("master").status).toBe(1);
    });

    it("未解決スレッドが増えれば、また送る", () => {
      // **push が無くても master が指摘を返せば状態は動く。** SHA だけでは足りない
      withState({ prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot"] }] });
      expect(run("master").status).toBe(0);

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
