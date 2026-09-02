/**
 * **ログアウトの口は POST だけを受ける**（#563 の完了条件のひとつ）。
 *
 * **GET で消せると、`<img src>` 1 つで他人をログアウトさせられる。**
 * **Route Handler は GET を定義しなければ 405 を返す**ので、**守っているのは
 * 「GET を生やさないこと」**である——**押す側を作った周回で、押しやすさのために
 * リンクへ替えたくなる**（#563 で足したのはボタンで、こちらは変えていない）。
 *
 * **画面の側は `src/ui/auth/sign-out-button.test.ts` が見る**（POST で出すこと）。
 * **ここは口の側**である——**両方が揃って初めて「出られて、かつ他人に消されない」。**
 */

import { describe, expect, it } from "vitest";
import * as route from "./route";

describe("ログアウトの口", () => {
  it("POST を受ける", () => {
    expect(typeof route.POST).toBe("function");
  });

  it("GET は生やさない", () => {
    // **生やした瞬間にここが赤くなる。** **405 は「実装し忘れ」ではなく、
    // この 1 行が守っている状態**である
    expect("GET" in route).toBe(false);
  });

  it("消せる動詞を、ほかにも増やさない", () => {
    // **GET だけを見ていると、`DELETE` や `HEAD` を足した日に黙る**
    // ——**受ける動詞は POST 1 つだけ**である
    expect(Object.keys(route)).toEqual(["POST"]);
  });
});
