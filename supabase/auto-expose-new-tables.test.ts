/**
 * **`public` に作った新しいものが、書かずに Data API へ出ないこと**（#561）。
 *
 * **Supabase CLI 2.116.0 で `auto_expose_new_tables` の既定が `true` へ反転する。**
 * **`config.toml` に書いていなければ、その日から `public` の新しいテーブル・ビューへ
 * `anon` / `authenticated` / `service_role` の権限が自動で付く**——**migration から
 * `grant` が抜けても DB の試験は通る。** **動くことは変わらず、壊れたときに
 * 検出できなくなる側**である（`AGENTS.md` §4 / §6）。
 *
 * **ここで見るのは「書いてあるか」だけ**である。**緩んだ状態そのものは DB でしか
 * 出ない**（**既定の権限は、テーブルを作った瞬間に決まる**）——**そちらは 2.116.0 が
 * 入るまで再現できない**ので、**入る前に効く錠をここに置く。**
 *
 * **測った結果は PR に書いてある**（`= true` にすると、`public` の新しいテーブルへの
 * 既定の権限に `anon` の SELECT が入る）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONFIG = fileURLToPath(new URL("./config.toml", import.meta.url));

/**
 * **有効な設定行だけを見る。**
 *
 * **語で探さない** (`AGENTS.md` §4)。**このリポジトリは理由を厚く書く**ので、
 * **`auto_expose_new_tables` は上の説明にも、`config.toml` のコメントにも出てくる**
 * ——**`toContain` で当てると、コメントアウトされたままでも緑になる。**
 * **行頭から当てて、`#` で始まる行を外す。**
 */
function activeSetting(): string | undefined {
  const found = readFileSync(CONFIG, "utf8").match(/^auto_expose_new_tables\s*=\s*(\S+)\s*$/m);
  return found?.[1];
}

describe("supabase/config.toml の auto_expose_new_tables", () => {
  it("false と明示してある（未設定にすると 2.116.0 で自動公開へ反転する）", () => {
    expect(activeSetting()).toBe("false");
  });
});
