-- WebEaze: hours worked per request ──────────────────────────────────────────
-- Clients on a custom billing arrangement are not a subscription. They pay for work actually done,
-- at clients.billing_rate per hour, so their income is variable and cannot be rolled into MRR the
-- way a plan can. To report it honestly we need to know how long each request took, which nothing
-- currently records.
--
-- `hours` is filled in from the admin resolution panel when a request is marked Done. It is optional:
-- anything left blank is estimated at a default when reporting, and the figure is labelled as an
-- estimate so it is never mistaken for logged time.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.update_requests
  add column if not exists hours numeric;

alter table public.update_requests drop constraint if exists update_requests_hours_check;
alter table public.update_requests add constraint update_requests_hours_check
  check (hours is null or (hours >= 0 and hours <= 200));

-- Variable revenue is always "this client, this month", so index the way it is queried.
create index if not exists update_requests_user_completed_idx
  on public.update_requests (user_id, completed_at);

notify pgrst, 'reload schema';
