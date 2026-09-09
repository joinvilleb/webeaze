-- Chase an unanswered question, once ────────────────────────────────────────
--
-- When we set a request to "Needs info" the work stops until the client answers. Some never do, and
-- nothing chased them, so the request sat parked and both sides waited: we thought they were getting
-- to it, they had forgotten what we asked.
--
-- lifecycle-emails now sends ONE follow-up three days later, quoting the original question so they do
-- not have to go looking for it. Two columns make that possible and keep it to one email.
--
-- Run once in the Supabase SQL editor, then:  supabase functions deploy lifecycle-emails --no-verify-jwt

alter table public.update_requests
  add column if not exists needs_info_at          timestamptz,
  add column if not exists needs_info_reminded_at timestamptz;

comment on column public.update_requests.needs_info_at is
  'When we last asked this client a question. Set by admin.html saveNeedsInfo. Separate from updated_at, which moves for any edit and would make the follow-up fire off an unrelated change.';
comment on column public.update_requests.needs_info_reminded_at is
  'When the single follow-up was sent. Non-null means never chase this one again.';

-- Anything already parked has no needs_info_at, so it would never be chased. Backfill from updated_at
-- once, which is the closest thing to "when we asked" for rows that predate the column.
update public.update_requests
   set needs_info_at = coalesce(updated_at, created_at)
 where status = 'Needs info'
   and needs_info_message is not null
   and needs_info_at is null;

-- What would go out on the next run:
--   select id, type, needs_info_at, left(needs_info_message, 60) as asked
--     from public.update_requests
--    where status = 'Needs info' and needs_info_message is not null
--      and client_reply is null and needs_info_reminded_at is null
--      and needs_info_at <= now() - interval '3 days';
