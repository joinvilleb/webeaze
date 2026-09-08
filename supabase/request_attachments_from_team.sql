-- Images WE attach to a request ─────────────────────────────────────────────
-- request_attachments already carries the files a client sends with their request. This adds one
-- flag so the same table can also hold the ones we send back: a screenshot of the thing we are
-- asking about ("this button here"), or a before/after when the work is done.
--
-- One column rather than a second table, because it is the same object with the same lifecycle and
-- the portal already reads and renders these rows. The flag only decides which side of the
-- conversation an image is shown on, and what it is labelled.
--
-- No storage policy change is needed: admin uploads into its own `<auth.uid()>/...` folder in the
-- existing request-attachments bucket, exactly as a client does into theirs, and the bucket serves
-- public URLs either way.
--
-- Run once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.request_attachments
  add column if not exists from_team boolean not null default false;

comment on column public.request_attachments.from_team is
  'true = WebEaze attached this to explain something (shown in the Needs info / What we did panels). false = the client sent it with their request.';

-- Everything already on file came from a client.
update public.request_attachments set from_team = false where from_team is null;

notify pgrst, 'reload schema';
