-- What a job is worth to the client, so the report can show what search is earning (2026-09-26).
--
-- The search card could already say a site was shown 26,346 times. Nobody can tell whether that is
-- good. The chain from there is all real data we already hold: impressions, clicks, and the leads
-- that arrived from Google. The one number missing is what a job is worth, and that is the client's
-- to tell us: inventing an industry average would put a figure on their report that is not theirs.
--
-- Optional. Null means the card shows the real chain and offers to work out the rest.
--
-- Safe to run more than once.

alter table public.clients
  add column if not exists avg_job_value numeric;

comment on column public.clients.avg_job_value is
  'What a typical job is worth to this client, in dollars. Set by them in the portal. Null = not told, and the report says so rather than guessing.';

-- The client sets their own. Existing policies already scope clients rows to their owner, so this
-- only has to make sure the column is writable through whatever policy governs the row.
-- Nothing else needed: no new table, no new policy.
