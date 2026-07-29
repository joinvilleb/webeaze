-- ============================================================================
-- client_metrics  —  storage for the automatic "Growth Report" (performance +
-- growth data pulled from real sources). Run once in the Supabase SQL editor.
-- ============================================================================

-- One row per client. `metrics` is a JSON snapshot so we can add sources
-- (speed, uptime, reviews, search) without schema churn.
create table if not exists public.client_metrics (
  user_id       uuid primary key,
  client_id     uuid,
  site_url      text,
  metrics       jsonb not null default '{}'::jsonb,   -- { speed:{...}, uptime:{...}, reviews:{...}, search:{...} }
  refreshed_at  timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.client_metrics enable row level security;

-- Clients read their own snapshot; only the service role (the edge function) writes.
drop policy if exists "clients read own metrics" on public.client_metrics;
create policy "clients read own metrics"
  on public.client_metrics for select
  using (auth.uid() = user_id);

-- Admin can read every client's metrics (so "View as client" preview shows real data).
drop policy if exists "admin reads all metrics" on public.client_metrics;
create policy "admin reads all metrics"
  on public.client_metrics for select
  using ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- For the reviews source later: store each client's Google place id on the client
-- record (editable in admin). Safe to run now; harmless if reviews stay off.
alter table public.clients add column if not exists google_place_id text;


-- ── Monthly auto-refresh + email (requires pg_cron + pg_net) ──
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- Refresh every client's metrics and send the monthly summary. Runs 1st of the
-- month at 13:00 UTC (~8am ET). Replace <PROJECT_REF> and <CRON_SECRET>.
--
-- select cron.schedule(
--   'growth-report-monthly',
--   '0 13 1 * *',
--   $$
--   select net.http_post(
--     url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/growth-report',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
--     body    := jsonb_build_object('mode','monthly')
--   );
--   $$
-- );
