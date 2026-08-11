-- WebEaze outreach machine — daily automation ──────────────────────────────
-- Runs the machine hands-off: each morning it tops up drafts, then sends them.
-- `outreach-send` auto-ramps its own daily cap (2/day the first week, then 4 -> 6 -> 8 -> 10
-- as the mailbox earns trust), so there is nothing to babysit.
--
-- Requires pg_cron + pg_net (both enabled on Supabase by default) and the three
-- functions deployed with "Verify JWT" OFF. Replace <PROJECT_REF> and <CRON_SECRET>.
-- Run once in the Supabase SQL editor.
--
-- SCANNING is automated too: the scan-targets job below rotates through the (niche x area)
-- rows in `prospect_targets` (supabase/prospect_targets.sql), a few per day, so the pool refills
-- itself across all your states. Add/remove targets by editing that table.

-- 1) Daily scan — refills the pool from prospect_targets (rotates through the list).
select cron.schedule(
  'prospect-scan-daily',
  '30 12 * * *',       -- 30 min before drafting
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/prospect-scan',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body    := jsonb_build_object('action','scan-targets','batch',6)
  );
  $$
);

-- 2) Daily draft — keeps a buffer of ready-to-send, personalized emails.
select cron.schedule(
  'outreach-draft-daily',
  '0 13 * * *',        -- 13:00 UTC ≈ 8-9am ET (shifts with DST; adjust to taste)
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/outreach-draft',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body    := jsonb_build_object('limit', 10)
  );
  $$
);

-- 3) Daily send — 30 min later so drafts are ready. Cap is auto-ramped, so no limit is passed.
select cron.schedule(
  'outreach-send-daily',
  '30 13 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/outreach-send',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

-- To pause the machine later:
--   select cron.unschedule('prospect-scan-daily');
--   select cron.unschedule('outreach-draft-daily');
--   select cron.unschedule('outreach-send-daily');
