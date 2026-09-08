-- Daily lead emails become opt-IN ────────────────────────────────────────────
-- They were on unless a client turned them off. Now they are off unless a client turns them on.
--
-- The only thing that changes here is the DEFAULT. What actually flips the behaviour is the reading
-- of a MISSING row, which lives in the lead-digest function: it used to collect the clients who had
-- opted out and skip them; it now collects the ones who have opted in and mails only those. Both
-- halves have to ship together, or a client sees "off" on a switch that is still sending.
--
-- Rows that already exist are left exactly as they are. A row only appears when someone touches the
-- switch, so every one of them is a deliberate choice and none of them should be overwritten by a
-- change of default.
--
-- Expect the send volume to drop to near zero at first: almost nobody has an explicit row, so almost
-- nobody is opted in. That is the intent, but it is worth knowing before you look at the numbers.
--
-- Run once in the Supabase SQL editor.

alter table public.email_prefs alter column lead_digest set default false;

comment on column public.email_prefs.lead_digest is
  'Opt-IN for the daily lead digest. No row at all means OFF: only an explicit true gets the email.';

notify pgrst, 'reload schema';

-- Who is opted in right now:
--   select c.name, c.email from public.email_prefs p
--     join public.clients c on c.user_id = p.user_id where p.lead_digest;
