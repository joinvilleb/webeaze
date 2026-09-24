-- Keep the turnaround numbers current without anyone opening the admin.
--
-- THE PROBLEM: the medians, the queue depth and the finish-per-day figure behind every "typically
-- completed in ..." line and every Expected date were computed in ONE place: loadRequests() in
-- admin.html. That runs when Billy opens the admin Requests tab. So the numbers every client sees
-- were as old as his last visit to that tab. A quiet week in the admin and the portal was quoting
-- last week's pace against this week's queue, which is the opposite of "based on current levels".
--
-- RUN supabase/addon_delivery.sql FIRST: this reads update_requests.addon to keep add-ons out of the
-- medians, and will not create the function without that column.
--
-- THE FIX: compute them in the database, and recompute whenever the queue actually changes. A
-- request arriving, being completed, or changing status is exactly when these numbers move, so the
-- trigger fires precisely when the answer is different and never otherwise.
--
-- The shape written here must match what the portal reads (portal/index.html: observedHours,
-- turnaroundMeta, queueHours):
--   { "<request type>": <median hours, integer>, ...,
--     "_meta": { "n": {"<type>": <sample count>}, "open": <int>, "perDay": <number>, "at": <iso> } }
-- _meta rides in the same jsonb because no request type is ever named "_meta".
--
-- This also fixes a quieter bug: the admin computed from allRequests, and PostgREST caps an
-- unbounded select at 1000 rows, so once there were more than 1000 requests the medians were built
-- from an arbitrary slice. SQL has no such cap.
--
-- Safe to run more than once.

create or replace function public.refresh_turnaround_stats()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  medians jsonb;
  counts  jsonb;
  open_now int;
  per_day  numeric;
begin
  -- Median completion hours per type, last 60 days, ignoring junk and backfilled rows. Same window
  -- and same 0 < hrs <= 720 guard the admin used, so the numbers do not jump when this takes over.
  with raw as (
    select type,
           extract(epoch from (completed_at - created_at)) / 3600.0 as hrs
      from public.update_requests
     where completed_at is not null
       and created_at is not null
       and type is not null          -- jsonb_object_agg raises on a null key, and this runs in a trigger
       and addon is null             -- an add-on runs for weeks by design; see addon_delivery.sql
       and created_at > now() - interval '60 days'
  ), done as (
    select type, hrs from raw where hrs > 0 and hrs <= 720
  ), per_type as (
    select type,
           round(percentile_cont(0.5) within group (order by hrs))::int as median_hours,
           count(*)::int as n
      from done
     group by type
  )
  select coalesce(jsonb_object_agg(type, median_hours), '{}'::jsonb),
         coalesce(jsonb_object_agg(type, n), '{}'::jsonb)
    into medians, counts
    from per_type;

  -- The line as it stands right now. Matches the admin's definition of open: not finished, not
  -- waiting on the client, not parked for a future date.
  select count(*)::int into open_now
    from public.update_requests
   where status is distinct from 'Done'
     and status is distinct from 'Needs info'
     and scheduled_for is null
     and addon is null;

  -- How much we actually finish per day, over the last 30.
  select round((count(*)::numeric / 30.0), 1) into per_day
    from public.update_requests
   where completed_at is not null
     and addon is null
     and completed_at > now() - interval '30 days';

  update public.portal_settings
     set turnaround_stats = medians || jsonb_build_object(
           '_meta', jsonb_build_object(
             'n', counts,
             'open', open_now,
             'perDay', per_day,
             'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
           ))
   where id = 'banner';
end;
$fn$;

comment on function public.refresh_turnaround_stats() is
  'Recomputes portal_settings.turnaround_stats (per-type median hours, sample counts, open queue, finished-per-day) from update_requests. Called by the trigger below; safe to call by hand.';

-- Recompute when the queue changes. AFTER, so it sees the committed row. Statement-level: a bulk
-- update touching twenty rows should recompute once, not twenty times.
create or replace function public.trg_refresh_turnaround_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $t$
begin
  -- These numbers are a convenience, not part of the write. If recomputing them ever fails, the
  -- request must still be filed: a client losing what they typed because a median could not be
  -- calculated is far worse than a stale estimate.
  begin
    perform public.refresh_turnaround_stats();
  exception when others then
    raise warning 'refresh_turnaround_stats failed: %', sqlerrm;
  end;
  return null;
end;
$t$;

drop trigger if exists update_requests_refresh_turnaround on public.update_requests;
create trigger update_requests_refresh_turnaround
  after insert or delete or update of status, completed_at, scheduled_for, type
  on public.update_requests
  for each statement
  execute function public.trg_refresh_turnaround_stats();

-- Seed it once so the portal is correct immediately rather than after the next request.
select public.refresh_turnaround_stats();

-- Check: the numbers the portal will quote from now on.
select turnaround_stats from public.portal_settings where id = 'banner';
