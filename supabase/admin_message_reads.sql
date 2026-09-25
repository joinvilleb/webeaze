-- Let admin mark a client conversation as read (2026-09-25).
--
-- The Messages tab decides "waiting on us" from one fact: the newest note in a conversation was
-- written by the client. That is right, and it is also permanent, so a message you have read and
-- dealt with elsewhere (a phone call, a request you filed) sits there looking unanswered for good.
--
-- This records when a conversation was last read. A conversation counts as waiting when the client
-- spoke last AND that message is newer than the read mark, so marking it read clears it now and a
-- NEW message from them raises it again on its own. No unread flag to reset by hand.
--
-- Keyed by the same string the tab groups on (client_id, falling back to user_id), which is text
-- rather than uuid because it can be either.
--
-- Safe to run more than once.

create table if not exists public.admin_message_reads (
  conv_key   text primary key,
  read_at    timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_message_reads enable row level security;

-- Admin only. This is Billy's own reading position, not anything a client should see or set.
drop policy if exists "admin_message_reads admin" on public.admin_message_reads;
create policy "admin_message_reads admin" on public.admin_message_reads
  for all using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');
grant select, insert, update on public.admin_message_reads to authenticated;
