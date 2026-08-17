-- WebEaze: give a client a business name ─────────────────────────────────────
-- clients.name is the CONTACT PERSON. The portal greets with it ("Good evening, Mike") and every
-- email opens with its first word, which is correct and should not change. The consequence is that
-- nothing anywhere holds the name of the BUSINESS, so any list of clients reads as a list of people.
--
-- That is fine while one login means one business. It stops being fine the moment someone looks
-- after several, because the account switcher then offers three people's names instead of three
-- businesses.
--
-- The answer already exists in the data: Site setup asks "Business name" and stores it in
-- site_submissions.contact->>'business'. This lifts it onto clients where the rest of the app can
-- reach it, and backfills every client who has already completed setup.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.clients add column if not exists business_name text;

-- Backfill from the setup form. Newest submission per client wins, blanks are ignored, and a
-- business_name that has already been set by hand is never overwritten.
with best as (
  select distinct on (s.user_id)
         s.user_id,
         nullif(btrim(s.contact->>'business'), '') as biz
  from public.site_submissions s
  where nullif(btrim(s.contact->>'business'), '') is not null
  order by s.user_id, s.submitted_at desc nulls last, s.created_at desc nulls last
)
update public.clients c
   set business_name = best.biz
  from best
 where best.user_id = c.user_id
   and nullif(btrim(coalesce(c.business_name, '')), '') is null;

-- What is still missing, so you can fill those in from the admin client editor.
do $$
declare n int;
begin
  select count(*) into n from public.clients
   where nullif(btrim(coalesce(business_name, '')), '') is null
     and coalesce(status, '') <> 'inactive';
  raise notice 'clients still without a business name: % (they fall back to their domain)', n;
end $$;
