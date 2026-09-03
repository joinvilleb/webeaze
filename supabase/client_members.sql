-- ============================================================================
-- Multi-user: separate logins per business.
--
-- Problem: every client-scoped table keys on `user_id = clients.user_id` (the ONE primary account)
-- and its RLS is `auth.uid() = user_id`. So only that single login can ever see the business data.
--
-- Solution: a membership table (public.client_members) linking extra Supabase auth users to a
-- business, plus a helper public.acts_as(owner_user_id) that returns true when the caller either IS
-- that owner or is an accepted teammate of theirs. We then ADD one permissive policy per client table
-- (`using (public.acts_as(user_id))`) alongside the existing owner/admin policies. Nothing is
-- re-keyed: the data stays on the owner's user_id, and teammates "act as" that owner.
--
-- Safe to run repeatedly. Run once in the Supabase SQL editor.
-- ============================================================================

-- 1) Membership table -------------------------------------------------------
create table if not exists public.client_members (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  owner_user_id  uuid not null,          -- = clients.user_id; the account all business data is keyed on
  member_user_id uuid,                   -- the teammate's auth.users id (null until the invite is created)
  email          text not null,
  role           text not null default 'member',    -- 'owner' | 'member'
  invited_at     timestamptz not null default now(),
  accepted_at    timestamptz,            -- non-null once they can act; acts_as() requires this
  created_at     timestamptz not null default now()
);

create unique index if not exists client_members_owner_member_uidx
  on public.client_members (owner_user_id, member_user_id)
  where member_user_id is not null;
create index if not exists client_members_member_idx on public.client_members (member_user_id);
create index if not exists client_members_client_idx on public.client_members (client_id);

-- 2) acts_as(): the single source of truth for "may this caller act as this owner?" -------------
-- SECURITY DEFINER so it can read client_members without tripping that table's own RLS (and without
-- recursion). STABLE so the planner can cache it within a statement.
create or replace function public.acts_as(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() = target_user
    or exists (
      select 1 from public.client_members m
      where m.owner_user_id  = target_user
        and m.member_user_id = auth.uid()
        and m.accepted_at is not null
    );
$$;
revoke all on function public.acts_as(uuid) from public;
grant execute on function public.acts_as(uuid) to authenticated;

-- 3) RLS on the membership table itself -------------------------------------
alter table public.client_members enable row level security;

-- Admin (Billy) fully manages memberships from the admin panel.
drop policy if exists "client_members admin all" on public.client_members;
create policy "client_members admin all" on public.client_members
  for all to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- A teammate reads their own membership (so the portal can resolve their business on login); an owner
-- can see who is on their team.
drop policy if exists "client_members read own" on public.client_members;
create policy "client_members read own" on public.client_members
  for select to authenticated
  using (member_user_id = auth.uid() or owner_user_id = auth.uid());

grant select on public.client_members to authenticated;

-- 4) Backfill an 'owner' row for every existing client ----------------------
-- Optional for RLS (acts_as already returns true for the owner), but it makes the admin Team list
-- show the primary login too.
insert into public.client_members (client_id, owner_user_id, member_user_id, email, role, accepted_at)
select c.id, c.user_id, c.user_id, coalesce(nullif(c.email, ''), 'owner'), 'owner', now()
from public.clients c
where c.user_id is not null
on conflict (owner_user_id, member_user_id) where member_user_id is not null do nothing;

-- 5) Additive member policies on every client-scoped table ------------------
-- Each client table carries an owner-key column equal to clients.user_id (usually `user_id`, but
-- `referrals` uses `referrer_user_id`). We add one permissive policy per operation gated by
-- acts_as(<that column>). PostgreSQL ORs permissive policies together, so the existing owner
-- ("auth.uid() = user_id") and admin policies keep working untouched. Every table+column is checked
-- for existence first, so a missing table OR a mis-named column is SKIPPED (with a notice) instead of
-- aborting the whole migration. mode: 'r' = read-only for teammates, 'rw' = read + create + update.
do $mig$
declare
  r record;
  has_col boolean;
begin
  for r in
    select * from (values
      ('clients',             'user_id',          'r'),
      ('client_metrics',      'user_id',          'r'),
      ('client_notes',        'user_id',          'r'),
      ('site_checks',         'user_id',          'r'),
      ('reward_grants',       'user_id',          'r'),
      ('referrals',           'referrer_user_id', 'r'),
      ('chat_messages',       'user_id',          'rw'),
      ('lead_events',         'user_id',          'rw'),
      ('update_requests',     'user_id',          'rw'),
      ('request_attachments', 'user_id',          'rw'),
      ('portal_state',        'user_id',          'rw'),
      ('email_prefs',         'user_id',          'rw'),
      ('portal_tour',         'user_id',          'rw'),
      ('site_blocks',         'user_id',          'rw'),
      ('site_issues',         'user_id',          'rw'),
      ('site_submissions',    'user_id',          'rw'),
      ('notification_reads',  'user_id',          'rw'),
      ('client_activity',     'user_id',          'rw')
    ) as x(tbl, col, mode)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'client_members: skipping %, table not found', r.tbl;
      continue;
    end if;
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) into has_col;
    if not has_col then
      raise notice 'client_members: skipping %, column % not found', r.tbl, r.col;
      continue;
    end if;

    -- SELECT for teammates (all tables)
    execute format('drop policy if exists %I on public.%I', 'members_act_select', r.tbl);
    execute format('create policy %I on public.%I for select to authenticated using (public.acts_as(%I))', 'members_act_select', r.tbl, r.col);
    execute format('grant select on public.%I to authenticated', r.tbl);

    -- INSERT + UPDATE for the read-write tables (matches what the owner can do in the portal)
    if r.mode = 'rw' then
      execute format('drop policy if exists %I on public.%I', 'members_act_insert', r.tbl);
      execute format('create policy %I on public.%I for insert to authenticated with check (public.acts_as(%I))', 'members_act_insert', r.tbl, r.col);
      execute format('drop policy if exists %I on public.%I', 'members_act_update', r.tbl);
      execute format('create policy %I on public.%I for update to authenticated using (public.acts_as(%I)) with check (public.acts_as(%I))', 'members_act_update', r.tbl, r.col, r.col);
      execute format('grant select, insert, update on public.%I to authenticated', r.tbl);
    end if;
  end loop;
end
$mig$;

notify pgrst, 'reload schema';

-- ── Verify (optional) ──────────────────────────────────────────────────────
-- List the new member policies:
--   select tablename, policyname, cmd from pg_policies where policyname like 'members_act_%' order by 1,3;
-- Confirm acts_as compiles:
--   select public.acts_as('00000000-0000-0000-0000-000000000000');
-- See a business's team:
--   select email, role, member_user_id, accepted_at from public.client_members where client_id = '<CLIENT_UUID>';
