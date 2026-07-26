-- ============================================================================
-- reward_grants  +  reward-scan schedule
-- Run this in the Supabase SQL editor (Dashboard > SQL). One-time setup.
-- ============================================================================

-- 1) Ledger of granted milestone rewards. One row per (client, milestone) ever
--    awarded, so the reward-scan function never emails the same reward twice.
create table if not exists public.reward_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  client_id   uuid,
  milestone   text not null,
  reward      text,
  granted_at  timestamptz not null default now(),
  unique (user_id, milestone)
);

alter table public.reward_grants enable row level security;

-- Clients may read their own grants (optional; lets the portal show them later).
-- Writes have no policy, so only the service role (the edge function) can insert.
drop policy if exists "clients read own reward_grants" on public.reward_grants;
create policy "clients read own reward_grants"
  on public.reward_grants for select
  using (auth.uid() = user_id);


-- 2) OPTIONAL backfill -- run this ONCE, BEFORE scheduling the cron, to mark the
--    rewards existing clients ALREADY qualify for as "granted" WITHOUT emailing
--    them. This prevents a surprise blast to every long-time client on the first
--    run. Skip it if you'd rather retroactively email (and reward) everyone who
--    already qualifies.
--
-- insert into public.reward_grants (user_id, client_id, milestone, reward)
-- select c.user_id, c.id, r.milestone, r.reward
-- from public.clients c
-- cross join (values
--   ('Loyal client',   25,  'A little thank-you on your next invoice'),
--   ('WebEaze VIP',    50,  'A thank-you credit on your next invoice'),
--   ('WebEaze legend', 100, 'A free month, on us')
-- ) as r(milestone, tgt, reward)
-- where (select count(*) from public.update_requests u
--        where u.user_id = c.user_id and u.status = 'Done') >= r.tgt
-- on conflict (user_id, milestone) do nothing;


-- 3) Schedule the scan. Requires pg_cron + pg_net (both available on Supabase).
--    Enable the extensions once:
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Then schedule it. REPLACE <PROJECT_REF> and <CRON_SECRET> with your values
-- (<CRON_SECRET> must match the secret you set on the function).
--
-- select cron.schedule(
--   'reward-scan-hourly',
--   '0 * * * *',                          -- top of every hour
--   $$
--   select net.http_post(
--     url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/reward-scan',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
--     body    := '{}'::jsonb
--   );
--   $$
-- );
--
-- To change the cadence later: select cron.unschedule('reward-scan-hourly'); then re-run.
