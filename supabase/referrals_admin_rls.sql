-- Admin (Billy) can read every referral and mark payouts as paid, so the admin Growth tab can surface
-- referral rewards owed and let him check them off. Mirrors the admin RLS on public.clients. The
-- existing "clients read own referrals" policy is untouched. Safe to run repeatedly.

alter table public.referrals enable row level security;

drop policy if exists "referrals admin all" on public.referrals;
create policy "referrals admin all" on public.referrals
  for all
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select, update on public.referrals to authenticated;

notify pgrst, 'reload schema';
