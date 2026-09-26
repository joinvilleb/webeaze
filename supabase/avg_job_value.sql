-- clients.avg_job_value — ADDED, THEN SET ASIDE (2026-09-26).
--
-- The search card briefly ended with "at $350 a job, that is about $3,850 of work in play". The
-- word was the problem: a restaurant has covers, a gym has members, a tutor has students, and there
-- is no single noun for what these businesses sell that is not wrong for some of them. Rather than
-- pick one and be wrong on a client's own report, the card stops at the measured chain.
--
-- The column stays because it is already in the database and empty columns cost nothing. If a value
-- per enquiry is ever worth showing again, the word has to come from the client too, not just the
-- number, and this is where the number would live.
--
-- Nothing reads it today. Safe to run, safe to skip.

alter table public.clients
  add column if not exists avg_job_value numeric;

comment on column public.clients.avg_job_value is
  'Unused. Kept from an attempt to value search traffic; the wording, not the number, is what stopped it.';
