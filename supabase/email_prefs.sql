-- Per-client email preferences, set by the client themselves from the portal ─────────────────
-- Today the only switch is the daily lead digest (the one lead-digest sends each evening). It lives
-- in its own table rather than on `clients` because clients only have READ access to their own
-- clients row (see client_members.sql, mode 'r'); giving them UPDATE there would let them edit their
-- own plan and status. A separate table keeps the writable surface to exactly this one flag.
--
-- Default is ON: a row only appears once someone touches the switch, and no row means opted in, so
-- existing clients keep getting the digest without a backfill.
--
-- Until this runs, the portal simply hides the switch and every client stays subscribed.
-- Run once in the Supabase SQL editor.

create table if not exists public.email_prefs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  lead_digest boolean not null default true,   -- the daily "your website got N leads today" email
  updated_at  timestamptz not null default now()
);

alter table public.email_prefs enable row level security;

-- Access mirrors the other client-scoped tables: the owner and any accepted teammate (public.acts_as)
-- read and write the business's row, and the admin can read everything. acts_as() only exists once
-- client_members.sql has been run, so fall back to a plain owner check when it is missing.
do $$
declare
  owns text := case
    when to_regprocedure('public.acts_as(uuid)') is not null then 'public.acts_as(user_id)'
    else 'auth.uid() = user_id'
  end;
begin
  execute 'drop policy if exists "email_prefs read own or admin" on public.email_prefs';
  execute 'create policy "email_prefs read own or admin" on public.email_prefs for select to authenticated using ('
          || owns || ' or (auth.jwt() ->> ''email'') = ''billy@webeaze.io'')';

  execute 'drop policy if exists "email_prefs insert own" on public.email_prefs';
  execute 'create policy "email_prefs insert own" on public.email_prefs for insert to authenticated with check (' || owns || ')';

  execute 'drop policy if exists "email_prefs update own" on public.email_prefs';
  execute 'create policy "email_prefs update own" on public.email_prefs for update to authenticated using ('
          || owns || ') with check (' || owns || ')';
end $$;

-- Admin (Billy) can also flip it from the SQL editor / admin panel when a client asks by email.
drop policy if exists "email_prefs admin all" on public.email_prefs;
create policy "email_prefs admin all" on public.email_prefs
  for all to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select, insert, update on public.email_prefs to authenticated;

notify pgrst, 'reload schema';

-- ── Handy ───────────────────────────────────────────────────────────────────
-- Who has opted out:
--   select c.name, c.email, p.updated_at from public.email_prefs p
--     join public.clients c on c.user_id = p.user_id where p.lead_digest = false order by p.updated_at desc;
-- Turn it back on for one client (support request):
--   update public.email_prefs set lead_digest = true, updated_at = now() where user_id = '<OWNER_UUID>';
