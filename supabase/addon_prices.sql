-- Portal add-ons, wired to the real Stripe products (2026-09-23).
--
-- Until now an add-on purchase built its Stripe invoice from a description and an amount the BROWSER
-- sent, so the invoice showed a plain text line at whatever price the page happened to hold, and the
-- amount was whatever the page said it was. This table is the server-side answer to both: the price
-- lives in Stripe, and the dollar figure lives here as a fallback, so neither comes from the client.
--
-- Fill in stripe_price_id from the admin Money tab, not here. One row per add-on, keyed by the exact
-- name the portal uses (portal/index.html, const ADD_ONS), because that name is what create-invoice
-- is handed and it is what the client saw on the card they pressed.
--
-- Safe to run more than once. Re-running does not overwrite price IDs you have already pasted in.

create table if not exists public.addon_prices (
  addon            text primary key,                  -- exact ADD_ONS name
  stripe_price_id  text,                              -- price_..., from the Stripe product
  amount_usd       integer not null default 0,        -- fallback when no price ID is set yet
  invoiceable      boolean not null default false,    -- false = this one files a request instead
  updated_at       timestamptz not null default now()
);

-- Seeded with the fee schedule as it stands. amount_usd is here so a purchase still works, at the
-- right price, before any price ID has been pasted in; once one is set, Stripe owns the number.
insert into public.addon_prices (addon, amount_usd, invoiceable) values
  ('New Website Build',        949, true),
  ('Website Revamp',           479, true),
  ('Web Project: Standard',    359, true),
  ('Web Project: Basic',       179, true),
  ('Logo Design',              359, true),
  ('Additional Domain',        109, true),
  ('Remove Footer Credit',     179, true),
  -- These are quoted, so the portal files a request rather than invoicing. They are listed here so
  -- the prices live in one place, and so switching one to invoiceable later is a single checkbox.
  ('Online Store Setup',       779, false),
  ('Booking System',           389, false),
  ('Campaign / Landing Page',  389, false),
  ('Form or CRM Integration',  359, false),
  ('Additional Page',          229, false),
  ('Rush Request',              89, false)
on conflict (addon) do nothing;

alter table public.addon_prices enable row level security;

-- Admin only. Clients never read this: the portal shows its own prices and create-invoice runs with
-- the service role, so there is no reason for a client's browser to hold the price IDs.
drop policy if exists "addon_prices admin" on public.addon_prices;
create policy "addon_prices admin" on public.addon_prices
  for all using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');
grant select, insert, update on public.addon_prices to authenticated;

create or replace function public.addon_prices_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists addon_prices_touch on public.addon_prices;
create trigger addon_prices_touch before update on public.addon_prices
  for each row execute function public.addon_prices_touch();
