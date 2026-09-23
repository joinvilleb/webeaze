-- Requests Billy logs on a client's behalf should not get the automated clarifying question.
--
-- WHY: dispatch-request asks one question the moment a request lands, because a client who types
-- "change the photo" benefits from being asked "which page?" straight away rather than a day later.
-- That reasoning does not hold for a request Billy logs himself after a phone call: he already has
-- the answer, and emailing the client "Quick question about your request" about a request THEY never
-- submitted is confusing at best.
--
-- The flag is set by the admin Log a request panel. Everything else about the row is unchanged, so
-- it still flows through dispatch-request, still appears in their history, and is still eligible for
-- the bot and the scheduled sweep. Only the question is skipped.
--
-- Safe to run more than once. No RLS change: this is one more column on a table that already has
-- its policies, and the admin writes it with the same insert it already makes.

alter table public.update_requests
  add column if not exists logged_by_admin boolean not null default false;

comment on column public.update_requests.logged_by_admin is
  'True when WebEaze filed this request for the client (phone call, email, spotted it ourselves). Suppresses the automated clarifying question in dispatch-request. Default false: a request the client submitted.';

-- PostgREST caches the schema; without this the portal keeps 400ing on the new column.
notify pgrst, 'reload schema';

-- Check:
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'update_requests' and column_name = 'logged_by_admin';
