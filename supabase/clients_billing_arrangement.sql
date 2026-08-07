-- Per-client values for the custom billing arrangement popup shown in the client portal (Account
-- Information). The wording is standard; these fill in each client's specifics. Only used for clients
-- on a custom arrangement (billing_label set). billing_cap_hours null = no monthly maintenance cap.
alter table public.clients
  add column if not exists billing_rate      numeric,
  add column if not exists billing_cap_hours integer;

-- Refresh PostgREST's schema cache so the new columns are usable immediately.
notify pgrst, 'reload schema';
