-- The status-change emails, and why the Needs info one is switched off ───────
--
-- `public.notify_request_done()` is an AFTER UPDATE trigger function on update_requests that was
-- created directly in the SQL editor and never checked into this repo, which is why it took a hunt
-- through pg_trigger to find. It has two branches: one email when a request goes to Done, and one
-- when it goes to Needs info.
--
-- The Needs info branch is now a duplicate. admin.html sends its own version on the same action
-- (emailNeedsInfo), which carries the message with its paragraphs and links intact, and a button
-- straight to the encrypted form when a login is being asked for. Clients were getting both.
--
-- The fix deliberately does NOT rewrite the function. A `create or replace` would have to restate
-- the function's attributes (security definer, search_path, volatility) and getting one wrong is a
-- silent break in the email that still works. A WHEN clause on the trigger reaches the same result
-- by never calling the function for a Needs info change: the dead branch just becomes unreachable.
--
-- Run once in the Supabase SQL editor.

drop trigger if exists on_request_done on public.update_requests;

create trigger on_request_done
  after update on public.update_requests
  for each row
  when (new.status is distinct from old.status and new.status = 'Done')
  execute function public.notify_request_done();

comment on function public.notify_request_done is
  'Emails the client when a request is completed. Its Needs info branch is dead code: the trigger no longer fires for that status because admin.html sends that email itself.';

-- ── Check it ────────────────────────────────────────────────────────────────
-- Confirm the WHEN clause is on:
--   select pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid
--    where c.relname = 'update_requests' and t.tgname = 'on_request_done';
--
-- ── Two things worth fixing in that function separately ─────────────────────
-- 1. It concatenates new.type and new.notes straight into the HTML with no escaping, so a client
--    who writes "price < $500" in their request breaks the layout of the email confirming it.
-- 2. It sends to the auth.users login address only. Every other client email goes to
--    clients.email plus clients.second_email, so a partner CC'd on everything else misses this one.
