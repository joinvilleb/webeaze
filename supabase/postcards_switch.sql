-- From cold email to postcards (2026-09-22).
--
-- Billy is cancelling the getwebeaze.com mailbox and mailing postcards instead. The prospect SCAN
-- keeps running, because it is what fills the postcard list; drafting and sending stop. Both email
-- functions already refuse to run (they return "switched off" unless OUTREACH_ENABLED='true'), so
-- this file is tidy-up, not the safety net: it removes their daily schedules and points the scan
-- at the four places Billy mails: the City of Miami, Maryland, Pennsylvania and New Jersey.
--
-- Safe to run more than once.

-- 1) Stop scheduling the email stages. The scan keeps its schedule.
do $$
begin
  perform cron.unschedule('outreach-draft-daily') where exists (select 1 from cron.job where jobname = 'outreach-draft-daily');
  perform cron.unschedule('outreach-send-daily')  where exists (select 1 from cron.job where jobname = 'outreach-send-daily');
end $$;

-- 2) Scan only the four regions. Everything else pauses (kept, not deleted, so it can come back).
update public.prospect_targets
   set active = false
 where not (area = 'Miami, FL' or area like '%, MD' or area like '%, PA' or area like '%, NJ');

-- 3) Add Maryland, and widen Pennsylvania and New Jersey beyond the two cities each already had.
--    Same owner-run niches as Miami. New rows have no last_scanned_at, so they scan first.
insert into public.prospect_targets (niche, area)
select n, a
from   unnest(array[
         'landscaping companies','general contractors','remodeling contractors','roofing contractors',
         'gyms','personal trainers','coffee shops','bakeries',
         'hair salons','barbershops','pet grooming','auto detailing'
       ]) as n,
       unnest(array[
         'Baltimore, MD','Annapolis, MD','Silver Spring, MD','Rockville, MD','Frederick, MD','Columbia, MD',
         'Philadelphia, PA','Pittsburgh, PA','Allentown, PA','Harrisburg, PA','Lancaster, PA','Reading, PA',
         'Newark, NJ','Jersey City, NJ','Cherry Hill, NJ','Trenton, NJ','Paterson, NJ','Edison, NJ'
       ]) as a
on conflict (niche, area) do update set active = true;

-- 'Miami, FL' stays on with every niche it already had.
update public.prospect_targets set active = true where area = 'Miami, FL';

-- Check: what the scan now rotates through, and which schedules remain.
select split_part(area, ', ', 2) as state, count(*) filter (where active) as active_targets, count(*) as all_targets
  from public.prospect_targets group by 1 order by 1;
select jobname, schedule from cron.job where jobname like 'outreach%' or jobname like 'prospect%';
