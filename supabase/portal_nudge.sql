-- Dedupe column for the "you have never opened your portal" nudge.
--
-- A client gets a portal invite when their account is created, but nothing follows up if they never
-- sign in. That is the single most valuable nudge we can send: everything we build for them lives
-- behind that login, and a client who has never seen it cannot get any value from the plan.
--
-- Matches the existing lifecycle columns (onboarding_nudge_at, review_nudge_at): a timestamp means
-- handled, so the daily job never sends twice.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.

alter table public.clients
  add column if not exists portal_nudge_at timestamptz;   -- never-logged-in nudge sent (or skipped)

comment on column public.clients.portal_nudge_at is
  'When the "you have not opened your portal yet" email was sent, or when the check was skipped because they had already signed in. Null means still eligible.';

notify pgrst, 'reload schema';

-- Check who is currently eligible (created 3 to 30 days ago, active, never nudged):
--   select c.name, c.email, c.created_at
--   from public.clients c
--   where c.status <> 'inactive' and c.portal_nudge_at is null
--     and c.created_at between now() - interval '30 days' and now() - interval '3 days';
