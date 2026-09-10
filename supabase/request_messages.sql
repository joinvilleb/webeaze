-- A request is a conversation, not two boxes ────────────────────────────────
--
-- Until now one request held exactly one question from us (update_requests.needs_info_message) and
-- exactly one answer from them (client_reply). Asking a second question overwrote the first, so the
-- thread that led to the work was destroyed by the act of continuing it, and the client's reply box
-- disappeared the moment they used it. This table is the thread.
--
-- The two old columns are KEPT and still written, always holding the most recent message of each
-- kind. Everything else in the system reads them: the three-day chase in the lifecycle-emails
-- function tests `client_reply is null`, the portal's "we need more info" panel reads
-- needs_info_message, and the request card badges off status. Making this table the only truth would
-- have meant rewriting all of that at the same time; making it additive means the thread is a pure
-- gain and nothing downstream had to move.
--
-- Run once in the Supabase SQL editor. Safe to re-run: the backfill will not duplicate.

create table if not exists public.request_messages (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.update_requests(id) on delete cascade,
  user_id    uuid not null,                   -- the client account, so RLS matches every other table
  sender     text not null check (sender in ('team', 'client')),
  body       text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists request_messages_req_idx on public.request_messages (request_id, created_at);
create index if not exists request_messages_user_idx on public.request_messages (user_id, created_at desc);

comment on table public.request_messages is
  'The back and forth on one request. update_requests.needs_info_message and .client_reply still hold the latest of each and are what the follow-up cron reads.';

-- ── Backfill, so no existing conversation starts empty ──────────────────────
-- The ask first, then the reply. A request whose needs_info_at was never stamped falls back to
-- updated_at for both, which would leave the two rows tied and orderable either way; pushing the
-- reply one second past the ask keeps every thread in the order it actually happened.
insert into public.request_messages (request_id, user_id, sender, body, created_at)
select r.id, r.user_id, 'team', r.needs_info_message,
       coalesce(r.needs_info_at, r.updated_at, r.created_at)
  from public.update_requests r
 where coalesce(r.needs_info_message, '') <> ''
   and not exists (select 1 from public.request_messages m where m.request_id = r.id and m.sender = 'team');

insert into public.request_messages (request_id, user_id, sender, body, created_at)
select r.id, r.user_id, 'client', r.client_reply,
       greatest(coalesce(r.updated_at, r.created_at),
                coalesce(r.needs_info_at, r.created_at) + interval '1 second')
  from public.update_requests r
 where coalesce(r.client_reply, '') <> ''
   and not exists (select 1 from public.request_messages m where m.request_id = r.id and m.sender = 'client');

alter table public.request_messages enable row level security;

drop policy if exists "admin manages request messages" on public.request_messages;
create policy "admin manages request messages" on public.request_messages
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- The client and their teammates read the whole thread and add to it. No update and no delete on
-- purpose: a thread is the record of what was asked and answered, and a request gets worked from it.
do $mig$
declare
  chk text := case when to_regprocedure('public.acts_as(uuid)') is null
                   then 'user_id = auth.uid()'
                   else 'public.acts_as(user_id)' end;
begin
  execute 'drop policy if exists "client reads own request messages" on public.request_messages';
  execute 'create policy "client reads own request messages" on public.request_messages for select to authenticated using (' || chk || ')';
  execute 'drop policy if exists "client writes own request messages" on public.request_messages';
  execute 'create policy "client writes own request messages" on public.request_messages for insert to authenticated with check ((' || chk || ') and sender = ''client'')';
end
$mig$;

grant select, insert on public.request_messages to authenticated;

notify pgrst, 'reload schema';

-- ── Check it ────────────────────────────────────────────────────────────────
--   select r.type, m.sender, left(m.body, 50) as said, m.created_at
--     from public.request_messages m
--     join public.update_requests r on r.id = m.request_id
--    order by m.request_id, m.created_at;
