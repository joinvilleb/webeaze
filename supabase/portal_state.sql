-- Per-client "seen once" state, synced across devices. localStorage is per-device, so one-time moments
-- (the welcome-to-Growth popup, what's-new read state, etc.) would otherwise re-appear on every new
-- phone or computer a client signs in on. This holds those flags server-side, keyed to the client, so
-- once they've seen something it stays seen everywhere. The portal reads it on login and writes to it.
--
-- Until this runs, the portal falls back to per-device localStorage (today's behaviour). Run once in
-- the Supabase SQL editor.

create table if not exists public.portal_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  state       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.portal_state enable row level security;

-- A client reads and writes only their own row; Billy (admin) can read all.
drop policy if exists "portal_state read own or admin" on public.portal_state;
create policy "portal_state read own or admin" on public.portal_state
  for select using (auth.uid() = user_id or (auth.jwt() ->> 'email') = 'billy@webeaze.io');

drop policy if exists "portal_state insert own" on public.portal_state;
create policy "portal_state insert own" on public.portal_state
  for insert with check (auth.uid() = user_id);

drop policy if exists "portal_state update own" on public.portal_state;
create policy "portal_state update own" on public.portal_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
