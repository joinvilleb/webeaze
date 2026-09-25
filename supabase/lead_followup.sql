-- One nudge per uncontacted inquiry.
--
-- WHY: the lead inbox only pays for itself if someone actually rings these people back. Two days
-- after an inquiry arrives with no contact recorded, the client gets one email listing who is still
-- waiting. This column is what stops that becoming a daily drip: non-null means never nudge that
-- lead again, exactly like update_requests.needs_info_reminded_at.
--
-- Read by: supabase/functions/lifecycle-emails/index.ts (block 6). Without this column the block
-- logs a warning and skips, so running it is what turns the chase on.
--
-- Safe to run more than once.

alter table public.lead_events
  add column if not exists lead_nudged_at timestamptz;

-- The daily job filters on these three, so give it an index rather than a full scan per run.
create index if not exists lead_events_followup_idx
  on public.lead_events (user_id, created_at)
  where contacted_at is null and outcome is null and lead_nudged_at is null;

-- Nothing that arrived before today gets chased: switching this on should not fire off a pile of
-- emails about inquiries that were dealt with by phone months ago.
update public.lead_events
   set lead_nudged_at = now()
 where lead_nudged_at is null
   and contacted_at is null
   and created_at < now() - interval '2 days';

-- What would go out on the next run (should be empty right after the backfill above):
select c.name, count(*) as waiting, min(l.created_at) as oldest
  from public.lead_events l
  join public.clients c on c.user_id = l.user_id
 where l.contacted_at is null
   and l.outcome is null
   and l.lead_nudged_at is null
   and l.type <> 'order'
   and l.created_at <= now() - interval '2 days'
   and c.status = 'active'
 group by c.name
 order by oldest;
