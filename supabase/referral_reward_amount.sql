-- Store the payout promised for each referral, so a holiday boost survives to payout time.
--
-- Why this is needed: the portal can promise a doubled reward in the run-up to a holiday, but the
-- referral row is created later (by the admin) and paid later still. Without the amount stored on
-- the row, a referral earned during a $100 boost would be emailed and paid $50 weeks afterwards,
-- because every other part of the system hard-codes 50.
--
-- Run ONCE in the Supabase SQL editor, BEFORE re-pasting referral_emails.sql. Safe to re-run.

alter table public.referrals
  add column if not exists reward_amount integer not null default 50;

comment on column public.referrals.reward_amount is
  'Payout promised for this referral in whole USD. 50 normally, 100 during a holiday boost. Set when the referral is created and never recalculated, so the client gets what they were promised at the time.';

-- Existing rows were all made under the flat $50 programme.
update public.referrals set reward_amount = 50 where reward_amount is null;

notify pgrst, 'reload schema';

-- Check:
--   select id, referred_name, status, reward_paid, reward_amount from public.referrals order by created_at desc limit 10;
