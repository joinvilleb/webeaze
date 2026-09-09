-- Company updates in What's New ─────────────────────────────────────────────
--
-- portal_updates was built as a portal CHANGELOG: "New", "Improved", "Fixed". News about the company
-- itself, an annual review, a price change, holiday cover, was landing in that same list under the
-- heading "New in your portal", which reads as though a feature shipped.
--
-- One column splits them. 'product' keeps the existing behaviour, so every row already posted stays
-- exactly where it is.
--
-- Run once in the Supabase SQL editor. Until you do, the admin still publishes (it retries without
-- the column) and everything shows under "New in your portal" as before.

alter table public.portal_updates
  add column if not exists category text not null default 'product';

comment on column public.portal_updates.category is
  'product = portal changelog entry, company = news about WebEaze itself (annual review, price change, holiday cover). Company entries render in their own card, above everything else, never collapsed, with links made clickable.';

-- Optional: move an already-posted company announcement into the new card.
--   update public.portal_updates
--      set category = 'company', tag = 'Announcement'
--    where title ilike '%annual review%';

-- Check it:
--   select title, tag, category, published_at from public.portal_updates order by published_at desc limit 10;
