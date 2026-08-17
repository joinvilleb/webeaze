-- WebEaze lead context ───────────────────────────────────────────────────────
-- Adds the three fields that turn "you got a lead" into something an owner can act on:
--
--   device  'mobile' | 'tablet' | 'desktop'  — someone on a phone at 7pm is a different follow-up
--                                              to someone at a desk mid-morning
--   source  the referring host, or 'direct'  — 'google.com', 'facebook.com', 'direct'
--   target  which number/address was tapped  — a business with a main line AND a mobile, or sales@
--                                              and info@, needs to know which one is ringing
--
-- None of these identify a person. They are read from what the browser already exposes to the page
-- (user agent, referrer, and the href that was clicked), which is why they are kept for EVERY plan,
-- unlike the name/email/phone/message on a form submit which stay Growth-only.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.
--
-- Until this runs, track-lead falls back to inserting a bare row (user_id/type/page), so leads keep
-- recording and simply carry no context. Nothing breaks by waiting.

alter table public.lead_events add column if not exists device text;
alter table public.lead_events add column if not exists source text;
alter table public.lead_events add column if not exists target text;

alter table public.lead_events drop constraint if exists lead_events_device_check;
alter table public.lead_events add constraint lead_events_device_check
  check (device is null or device in ('mobile', 'tablet', 'desktop'));

-- "Where are my leads coming from" is the question this answers, so index it.
create index if not exists lead_events_source_idx on public.lead_events (user_id, source);
