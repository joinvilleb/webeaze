-- Postcard / QR scan tracking. Each scan of a printed QR hits the scan-track function, which logs a
-- row here (which campaign, when, rough country + device) and redirects the prospect onward. Lets Billy
-- see which mailings actually get scanned. Writes are service-role (the function); only Billy reads.
-- Run once in the Supabase SQL editor.

create table if not exists public.scan_events (
  id          bigint generated always as identity primary key,
  campaign    text not null default 'postcard',
  country     text,
  ip          text,
  user_agent  text,
  referer     text,
  dest        text,
  created_at  timestamptz not null default now()
);

alter table public.scan_events enable row level security;

drop policy if exists "scan_events admin read" on public.scan_events;
create policy "scan_events admin read" on public.scan_events
  for select using ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

create index if not exists scan_events_campaign_idx on public.scan_events (campaign, created_at desc);
