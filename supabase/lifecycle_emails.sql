-- Columns for the daily lifecycle-emails function (win-back, stuck-onboarding nudge, review+referral
-- nudge). cancelled_at / launched_at drive the timing; the *_at "sent" columns dedupe so each email
-- goes out at most once per client. All going-forward only (existing clients aren't back-filled, so
-- nobody gets a surprise blast for something that happened before this shipped).
alter table public.clients
  add column if not exists cancelled_at        timestamptz,   -- set when marked inactive
  add column if not exists launched_at         timestamptz,   -- set when the site URL first goes live
  add column if not exists winback_email_at    timestamptz,   -- win-back email sent
  add column if not exists onboarding_nudge_at timestamptz,   -- stuck-onboarding nudge sent (or skipped)
  add column if not exists review_nudge_at     timestamptz;   -- review + referral nudge sent

notify pgrst, 'reload schema';

-- Schedule (run AFTER deploying the function: supabase functions deploy lifecycle-emails --no-verify-jwt).
-- Replace <YOUR_CRON_SECRET> with the same value as the function's CRON_SECRET.
-- select cron.schedule(
--   'lifecycle-emails-daily',
--   '30 14 * * *',   -- every day at 14:30 UTC (~10:30am ET)
--   $$
--   select net.http_post(
--     url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/lifecycle-emails',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<YOUR_CRON_SECRET>'),
--     body    := '{}'::jsonb
--   );
--   $$
-- );
-- Remove later:  select cron.unschedule('lifecycle-emails-daily');
