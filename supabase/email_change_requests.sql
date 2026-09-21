-- Letting a client change their own sign-in email, without being able to lock themselves out.
--
-- WHY A TABLE: the change cannot happen when they press the button. A typo in the new address would
-- move their login to an address they do not own, and no amount of support can undo that from the
-- client side. So the request is parked here, a link goes to the NEW address, and the change only
-- happens when someone proves they can read that inbox. An unconfirmed request simply expires.
--
-- The old address is told as well, so a change nobody asked for is visible to the person losing the
-- account rather than silent.
--
-- Safe to run more than once.

create table if not exists public.email_change_requests (
  token       text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  old_email   text not null,
  new_email   text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index if not exists email_change_requests_user_idx on public.email_change_requests (user_id);

alter table public.email_change_requests enable row level security;

-- Nobody reads this from a browser. The edge function holds the service role, which bypasses RLS,
-- and the token in the emailed link is the only thing that can spend a request. With RLS on and no
-- policy, an anon or authenticated client sees nothing here at all, which is what we want: the
-- tokens are the secret.
drop policy if exists "email change admin" on public.email_change_requests;
create policy "email change admin"
  on public.email_change_requests for all
  using ( (auth.jwt() ->> 'email') = 'billy@webeaze.io' )
  with check ( (auth.jwt() ->> 'email') = 'billy@webeaze.io' );

revoke all on public.email_change_requests from anon, authenticated;

notify pgrst, 'reload schema';

-- Check:
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'email_change_requests' order by ordinal_position;
