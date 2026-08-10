import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-handoff", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

/** GitHub の状態。**偽の `gh` はこれを返すだけ**にして、判断だけを試す。 */
type State = {
  /** open PR。`labels` は付いている label 名。 */
  prs?: {
    number: number;
    labels?: string[];
    /** 未解決スレッドの最後の発言。**件数だけでは持ち手が決まらない。** */
    unresolvedBy?: ("bot" | "us")[];
    /** 最後の発言の ID。**返信だけでも動く値**である。 */
    lastComment?: number;
    head?: string;
  }[];
  ready?: number;
  inProgress?: number;
  backlog?: number;
  /** `parked` な PR が閉じる予定の Issue 番号（PR 本文の `Closes #N`）。 */
  parkedCloses?: number[];
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

  function withState(state: State): void {
    const prs = (state.prs ?? [])
      .map((pr) => `${pr.number}\t${(pr.labels ?? []).join(",")}\t${pr.head ?? "a".repeat(40)}`)
      .join("\n");
    // **ゲートと同じものを見る。** 未解決スレッドは GraphQL からしか取れない。
    // 1 行 1 スレッドで、**最後の発言の ID と書いた人**を返す
    const threads = (state.prs ?? [])
      .flatMap((pr) =>
        (pr.unresolvedBy ?? []).map(
          (who, index) =>
            `${pr.lastComment ?? 100 + index}\t${who === "bot" ? "chatgpt-codex-connector" : "mattyan1053"}`,
        ),
      )
      .join("\n");
    const parked = (state.parkedCloses ?? []).map((n) => `Closes #${n}`).join("\n");

    writeFileSync(
      join(path, "gh"),
      [
        "#!/usr/bin/env bash",
        ...failureLines(state),
        ...answerLines("repo view", "owner\nrepo"),
        // **ゲートと同じ読み方をしているか。** スレッド自体をページングしていないと、
        // 101 件目以降にだけ未解決が残る PR を 0 件と数える
        'if [[ $* == *"api graphql"* ]]; then',
        '  if [[ $* != *"pageInfo"* || $* != *"after: $endCursor"* ]]; then',
        '    echo "スタブ: reviewThreads をページングしていない" >&2',
        "    exit 1",
        "  fi",
        "fi",
        ...answerLines("api graphql", threads),
        // **`parked` の問い合わせも `pr list` を含む。** 先に見ないと取り違える
        ...answerLines("parked", parked),
        ...answerLines("pr list", prs),
        'if [[ $* == *"--label ready"* ]]; then echo ' + String(state.ready ?? 0) + "; exit 0; fi",
        'if [[ $* == *"--label in-progress"* ]]; then echo ' +
          String(state.inProgress ?? 0) +
          "; exit 0; fi",
        'if [[ $* == *"--label backlog"* ]]; then echo ' +
          String(state.backlog ?? 0) +
          "; exit 0; fi",
        'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  function run(...args: string[]): Run {
    const result = spawnSync(SCRIPT, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
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
    { name: "ready の取得だけ", state: { failsOn: "--label ready" } },
  ])("状態を読めなければ 2 で落ちる（$name）", ({ state }) => {
    // **判定不能を「送らない」に倒さない。** 倒すと、止まっていることに気づけない
    withState(state);

    expect(run("master").status).toBe(2);
  });

  it("役の綴りを固定する", () => {
    withState({});

    expect(run("workers").status).toBe(2);
    expect(run().status).toBe(2);
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
      prs: [{ number: 12, labels: ["parked"] }],
      parkedCloses: [7],
      ready: 1,
      inProgress: 1,
    });

    expect(run("master").stdout).toMatch(/^worker\t/);
  });

  describe("ゲートと同じものを見る", () => {
    it("未解決スレッドが残る PR は master の持ち物にしない", () => {
      // **ゲートは未解決スレッドを見て落とすのに、handoff は label だけを見ていた。**
      // label が 0 件だと「master がゲートを回せる」と読み、**自分宛なので黙る**
      // （#103 と #107 で実際に起きた。手順書どおりに進んでも label は付かない）
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });

      const handoff = run("master");

      expect(handoff.stdout).toMatch(/^worker\t/);
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
      // **自己宛てでも重複でも通る。** その状態が続いていること自体が、記録したい事実
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });

      const handoff = run("worker");

      expect(handoff.status).toBe(3);
      expect(handoff.stdout).toBe("");
    });

    it("label が付いていれば矛盾ではない", () => {
      withState({ prs: [{ number: 12, labels: ["changes-requested"], unresolvedBy: ["bot"] }] });

      expect(run("master").status).toBe(0);
    });

    it("未解決スレッドを読めなければ 2 で落ちる", () => {
      withState({ prs: [{ number: 12 }], failsOn: "api graphql" });

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

    it("誰も答えていない指摘は worker の持ち物", () => {
      // レビューの bot が最後なら、**まだ誰も答えていない**
      withState({ prs: [{ number: 12, unresolvedBy: ["bot"] }] });

      expect(run("master").stdout).toMatch(/^worker\t/);
      // **worker から呼べば自分宛てなので送らない**（記録は別の判断なので通る）
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

  it("parked でない着手中があれば渡さない", () => {
    // worker が動いている。**起こす必要は無い**
    withState({ ready: 1, inProgress: 1 });

    expect(run("master").status).toBe(1);
  });
});
