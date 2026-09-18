-- Close two write holes found in the RLS audit, and let a teammate use the secure form.
--
-- WHY: both tables carried a policy written as FOR ALL, which grants UPDATE and DELETE as well as
-- SELECT. Nothing in the portal uses that, but the API is reachable with any signed-in client's own
-- token, so the rules were wider than the product.
--
--   clients          a client could rewrite their OWN row: plan, plan_amount, billing_label, status,
--                    site_url, next_billing_date. Setting plan = 'Elite' unlocks Growth-only features
--                    in the portal, so this was a paywall anyone could step over. The portal never
--                    writes to this table at all (checked every call site), so read is all it needs.
--
--   update_requests  a client could set any column on their own request: status = 'Done', a made-up
--                    resolution, priority = 'Urgent' to jump the queue, or `hours`, which is what the
--                    Money tab bills hourly clients from. The portal only ever writes client_reply,
--                    status (Needs info -> Received when they answer) and feedback, so a trigger now
--                    holds non-admin updates to exactly that, the same way social_posts is guarded.
--
--   client_credentials  a teammate could not send a login through the secure form: the insert policy
--                    pinned auth.uid() to user_id. Reading stays owner-only, because those are secrets.
--
-- Safe to run more than once. Nothing here touches the service role, which bypasses RLS, so every
-- edge function and the admin page keep working exactly as they do now.

-- ── clients: read only, for the client and their teammates ──
drop policy if exists "Own data only" on public.clients;

drop policy if exists "clients read own row" on public.clients;
create policy "clients read own row"
  on public.clients for select
  using ( auth.uid() = user_id );

-- ── update_requests: keep the policies, add a column guard ──
create or replace function public.guard_client_request_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_admin boolean := coalesce((auth.jwt() ->> 'email') = 'billy@webeaze.io', false);
begin
  -- The service role has no JWT at all, and that is how every edge function and the bot write here.
  if auth.uid() is null or is_admin then
    return new;
  end if;

  -- A client may answer, and answering unblocks the request. Nothing else may move.
  if new.status is distinct from old.status
     and not (old.status = 'Needs info' and new.status = 'Received') then
    raise exception 'Only WebEaze can change the status of a request';
  end if;

  if new.type              is distinct from old.type
     or new.notes          is distinct from old.notes
     or new.resolution     is distinct from old.resolution
     or new.priority       is distinct from old.priority
     or new.hours          is distinct from old.hours
     or new.completed_at   is distinct from old.completed_at
     or new.scheduled_for  is distinct from old.scheduled_for
     or new.user_id        is distinct from old.user_id
     or new.created_at     is distinct from old.created_at then
    raise exception 'That part of a request can only be changed by WebEaze';
  end if;

  return new;
end $$;

drop trigger if exists trg_guard_client_request_update on public.update_requests;
create trigger trg_guard_client_request_update
  before update on public.update_requests
  for each row execute function public.guard_client_request_update();

-- ── client_credentials: a teammate can send one, but still cannot read them ──
do $$
begin
  if to_regprocedure('public.acts_as(uuid)') is not null then
    drop policy if exists "client insert own" on public.client_credentials;
    create policy "client insert own"
      on public.client_credentials for insert
      with check ( public.acts_as(user_id) );
  end if;
end $$;

-- ── Check ──
-- clients should now show SELECT policies only (plus the admin ALL policy):
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public'
   and tablename in ('clients', 'client_credentials')
 order by tablename, cmd, policyname;
