-- Temporary support-hours overrides, set from the admin portal.
--
-- The normal schedule (Mon-Fri 9-5 ET) and the holiday closures live in portal/status.js, which means
-- a one-off change (closing early, opening on a Saturday, shutting for a day) needed a code edit and
-- a deploy. This table lets the admin set a dated exception that the portal picks up immediately.
--
-- A row either closes us for a date range, or replaces the open/close hours for it. Whichever row
-- matches the current date wins over the normal schedule; holidays in status.js still apply when no
-- override covers the day.
--
-- Run ONCE in the Supabase SQL editor. Safe to re-run.

create table if not exists public.support_overrides (
  id          uuid primary key default gen_random_uuid(),
  starts_on   date not null,
  ends_on     date not null,
  kind        text not null default 'closed' check (kind in ('closed', 'hours')),
  open_hour   integer check (open_hour  between 0 and 23),
  close_hour  integer check (close_hour between 1 and 24),
  note        text,                      -- shown to clients instead of the default wording
  created_at  timestamptz not null default now(),
  constraint support_overrides_range check (ends_on >= starts_on),
  -- 'hours' rows must actually carry hours, and they have to make sense.
  constraint support_overrides_hours check (
    kind <> 'hours' or (open_hour is not null and close_hour is not null and close_hour > open_hour)
  )
);

comment on table public.support_overrides is
  'Dated exceptions to the normal support hours. Read by every signed-in client, written only by the admin.';

alter table public.support_overrides enable row level security;

-- Everyone signed in can read them: the portal needs them to show the right status.
drop policy if exists "support overrides readable" on public.support_overrides;
create policy "support overrides readable"
  on public.support_overrides for select to authenticated using (true);

-- Only the admin account can create, change or remove one.
drop policy if exists "support overrides admin writes" on public.support_overrides;
create policy "support overrides admin writes"
  on public.support_overrides for all to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select, insert, update, delete on public.support_overrides to authenticated;

create index if not exists support_overrides_range_idx on public.support_overrides (starts_on, ends_on);

notify pgrst, 'reload schema';

-- Examples:
--   Closed all day Friday:
--     insert into public.support_overrides (starts_on, ends_on, kind, note)
--     values ('2026-08-21', '2026-08-21', 'closed', 'Closed today for a team day. Back Monday at 9am ET.');
--   Closing early (9am to 1pm) for a week:
--     insert into public.support_overrides (starts_on, ends_on, kind, open_hour, close_hour, note)
--     values ('2026-08-24', '2026-08-28', 'hours', 9, 13, 'Shorter hours this week, 9am to 1pm ET.');
