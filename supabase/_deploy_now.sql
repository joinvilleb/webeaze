-- WebEaze: one-time SQL to finish turning on the new automation.
-- Run these in the Supabase SQL editor. Replace <CRON_SECRET> with your real CRON_SECRET value.

-- 1) Fix Google Place IDs persisting from the admin (PostgREST schema cache).
--    Also adds the banner "since" timestamp column (portal banner shows when an issue started).
alter table public.portal_settings add column if not exists banner_started_at timestamptz;
notify pgrst, 'reload schema';

-- 2) site_issues table (skip if you already ran supabase/site_issues.sql).
--    Open supabase/site_issues.sql and run it if the table doesn't exist yet.

-- 3) Weekly proactive maintenance sweep (Mondays 9am). Fans out via the function itself.
select cron.schedule(
  'proactive-fixes',
  '0 9 * * 1',
  $$
    select net.http_post(
      url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/proactive-fixes',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>')
    );
  $$
);

-- 4) (Optional) 6-hourly site-watch monitor, if you deploy site-watch.
-- select cron.schedule('site-watch','0 */6 * * *', $$
--   select net.http_post(
--     url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/site-watch',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>')
--   );
-- $$);

-- To change a schedule later: select cron.unschedule('proactive-fixes'); then re-run the schedule.
