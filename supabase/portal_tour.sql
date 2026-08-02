-- WebEaze portal first-run tour tracking ──────────────────────────────────────
-- One row per client, written the first time they finish or skip the welcome
-- walkthrough. Stored in the database (not the browser) so the tour shows exactly
-- ONCE per account, ever, even if they later sign in on a new phone or laptop.
-- Each client can read and write ONLY their own row.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.portal_tour (
  user_id      uuid primary key,
  completed_at timestamptz not null default now()
);

alter table public.portal_tour enable row level security;

drop policy if exists "own tour read" on public.portal_tour;
create policy "own tour read" on public.portal_tour
  for select using (auth.uid() = user_id);

drop policy if exists "own tour write" on public.portal_tour;
create policy "own tour write" on public.portal_tour
  for insert with check (auth.uid() = user_id);

drop policy if exists "own tour update" on public.portal_tour;
create policy "own tour update" on public.portal_tour
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.portal_tour to authenticated;
