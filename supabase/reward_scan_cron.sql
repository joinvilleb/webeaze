-- Turn on milestone emails.
--
-- WHY: reward-scan has existed for months and has never run. Its cron block in reward_grants.sql was
-- left commented out with placeholders, so no client has ever been told they hit a milestone, and no
-- reward has ever been applied. The function now covers every milestone, not only the three that
-- carry a perk, and emails the client and the team each time one is crossed.
--
-- HISTORY IS SAFE. Every milestone has a knowable earn date (the completed_at of the Nth finished
-- request, or the anniversary of signing up). Anything earned more than 3 days ago is recorded
-- silently on the first run, so a client who has been here a year does not receive eight emails at
-- once. Expect the first run to report a large "backfilled" number and a small "sent" one.
--
-- Run this AFTER deploying the function:
--   supabase functions deploy reward-scan --no-verify-jwt
--
-- Safe to run more than once: it unschedules any previous copy first.

select cron.unschedule('reward-scan-hourly')
 where exists (select 1 from cron.job where jobname = 'reward-scan-hourly');

select cron.schedule(
  'reward-scan-hourly',
  '20 * * * *',                       -- twenty past every hour, away from the other jobs
  $$
  select net.http_post(
    url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/reward-scan',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-cron-secret', 'ZZEnhzofKAFFPjIuLf9zicMtqtxM8aCgmufu'),
    body    := '{}'::jsonb
  );
  $$
);

-- Check it is on:
select jobname, schedule, active from cron.job where jobname = 'reward-scan-hourly';

-- After the first run, this shows what was recorded and whether it was announced or backfilled:
--   select c.name, g.milestone, g.reward, g.granted_at
--     from public.reward_grants g join public.clients c on c.user_id = g.user_id
--    order by g.granted_at desc limit 40;

-- To stop it again:  select cron.unschedule('reward-scan-hourly');
