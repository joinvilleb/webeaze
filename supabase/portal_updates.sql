-- WebEaze portal "What's new" changelog ───────────────────────────────────────
-- A small client-facing feed of portal/platform improvements. Every client sees
-- published entries (optionally plan-targeted); Billy posts them from the admin.
-- The per-CLIENT website work log is separate and already automatic (request
-- history + monthly recap). This feed is the "what's new in the portal" story.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.portal_updates (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text not null,
  tag          text not null default 'New',     -- 'New' | 'Improved' | 'Fixed'
  audience     text not null default 'all',      -- 'all' | 'growth' (Growth + Elite only)
  published    boolean not null default true,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists portal_updates_pub_idx on public.portal_updates (published, published_at desc);

alter table public.portal_updates enable row level security;

-- Every signed-in client can read published entries; only Billy writes.
drop policy if exists "read published updates" on public.portal_updates;
create policy "read published updates" on public.portal_updates
  for select using (published = true or (auth.jwt() ->> 'email') = 'billy@webeaze.io');

drop policy if exists "admin writes updates" on public.portal_updates;
create policy "admin writes updates" on public.portal_updates
  for all using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');

grant select on public.portal_updates to authenticated;
grant insert, update, delete on public.portal_updates to authenticated;

-- ── Seed: the improvements shipped recently, so the feed launches populated ──
insert into public.portal_updates (title, body, tag, audience, published_at) values
  ('See how you compare locally', 'Your site report now shows how you stack up against nearby businesses in your trade, on Google rating, reviews, and site speed. Look for "How you compare locally".', 'New', 'growth', now()),
  ('Your value at a glance', 'Open Request history to see a quick summary of what your plan has delivered: leads brought in, requests completed, and money saved.', 'New', 'all', now() - interval '1 hour'),
  ('Instant answers in chat', 'Meet Eaze, your assistant in live chat. Ask a question any time, day or night, and get a straight answer right away.', 'New', 'all', now() - interval '3 days'),
  ('Collect more Google reviews', 'A one-tap link and QR code that drop happy customers straight onto your Google review form. Find it in your site report under your rating.', 'New', 'all', now() - interval '6 days'),
  ('Around-the-clock site monitoring', 'We now keep an eye on your website 24/7 and quietly handle issues like broken links or downtime, often before you would ever notice.', 'Improved', 'all', now() - interval '9 days');
