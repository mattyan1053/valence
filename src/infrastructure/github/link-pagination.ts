/**
 * `Link` ヘッダを辿って、続きのページを読む。
 *
 * **件数で最後のページを当てない。** **「1 ページの上限と同じ件数だったら続きがある」は
 * 推測**で、**`Link` は答えそのもの**である——**推測で当てると、ちょうど上限で
 * 終わるときに 1 往復多く投げ、上限を超え続けるときは打ち切りに当たる。**
 *
 * **読む部品を 2 つ持たない** (#245 のレビュー)。**片方だけ直る**——
 * **`Link` の読み方（引用形式・パラメータ順・複数の `rel`）は間違えやすい**ので、
 * **1 箇所に置く。**
 */

const API_ORIGIN = "https://api.github.com";

/**
 * 続きのページ。
 *
 * **`api.github.com` 以外は辿らない。** この要求には token が載っているので、
 * 応答に書かれた URL をそのまま辿ると、**別のホストへ資格情報を送りうる**。
 *
 * **「次が無い」と「読めなかった」を分ける。** 読めないものを「次が無い」に丸めると、
 * **1 ページだけを全件のつもりで返す**。消えた PR を base にしている PR は辺を失い、
 * **エラーも警告も出ないまま独立した PR として描かれる**。
 */
export function nextPageUrl(link: string | null, what: string): string | undefined {
  if (link === null) {
    return undefined;
  }

  let unreadable = false;
  for (const entry of link.split(",")) {
    if (entry.trim() === "") {
      continue;
    }
    const parsed = parseLinkEntry(entry);
    if (parsed === undefined) {
      unreadable = true;
      continue;
    }
    if (parsed.rel.includes("next")) {
      return sameOrigin(parsed.url, what);
    }
  }

  if (unreadable) {
    throw new Error(`${what}の Link ヘッダを読み取れません`);
  }
  return undefined;
}

/**
 * `Link` の 1 要素を読む。
 *
 * **パラメータの順序にも引用形式にも依存しない。** `Link` はどちらも保証せず、
 * `<...>; type="x"; rel="next"` も `<...>; rel=next` も有効である。
 * `rel` は空白区切りで複数の関係を持ちうるので、語として照合する。
 */
function parseLinkEntry(entry: string): { url: string; rel: string[] } | undefined {
  const [, url, rest] = /^\s*<([^>]*)>(.*)$/s.exec(entry) ?? [];
  if (url === undefined || url === "") {
    return undefined;
  }
  const rel = (rest ?? "")
    .split(";")
    .map((parameter) => /^\s*rel\s*=\s*"?([^"]*)"?\s*$/.exec(parameter)?.[1])
    .find((value) => value !== undefined);
  return { url, rel: (rel ?? "").trim().split(/\s+/) };
}

function sameOrigin(url: string, what: string): string {
  if (!url.startsWith(`${API_ORIGIN}/`)) {
    throw new Error(`${what}の続きが GitHub API 以外を指しています`);
  }
  return url;
}
