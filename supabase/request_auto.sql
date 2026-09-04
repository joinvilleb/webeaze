-- WebEaze: draft every new request automatically ─────────────────────────────
-- Fires request-draft the moment a client submits, so the AI has read their repo and opened a pull
-- request before anyone looks at the inbox. With autoMerge on for that client, it publishes itself.
--
-- WITHOUT this file the system still works, it just waits for the "Draft with AI" button in admin.
-- This is the piece that makes it hands-off.
--
-- BEFORE RUNNING, be sure you want this. It means an AI reads a client's website and changes it with
-- no human in the loop, minutes after they ask. The safety chain is: the request type gate in
-- request-draft, then the bot's own escalate tool, then a second AI reviewing the diff, and only then
-- a merge, and only for clients with "autoMerge": true in CLIENTS_JSON. Every one of those can be
-- wrong at the same time.
--
-- To turn it off again, keep everything else and just drop the trigger:
--   drop trigger if exists trg_request_autodraft on public.update_requests;
--
-- Requires: CRON_SECRET set on the request-draft function (same value the other cron functions use),
--           and the pg_net extension (the portal already uses it elsewhere).
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

-- Put your real values here before running. The secret is the function's CRON_SECRET, not BOT_SECRET.
--   select set_config('app.settings.fn_base', 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1', false);

create or replace function public.autodraft_request()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $$
declare
  v_url  text := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/request-draft';
  v_sec  text := 'ZZEnhzofKAFFPjIuLf9zicMtqtxM8aCgmufu';
begin
  -- Only the kinds of request the bot can actually action. request-draft checks this again, but
  -- filtering here means we do not make an HTTP call per billing question.
  -- NOT anchored, and it must stay that way. The client-facing option is "Urgent — site down", so an
  -- anchored ^(site down|...) matched nothing and would have handed a live outage to an AI to go and
  -- edit files with. Keep this in step with UNSUITABLE in request-draft/index.ts.
  if new.type is null
     or trim(new.type) ~* '^other$'
     or new.type ~* '(site down|hosting|domain|billing|urgent)'
     or coalesce(length(trim(new.notes)), 0) < 15 then
    return new;
  end if;

  -- Fire and forget. A failure here must never roll back the client's request: they pressed send and
  -- their request is the thing that matters, the draft is a bonus.
  begin
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_sec),
      body    := jsonb_build_object('requestId', new.id)
    );
  exception when others then
    raise warning 'autodraft_request skipped for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists trg_request_autodraft on public.update_requests;
create trigger trg_request_autodraft
  after insert on public.update_requests
  for each row execute function public.autodraft_request();

comment on function public.autodraft_request is
  'Fires request-draft for a newly submitted request so the AI drafts a change without waiting for the admin button. Drop the trigger trg_request_autodraft to disable.';

notify pgrst, 'reload schema';
