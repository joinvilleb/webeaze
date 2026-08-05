-- FIX: the admin Chat tab shows "No conversations yet" even though clients have been chatting.
--
-- Cause: public.chat_messages has RLS that lets each CLIENT see only their own messages, but there is
-- no policy letting the WebEaze admin account read (or manage) other clients' messages. Eaze replies
-- still work because the chat-assist function writes with the service role (which bypasses RLS), and
-- clients see their own thread, but the admin, reading with Billy's normal login, matches 0 rows. So
-- the thread list is empty and live updates never arrive (Supabase realtime also respects RLS).
-- Mirrors clients_admin_rls.sql / site_submissions_admin_rls.sql.
--
-- Run this ONCE in the Supabase SQL editor while logged into the project.

create policy "admin manages chat_messages"
  on public.chat_messages
  for all
  to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- Confirm the diagnosis first if you like (the SQL editor runs as a superuser, bypassing RLS):
--   Messages really exist:   select count(*), user_id from public.chat_messages group by user_id;
--   Existing policies:        select policyname, cmd from pg_policies where tablename = 'chat_messages';
-- After running, reopen the admin Chat tab: your client conversations should now appear.
--
-- Realtime note: the admin's live updates also need chat_messages in the realtime publication. The
-- client chat already uses realtime, so it is almost certainly enabled; if live updates still lag, check
-- Database > Publications > supabase_realtime includes public.chat_messages.
