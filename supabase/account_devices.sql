-- Where you're signed in, and who on your team has been in lately.
--
-- WHY: the account panel could only "sign out everywhere else", blind. Nobody could see which phones
-- and computers were signed in, end just one of them, or (as the main login) see whether a teammate
-- had ever actually used the portal. Sessions live in auth.sessions, which a browser cannot read, so
-- these three functions are the only doors, and each one is pinned to the caller's own account.
--
--   my_sessions()        your own signed-in devices, newest activity first, flagging this one
--   end_my_session(id)   signs out ONE of your own devices (its refresh token dies with the row;
--                        the device drops off within the hour, when its current token expires)
--   team_activity()      for the main login only: when each person on the account was last active,
--                        and on what device. Teammates calling it get nothing back.
--
-- SECURITY DEFINER so they can read auth.*, with search_path pinned and every query filtered on
-- auth.uid(). Execute is granted to signed-in users only.
--
-- Safe to run more than once.

create or replace function public.my_sessions()
returns table (id uuid, created_at timestamptz, last_active timestamptz, user_agent text, is_current boolean)
language sql
stable
security definer
set search_path = public, auth
as $$
  select s.id,
         s.created_at,
         greatest(s.updated_at, s.refreshed_at at time zone 'utc', s.created_at) as last_active,
         s.user_agent,
         s.id::text = coalesce(auth.jwt() ->> 'session_id', '') as is_current
    from auth.sessions s
   where s.user_id = auth.uid()
     and (s.not_after is null or s.not_after > now())
   order by last_active desc nulls last
   limit 25;
$$;

create or replace function public.end_my_session(target uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then return false; end if;
  delete from auth.sessions where id = target and user_id = auth.uid();
  return found;
end $$;

create or replace function public.team_activity()
returns table (member_user_id uuid, last_active timestamptz, user_agent text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select m.member_user_id,
         coalesce(latest.last_active, u.last_sign_in_at) as last_active,
         latest.user_agent
    from public.client_members m
    join auth.users u on u.id = m.member_user_id
    left join lateral (
      select greatest(s.updated_at, s.refreshed_at at time zone 'utc', s.created_at) as last_active, s.user_agent
        from auth.sessions s
       where s.user_id = m.member_user_id
       order by 1 desc nulls last
       limit 1
    ) latest on true
   where m.owner_user_id = auth.uid()
     and m.member_user_id is not null;
$$;

revoke all on function public.my_sessions()          from public, anon;
revoke all on function public.end_my_session(uuid)   from public, anon;
revoke all on function public.team_activity()        from public, anon;
grant execute on function public.my_sessions()        to authenticated;
grant execute on function public.end_my_session(uuid) to authenticated;
grant execute on function public.team_activity()      to authenticated;

notify pgrst, 'reload schema';

-- Check (as the SQL editor you are not a portal user, so these return nothing here; that is expected):
select proname from pg_proc where proname in ('my_sessions', 'end_my_session', 'team_activity');
