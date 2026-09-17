-- Throttle for one-tap sign-in links.
--
-- WHY: login-link emails a magic link to anyone who asks, provided the address belongs to an active
-- client or an accepted teammate. This table is what stops a bored person (or a stuck button on a
-- phone) turning that into a mail flood: one link per address per minute, recorded before the send
-- so a burst of taps cannot race past the check.
--
-- Nothing reads this but the function, which runs as the service role, so no client-facing policy is
-- needed. RLS is on with no policy at all, which denies every other caller by default.
--
-- Safe to run more than once.

create table if not exists public.login_link_requests (
  email    text primary key,
  sent_at  timestamptz not null default now()
);

alter table public.login_link_requests enable row level security;

-- Deliberately empty: the service role bypasses RLS, everyone else gets nothing.
drop policy if exists "login_link_requests admin all" on public.login_link_requests;
create policy "login_link_requests admin all"
  on public.login_link_requests for all
  using ( (auth.jwt() ->> 'email') = 'billy@webeaze.io' )
  with check ( (auth.jwt() ->> 'email') = 'billy@webeaze.io' );

-- Old rows carry no meaning after a minute; keep the table small.
delete from public.login_link_requests where sent_at < now() - interval '7 days';

-- Check:
select count(*) as rows_kept from public.login_link_requests;
