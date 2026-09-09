-- What we cover for each client ─────────────────────────────────────────────
--
-- Two problems, one table. The client has nowhere to see what their plan actually covers and when
-- each piece renews, so "what am I paying for" is a support question. And on our side there was no
-- record of what we are buying on their behalf, so the monthly card statement had to be reconciled
-- from memory.
--
-- `amount` is OUR cost, never theirs. Clients never see it: the portal shows the item and its
-- renewal date only. Keep it that way, or a $14 domain reads as a line on their invoice.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.client_costs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  client_id      uuid,
  label          text not null,                       -- "bearcarpetcleaning.com"
  kind           text not null default 'other',       -- domain | hosting | email | software | service | other
  provider       text,                                -- GoDaddy, Cloudflare, Google Workspace
  amount         numeric(10,2) not null default 0,    -- what WE pay, per cycle
  cycle          text not null default 'yearly',      -- monthly | yearly | one_time
  renews_on      date,
  client_visible boolean not null default true,       -- false = our cost, not part of their story
  notes          text,
  created_at     timestamptz not null default now()
);

create index if not exists client_costs_user_idx on public.client_costs (user_id);
create index if not exists client_costs_renew_idx on public.client_costs (renews_on);

alter table public.client_costs enable row level security;

-- The client reads only their own, and only the ones marked visible. No amount is exposed by the
-- portal, but RLS is the thing that makes that true rather than a promise the front end keeps.
drop policy if exists "client reads own visible costs" on public.client_costs;
create policy "client reads own visible costs" on public.client_costs
  for select to authenticated
  using (user_id = auth.uid() and client_visible = true);

drop policy if exists "admin manages costs" on public.client_costs;
create policy "admin manages costs" on public.client_costs
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select on public.client_costs to authenticated;
grant insert, update, delete on public.client_costs to authenticated;

-- ── Your side: what is going out, and when ──────────────────────────────────
-- Monthly equivalent of everything, so a yearly domain and a monthly mailbox can be added up:
--   select round(sum(case cycle when 'monthly' then amount
--                               when 'yearly'  then amount / 12
--                               else 0 end), 2) as monthly_run_rate
--     from public.client_costs;
--
-- What renews in the next 30 days:
--   select c.name, k.label, k.kind, k.amount, k.cycle, k.renews_on
--     from public.client_costs k
--     left join public.clients c on c.user_id = k.user_id
--    where k.renews_on between current_date and current_date + 30
--    order by k.renews_on;
