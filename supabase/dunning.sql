-- Chase a failed card, automatically (2026-09-24).
--
-- Until now a bounced card was silent. stripe-webhook only listened for invoice.paid, and the
-- clients.payment_failed flag was a CHECKBOX an admin ticked by hand. payment-status could show a
-- "update your card" nudge, but only to a client who happened to open the portal. So the real
-- sequence was: card fails, Stripe retries quietly, nobody says anything, the subscription cancels,
-- and we find out when the client asks why their site is gone.
--
-- Now: the webhook opens a case the moment Stripe reports a failure and sends the first email, a
-- daily job sends the day-3 and day-7 follow-ups, and a successful payment closes the case.
--
-- Safe to run more than once.

alter table public.clients
  -- When the CURRENT run of failures began. Null means no open case. Not the last failure: Stripe
  -- retries the same invoice several times, and each retry is the same problem, not a new one.
  add column if not exists payment_failed_at timestamptz,
  -- How far the chase has got: 0 none, 1 first email sent, 2 day-three sent, 3 day-seven sent.
  -- Held as the stage we have SENT, so the daily job is idempotent: running twice sends nothing
  -- twice, and a missed day catches up rather than skipping.
  add column if not exists dunning_stage smallint not null default 0,
  add column if not exists dunning_last_at timestamptz;

comment on column public.clients.payment_failed_at is
  'Start of the current run of card failures. Null = no open case. Set by stripe-webhook, cleared on payment.';
comment on column public.clients.dunning_stage is
  'Highest dunning email already sent: 0 none, 1 first, 2 day three, 3 day seven.';

-- Finding the open cases is the daily job's only query.
create index if not exists clients_dunning_idx on public.clients (payment_failed_at)
  where payment_failed_at is not null;

-- ── Daily, at 15:00 UTC (11am Eastern in summer, 10am in winter) ────────────
-- Late morning on purpose: a "your card failed" email at 3am reads as an emergency, and this is a
-- thing they fix over coffee. The cron secret is copied from an existing job so there is no
-- placeholder to forget, the same way postcard_automation.sql does it.
do $$
declare cmd text; secret text; url text;
begin
  select command into cmd from cron.job where jobname = 'prospect-scan-daily';
  if cmd is null then
    raise notice 'prospect-scan-daily not found; schedule dunning-daily by hand with the real CRON_SECRET.';
    return;
  end if;
  secret := substring(cmd from $re$'x-cron-secret'\s*,\s*'([^']+)'$re$);
  url := substring(cmd from $re$'(https://[^']+)/functions/v1/$re$);
  if secret is null or secret like '<%' then
    raise exception 'Could not read the cron secret from prospect-scan-daily. Schedule dunning-daily by hand.';
  end if;

  perform cron.unschedule('dunning-daily') where exists (select 1 from cron.job where jobname = 'dunning-daily');
  perform cron.schedule('dunning-daily', '0 15 * * *', format($j$
    select net.http_post(
      url := '%s/functions/v1/dunning',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','%s'),
      body := '{}'::jsonb
    );
  $j$, coalesce(url, 'https://gmgzhjxfypuyzzgqwona.supabase.co'), secret));
end $$;

select jobname, schedule from cron.job where jobname = 'dunning-daily';
