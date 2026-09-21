-- Which emails a client gets, controllable from the account panel.
--
-- WHY: today there is one switch, for the daily inquiry summary, and it is at the bottom of the
-- Inquiries page. Exactly ONE account in the whole client base has it on, which is a discovery
-- problem rather than a demand problem. Everything else we send on a schedule (the monthly report,
-- the instant inquiry alert, the follow-up nudges) has no switch at all.
--
-- THE IMPORTANT PART: lead_digest is opt-IN, and a MISSING ROW means OFF. These four are the other
-- way round. They describe emails that go out today, and almost no client has a row at all, so a
-- missing row and a missing column must both read as ON. Every sender gates them as
--     if (pref && pref.x === false) skip
-- never as
--     if (!pref || !pref.x) skip
-- Get that backwards and every client silently stops receiving their monthly report.
--
-- Safe to run more than once. RLS and grants are inherited: the policies in email_prefs.sql are
-- row-level and the grant is table-level, so new columns need no further permissions.

alter table public.email_prefs
  add column if not exists lead_instant  boolean not null default true,
  add column if not exists growth_report boolean not null default true,
  add column if not exists nudges        boolean not null default true,
  add column if not exists request_done  boolean not null default true;

comment on column public.email_prefs.lead_instant  is 'Email the moment an inquiry arrives. Growth/Elite only. Default on.';
comment on column public.email_prefs.growth_report is 'Monthly site report email. Default on.';
comment on column public.email_prefs.nudges        is 'Follow-up reminders about inquiries and unfinished setup. Default on.';
comment on column public.email_prefs.request_done  is 'Email when a request is completed. Default on.';

-- PostgREST caches the schema; without this the portal keeps 400ing on the new columns.
notify pgrst, 'reload schema';

-- Check:
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'email_prefs'
 order by ordinal_position;
