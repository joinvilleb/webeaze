-- Admin (Billy) can read every referral and mark payouts as paid, so the admin Growth tab can surface
-- referral rewards owed and let him check them off. Mirrors the admin RLS on public.clients. The
-- existing "clients read own referrals" policy is untouched. Safe to run repeatedly.

alter table public.referrals enable row level security;

drop policy if exists "referrals admin all" on public.referrals;
create policy "referrals admin all" on public.referrals
  for all
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- select/insert/update/delete so the admin Growth tab can fully manage referrals (add, edit status,
-- mark paid, remove). RLS still gates every write to billy@webeaze.io via the "referrals admin all"
-- policy above, plus the existing "clients read own referrals" select policy — so widening the table
-- grant does not let a regular client write (no client insert/update/delete policy exists).
grant select, insert, update, delete on public.referrals to authenticated;

notify pgrst, 'reload schema';
