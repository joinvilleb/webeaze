-- Admin (Billy) can read every loyalty-reward grant, so the admin Growth tab + client profile can show
-- which clients hit which milestone (Loyal client / VIP / legend). Mirrors the admin RLS on clients.
--
-- This file is STANDALONE: it also creates the reward_grants table if it doesn't exist yet (the table
-- normally lives in reward_grants.sql, which had not been run). Safe to run repeatedly.
--
-- NOTE: creating the table + this policy only lets the admin READ it. Nothing writes rows until the
-- `reward-scan` edge function runs on its hourly cron (that is what awards a milestone once a client
-- crosses 25 / 50 / 100 completed requests). So this section stays empty until that is set up.

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

-- Clients may read their own grants (from reward_grants.sql; recreated here so this file stands alone).
drop policy if exists "clients read own reward_grants" on public.reward_grants;
create policy "clients read own reward_grants"
  on public.reward_grants for select
  using (auth.uid() = user_id);

-- Admin read/manage.
drop policy if exists "reward_grants admin all" on public.reward_grants;
create policy "reward_grants admin all" on public.reward_grants
  for all
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select on public.reward_grants to authenticated;

notify pgrst, 'reload schema';
