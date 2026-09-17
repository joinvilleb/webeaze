-- What's new entry: why the Leads number changed.
--
-- WHY: the home tile used to count every tap on a phone number, email link or "book now" button as a
-- lead. Across all clients that was 2105 events in 60 days with only 23 carrying a name. The tile now
-- counts enquiries you can reply to, with taps on a second line, so the number matches the inbox and
-- matches their phone log. Their figure will drop sharply this month, and a drop with no explanation
-- reads as "my website stopped working".
--
-- Publish when you are ready. Set published to false first if you want to read it in the portal
-- preview before clients see it.

insert into public.portal_updates (published, published_at, tag, title, category, audience, body)
values (
  true,
  now(),
  'Update',
  'Leads now counts people you can reply to',
  'product',
  'all',
  'Your Leads number used to include every tap on your phone number, email link or booking button, so it was always higher than the number of people you could actually get back to.'
  || E'\n\n'
  || 'It now counts enquiries with details you can reply to, and shows taps on a second line underneath. You will probably see a smaller number this month than last.'
  || E'\n\n'
  || 'Nothing has changed on your website and nobody has stopped getting in touch. We are just counting it the way you would count it.'
);

-- Check what clients will see:
select title, published, published_at, left(body, 80) as opening
  from public.portal_updates
 order by published_at desc
 limit 3;
