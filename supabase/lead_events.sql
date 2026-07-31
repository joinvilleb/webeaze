-- WebEaze lead tracking ─────────────────────────────────────────────────────
-- Captures real customer actions on a client's website (form submissions,
-- click-to-call, click-to-email) so the portal + monthly email can show
-- "Leads this month". The track.js snippet on each client site posts events to
-- the `track-lead` edge function (service role), which inserts here.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.lead_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- which client (clients.user_id)
  type       text not null check (type in ('form','call','email')),
  page       text,                          -- path the action happened on (no query string)
  created_at timestamptz not null default now()
);

create index if not exists lead_events_user_created_idx
  on public.lead_events (user_id, created_at desc);

alter table public.lead_events enable row level security;

-- Clients read only their own leads; Billy (admin) can read any so the portal preview works.
-- Writes happen only through the service-role edge function, so there is no client insert policy.
drop policy if exists "lead_events read own or admin" on public.lead_events;
create policy "lead_events read own or admin" on public.lead_events
  for select using (
    auth.uid() = user_id
    or (auth.jwt() ->> 'email') = 'billy@webeaze.io'
  );

grant select on public.lead_events to authenticated;
