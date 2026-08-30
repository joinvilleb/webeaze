-- WebEaze: a running log of what happened during a portal notice ──────────────
-- The banner says what is wrong right now, but a client watching an issue over two days has no way
-- to see that anything is being done about it, and the moment it IS fixed the banner goes away — so
-- the one message worth reading is the one they never get. These rows are that missing history:
-- every update posted during a notice, in order, readable until the banner is switched off.
--
-- Scoped by incident_id, which is stamped on portal_settings when the banner is turned on fresh.
-- Turning the banner off and starting a new notice mints a new id, so the next issue begins with a
-- clean timeline while the old one stays on the record rather than being deleted.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.

create table if not exists public.banner_updates (
  id          uuid primary key default gen_random_uuid(),
  incident_id uuid not null,
  message     text not null,
  kind        text not null default 'update',   -- 'started' | 'update' | 'resolved'
  created_at  timestamptz not null default now()
);

alter table public.banner_updates drop constraint if exists banner_updates_kind_check;
alter table public.banner_updates add constraint banner_updates_kind_check
  check (kind in ('started', 'update', 'resolved'));

-- Which notice the banner is currently showing. Null on an older row simply means "no timeline yet",
-- which the portal treats as the plain banner it has always been.
alter table public.portal_settings add column if not exists banner_incident_id uuid;

create index if not exists banner_updates_incident_idx
  on public.banner_updates (incident_id, created_at desc);

alter table public.banner_updates enable row level security;

-- Every signed-in client reads these: it is the same notice everyone is already seeing, and the
-- timeline is worthless if it is not visible to the people waiting on the fix. Writes are admin only.
drop policy if exists "banner_updates readable by clients" on public.banner_updates;
create policy "banner_updates readable by clients"
  on public.banner_updates for select to authenticated using (true);

drop policy if exists "banner_updates admin writes" on public.banner_updates;
create policy "banner_updates admin writes"
  on public.banner_updates for all to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select on public.banner_updates to authenticated;
grant insert, update, delete on public.banner_updates to authenticated;

notify pgrst, 'reload schema';

-- Check:
--   select kind, created_at, message from public.banner_updates order by created_at desc limit 10;
