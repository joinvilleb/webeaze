-- WebEaze prospecting targets ───────────────────────────────────────────────
-- The list of (niche, area) combos the machine scans to keep the prospect pool full.
-- The `prospect-scan` function's 'scan-targets' mode reads this, scans the oldest-scanned
-- ones each run, and rotates through the whole list over a few days. Add/remove rows anytime.
-- Admin-only; run once in the Supabase SQL editor.
-- Miami / South Florida targets live in supabase/prospect_targets_miami.sql (run that too).

create table if not exists public.prospect_targets (
  id              uuid primary key default gen_random_uuid(),
  niche           text not null,                  -- e.g. 'plumbers', 'HVAC contractors'
  area            text not null,                  -- e.g. 'Wilmington, DE'
  active          boolean not null default true,
  max_pages       smallint not null default 1,    -- 1-3 (20 businesses per page)
  last_scanned_at timestamptz,                     -- oldest gets scanned first
  created_at      timestamptz not null default now(),
  unique (niche, area)
);

create index if not exists prospect_targets_rota_idx on public.prospect_targets (active, last_scanned_at nulls first);

alter table public.prospect_targets enable row level security;
drop policy if exists "prospect_targets admin all" on public.prospect_targets;
create policy "prospect_targets admin all" on public.prospect_targets
  for all
  using      ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');
grant select, insert, update, delete on public.prospect_targets to authenticated;

-- Starter set: 8 independent small-business niches × 8 metros across DE / NJ / PA / NY. These are
-- owner-run local shops (not franchise-heavy trades), so the person you email can actually decide.
insert into public.prospect_targets (niche, area)
select n, a
from   unnest(array['landscaping companies','gyms','bakeries','coffee shops','hair salons','pet grooming','florists','auto detailing']) as n,
       unnest(array[
         'Wilmington, DE','Dover, DE',
         'Cherry Hill, NJ','Newark, NJ',
         'Philadelphia, PA','Lancaster, PA',
         'Brooklyn, NY','Yonkers, NY'
       ]) as a
on conflict (niche, area) do nothing;
