-- Every email Resend handles for us, recorded per recipient.
--
-- Why: the portal now sends a lot of mail (request confirmations and completions, growth reports,
-- referral emails, lifecycle nudges, announcements). If a client's address is bouncing they receive
-- NONE of it, and today nothing would tell you. Opens are a soft signal, clicks a real one, but the
-- bounce is the one that actually costs you a client.
--
-- Fed by supabase/functions/email-webhook from Resend's webhooks. Shown on the client record in the
-- admin, with a warning when the most recent event for that address is a bounce or complaint.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.

create table if not exists public.email_events (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,                 -- recipient, lower-cased so lookups are predictable
  event       text not null,                 -- sent | delivered | opened | clicked | bounced | complained | delivery_delayed
  subject     text,
  message_id  text,                          -- Resend's email id, so events group into one message
  link        text,                          -- for clicks
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

comment on table public.email_events is
  'Delivery events from Resend, per recipient. Read by the admin client panel; written only by the email-webhook function via the service role.';

create index if not exists email_events_email_idx on public.email_events (lower(email), occurred_at desc);
create index if not exists email_events_msg_idx   on public.email_events (message_id);

-- The same event can be delivered twice by a webhook retry; this makes that harmless.
create unique index if not exists email_events_dedupe_idx
  on public.email_events (message_id, event, occurred_at)
  where message_id is not null;

alter table public.email_events enable row level security;

-- Admin reads. Writes come from the webhook using the service role, which bypasses RLS, so no
-- insert policy is granted to anyone signed in.
drop policy if exists "email events admin read" on public.email_events;
create policy "email events admin read"
  on public.email_events for select to authenticated
  using ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select on public.email_events to authenticated;

notify pgrst, 'reload schema';

-- Check:
--   select email, event, subject, occurred_at from public.email_events order by occurred_at desc limit 20;
--   -- addresses currently failing:
--   select distinct on (lower(email)) email, event, occurred_at
--     from public.email_events order by lower(email), occurred_at desc;
