import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-silent-park", import.meta.url));

/** 列区切り。**タブは IFS の空白に畳まれる**ので US を使う（`bin/loop-handoff` と同じ）。 */
const FIELD = "\u001f";

/**
 * 理由の無い保留を見つける（#163）。
 *
 * **人待ちにするときは、label を付けてから理由を投稿する。** 投稿が落ちたら
 * label を戻すが、**その戻しも `|| true` で握り潰される**——**落ちる原因が
 * API 障害なら、戻す側も同じ理由で落ちる**（相関する）。
 *
 * 残るのは **`parked` + `awaiting-human` が付いていて、理由がどこにも無い PR** である。
 * **ステップ 2 は `parked` を選ばない**ので、**次の周回はその PR を見ない**——
 * **停止は 1 回しか積まれず、3 周に届かないので人も呼ばれない**。
 *
 * **証拠は GitHub 側に残る**（label はあるのに、その後の発言が無い）。
 * **障害が明けた周回が拾える**ので、ここに新しい記録は要らない。
 */
describe("bin/loop-silent-park", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-silent-park-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** `gh` を差し替える。**返すのは、スクリプトが読む形の行そのもの**。 */
  function withRows(rows: string[], exitCode = 0): string {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        // **リポジトリの名前を尋ねられたら答える**（本体の問い合わせと分ける）
        'if [[ $* == *"repo view"* ]]; then printf "owner\\nrepo\\n"; exit 0; fi',
        `exit_code=${exitCode}`,
        '((exit_code == 0)) || exit "$exit_code"',
        // **区切りを JSON で書かない。** `JSON.stringify` は US を `\\u001f` に逃がし、
        // **bash の `printf '%s'` はそれを解釈しない**——**列が割れないまま渡り、
        // 「人待ちでない」に化ける**（実際にそうなった）。**生のまま埋める**
        ...rows.map((row) => `printf '%s\\n' '${row}'`),
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return stub;
  }

  function run(stub: string): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(SCRIPT, [], {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** `<PR番号>␟<いまの label>␟<人待ちにした時刻>␟<最後の発言の時刻>` */
  function row(
    number: number,
    parkedAt: string,
    lastComment: string,
    labels = "parked,awaiting-human",
  ): string {
    return [String(number), labels, parkedAt, lastComment].join(FIELD);
  }

  it("理由を投稿できなかった保留を挙げる", () => {
    // **二重に落ちた結果の状態**である——label は付いていて、
    // **その後の発言が 1 つも無い**（投稿も、戻しも落ちた）
    const result = run(withRows([row(42, "2026-08-12T04:00:00Z", "2026-08-12T03:00:00Z")]));

    expect(result.status, "見つけたのに 0 を返している").toBe(1);
    expect(result.stdout, "どの PR かが出ていない").toContain("42");
  });

  it("理由が投稿されている保留は、挙げない", () => {
    // **うるさくしない。** 正常な人待ちは**そのままにしておくもの**で、
    // **毎周回それを報せると、本当に拾ってほしいものが埋もれる**
    const result = run(withRows([row(42, "2026-08-12T04:00:00Z", "2026-08-12T04:00:01Z")]));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("同じ秒に投稿された理由も、理由として読む", () => {
    // **GitHub の `createdAt` は秒まで**で、**label を付けてから理由を投稿するまでは
    // `gh` を 1 回挟むだけ**である（この環境の実測で 0.2〜1 秒）——**同じ秒に収まる**。
    //
    // **落ちる先が悪い。** 手順書は exit 1 なら「**理由を投稿し直す**」なので、
    // **既にある理由の隣に同じものをもう 1 つ貼る**ことになる。そのあと自然に直るが、
    // **1 周ぶんと重複コメントが 1 つ残り**、その間**持ち手の 1 番目**を占める。
    //
    // **書いてある手順では、コメントは必ず label より後**である
    // （`--add-label` が成功してから `gh pr comment`）——**同じ秒なら、それは理由**。
    // 逆に倒すと、**起こる形が手順書に書かれていないほう**（label より前の同じ秒）を
    // 守るために、**書いてある形を壊す**ことになる
    const sameSecond = "2026-08-12T04:00:00Z";

    const result = run(withRows([row(42, sameSecond, sameSecond)]));

    expect(result.status, "正常な保留を偽物と呼んでいる").toBe(0);
    expect(result.stdout).toBe("");
  });

  /**
   * **手順どおりに保留すると挙がっていた**（#588）。
   *
   * **手順は「投稿してから保留にする」**（`loop/procedure/master.md` 447 / 712 行。
   * **`parked` は錠ではない**ので**理由が先にあるほうが穴が無い**。#163）——
   * **コメントは必ず label より前**である。**この判定はその逆を求めていた。**
   *
   * **実測**（2026-09-03、PR #585）: **手順どおりに実行して exit 1**。
   * **間に `bin/loop-parked-head record` が挟まる**ので、**秒がずれると落ちる**
   * ——**手順どおりにやるほど落ちやすい。**
   */
  it("投稿してから保留にした PR は、挙げない", () => {
    // **手順の順序そのもの**——**投稿 → 記録 → label** で、**数秒ずれる。**
    const result = run(withRows([row(42, "2026-08-12T04:00:03Z", "2026-08-12T04:00:00Z")]));

    expect(result.status, "手順どおりの保留を偽物と呼んでいる").toBe(0);
    expect(result.stdout).toBe("");
  });

  it("date が使えなくても、保留の後の発言は理由と読む", () => {
    // **前側（保留より前の発言）だけが `date` に頼る**——**後ろ側は文字列で比べる**
    // ので、**道具が無くても、これまでどおり動く。**
    const stub = withRows([row(42, "2026-08-12T04:00:00Z", "2026-08-12T04:00:01Z")]);
    writeFileSync(join(stub, "date"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    expect(run(stub).status, "date が無いだけで正常な保留を挙げている").toBe(0);
  });

  it("date が使えなければ、前側は数えない", () => {
    // **倒れる先は「挙げる」**——**黙るより、うるさいほうが安い。**
    const stub = withRows([row(42, "2026-08-12T04:00:03Z", "2026-08-12T04:00:00Z")]);
    writeFileSync(join(stub, "date"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    expect(run(stub).status, "測れないのに理由があると読んでいる").toBe(1);
  });

  it("保留と関わりの無い古い発言は、理由と数えない", () => {
    // **緩めない**（#588 の完了条件 2）——**「理由がどこにも無い」を見たい**ので、
    // **保留から離れた発言まで数えると、何も見なくなる。**
    const result = run(withRows([row(42, "2026-08-12T04:00:00Z", "2026-08-12T03:00:00Z")]));

    expect(result.status, "古い発言を理由として数えている").toBe(1);
    expect(result.stdout).toContain("42");
  });

  it("発言が 1 つも無い保留も挙げる", () => {
    // **投稿が落ちた PR には、そもそも発言が無いことがある**（作った直後に保留）
    expect(run(withRows([row(42, "2026-08-12T04:00:00Z", "")])).status).toBe(1);
  });

  it("人待ちでない PR は見ない", () => {
    // **時刻が空なら、その PR は 1 度も人待ちにされていない**
    expect(run(withRows([row(42, "", "2026-08-12T03:00:00Z", "")])).status).toBe(0);
  });

  it("人が戻した保留は、挙げない", () => {
    // **`LABELED_EVENT` は履歴なので、label を外しても残る。**
    // **いまの label を見ないと、外れた PR を挙げ続ける**——しかも
    // **これは例外的な経路ではなく、書いてある再開手順そのもの**である。
    //
    // `loop/README.md` の再開手順は「**スレッドを resolve**」か
    // 「**スレッドへ書いて `changes-requested`**」＋ label を外す、で、
    // **どちらも issue コメントを作らない**——**手順どおりに再開した PR が、
    // その瞬間から「理由の無い保留」になり、消えない**。
    //
    // **占めるのは 1 番目の椅子である**（`bin/loop-handoff` は他の持ち物より先に見る）。
    // **偽物がそこに座ると、本物が出てこない**
    const result = run(withRows([row(42, "2026-08-12T04:00:00Z", "", "changes-requested")]));

    expect(result.status, "外れた label の保留を挙げている").toBe(0);
    expect(result.stdout).toBe("");
  });

  it("読めなければ、0 件と同じ顔をしない", () => {
    // **「0 件」と「読めなかった」を同じ静けさにしない**——
    // **拾い手が黙るのは、拾うものが無いときだけ**である
    const result = run(withRows([], 1));

    expect(result.status).toBe(2);
    expect(result.stderr).not.toBe("");
  });
});
