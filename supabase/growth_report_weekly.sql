-- Weekly data-only refresh of the Growth Report metrics (speed, reviews, search, competitors, AI copy).
-- NO email — it just keeps every active client's numbers current between the monthly email run.
--
-- Scope: only clients who (a) have a linked account and (b) have logged in at least once, so we never
-- burn PageSpeed / Places / AI calls on never-logged-in accounts. "Logged in at least once" comes from
-- auth.users.last_sign_in_at, which is authoritative and retroactive (no heartbeat needed).
--
-- Fan-out: a helper function loops the qualifying clients and fires ONE edge call each via pg_net, so
-- every invocation refreshes a single client in ~30s and nothing hits the wall-clock limit. The
-- growth-report {action:'refresh', only:<user_id>} path handles one client and sends no email.
--
-- Prereqs: pg_cron + pg_net enabled; growth-report deployed (--no-verify-jwt). Run once in the SQL editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper: fan out a refresh call per qualifying client. SECURITY DEFINER (owner = postgres) so it can
-- read auth.users' login times no matter which role the cron runs as. Returns how many it fired.
create or replace function public.growth_refresh_weekly()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  rec record;
  n   integer := 0;
begin
  for rec in
    select c.user_id
    from public.clients c
    join auth.users u on u.id = c.user_id
    where c.site_url is not null
      and coalesce(c.status, '') <> 'inactive'
      and u.last_sign_in_at is not null        -- logged in at least once
  loop
    perform net.http_post(
      url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/growth-report',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'ZZEnhzofKAFFPjIuLf9zicMtqtxM8aCgmufu'),
      body    := jsonb_build_object('action', 'refresh', 'only', rec.user_id::text)
    );
    n := n + 1;
  end loop;
  return n;
end;
$fn$;

-- Schedule it weekly (matches the simple shape of the other crons: one function call).
select cron.schedule(
  'growth-report-weekly',
  '0 11 * * 1',   -- every Monday at 11:00 UTC (about 6-7am ET), so numbers are fresh for the week
  $$ select public.growth_refresh_weekly(); $$
);

-- Run it right now (also returns how many clients it fired for):  select public.growth_refresh_weekly();
-- Change the day/time later:  select cron.alter_job((select jobid from cron.job where jobname='growth-report-weekly'), schedule => '0 11 * * 1');
-- Remove it:                  select cron.unschedule('growth-report-weekly');
--
-- Sanity-check WHO it will refresh (no calls fired):
--   select c.name, c.email, u.last_sign_in_at
--   from public.clients c join auth.users u on u.id = c.user_id
--   where c.site_url is not null and coalesce(c.status,'') <> 'inactive' and u.last_sign_in_at is not null
--   order by u.last_sign_in_at desc;
