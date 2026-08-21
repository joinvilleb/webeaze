-- WebEaze prospecting engine ────────────────────────────────────────────────
-- The top of the lead-acquisition machine. The `prospect-scan` edge function
-- searches Google Places by niche + area, scores each business by "how much they
-- need us" (no website, slow site, thin reviews...), and upserts them here for
-- outreach. This is internal sales data — admin (Billy) only; every write goes
-- through the service role, so there is no public insert path.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.prospects (
  id            uuid primary key default gen_random_uuid(),
  place_id      text unique not null,           -- Google Place ID (dedupe key across re-scans)
  name          text not null,
  category      text,                           -- human trade label (Places primaryTypeDisplayName)
  primary_type  text,                           -- Google primaryType, e.g. 'plumber'
  address       text,
  lat           double precision,
  lng           double precision,
  phone         text,
  website       text,                           -- null = no website (a strong buy signal)
  email         text,                           -- filled later if/when we find one
  rating        numeric(2,1),
  review_count  integer,
  speed_mobile  integer,                        -- PageSpeed mobile 0-100 (null until enriched)
  score         integer not null default 0,     -- 0-100 "needs us" probability
  score_reasons text[]  not null default '{}',  -- why it scored that way (for the admin list)
  area          text,                           -- the search area label used to find it
  niche         text,                           -- the search niche label used to find it
  status        text    not null default 'new'
                check (status in ('new','queued','drafted','sent','replied','won','lost','skipped','bounced')),
  channel       text    not null default 'email'
                check (channel in ('email','call')),   -- 'call' when no email could be found
  outreach      jsonb,                          -- drafted sequence { subject, body, followups[], model, generatedAt }
  proposal_url  text,                           -- set once a proposal is generated
  user_id       uuid,                           -- set once they convert to a client (clients.user_id)
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Idempotent adds, so re-running (or an already-created table) picks up the outreach columns.
--
-- These matter more than they look. `create table if not exists` above does NOTHING when the table
-- already exists, so a table created by an earlier version of this file is missing every column added
-- since. outreach-draft selects score_reasons and speed_mobile, and a missing column there is a
-- PostgREST error, which the function turns into a 500, which the admin UI showed as the useless
-- "Edge Function returned a non-2xx status code". So every column the code touches gets an explicit
-- add here, not just the newest ones.
alter table public.prospects add column if not exists primary_type text;
alter table public.prospects add column if not exists email        text;
alter table public.prospects add column if not exists speed_mobile integer;
alter table public.prospects add column if not exists score_reasons text[] not null default '{}';
alter table public.prospects add column if not exists area         text;
alter table public.prospects add column if not exists niche        text;
alter table public.prospects add column if not exists proposal_url text;
alter table public.prospects add column if not exists user_id      uuid;
alter table public.prospects add column if not exists notes        text;
alter table public.prospects add column if not exists channel      text not null default 'email';
alter table public.prospects add column if not exists outreach     jsonb;
alter table public.prospects add column if not exists sent_step    smallint not null default 0;   -- 0 none, 1 first sent, 2 fu1 sent, 3 done
alter table public.prospects add column if not exists last_sent_at timestamptz;                    -- when the last step went out (for follow-up timing)
alter table public.prospects drop constraint if exists prospects_channel_check;
alter table public.prospects add constraint prospects_channel_check check (channel in ('email','call'));
alter table public.prospects drop constraint if exists prospects_status_check;
alter table public.prospects add constraint prospects_status_check
  check (status in ('new','queued','drafted','sent','replied','won','lost','skipped','bounced'));

create index if not exists prospects_score_idx      on public.prospects (score desc, review_count desc nulls last);
create index if not exists prospects_status_idx     on public.prospects (status);
create index if not exists prospects_area_niche_idx on public.prospects (area, niche);

alter table public.prospects enable row level security;

-- Admin-only. Prospects are our private outreach pipeline, never exposed to clients.
-- Writes still flow through the service-role function; this policy lets Billy read/manage
-- the pipeline from an authenticated admin session (e.g. a portal admin view).
drop policy if exists "prospects admin all" on public.prospects;
create policy "prospects admin all" on public.prospects
  for all
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select, insert, update, delete on public.prospects to authenticated;
