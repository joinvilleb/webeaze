-- Turn off the database's completion email ──────────────────────────────────
--
-- Run this once in the Supabase SQL editor. Until you do, every completed request sends the client
-- TWO emails: the old one from this trigger and the new one from admin.html.
--
-- `public.notify_request_done()` is an AFTER UPDATE trigger function on update_requests, created in
-- the SQL editor and never checked into this repo. It has two branches, Done and Needs info, and
-- admin.html now sends a better email for both:
--
--   Needs info  ->  emailNeedsInfo, which keeps the paragraphs and links of what we actually wrote
--                   and adds a button to the encrypted form when we are asking for a login.
--   Done        ->  emailRequestDone, which carries the resolution in our own words, links every
--                   screenshot we attached, and opens that exact request in their history.
--
-- The trigger email did none of that. It concatenated the raw type and notes with no escaping, so a
-- client who wrote "price < $500" got a broken layout in the mail confirming it, and it went only to
-- the auth login address, so a partner on clients.second_email never saw it.
--
-- Dropping the trigger and keeping the function means nothing is lost. The function stays in the
-- database, so it can be re-attached in one statement if the portal path ever needs to be pulled.
--
-- This supersedes request_status_emails.sql, which narrowed the same trigger to the Done branch
-- only. If that file was never run, skip it: this drops the whole trigger and covers both branches.

drop trigger if exists on_request_done on public.update_requests;

comment on function public.notify_request_done is
  'Detached 2026-09-08. Both of its emails, Done and Needs info, are now sent by admin.html with the '
  'real text, attachments and a deep link. Kept as a fallback: re-attach with an AFTER UPDATE trigger '
  'on update_requests if the portal ever stops sending them.';

-- ── Check it ────────────────────────────────────────────────────────────────
-- Should return no rows:
--   select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
--    where c.relname = 'update_requests' and t.tgname = 'on_request_done';
--
-- The function should still be there:
--   select proname from pg_proc where proname = 'notify_request_done';
