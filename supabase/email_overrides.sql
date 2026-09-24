-- Editable email copy (2026-09-24).
--
-- Holds ONLY what Billy has changed. The defaults live in emails/templates.json, deployed with the
-- portal as email-templates.json, so an email nobody has edited has no row here at all and "reset to
-- default" is a delete. Nothing in here can stop an email going out: every function passes its own
-- built-in copy as a last fallback.
--
-- Safe to run more than once.

create table if not exists public.email_overrides (
  key         text primary key,
  subject     text,                      -- null means "use the default subject"
  slots       jsonb not null default '{}'::jsonb,   -- only the slots that were changed
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.email_overrides enable row level security;

-- Admin edits. The functions read with the service role, which bypasses RLS, so they need no policy.
drop policy if exists "email_overrides admin" on public.email_overrides;
create policy "email_overrides admin" on public.email_overrides
  for all using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select, insert, update, delete on public.email_overrides to authenticated;

-- Who changed what, and when, without a second table: a client says "that email reads oddly" and the
-- first question is whether the wording moved.
create or replace function public.email_overrides_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', 'service');
  return new;
end $$;

drop trigger if exists email_overrides_touch on public.email_overrides;
create trigger email_overrides_touch before insert or update on public.email_overrides
  for each row execute function public.email_overrides_touch();

notify pgrst, 'reload schema';

-- Check:
select key, subject, jsonb_object_keys(slots) as changed_slot, updated_at, updated_by
from public.email_overrides order by updated_at desc;
