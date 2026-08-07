-- Authoritative "has this client ever signed in, and when" for the admin dashboard.
--
-- Supabase Auth already records auth.users.last_sign_in_at on every successful login. It is retroactive:
-- the moment you run this, it knows for every existing client, with no heartbeat and no waiting for them
-- to log in again. The old approach relied on a client_activity heartbeat table that (a) you never created
-- and (b) would only start knowing from the day it was added, so the admin showed "Never signed in" for
-- everyone. This replaces that as the source of truth for the profile's sign-in pill.
--
-- The admin dashboard runs client-side and cannot read the `auth` schema directly, so this SECURITY
-- DEFINER function exposes just the two timestamps, and only to Billy (every other caller gets no rows).
--
-- Run once in the Supabase SQL editor.

create or replace function public.admin_login_status()
returns table (user_id uuid, last_sign_in_at timestamptz, created_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select u.id, u.last_sign_in_at, u.created_at
  from auth.users u
  where (auth.jwt() ->> 'email') = 'billy@webeaze.io';
$$;

-- Only logged-in users can call it, and the WHERE above means only Billy ever gets rows back.
revoke all on function public.admin_login_status() from public, anon;
grant execute on function public.admin_login_status() to authenticated;
