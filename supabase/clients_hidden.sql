-- Keep a record out of the numbers ──────────────────────────────────────────
--
-- A duplicate client row was inflating every count and every revenue figure, and there was no way to
-- take it out short of deleting it, which loses whatever real history is attached to it.
--
-- `hidden` is deliberately NOT the same thing as `status = 'inactive'`. Inactive means a real client
-- who cancelled: they still count in churn, their history is still theirs, and the portal shows them
-- the cancelled screen. Hidden means "this row is not a business", a duplicate or a test account, and
-- it should vanish from money, from Insights and from Pulse.
--
-- Run once in the Supabase SQL editor. Everything degrades safely without it: an absent column reads
-- as undefined, which is falsy, so nothing is hidden and the pages behave exactly as they do today.

alter table public.clients
  add column if not exists hidden boolean not null default false;

comment on column public.clients.hidden is
  'True for duplicate or test rows. Excluded from revenue, costs, Insights and Pulse. Not the same as status=inactive, which is a real client who cancelled.';

-- Find likely duplicates before hiding one:
--   select lower(email) as email, count(*), array_agg(id) as ids, array_agg(name) as names
--     from public.clients group by lower(email) having count(*) > 1;
--
-- Hide one by id:
--   update public.clients set hidden = true where id = '<the duplicate id>';
