-- Add-ons stop flowing as ordinary requests (2026-09-23).
--
-- A paid add-on used to be inserted as type 'Other', which meant three things, only the first of
-- them cosmetic:
--   1. the client was shown the 'Other' turnaround, 48 hours, for a job that takes weeks
--   2. computeSlaStats graded it against those same 48 hours, so every add-on we delivered counted
--      as late and dragged down the on-time figure shown to every client
--   3. turnaround_stats is keyed by type, so one three-week build went into the 'Other' median and
--      inflated the estimate quoted on every ordinary 'Other' request afterwards
--
-- An add-on now carries its own name, its own stages and its own delivery date, and both statistics
-- skip it. It stays in update_requests on purpose: history, message threads, completion emails and
-- notifications all already work there, and a separate table would mean rebuilding every one.
--
-- Safe to run more than once. Needs supabase/addon_prices.sql first.

-- ── The job, on the request ──────────────────────────────────────────────────
alter table public.update_requests
  add column if not exists addon        text,              -- the add-on's name; null on a normal request
  add column if not exists addon_stage  smallint not null default 0,
  add column if not exists addon_stages jsonb;             -- ["Brief","Design",...] frozen at purchase

-- Frozen on purpose: the stage list is copied onto the row when the add-on is bought, so editing the
-- schedule later never rewrites the steps a client has already been watching.

comment on column public.update_requests.addon is
  'Add-on name when this request IS an add-on. Excluded from turnaround stats and the on-time figure.';

create index if not exists update_requests_addon_idx on public.update_requests (addon) where addon is not null;

-- ── How long each one takes, and what the steps are ──────────────────────────
-- Seeded from the delivery spec in the portal, then tuned in admin without a deploy. The stages live
-- here rather than in the webhook so there is one list, not two that drift: the portal keeps its own
-- copy only as a fallback for the confirm screen, before this has loaded.
alter table public.addon_prices
  add column if not exists lead_days smallint not null default 0,
  add column if not exists stages    jsonb;

update public.addon_prices set lead_days = v.d from (values
  ('New Website Build', 21), ('Website Revamp', 14), ('Web Project: Standard', 7),
  ('Web Project: Basic', 4), ('Logo Design', 7), ('Additional Domain', 2),
  ('Remove Footer Credit', 2), ('Online Store Setup', 21), ('Booking System', 7),
  ('Campaign / Landing Page', 7), ('Form or CRM Integration', 5), ('Additional Page', 4),
  ('Rush Request', 1)
) as v(a, d) where public.addon_prices.addon = v.a and public.addon_prices.lead_days = 0;

update public.addon_prices set stages = v.s::jsonb from (values
  ('New Website Build',       '["Brief","Design","Build","Your review","Live"]'),
  ('Website Revamp',          '["Brief","Design","Build","Your review","Live"]'),
  ('Web Project: Standard',   '["Brief","Build","Your review","Live"]'),
  ('Web Project: Basic',      '["Brief","Build","Your review","Live"]'),
  ('Logo Design',             '["Brief","Concepts","Your review","Final files"]'),
  ('Additional Domain',       '["Registered","Pointed at your site","Live"]'),
  ('Remove Footer Credit',    '["Booked","Removed","Live"]'),
  ('Online Store Setup',      '["Brief","Platform","Products","Payments","Testing","Live"]'),
  ('Booking System',          '["Brief","Connected","Testing","Live"]'),
  ('Campaign / Landing Page', '["Brief","Design","Build","Your review","Live"]'),
  ('Form or CRM Integration', '["Brief","Connected","Testing","Live"]'),
  ('Additional Page',         '["Brief","Build","Your review","Live"]'),
  ('Rush Request',            '["Booked","In progress","Done"]')
) as v(a, s) where public.addon_prices.addon = v.a and public.addon_prices.stages is null;

-- ── The brief, taken before payment ──────────────────────────────────────────
-- The client answers the questions the job needs BEFORE the invoice exists, so we never hold money
-- for work we cannot begin. create-invoice writes the row and stamps its id on the invoice; the
-- webhook reads it back when the invoice is paid and puts the answers in the request.
create table if not exists public.addon_orders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  addon       text not null,
  answers     jsonb not null default '[]'::jsonb,   -- [{q, a}, ...] in the order they were asked
  invoice_id  text,
  request_id  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists addon_orders_user_idx on public.addon_orders (user_id, created_at desc);
create index if not exists addon_orders_invoice_idx on public.addon_orders (invoice_id) where invoice_id is not null;

alter table public.addon_orders enable row level security;

-- A client may file their own brief and read it back. They may not change one after the fact: the
-- brief is what we quoted and built against, so it is written once.
drop policy if exists "addon_orders own insert" on public.addon_orders;
create policy "addon_orders own insert" on public.addon_orders
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "addon_orders own read" on public.addon_orders;
create policy "addon_orders own read" on public.addon_orders
  for select to authenticated using (auth.uid() = user_id or (auth.jwt() ->> 'email') = 'billy@webeaze.io');
grant select, insert on public.addon_orders to authenticated;

-- ── Lead times, readable by the client ───────────────────────────────────────
-- The portal has to tell someone how long their add-on takes before they buy it, and that number is
-- tuned in admin. It cannot read addon_prices, which holds the Stripe price IDs and is admin-only,
-- so this view exposes the two harmless columns and nothing else. security_invoker stays off on
-- purpose: the whole point is to read past the table's own policy.
create or replace view public.addon_lead_times as
  select addon, lead_days, stages from public.addon_prices;
grant select on public.addon_lead_times to authenticated;

-- ── Telling them when it is their turn ───────────────────────────────────────
-- One stage on most add-ons puts the ball in the client's court ("Your review"), and a job sitting
-- there unseen is the one place this whole flow stalls. Moving to it emails them.
--
-- This holds the stage we last emailed about, rather than a plain "emailed" flag, so that moving
-- back to review for a second round does send a second email, while clicking the same stage twice
-- sends nothing.
alter table public.update_requests
  add column if not exists addon_notified_stage smallint;
