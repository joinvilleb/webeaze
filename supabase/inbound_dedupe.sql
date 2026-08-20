-- WebEaze: stop an inbound email posting twice ────────────────────────────────
-- The Gmail Apps Script only advances its "last handled" watermark when inbound-note returns a 2xx.
-- That is the right behaviour (a failed post is retried next run), but it means a post that SUCCEEDS
-- and then loses the response, or a run that overlaps the previous one, replays the same email. The
-- script's own comment claims the function dedupes by messageId; it never did.
--
-- Duplicated text was untidy. Now that a client can email PHOTOS in, a replay also re-uploads and
-- re-posts every image, so this needs a real guard.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.client_notes
  add column if not exists source_message_id text;

-- Partial unique index: only inbound rows carry an id, and notes written in the portal stay null.
create unique index if not exists client_notes_source_msg_uidx
  on public.client_notes (source_message_id)
  where source_message_id is not null;

notify pgrst, 'reload schema';
