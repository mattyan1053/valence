/**
 * ログインの入口。**開いても何も始まらない。**
 *
 * **コールバックが失敗したときの戻り先でもある。** **ここが自動で認可画面へ送ると、
 * キャンセルした人が同じ画面へ戻され続ける**——**倒す先は 2 つあり**、
 * **行き止まりにもしない**（**ここから意図して始められる**）。
 */

export default function LoginPage() {
  return (
    <main>
      <h1>Valence にログイン</h1>
      <p>GitHub のアカウントでログインします。押すと GitHub の認可画面へ移ります。</p>
      <form method="post" action="/auth/login/start">
        <button type="submit">GitHub でログイン</button>
      </form>
    </main>
  );
}
