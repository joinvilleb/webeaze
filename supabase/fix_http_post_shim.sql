-- FIX: admin can't save clients (and marking requests done / referral updates fail) with
--   42883  function extensions.http_post(url => text, body => jsonb) does not exist
--
-- Cause: several triggers were written to call extensions.http_post(), but pg_net now installs
-- http_post in the `net` schema (confirmed: select ... from pg_proc -> schema = net). A trigger that
-- calls a missing function throws, and because these are AFTER triggers in the same transaction, the
-- write they fired on is rolled back. on_site_launched fires on EVERY client save (the admin panel
-- always writes site_url), which is why no client edit ever saves.
--
-- Rather than rewrite each trigger, add a compatibility shim at the old path that forwards to the real
-- function. One statement fixes on_site_launched, on_request_done, on_referral_status, and any webhook
-- still calling the old path. It is not reachable from the REST API (only `public` functions are), so
-- it only ever runs inside these triggers.
--
-- Run once in the Supabase SQL editor.

create or replace function extensions.http_post(
  url                  text,
  body                 jsonb   default '{}'::jsonb,
  params               jsonb   default '{}'::jsonb,
  headers              jsonb   default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language sql
security definer
set search_path = net, public
as $$
  select net.http_post(
    url := url, body := body, params := params,
    headers := headers, timeout_milliseconds := timeout_milliseconds
  );
$$;

grant execute on function extensions.http_post(text, jsonb, jsonb, jsonb, integer)
  to authenticated, service_role, anon;

-- After running: re-open a client, change the plan amount, Save -> "Client updated."
