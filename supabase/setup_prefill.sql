-- WebEaze: Site setup prefill ────────────────────────────────────────────────
-- Adds somewhere for our GUESS at a client's business details to live, separate from the four blobs
-- that hold the client's own answers (contact, domain_info, brand, content).
--
-- Keeping it separate is the whole safety property of the feature. A background job that could write
-- into `content` could overwrite an About section a client spent ten minutes on. This one cannot: the
-- portal reads `prefill`, offers it, and only the client's own save writes the real columns.
--
-- It also means the draft survives a partial setup. A client who fills in step 1 and comes back a week
-- later still has the prefill waiting, rather than it being lost the moment they touched the form.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

alter table public.site_submissions
  add column if not exists prefill jsonb,
  add column if not exists prefill_at timestamptz;

-- Admin sorts clients by "has a prefill been built yet", so make that cheap.
create index if not exists site_submissions_prefill_at_idx
  on public.site_submissions (prefill_at)
  where prefill_at is not null;

comment on column public.site_submissions.prefill is
  'Our guess at this client''s business details, from Google Places + their existing website + AI. Written ONLY by the setup-prefill edge function. Never the client''s own answers.';
comment on column public.site_submissions.prefill_at is
  'When the prefill above was built. Used to rate limit rebuilds to once a day per client.';

notify pgrst, 'reload schema';
