/**
 * **人が 1 度開く道が、書かれていること**（#411）。
 *
 * **このループは人が居なくても回る**ので、**「人が 1 度やること」は、書かれていなければ
 * 永久に起きない。** **機械は認可画面で止まる**（#409 で実測）——**そこから先が
 * 済むまで、「盤面が GitHub と一致しているか」は誰も見ていない。**
 *
 * **見るのは「節が在る」ではなく、「その節が、渡せる形か」**である
 * ——**開く手・確かめる手・報せることの 3 つ。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(REPO_ROOT, ".claude/skills/dev-environment/SKILL.md");

/** その節で**実際に打つ行**（コメントと空行は除く）。 */
function commands(): string[] {
  return [...section().matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((match) => (match[1] ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * **開く手順そのもの**（`### 開く` から、次の見出しまで）。
 *
 * **節ぜんぶで見ない** (#463 のレビュー)——**同じ節の上のほうにも
 * `./task loop:preview:up` が出る**ので、**手順から消しても、そちらに当たって緑になる**
 * （**変異で素通りした**。§4 の「その語は他にも出るか」）。
 */
function openSteps(): string {
  const from = section().indexOf("### 開く");
  expect(from, "開く手順がありません").toBeGreaterThanOrEqual(0);
  const rest = section().slice(from);
  const to = rest.indexOf("\n### ", 1);
  return to < 0 ? rest : rest.slice(0, to);
}

/** 開く手順の中で**実際に打つ行**（コメントと空行は除く）。 */
function openCommands(): string[] {
  return [...openSteps().matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((match) => (match[1] ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** 人が 1 度開く節（次の `## ` まで）。 */
function section(): string {
  const text = readFileSync(SKILL, "utf8");
  const from = text.indexOf("## ログイン後の盤面を、人が 1 度開く");
  expect(from, "人が 1 度開く道が書かれていない").toBeGreaterThanOrEqual(0);
  return text.slice(from).split("\n## ")[0] ?? "";
}

describe("人が 1 度開く道", () => {
  it("人が読む場所から、辿れる", () => {
    // **書いてあっても、人が読む場所から辿れなければ起きない**——**運用の正は
    // `loop/README.md`** で、**人はそこから入る。**
    const readme = readFileSync(join(REPO_ROOT, "loop/README.md"), "utf8");

    expect(readme, "運用の README から辿れない").toContain("ログイン後の盤面を、人が 1 度開く");
  });

  it("どこを開くかが書いてある", () => {
    // **port は書き写さない**（#412）——**訊く口を使う。**
    expect(section(), "どのポートを開くのかが無い").toContain("./task port");
    expect(section(), "何を押すのかが無い").toMatch(/GitHub でログイン/);
  });

  it("土台を起こす手が、打つ行にある", () => {
    // **`./task up` は app しか起こさない** (#418 のレビュー)——**Supabase が
    // 止まっていると、ログインの開始が `SUPABASE_URL` へ繋がらず、認可画面より前で
    // 落ちる。** **初めて開くときは、まさにその状態**である。
    //
    // **打つ行で見る**——**説明に「Supabase も要る」と書くだけでは、打つ人は打たない。**
    // **行末のコメントごと比べない**（**打つのは行の頭**である）
    expect(
      commands().some((line) => line.startsWith("./task db:up")),
      `Supabase を起こす手が、打つ行に無い: ${commands().join(" / ")}`,
    ).toBe(true);
  });

  it("どの作業場から開くかが、理由つきで書いてある", () => {
    // **開くのは人が見る画面である** (#463)——**その port は許可一覧に載っている**ので、
    // **ここでログインまで完了する。** **前は「既定の作業場（3000）で始める」**だったが、
    // **約束の側が変わった**（`supabase/config.toml` に人が見る画面のぶんを載せた）。
    //
    // **既定の作業場でも通る**が、**映っているのは worker の作業ツリー**である
    // ——**未コミットか古い `main`**（#457）。**確かめたいのは `origin/main`** なので、
    // **理由つきで「使わない」と書いてある必要がある。**
    //
    // **語ではなく、効いている場所を見る**（この試験を語で書いて、変異を 2 つ素通しした）
    // ——**`loop:preview` も「許可一覧」も節の中に何度も出る**ので、**打つ行**と、
    // **そこにしか無い文**で見る。
    expect(
      openCommands().some((line) => line.startsWith("./task loop:preview:up")),
      `人が見る画面を上げる手が、開く手順の打つ行に無い: ${openCommands().join(" / ")}`,
    ).toBe(true);
    expect(section(), "戻れる先が固定であることが書かれていない").toMatch(/site_url/);
    // **既定の作業場を使わない理由**（**そこにしか無い文**）
    expect(section(), "既定の作業場を使わない理由が書かれていない").toContain(
      "映っているのは worker の作業ツリー",
    );
  });

  it("設定を変えたら上げ直す手が、打つ行にある", () => {
    // **GoTrue は起動時に読む** (#463)——**許可一覧を足しても、上げ直すまで効かない。**
    // **症状は「ログインしたのに入口へ戻る」**で、**画面には理由が出ない**ので、
    // **打つ行に無いと、その人はここで止まったまま**である。
    expect(
      openCommands().some((line) => line.includes("db:down") && line.includes("db:up")),
      `上げ直す手が、開く手順の打つ行に無い: ${openCommands().join(" / ")}`,
    ).toBe(true);
  });

  it("認証のあと、どこで見るかが書いてある", () => {
    // **Cookie は port で分かれない** (#462 のレビュー 2 周目)——**3000 で認証を通せば、
    // 人が見る画面にも同じ Cookie が送られる。** **確認まで既定の作業場でやらせると、
    // worker の作業場（未コミットか古いもの）を見せることになる**——**#457 が消しに
    // 来た誤読を、案内が作り直す。**
    //
    // **語ではなく、そこにしか無い文で見る**（§4）——**「人が見る画面」も
    // `loop:preview` も、この節には既に何度も出る。**
    expect(section(), "認証のあとの見どころが書かれていない").toMatch(
      /Cookie は port で分かれない/,
    );
    // **host が違えば送られない**——**この 1 行が無いと、読んだ人の半分が落ちる。**
    //
    // **`同じ host` では見ない**（変異が素通りした）——**手順の別の行にも出る**ので、
    // **説明を丸ごと消しても緑のまま**だった。**踏む形そのもの**（混ぜた組み合わせ）
    // **が書いてあるか**を見る。
    expect(section(), "host を混ぜると落ちることが書かれていない").toMatch(
      /`localhost:3000` で認証して/,
    );
  });

  it("開いたあと、何を確かめるかが書いてある", () => {
    // **#409 の完了条件で唯一残ったもの**——**盤面と GitHub が一致しているか。**
    // **確かめる相手は画面の外にある**ので、**引く手ごと書いておく。**
    //
    // **打つ行で見る** (この試験を本文で書いて、変異を素通しした)——**説明のほうにも
    // `gh pr list` と書いてある**ので、**手を消しても、語だけで満たされていた**
    // （#396 と同じ形。**判定の範囲が本文より広いと、本文に負ける**）。
    expect(commands(), "GitHub 側と突き合わせる手が、打つ行に無い").toContain(
      "gh pr list --repo <owner>/<name> --state open --json number --jq '.[].number'",
    );
    expect(section(), "0 本のときに何を見るかが無い").toMatch(/0 本/);
  });

  it("開けなかったときに、何を報せるかが書いてある", () => {
    // **報せ方が無いと、止まったことが誰にも届かない**——**このループは、
    // 人が「言われたこと」しか受け取らない。**
    expect(section(), "報せることが無い").toMatch(/報せる/);
    expect(section(), "どこで止まったかを報せる、が無い").toMatch(/止まった/);
  });

  it("貼ってはいけないものが書いてある", () => {
    // **URL には `code=` が載る**（認可の戻り）——**秘密は `.env`**（`AGENTS.md` §6）。
    // **「報せてください」だけ書くと、丸ごと貼られる。**
    expect(section(), "貼らないものが書かれていない").toMatch(/貼らない/);
    expect(section(), "認可の戻りに何が載るかが無い").toMatch(/code=/);
  });
});
