-- A record of every announcement email sent to all clients from the admin.
--
-- Sending to the whole client list is irreversible, so it is worth having a log: what went out, when,
-- who it reached, and how many failed. It also makes an accidental double-send obvious, because the
-- admin shows the last few sends right above the compose box.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.

create table if not exists public.broadcasts (
  id           uuid primary key default gen_random_uuid(),
  subject      text not null,
  body         text not null,          -- the plain text as typed, so it can be reused or corrected
  audience     text not null default 'active',
  sent_count   integer not null default 0,
  failed_count integer not null default 0,
  sent_by      text,
  created_at   timestamptz not null default now()
);

comment on table public.broadcasts is
  'Log of announcement emails sent to clients from the admin (terms changes, portal updates, notices).';

alter table public.broadcasts enable row level security;

-- Admin only, in both directions. Clients have no reason to read these.
drop policy if exists "broadcasts admin only" on public.broadcasts;
create policy "broadcasts admin only"
  on public.broadcasts for all to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select, insert, update, delete on public.broadcasts to authenticated;

notify pgrst, 'reload schema';

-- Check:
--   select created_at, subject, audience, sent_count, failed_count from public.broadcasts order by created_at desc limit 10;
