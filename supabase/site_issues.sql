-- WebEaze proactive site monitoring ("we caught it and fixed it") ─────────────
-- The site-watch edge function checks each client's site on a schedule and logs
-- problems here. Clients only ever see FIXED issues (the reassuring "recently
-- handled" list); open problems are internal, for Billy. Billy marks things fixed
-- (with a short client-facing note) in the admin.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.site_issues (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,                 -- which client (clients.user_id)
  client_id   uuid,
  kind        text not null,                 -- 'down' | 'domain_expiring' | 'broken_link'
  detail      text,                          -- internal description of what we found
  url         text,                          -- affected URL (e.g. the broken link)
  status      text not null default 'open',  -- 'open' | 'fixed'
  client_note text,                          -- the client-facing "what we did", shown once fixed
  detected_at timestamptz not null default now(),
  fixed_at    timestamptz,
  notified    boolean not null default false -- whether Billy has been emailed about it
);

create index if not exists site_issues_user_idx on public.site_issues (user_id, status, detected_at desc);
create index if not exists site_issues_open_idx  on public.site_issues (user_id, kind, url) where status = 'open';

alter table public.site_issues enable row level security;

-- Clients see ONLY their fixed issues; Billy (admin) sees everything. Writes are service-role
-- (the function) or admin.
drop policy if exists "site_issues read" on public.site_issues;
create policy "site_issues read" on public.site_issues
  for select using (
    (auth.uid() = user_id and status = 'fixed')
    or (auth.jwt() ->> 'email') = 'billy@webeaze.io'
  );

drop policy if exists "site_issues admin update" on public.site_issues;
create policy "site_issues admin update" on public.site_issues
  for update using ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select, update on public.site_issues to authenticated;

-- ── Schedule (requires pg_cron + pg_net, already enabled for growth-report) ──
-- Runs every 6 hours. Replace <CRON_SECRET> with the same secret the function uses.
--
-- select cron.schedule(
--   'site-watch',
--   '0 */6 * * *',
--   $$
--   select net.http_post(
--     url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/site-watch',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>')
--   );
--   $$
-- );
