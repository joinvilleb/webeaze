-- WebEaze lead tracking ─────────────────────────────────────────────────────
-- Captures real customer actions on a client's website (form submissions,
-- click-to-call, click-to-email, contact CTAs) and completed WooCommerce
-- orders, so the portal + monthly email can show "Leads this month" and, for
-- stores, "Online orders / revenue". The track.js snippet on each client site
-- posts events to the `track-lead` edge function (service role), which inserts here.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

create table if not exists public.lead_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- which client (clients.user_id)
  type       text not null check (type in ('form','call','email','contact','order')),
  page       text,                          -- path the action happened on (no query string)
  name       text,                          -- form details (Growth/Elite only), optional
  email      text,
  phone      text,
  message    text,
  amount     numeric,                       -- order total (type='order') — the client's own revenue
  order_ref  text,                          -- store order id (type='order') — used to de-duplicate
  created_at timestamptz not null default now()
);

-- Widen the type check for existing tables (was form/call/email, then +contact, now +order).
-- Safe to run repeatedly.
alter table public.lead_events drop constraint if exists lead_events_type_check;
alter table public.lead_events add constraint lead_events_type_check
  check (type in ('form','call','email','contact','order'));

-- Add the newer columns for tables created before they existed (no-op if already present).
alter table public.lead_events add column if not exists name         text;
alter table public.lead_events add column if not exists email        text;
alter table public.lead_events add column if not exists phone        text;
alter table public.lead_events add column if not exists message      text;
alter table public.lead_events add column if not exists amount       numeric;
alter table public.lead_events add column if not exists order_ref    text;
alter table public.lead_events add column if not exists contacted_at timestamptz;   -- follow-up: marked contacted
alter table public.lead_events add column if not exists outcome      text;           -- follow-up outcome: 'won' | 'lost' | null
alter table public.lead_events add column if not exists attachments  jsonb;          -- files sent with a form submission: [{name, path}] in the form-uploads bucket
alter table public.lead_events drop constraint if exists lead_events_outcome_check;
alter table public.lead_events add constraint lead_events_outcome_check
  check (outcome is null or outcome in ('won', 'lost'));

create index if not exists lead_events_user_created_idx
  on public.lead_events (user_id, created_at desc);

-- One row per store order: stops a refresh of / a return visit to the WooCommerce "order received"
-- page from double-counting the same sale (track-lead also checks before inserting; this is the backstop).
create unique index if not exists lead_events_order_uidx
  on public.lead_events (user_id, order_ref) where order_ref is not null;

alter table public.lead_events enable row level security;

-- Clients read only their own leads; Billy (admin) can read any so the portal preview works.
-- (Multi-user teammates get read access via the additive policy in client_members.sql.)
-- Writes happen only through the service-role edge function, so there is no client insert policy.
drop policy if exists "lead_events read own or admin" on public.lead_events;
create policy "lead_events read own or admin" on public.lead_events
  for select using (
    auth.uid() = user_id
    or (auth.jwt() ->> 'email') = 'billy@webeaze.io'
  );

grant select on public.lead_events to authenticated;
