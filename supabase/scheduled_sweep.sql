-- Scheduled-changes engine: fire every update_requests row whose scheduled_for date has arrived.
-- This is what makes fixed-date automations actually run on their own:
--   - Seasonal promo take-downs (the Seasonal promo tool files a dated "remove the banner" request)
--   - "Publish this on Monday" / dated price-list swaps
--   - Holiday closures (scheduled open/close changes)
--
-- dispatch-request skips future-dated requests on insert; this daily sweep calls it in `scheduled`
-- mode, which processes any request now due through the same bot + safety gate, then clears
-- scheduled_for on anything the bot didn't auto-merge so it becomes a normal pending request and is
-- never swept twice.
--
-- Prereqs: extensions pg_cron + pg_net enabled; dispatch-request deployed (--no-verify-jwt);
--          replace <YOUR_CRON_SECRET> with the same value as the function's CRON_SECRET.
-- Run this once in the Supabase SQL editor.

select cron.schedule(
  'scheduled-changes-sweep',
  '15 8 * * *',   -- every day at 08:15 UTC
  $$
  select net.http_post(
    url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/dispatch-request',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', '<YOUR_CRON_SECRET>'),
    body    := jsonb_build_object('mode', 'scheduled')
  );
  $$
);

-- To change the time later:   select cron.alter_job((select jobid from cron.job where jobname='scheduled-changes-sweep'), schedule => '15 8 * * *');
-- To remove it:               select cron.unschedule('scheduled-changes-sweep');
