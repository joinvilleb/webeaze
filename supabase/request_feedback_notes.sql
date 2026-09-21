-- What clients say when they rate a finished request, and when they said it.
--
-- WHY: the thumbs on a finished request stored 'up' or 'down' and nothing else. No words, so a
-- thumbs-down told us something went wrong but never what, and no date, so there was no way to see
-- whether anyone uses it or whether it is getting better or worse. The portal now asks one optional
-- question after a rating, and admin Insights reads both columns back.
--
-- feedback_note  what they typed after rating. Optional; most people will not bother.
-- feedback_at    stamped HERE, by the trigger, whenever the rating or the note changes. Not written
--                by the browser, so a client cannot backdate it.
--
-- Clients can already write `feedback` on their own requests. guard_client_request_update
-- (rls_tighten.sql) is a list of the columns they may NOT touch, so these two are writable by the
-- owner without changing it, which is what we want: they are the client's own words.
--
-- Safe to run more than once.

alter table public.update_requests
  add column if not exists feedback_note text,
  add column if not exists feedback_at   timestamptz;

-- A paragraph, not an essay pasted in by accident or a script.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'update_requests_feedback_note_len') then
    alter table public.update_requests
      add constraint update_requests_feedback_note_len
      check (feedback_note is null or char_length(feedback_note) <= 2000);
  end if;
end $$;

create or replace function public.stamp_request_feedback()
returns trigger
language plpgsql
as $$
begin
  if new.feedback is distinct from old.feedback or new.feedback_note is distinct from old.feedback_note then
    new.feedback_at := case when new.feedback is null and new.feedback_note is null then null else now() end;
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_request_feedback on public.update_requests;
create trigger trg_stamp_request_feedback
  before update on public.update_requests
  for each row execute function public.stamp_request_feedback();

-- Ratings given before this existed have no date. The day the work was finished is the closest
-- honest guess (the ask shows right after completion), and Insights labels it as the completed date.
update public.update_requests
   set feedback_at = coalesce(completed_at, updated_at, created_at)
 where feedback is not null and feedback_at is null;

notify pgrst, 'reload schema';

-- Check:
select count(*) filter (where feedback is not null)            as rated,
       count(*) filter (where feedback = 'up')                 as up,
       count(*) filter (where feedback = 'down')               as down,
       count(*) filter (where feedback_note is not null)       as with_note
  from public.update_requests;
