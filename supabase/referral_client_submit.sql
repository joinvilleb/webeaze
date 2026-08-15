-- Let clients log their own referrals from the portal.
--
-- Until now a referral row could only be created by the admin, so a client who sent someone our way
-- had no way to tell us. This adds an INSERT path for clients, locked down so it cannot be abused.
--
-- Run ONCE in the Supabase SQL editor, AFTER referral_reward_amount.sql. Safe to re-run.

-- 1. A client may insert a referral, but only ever attributed to THEMSELVES.
drop policy if exists "clients log own referrals" on public.referrals;
create policy "clients log own referrals"
  on public.referrals
  for insert
  to authenticated
  with check (referrer_user_id = auth.uid());

-- 2. Force the fields a client must not control.
--    Without this, the policy above still lets them POST reward_amount = 99999, or insert a row
--    already marked 'Signed up' and paid, which would fire the payout email immediately.
--    The admin is exempt so the Growth tab can still set a boosted amount and a real status.
create or replace function public.referrals_client_defaults()
returns trigger
language plpgsql
security definer
as $$
begin
  if coalesce(auth.jwt() ->> 'email', '') <> 'billy@webeaze.io' then
    new.status        := 'Referred';   -- always starts unverified, whatever was sent
    new.reward_paid   := false;
    new.reward_amount := 50;           -- the base rate; a boost is applied by the admin on review
  end if;
  return new;
end;
$$;

drop trigger if exists referrals_client_defaults_trg on public.referrals;
create trigger referrals_client_defaults_trg
  before insert on public.referrals
  for each row execute function public.referrals_client_defaults();

notify pgrst, 'reload schema';

-- Checks:
--   Policies:  select policyname, cmd from pg_policies where tablename = 'referrals';
--   Triggers:  select tgname from pg_trigger where tgrelid = 'public.referrals'::regclass;
--
-- Note on the boost: a client-logged referral always lands at $50. When you confirm it during a
-- holiday window, raise the amount on the row in the admin Growth tab and the emails follow it.
