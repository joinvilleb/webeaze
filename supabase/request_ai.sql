-- WebEaze: record what the AI did with a request ──────────────────────────────
-- The "Draft with AI" button in admin sends one request to the webeaze-request-bot, which opens a
-- pull request on the client's repo. These columns hold the outcome so the card still shows it after
-- a reload, and so a second click does not silently re-run a draft that already exists.
--
-- Nothing here goes live on a client site. A pull request waits for a human to merge it.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.update_requests
  add column if not exists ai_status text,      -- drafted | escalated | merged | no-change | failed | reverted
  add column if not exists ai_reason text,      -- why it escalated or failed, in the bot's words
  add column if not exists ai_pr_url text,      -- the pull request to review
  add column if not exists ai_at timestamptz;   -- when it last ran

comment on column public.update_requests.ai_status is
  'Outcome of the last AI drafting run. "drafted" means a pull request is open and waiting for review; it is NOT live.';

-- Only a handful of requests will ever have been through the bot, so index just those.
create index if not exists update_requests_ai_at_idx
  on public.update_requests (ai_at desc)
  where ai_at is not null;

notify pgrst, 'reload schema';
