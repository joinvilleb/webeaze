-- Lets the WebEaze admin account read/write any client's site_submissions row.
--
-- Needed by "onboarding autopilot": when you create a client in the admin, the browser drafts a starter
-- About + Services (via ai-assist) and saves it as a DRAFT site_submissions row for that new user. Without
-- this policy that write matches 0 rows under RLS (site_submissions is owner-only), so the auto-draft is
-- silently skipped and the client just gets the normal blank setup. Everything else keeps working.
--
-- Mirrors supabase/clients_admin_rls.sql. Run this ONCE in the Supabase SQL editor.

create policy "admin manages site_submissions"
  on public.site_submissions
  for all
  to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- Sanity checks (optional):
--   List policies:  select policyname, cmd from pg_policies where tablename = 'site_submissions';
-- After running, create a test client -> open its setup as that user -> About/Services are pre-filled.
