-- Live Blocks: website content a client edits in their portal that renders live on their own site via
-- the blocks.js embed (portal/blocks.js) + the public site-content edge function. One row per client
-- holding all their blocks as jsonb, e.g. { hours: {...}, announcement: {...} }.
--
-- The client reads/writes only their own row. The public embed on their website reads through the
-- site-content function (service role), so anonymous visitors never touch this table directly.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.site_blocks (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  blocks     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.site_blocks enable row level security;

drop policy if exists "site_blocks read own or admin" on public.site_blocks;
create policy "site_blocks read own or admin" on public.site_blocks
  for select using (auth.uid() = user_id or (auth.jwt() ->> 'email') = 'billy@webeaze.io');

drop policy if exists "site_blocks insert own" on public.site_blocks;
create policy "site_blocks insert own" on public.site_blocks
  for insert with check (auth.uid() = user_id);

drop policy if exists "site_blocks update own" on public.site_blocks;
create policy "site_blocks update own" on public.site_blocks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
