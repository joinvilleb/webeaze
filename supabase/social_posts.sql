-- Social media management: the shared plan a client approves ─────────────────
-- The new service is us running a client's Instagram/Facebook. This is deliberately NOT a publisher:
-- posting stays manual while the service is being tested, because a Meta API integration is weeks of
-- review for something we are still deciding we want. What it IS is the part clients actually care
-- about and the part that is painful over email, which is seeing next month's posts and approving them.
--
-- Flow:  draft (ours only)  ->  pending (they can see it)  ->  approved | changes  ->  posted
--
-- A 'draft' row is invisible to the client by RLS, so a half-written month is never on their screen.
-- Run once in the Supabase SQL editor. Safe to run repeatedly.

create table if not exists public.social_posts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,                       -- clients.user_id, the owner key every client table uses
  client_id     uuid,
  month         text not null,                       -- 'YYYY-MM', the batch this belongs to
  platform      text not null default 'both',        -- instagram | facebook | both
  caption       text not null default '',
  image_url     text,
  scheduled_for date,
  status        text not null default 'draft'
                check (status in ('draft', 'pending', 'approved', 'changes', 'posted')),
  client_note   text,                                -- what they want changed, in their words
  sort          smallint not null default 0,
  posted_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists social_posts_user_month_idx on public.social_posts (user_id, month, sort);

alter table public.social_posts enable row level security;

-- Admin runs the whole thing.
drop policy if exists "social_posts admin all" on public.social_posts;
create policy "social_posts admin all" on public.social_posts
  for all to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- The client (and their accepted teammates) see everything except our drafts, and can update a row
-- to approve it or ask for a change. acts_as() only exists once client_members.sql has been run.
do $$
declare
  owns text := case
    when to_regprocedure('public.acts_as(uuid)') is not null then 'public.acts_as(user_id)'
    else 'auth.uid() = user_id'
  end;
begin
  execute 'drop policy if exists "social_posts read own" on public.social_posts';
  execute 'create policy "social_posts read own" on public.social_posts for select to authenticated using ('
          || owns || ' and status <> ''draft'')';
  execute 'drop policy if exists "social_posts update own" on public.social_posts';
  execute 'create policy "social_posts update own" on public.social_posts for update to authenticated using ('
          || owns || ' and status <> ''draft'') with check (' || owns || ')';
end $$;

-- RLS can say WHICH rows a client may update, not WHICH COLUMNS. A column-level GRANT cannot help
-- either: admin and clients are both the `authenticated` role, so restricting columns would break
-- our own editing. A trigger is the only place this rule can actually live.
create or replace function public.social_posts_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'email') = 'billy@webeaze.io' then
    new.updated_at := now();
    return new;
  end if;
  if new.caption       is distinct from old.caption
     or new.image_url     is distinct from old.image_url
     or new.platform      is distinct from old.platform
     or new.month         is distinct from old.month
     or new.scheduled_for is distinct from old.scheduled_for
     or new.user_id       is distinct from old.user_id
     or new.posted_at     is distinct from old.posted_at then
    raise exception 'Only the approval status and your note can be changed here.';
  end if;
  if new.status not in ('approved', 'changes') then
    raise exception 'That is not a status you can set.';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_social_posts_guard on public.social_posts;
create trigger trg_social_posts_guard
  before update on public.social_posts
  for each row execute function public.social_posts_guard();

grant select, update on public.social_posts to authenticated;
grant insert, delete on public.social_posts to authenticated;   -- RLS restricts these to the admin

notify pgrst, 'reload schema';

-- ── Handy ───────────────────────────────────────────────────────────────────
-- This month's board for one client:
--   select month, platform, status, scheduled_for, left(caption, 60) from public.social_posts
--    where user_id = '<OWNER_UUID>' order by month desc, sort;
-- Anything waiting on a client right now:
--   select c.name, count(*) from public.social_posts s join public.clients c on c.user_id = s.user_id
--    where s.status = 'pending' group by 1;
