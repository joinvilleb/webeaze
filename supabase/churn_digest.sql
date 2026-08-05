-- Weekly churn-risk digest: emails Billy the ranked "reach out before they leave" list.
-- Same scoring as the in-admin Churn radar, but pushed to him so at-risk clients find him instead of
-- waiting for him to open the admin. A quiet week (no client over the threshold) sends no email.
--
-- Prereqs: extensions pg_cron + pg_net enabled; churn-digest deployed (--no-verify-jwt);
--          replace <YOUR_CRON_SECRET> with the same value as the function's CRON_SECRET.
-- Run this once in the Supabase SQL editor.

select cron.schedule(
  'churn-risk-digest',
  '0 14 * * 1',   -- every Monday at 14:00 UTC (about 9-10am ET)
  $$
  select net.http_post(
    url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/churn-digest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'ZZEnhzofKAFFPjIuLf9zicMtqtxM8aCgmufu'),
    body    := jsonb_build_object('mode', 'weekly')
  );
  $$
);

-- Change the time later:  select cron.alter_job((select jobid from cron.job where jobname='churn-risk-digest'), schedule => '0 14 * * 1');
-- Remove it:              select cron.unschedule('churn-risk-digest');
-- Test now (any time):    select net.http_post(url:='https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/churn-digest', headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret','<YOUR_CRON_SECRET>'), body:='{}'::jsonb);
