-- Flag likely spam on a lead, and let a client keep it out of their email ────
--
-- Every contact form on the internet gets cold B2B pitches, SEO spam and outright scams. They land
-- in the owner's lead inbox next to real customers, and in the daily digest email, which is what
-- makes people stop reading the digest.
--
-- Two separate decisions here, deliberately:
--   The BADGE in the portal is always on. The lead is still there, still openable, just dimmed with
--   a reason. Nothing is deleted or hidden, so a wrong guess costs a glance.
--   The EMAIL is opt-in. Silently dropping a lead from a digest is the one place a wrong guess could
--   cost a real job, so a client has to ask for it.
--
-- Run once in the Supabase SQL editor.

alter table public.email_prefs
  add column if not exists digest_skip_spam boolean not null default false;

comment on column public.email_prefs.digest_skip_spam is
  'Opt-in. When true, lead-digest leaves suspected spam out of the daily email. The lead is still recorded and still shown in the portal, flagged.';

-- Optional. The portal scores leads as it renders them, so this is not needed for the badge to work,
-- and old leads get scored the same as new ones. It exists so a future server-side scorer can record
-- its verdict once rather than every client recomputing it.
alter table public.lead_events
  add column if not exists spam_score int;

comment on column public.lead_events.spam_score is
  'Optional cached spam score. Null means never scored server-side; the portal scores on read either way.';

-- Who has opted in:
--   select user_id, lead_digest, digest_skip_spam from public.email_prefs where digest_skip_spam;
