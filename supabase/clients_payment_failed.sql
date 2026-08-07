-- Manual flag an admin sets when a client's payment has failed before. The client portal uses it to
-- show a "please update your card" nudge to ONLY those clients as their next payment approaches
-- (within 14 days). Everyone else never sees it. Billing is managed manually (no Stripe sync), so
-- this is an admin toggle on the client edit form, not an automated webhook.
alter table public.clients
  add column if not exists payment_failed boolean not null default false;
