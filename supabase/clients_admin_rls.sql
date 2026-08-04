-- FIX: admin edits to clients silently fail ("update matched 0 rows / likely an RLS rule").
--
-- Cause: public.clients has RLS enabled with client-owns-their-row policies, but NO policy lets the
-- WebEaze admin account update other clients' rows. Reads work (a read policy exists) and creating
-- clients works (that path uses the service role), so only EDITING a client fails, matching 0 rows.
-- Every other admin table (lead_events, portal_updates, growth_report...) already has this policy.
--
-- Run this ONCE in the Supabase SQL editor while logged into the project.

-- Full admin access (select/insert/update/delete) to the WebEaze admin account, matching the same
-- email check used across the other tables. auth.jwt() ->> 'email' is the logged-in user's email.
create policy "admin manages clients"
  on public.clients
  for all
  to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- Sanity checks (optional):
--   Confirm RLS is on:            select relrowsecurity from pg_class where relname = 'clients';
--   List clients policies:        select policyname, cmd from pg_policies where tablename = 'clients';
-- After running, re-open a client in the admin, change a field, Save -> it should say "Client updated."
