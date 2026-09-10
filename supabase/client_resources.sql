-- The client's own reference shelf ──────────────────────────────────────────
--
-- Everything about a client's business that is not a request and not a password: the Drive folder
-- with their photos, the current menu PDF, their Google Business listing, the Facebook page, the
-- booking system they use, the note about which gate code the crew needs.
--
-- Why it did not exist and had to: that material arrived in emails, in request notes, and in one-off
-- messages, so completing a request meant going and finding it again. The setup form captures this
-- ONCE, at onboarding, as a brief for building the site. This is the living version: a shelf both
-- sides can add to for as long as they are a client.
--
-- Both sides write to it. The client adds theirs on their Business info page; we add ours from the
-- client record in the admin. `added_by` records which, so nobody is surprised by a row appearing.
--
-- Not for credentials. Logins go through the encrypted secure-credential form, which is end to end
-- encrypted and deleted after use; this table is plain text that both sides read.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.client_resources (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                     -- the account owner, the same key every client table uses
  label      text not null,                     -- "Photos from the March job", "Our menu"
  url        text,                              -- a link they pasted, or the public URL of a file they sent
  note       text,                              -- what it is for. A row can be note-only: not everything is a link
  file_name  text,                              -- set when the row is a file we hold rather than a link they own
  added_by   text not null default 'client',    -- client | team
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A label alone says nothing. Every row has to carry something to open or something to read.
  constraint client_resources_has_content
    check (coalesce(url, '') <> '' or coalesce(note, '') <> '')
);

create index if not exists client_resources_user_idx on public.client_resources (user_id, created_at desc);

comment on table public.client_resources is
  'Links, files and notes about a client''s business, added by them or by us, used when completing their requests. Never credentials.';

-- Keep updated_at honest, so the admin can tell a shelf that is maintained from one that is stale.
create or replace function public.touch_client_resource()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_client_resources_touch on public.client_resources;
create trigger trg_client_resources_touch
  before update on public.client_resources
  for each row execute function public.touch_client_resource();

alter table public.client_resources enable row level security;

drop policy if exists "admin manages resources" on public.client_resources;
create policy "admin manages resources" on public.client_resources
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- The client's own policies. A teammate on client_members is the same person for this purpose: they
-- are the ones who have the folder link. acts_as() covers owner AND teammate in one call, so use it
-- where it exists and fall back to the plain owner check where client_members.sql has not been run.
do $mig$
declare
  chk text := case when to_regprocedure('public.acts_as(uuid)') is null
                   then 'user_id = auth.uid()'
                   else 'public.acts_as(user_id)' end;
begin
  execute 'drop policy if exists "client reads own resources" on public.client_resources';
  execute 'create policy "client reads own resources" on public.client_resources for select to authenticated using (' || chk || ')';
  execute 'drop policy if exists "client adds own resources" on public.client_resources';
  execute 'create policy "client adds own resources" on public.client_resources for insert to authenticated with check (' || chk || ')';
  execute 'drop policy if exists "client edits own resources" on public.client_resources';
  execute 'create policy "client edits own resources" on public.client_resources for update to authenticated using (' || chk || ') with check (' || chk || ')';
  -- Delete included deliberately. It is their shelf: a dead link they cannot remove is worse than
  -- no shelf, and nothing here is a record we need to keep.
  execute 'drop policy if exists "client removes own resources" on public.client_resources';
  execute 'create policy "client removes own resources" on public.client_resources for delete to authenticated using (' || chk || ')';
end
$mig$;

grant select, insert, update, delete on public.client_resources to authenticated;

notify pgrst, 'reload schema';

-- ── Check it ────────────────────────────────────────────────────────────────
--   select c.name, r.label, r.url, r.added_by
--     from public.client_resources r
--     left join public.clients c on c.user_id = r.user_id
--    order by r.created_at desc;
