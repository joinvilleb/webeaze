-- Daily lead digest: one end-of-day email per client recapping the leads their website captured that
-- day, instead of pinging them on every single lead. A day with no leads sends that client no email.
-- Pairs with the lead-digest edge function; track-lead no longer emails per-lead.
--
-- Prereqs: extensions pg_cron + pg_net enabled; lead-digest deployed (--no-verify-jwt);
--          CRON_SECRET already set on the project (same value used by churn-digest, reused below).
-- Run this once in the Supabase SQL editor.

select cron.schedule(
  'daily-lead-digest',
  '0 22 * * *',   -- every day at 22:00 UTC (about 5-6pm US Eastern). Bump later for clients further west.
  $$
  select net.http_post(
    url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/lead-digest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'ZZEnhzofKAFFPjIuLf9zicMtqtxM8aCgmufu'),
    body    := jsonb_build_object('hours', 24)
  );
  $$
);

-- Change the time later:  select cron.alter_job((select jobid from cron.job where jobname='daily-lead-digest'), schedule => '0 23 * * *');
-- Remove it:              select cron.unschedule('daily-lead-digest');
-- Test now (last 24h):    select net.http_post(url:='https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/lead-digest', headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret','ZZEnhzofKAFFPjIuLf9zicMtqtxM8aCgmufu'), body:=jsonb_build_object('hours',24));
