-- Lightweight portal activity heartbeat. The portal best-effort upserts one row per client each time
-- they open it (skipped during admin preview). This powers a TRUER "quiet" signal in the Churn radar
-- (admin.html) and the weekly churn-digest: scoring uses the MOST RECENT of last_seen and their last
-- request, so a client who still logs in (but has not filed a request lately) is not flagged as gone.
--
-- Until this table exists, the portal upsert is silently ignored and the radar falls back to
-- last-request activity exactly as before. Run this once in the Supabase SQL editor.

create table if not exists public.client_activity (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  last_seen  timestamptz not null default now()
);

alter table public.client_activity enable row level security;

-- A client reads and writes only their own row; Billy (admin) can read every row for the radar/digest.
drop policy if exists "client_activity read own or admin" on public.client_activity;
create policy "client_activity read own or admin" on public.client_activity
  for select using (auth.uid() = user_id or (auth.jwt() ->> 'email') = 'billy@webeaze.io');

drop policy if exists "client_activity insert own" on public.client_activity;
create policy "client_activity insert own" on public.client_activity
  for insert with check (auth.uid() = user_id);

drop policy if exists "client_activity update own" on public.client_activity;
create policy "client_activity update own" on public.client_activity
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
