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
    // **認可のあと戻れる先は 3000 番だけ**である (#418 のレビュー)——
    // **`supabase/config.toml` の `site_url` と `additional_redirect_urls` が
    // そこに固定**されていて、**worker の作業場は 3001 番以降**（#82）。
    //
    // **倒れる先が悪い**——**リモートなら 3000 番は転送していないので止まり、
    // 手元なら既定の作業場が動いていれば黙って別の盤面へ移る**（**この一連で
    // 追いかけてきた形**である）。
    //
    // **許可一覧を広げる道は採らない**（**共有物で、上のコメントが「port は固定」と
    // 言っている**。#371）——**採らないなら、手順の側に書いてある必要がある。**
    // **語ではなく、効いている場所を見る**（この試験を語で書いて、変異を 2 つ
    // 素通しした）——**「既定の作業場」も「許可一覧」も節の中に何度も出る**ので、
    // **本文を消しても、別の文が当たっていた**（#396 から数えて 5 度目の形）。
    //
    // **打つ行**（移る手）と、**そこにしか無い語**（`site_url`）で見る。
    expect(
      commands().some((line) => line.startsWith("cd ")),
      `既定の作業場へ移る手が、打つ行に無い: ${commands().join(" / ")}`,
    ).toBe(true);
    expect(section(), "戻れる先が固定であることが書かれていない").toMatch(/site_url/);
    // **打つ人が、その場で確かめられること**（**#412 の「訊く口」がそのまま使える**）
    expect(section(), "居場所を確かめる手が無い").toMatch(/3000 以外/);
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
