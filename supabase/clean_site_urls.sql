-- WebEaze: clean stray whitespace out of clients.site_url ─────────────────────
-- A site_url stored with a leading space or a pasted newline is live and clickable (browsers trim an
-- href) but breaks everything that PARSES it: the QR code reported "we do not have your website
-- address on file", the favicon missed, the shown domain kept the space, and server-side the whole
-- growth refresh came back empty because "https:// https://site.com" is not a URL.
--
-- The portal and growth-report now normalise on read, so this is not required. It is worth running
-- anyway so the stored value matches what everything actually uses.
--
-- Run this once in the Supabase SQL editor. Safe to run repeatedly.

-- Look first: these are the rows that would change.
select id, name, site_url
from public.clients
where site_url is not null
  and site_url <> regexp_replace(site_url, '\s', '', 'g');

-- Then clean them.
update public.clients
   set site_url = nullif(regexp_replace(site_url, '\s', '', 'g'), '')
 where site_url is not null
   and site_url <> regexp_replace(site_url, '\s', '', 'g');

-- Same trap, same fix, for the other hand-pasted URL column.
update public.clients
   set report_url = nullif(regexp_replace(report_url, '\s', '', 'g'), '')
 where report_url is not null
   and report_url <> regexp_replace(report_url, '\s', '', 'g');
