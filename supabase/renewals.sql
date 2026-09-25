-- Warn before something we buy for a client runs out (2026-09-25).
--
-- client_costs has carried a renews_on date for every domain, mailbox and platform we pay for on a
-- client's behalf, and nothing ever read it. It was shown on the client record in admin and acted on
-- by nobody. A domain lapsing takes the website AND the email with it, which is the worst failure
-- this company can have, and it was one date in one column away from being impossible.
--
-- Adds no tables and no columns: the function reads client_costs as it stands. This only schedules
-- it. Warnings fire at exactly 30, 14, 7, 3 and 1 days out, so each one happens once per renewal
-- without an "already warned" flag; anything past due is repeated daily until the date is fixed.
--
-- Safe to run more than once. Deploy the function first:
--   supabase functions deploy renewals --no-verify-jwt

do $$
declare cmd text; secret text; url text;
begin
  select command into cmd from cron.job where jobname = 'prospect-scan-daily';
  if cmd is null then
    raise notice 'prospect-scan-daily not found; schedule renewals-daily by hand with the real CRON_SECRET.';
    return;
  end if;
  secret := substring(cmd from $re$'x-cron-secret'\s*,\s*'([^']+)'$re$);
  url := substring(cmd from $re$'(https://[^']+)/functions/v1/$re$);
  if secret is null or secret like '<%' then
    raise exception 'Could not read the cron secret from prospect-scan-daily. Schedule renewals-daily by hand.';
  end if;

  perform cron.unschedule('renewals-daily') where exists (select 1 from cron.job where jobname = 'renewals-daily');
  -- 13:00 UTC, so it lands first thing Eastern and a renewal is dealt with during the working day
  -- rather than noticed at night.
  perform cron.schedule('renewals-daily', '0 13 * * *', format($j$
    select net.http_post(
      url := '%s/functions/v1/renewals',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','%s'),
      body := '{}'::jsonb
    );
  $j$, coalesce(url, 'https://gmgzhjxfypuyzzgqwona.supabase.co'), secret));
end $$;

select jobname, schedule, active from cron.job where jobname = 'renewals-daily';

-- ── Remembering which warning already went out ───────────────────────────────
-- Firing on an exact day (30, 14, 7...) means any day the job does not run loses that warning for
-- good. Grass Goats proved it on day one: it sat at 13 days out, so the 14-day warning had already
-- been missed and the next would not have come until 7.
--
-- This holds the threshold last warned about. The job warns when the current bucket is SMALLER than
-- the one recorded, so a missed day is caught up on the next run and nothing is ever sent twice.
-- Null means never warned. Reset to null by hand, or automatically when the date moves further out
-- than the widest threshold, which is what happens when a renewal is paid and the date rolls on.
alter table public.client_costs
  add column if not exists renewal_warned_days smallint;

comment on column public.client_costs.renewal_warned_days is
  'Smallest renewal warning already sent for the current renews_on (30/14/7/3/1). Null = none.';
