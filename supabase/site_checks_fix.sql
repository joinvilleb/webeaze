-- Why the "Up and healthy" pill went blank ───────────────────────────────────
--
-- The portal reads public.site_checks. NOTHING in this repo was writing it: the code comment in
-- loadUptime says an external Cloudflare Worker filled that table, and that Worker's source is not
-- here and has evidently stopped. site-watch was checking every client's site every 6 hours and
-- writing only site_issues, so the reachability answer was computed and then thrown away.
--
-- Fixed in code (needs deploying):
--   supabase functions deploy site-watch
--
-- site-watch now inserts one site_checks row per client per run, from the homepage check it was
-- already making. No extra request, no new secret.
--
-- The portal's freshness window moved with it. It only trusted a check under 30 MINUTES old, which
-- a 6-hourly job can never satisfy, so even a working writer would have left the pill stale. It is
-- now 8 hours: the cadence plus slack.

-- ── 1. Is site-watch even scheduled? ────────────────────────────────────────
-- If this returns no rows, the cron was never created and the checks have not been running at all.
--
--   select jobid, schedule, jobname, active from cron.job where jobname = 'site-watch';

-- ── 2. Schedule it if it is missing ─────────────────────────────────────────
-- Replace <CRON_SECRET> with the same value the function has in its secrets.
--
--   select cron.schedule(
--     'site-watch',
--     '0 */6 * * *',
--     $$
--     select net.http_post(
--       url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/site-watch',
--       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>')
--     );
--     $$
--   );

-- ── 3. Check it is writing, after the next run ──────────────────────────────
--   select user_id, is_up, last_checked from public.site_checks
--    order by last_checked desc limit 20;

-- ── 4. Keep the table from growing forever ──────────────────────────────────
-- One row per client per run is about 4 rows a day each. Harmless for a long time, but the portal
-- only ever reads the newest row, so old ones are dead weight. Run this whenever, or schedule it.

delete from public.site_checks
 where last_checked < now() - interval '90 days';

-- Optional, makes the portal's "newest row per client" read an index seek instead of a scan:
create index if not exists site_checks_user_checked_idx
  on public.site_checks (user_id, last_checked desc);
