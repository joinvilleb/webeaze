-- Let the people with a login own their own profile ─────────────────────────
--
-- The team list showed bare email addresses, because an address is all we ever stored. On an account
-- with three logins that reads as a list of strangers: nobody can tell which one is the bookkeeper
-- and which is the owner's son who files the photo requests.
--
-- Two small things, both of them the member's own to set:
--   name  -- what they are called, shown wherever their login appears
--   (their password is Supabase auth's, changed from the portal with auth.updateUser)
--
-- Run once in the Supabase SQL editor. Safe to re-run.

alter table public.client_members
  add column if not exists name text;

comment on column public.client_members.name is
  'What this person is called. Set by them in the portal; falls back to the email when empty.';

-- Backfill nothing on purpose: a name guessed from an email address ("jsmith") is worse than the
-- address itself, and the portal already falls back to the address when this is null.

-- ── Who may change it ───────────────────────────────────────────────────────
-- The member, on their own row. Not the owner on everyone else's: a name is how someone chooses to
-- be addressed, and this table is also what acts_as() reads, so the fewer hands on it the better.
drop policy if exists "member updates own row" on public.client_members;
create policy "member updates own row" on public.client_members
  for update to authenticated
  using (member_user_id = auth.uid())
  with check (member_user_id = auth.uid());

grant update (name) on public.client_members to authenticated;

notify pgrst, 'reload schema';

-- ── Check it ────────────────────────────────────────────────────────────────
--   select coalesce(name, '(no name)') as who, email, role, accepted_at
--     from public.client_members order by owner_user_id, role;
