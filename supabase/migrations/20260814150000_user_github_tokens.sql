-- GitHub のユーザートークンの置き場。
--
-- **中身は封じたまま入れる** (`src/infrastructure/crypto/token-cipher.ts`)。
-- **ここで決めるのは「誰の行が誰に見えるか」**で、**封じるのとは別の層**である
-- ——**片方が外れても、それだけでは全部が漏れないようにしてある。**

create table public.user_github_tokens (
  -- **1 人 1 行。** **主キーを `user_id` にする**ことで、**同じ人の行が 2 つ**という
  -- 状態を作れなくする——**2 つあると「どちらが今の 1 組か」が決まらず、
  -- 古いほうを使った要求だけが 401 で落ちる**（**遅れて出る失敗**になる）。
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- **封じた文字列。** 平文の token をここへ入れない。
  access_token text not null,
  refresh_token text not null,
  -- **期限だけは平文で持つ。** **更新が要るかの判断に使う**ので、
  -- **鍵を持たない経路（監視・移行）でも読めるほうがよい。中身ではない。**
  expires_at timestamptz not null,
  -- **最後に書いた時刻。** **同じ行を 2 本の要求が書き換える競り合い**で、
  -- **どちらが後か**を決めるのに使う (#214)。
  updated_at timestamptz not null default now()
);

comment on table public.user_github_tokens is
  'GitHub のユーザートークン。access_token / refresh_token は封じてある。';

-- **有効にするだけでは何も決まらない。** **ポリシーが 1 つも無ければ本人も読めず、
-- `using (true)` を書けば全員が読める**——**どちらも「有効にした」で通る。**
-- **決めているのは下の 4 つ**である。
alter table public.user_github_tokens enable row level security;

-- **匿名では触れない。** **既定の権限付与は `anon` にも及ぶ**ので、明示的に外す。
-- **ポリシーが無いので読めはしない**が、**権限とポリシーのどちらか一方に頼らない。**
revoke all on public.user_github_tokens from anon;
grant select, insert, update, delete on public.user_github_tokens to authenticated;

-- **`(select auth.uid())` と包む。** **裸で書くと行ごとに評価される**ので、
-- 行が増えたときに効いてくる（Supabase の推奨形）。
create policy "本人だけが自分の行を読める"
  on public.user_github_tokens for select to authenticated
  using ((select auth.uid()) = user_id);

-- **`with check` を落とさない。** **`user_id` は要求の本文から来る**ので、
-- **見ないと、他人の user_id を名乗った行を書ける**——**書いた側には見えず、
-- 書かれた側の 1 行を上書きする**（**誰も落ちない**）。
create policy "本人だけが自分の行を保存できる"
  on public.user_github_tokens for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- **`using` と `with check` の両方を書く。** **`using` は「どの行を触れるか」、
-- `with check` は「どんな行にしてよいか」**で、**後者が無いと、自分の行の
-- `user_id` を他人へ書き換えて渡せる。**
create policy "本人だけが自分の行を更新できる"
  on public.user_github_tokens for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "本人だけが自分の行を消せる"
  on public.user_github_tokens for delete to authenticated
  using ((select auth.uid()) = user_id);
