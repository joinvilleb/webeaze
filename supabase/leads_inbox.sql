-- Lead inbox (Growth/Elite): capture the details of a form-submitted lead so the owner can follow up,
-- and let the client mark a lead as contacted. Detail capture is gated to Growth/Elite in the
-- track-lead function; these columns just hold what it captures. Safe to run repeatedly.

alter table public.lead_events
  add column if not exists name         text,
  add column if not exists email        text,
  add column if not exists phone        text,
  add column if not exists message      text,
  add column if not exists contacted_at timestamptz;

-- Clients can flip their own leads to "contacted". The column-level grant means they can ONLY touch
-- contacted_at (never the captured name/email/etc.), and RLS still scopes it to their own rows.
drop policy if exists "lead_events update own" on public.lead_events;
create policy "lead_events update own" on public.lead_events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant update (contacted_at) on public.lead_events to authenticated;

notify pgrst, 'reload schema';
