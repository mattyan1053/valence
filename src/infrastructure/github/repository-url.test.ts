/**
 * **owner / name を、GitHub の URL へ 1 区切りとして入れる**（#353）。
 *
 * **これらは URL の経路から来る**（`src/app/repos/[owner]/[name]/`）。
 * **Next.js の動的区間は 1 区切りに当たるが、`%2F` は当たったあとに `/` へ戻る**ので、
 * **`/` や `..` を含む値が届きうる。**
 *
 * **同じ危険は #342 で 1 度直してある**（盤面へ戻す URL）——**外へ出す側は直っていて、
 * GitHub へ出す側が残っていた。**
 */

import { describe, expect, it } from "vitest";
import { repositoryUrl } from "./repository-url";

describe("リポジトリの API URL を組み立てる", () => {
  it("ふつうの owner / name は、これまでどおりの URL になる", () => {
    // **退行の検出**（#353 の完了条件）——**包んだせいで別の URL になっていないか**
    expect(repositoryUrl({ owner: "acme", name: "web" })).toBe(
      "https://api.github.com/repos/acme/web",
    );
  });

  it("`.` や `-` や `_` を含む名前も、そのままの形で出る", () => {
    // **GitHub のリポジトリ名に使える文字**——**包んでも変わってはいけない**
    expect(repositoryUrl({ owner: "acme-inc", name: "foo.bar_baz" })).toBe(
      "https://api.github.com/repos/acme-inc/foo.bar_baz",
    );
  });

  it("`/` を含む owner は、経路を増やさない", () => {
    // **そのまま繋ぐと `/repos/a/b/web` になり、別の API を叩く**
    const url = repositoryUrl({ owner: "a/b", name: "web" });

    expect(url).toBe("https://api.github.com/repos/a%2Fb/web");
    expect(url.split("/").length, "経路が 1 つ増えている").toBe(
      "https://api.github.com/repos/x/web".split("/").length,
    );
  });

  it("`.` と `..` は、包めないので断る", () => {
    // **`encodeURIComponent` は `.` を包まない**ので `..` が残り、
    // **`%2E%2E` にしても URL の仕様が dot segment として扱う**（実測）。
    // **安全な形が無い**ので、**包んだ顔で通さずに投げる。**
    for (const bad of ["..", ".", ""]) {
      expect(() => repositoryUrl({ owner: bad, name: "web" }), bad).toThrow();
      expect(() => repositoryUrl({ owner: "acme", name: bad }), bad).toThrow();
    }
  });

  it("`..` を含むだけの名前は、断らない", () => {
    // **危ないのは「区切りがちょうど `..`」のときだけ**である
    // ——**`foo..bar` は経路を遡らない**ので、**通す**
    expect(repositoryUrl({ owner: "acme", name: "foo..bar" })).toBe(
      "https://api.github.com/repos/acme/foo..bar",
    );
  });

  it("`?` や `#` を含む名前は、クエリや fragment にならない", () => {
    // **そのまま繋ぐと、以降が経路ではなくクエリとして読まれる**
    const url = repositoryUrl({ owner: "acme", name: "web?x=1" });

    expect(url).toBe("https://api.github.com/repos/acme/web%3Fx%3D1");
    expect(new URL(url).search, "クエリとして読まれている").toBe("");
  });

  it("包まずに組み立てた URL は、実際に別の場所を指す", () => {
    // **この 1 件が「なぜ包むのか」を示している**——**包まない形を並べて、
    // 正規化で行き先が変わることを見る**
    const unwrapped = new URL("https://api.github.com/repos/a/../b/web");

    expect(unwrapped.pathname).toBe("/repos/b/web");
    expect(new URL(repositoryUrl({ owner: "a/..", name: "web" })).pathname).not.toBe(
      "/repos/b/web",
    );
  });

  it("包んだ `/` は、経路の区切りに戻らない", () => {
    // **`%2F` は区切りとして解釈されない**（実測）——**これが `encodeURIComponent`
    // で守れる部分である**
    expect(new URL(repositoryUrl({ owner: "a/b", name: "web" })).pathname).toBe("/repos/a%2Fb/web");
  });
});
