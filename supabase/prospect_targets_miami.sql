-- WebEaze prospecting targets — MIAMI / SOUTH FLORIDA ────────────────────────
-- Adds the Miami metro to the (niche x area) rotation the outreach machine scans.
-- Companion to supabase/prospect_targets.sql (the original DE/NJ/PA/NY starter set);
-- this file only INSERTS, so the northeast targets keep running unless you turn them
-- off with the optional block at the bottom.
--
-- New rows have a NULL last_scanned_at, and `scan-targets` scans oldest-first (nulls first),
-- so every Miami target gets scanned before any northeast target is re-scanned.
-- Run once in the Supabase SQL editor (admin only).

-- 1) Core niches x core Miami-Dade areas ─────────────────────────────────────
-- Owner-run trades and storefronts: the person reading the email can say yes.
insert into public.prospect_targets (niche, area)
select n, a
from   unnest(array[
         'landscaping companies','general contractors','remodeling contractors','roofing contractors',
         'gyms','personal trainers','coffee shops','bakeries',
         'hair salons','barbershops','pet grooming','auto detailing'
       ]) as n,
       unnest(array[
         'Miami, FL','Miami Beach, FL','Coral Gables, FL','Hialeah, FL',
         'Doral, FL','Kendall, FL','North Miami, FL','Aventura, FL'
       ]) as a
on conflict (niche, area) do nothing;

-- 2) South-Florida-specific niches x the densest areas ───────────────────────
-- Pools, AC and pressure washing are year-round money down here; the studio/beauty
-- niches are dense in Miami Beach and the Gables.
insert into public.prospect_targets (niche, area)
select n, a
from   unnest(array[
         'pool cleaning services','air conditioning repair','pressure washing services','handyman services',
         'house cleaning services','moving companies','yoga studios','pilates studios',
         'med spas','nail salons','boat detailing','event planners'
       ]) as n,
       unnest(array[
         'Miami, FL','Miami Beach, FL','Coral Gables, FL','Hialeah, FL'
       ]) as a
on conflict (niche, area) do nothing;

-- 3) High-intent niches x the outer ring (south Miami-Dade + near Broward) ───
insert into public.prospect_targets (niche, area)
select n, a
from   unnest(array[
         'landscaping companies','general contractors','roofing contractors','pool cleaning services',
         'air conditioning repair','gyms','coffee shops','hair salons'
       ]) as n,
       unnest(array[
         'Fort Lauderdale, FL','Hollywood, FL','Pembroke Pines, FL','Homestead, FL'
       ]) as a
on conflict (niche, area) do nothing;

-- Go two pages deep (40 results) on "Miami, FL" itself — it is the densest area by far.
update public.prospect_targets set max_pages = 2 where area = 'Miami, FL';

-- ── Optional: pause the northeast and run Miami only ────────────────────────
-- Uncomment if you want the machine emailing South Florida exclusively.
-- update public.prospect_targets set active = false
--  where area like '%, DE' or area like '%, NJ' or area like '%, PA' or area like '%, NY';
-- To bring them back:  update public.prospect_targets set active = true where area not like '%, FL';

-- ── Check what you just added ───────────────────────────────────────────────
-- select split_part(area, ', ', 2) as state, count(*) filter (where active) as active_targets
--   from public.prospect_targets group by 1 order by 2 desc;
