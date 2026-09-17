-- Let a teammate post in Messages.
--
-- WHY: client_notes is the only client-writable table whose insert policy still pins auth.uid() to
-- user_id. The portal always writes the OWNER's user_id (that is what makes one shared conversation
-- per business), so an invited teammate hit "new row violates row-level security policy" on every
-- message, with or without a file. Every other table they can write to (update_requests,
-- request_messages, request_attachments, client_resources, site_submissions) already uses
-- public.acts_as(), which is true for the owner AND for an accepted teammate.
--
-- Safe to run more than once.

do $$
begin
  if to_regprocedure('public.acts_as(uuid)') is null then
    raise exception 'public.acts_as(uuid) is missing - run supabase/client_members.sql first';
  end if;
end $$;

drop policy if exists "clients add own notes" on public.client_notes;

-- author is still pinned to 'client': the portal must never be able to post as WebEaze.
create policy "clients add own notes"
  on public.client_notes
  for insert
  with check ( public.acts_as(user_id) and author = 'client' );

-- Reading was already covered by "members_act_select"; this keeps the pair symmetrical if that
-- policy was ever dropped.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'client_notes' and policyname = 'members_act_select'
  ) then
    create policy "members_act_select"
      on public.client_notes
      for select
      using ( public.acts_as(user_id) );
  end if;
end $$;

-- Check: both policies present, insert pinned to acts_as.
select policyname, cmd, coalesce(qual, with_check) as expr
from pg_policies
where schemaname = 'public' and tablename = 'client_notes'
order by cmd, policyname;
