-- "Needs info" can now ask for a login ───────────────────────────────────────
-- When a request is blocked on a password (an email account, a domain registrar, a booking tool),
-- the admin ticks "Ask for a login, securely" on the Needs info panel. That used to be a paragraph
-- typed by hand telling the client where to find the encrypted form; these two columns turn it into
-- a button, in the email AND on the request in their portal, that opens the form directly.
--
-- Nothing sensitive lives here. The password itself never touches this table: it goes through the
-- portal's end-to-end encrypted form into client_credentials. This is only the ASK.
--
-- Until this runs, the admin still sends the message and the email, and only says the secure-form
-- button could not be attached. Run once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.update_requests
  add column if not exists needs_credentials     boolean not null default false,
  add column if not exists needs_credentials_for text;   -- e.g. 'your email account'. Free text, shown to the client.

comment on column public.update_requests.needs_credentials is
  'The client has been asked to send a login through the encrypted form. Never holds a credential itself.';

notify pgrst, 'reload schema';
