-- When did anything last HAPPEN on a request? ────────────────────────────────
-- The portal home shows one "Latest request" card. It picked the most recently CREATED request, which
-- is not what anybody means by latest: a request filed in June that moved to In progress this morning
-- is the one the client wants to see, and it sat buried under two newer requests that had not moved in
-- weeks. Nothing on the row recorded activity, so there was nothing better to sort by.
--
-- This adds updated_at and a trigger that stamps it whenever the request actually changes state. The
-- WHEN list is deliberate: a status change, a resolution, an ask for more info, the client's reply, or
-- completion all count as activity. Bookkeeping writes (feedback, clearing scheduled_for, AI metadata)
-- do not, so a thumbs-up on a finished job cannot shove itself back to the top of the client's page.
--
-- Backfill uses the best evidence already on the row, so existing requests keep their real order
-- instead of all looking like they changed the moment this ran.
--
-- Until this runs the portal falls back to completed_at, then created_at, so nothing breaks.
-- Run once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.update_requests add column if not exists updated_at timestamptz;

update public.update_requests
   set updated_at = coalesce(completed_at, created_at)
 where updated_at is null;

alter table public.update_requests alter column updated_at set default now();

create or replace function public.touch_update_request()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_update_requests_touch on public.update_requests;
create trigger trg_update_requests_touch
  before update on public.update_requests
  for each row
  when (
       old.status              is distinct from new.status
    or old.resolution          is distinct from new.resolution
    or old.needs_info_message  is distinct from new.needs_info_message
    or old.client_reply        is distinct from new.client_reply
    or old.completed_at        is distinct from new.completed_at
  )
  execute function public.touch_update_request();

comment on column public.update_requests.updated_at is
  'Last time this request actually moved (status, resolution, needs-info ask, client reply, completion). Sorted on by the portal home "Latest request" card.';

notify pgrst, 'reload schema';

-- ── Check it ────────────────────────────────────────────────────────────────
-- What the home card will now show for each client, newest activity first:
--   select c.name, r.type, r.status, r.created_at, r.updated_at
--     from public.update_requests r join public.clients c on c.user_id = r.user_id
--    order by r.updated_at desc nulls last limit 20;
