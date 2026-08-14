-- FIX: deleting a request in the admin appears to do nothing.
--
-- Cause: public.update_requests has RLS enabled. Reading and marking Done work (those policies
-- exist), but if no policy grants the WebEaze admin account DELETE, the delete matches 0 rows and
-- PostgREST returns SUCCESS WITH NO ERROR. The admin therefore reported "Request deleted." and the
-- row was still there after the refresh. Same failure shape as clients_admin_rls.sql.
--
-- portal/admin.html now calls .delete(...).select('id') and treats "no error, zero rows" as blocked,
-- so after this runs you get an honest result either way.
--
-- Run this ONCE in the Supabase SQL editor while logged into the project. Safe to re-run.

drop policy if exists "admin manages update_requests" on public.update_requests;
create policy "admin manages update_requests"
  on public.update_requests
  for all
  to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

-- Attachments are deleted first by the admin before the request itself. Give the admin account the
-- same full access there, or that pre-delete silently no-ops and leaves orphaned rows behind.
drop policy if exists "admin manages request_attachments" on public.request_attachments;
create policy "admin manages request_attachments"
  on public.request_attachments
  for all
  to authenticated
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

notify pgrst, 'reload schema';

-- Better still, so attachments clean themselves up and the app never has to pre-delete:
--   alter table public.request_attachments
--     drop constraint if exists request_attachments_request_id_fkey,
--     add  constraint request_attachments_request_id_fkey
--       foreign key (request_id) references public.update_requests(id) on delete cascade;
--
-- Sanity checks:
--   Is RLS on?          select relrowsecurity from pg_class where relname = 'update_requests';
--   Which policies?     select policyname, cmd from pg_policies where tablename = 'update_requests';
--   Any DELETE policy?  -- if the cmd column shows no ALL/DELETE row, that was the bug.
