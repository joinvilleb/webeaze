-- New "What's new" changelog entries for the recent portal improvements.
-- Run in the Supabase SQL editor, or post the same text from the admin changelog composer.

insert into public.portal_updates (title, body, tag, audience) values
(
  'New tools and a sharper report',
  'Your report now has a Business tools section. Caption your job photos for the web with ready-to-use alt text, so your gallery looks great and works for every visitor. We also added an accessibility check so you can see how easy your site is to use, tidied the report so it is quicker to scan, and added a CSV export to your request history. Your website notes page got quick prompts too, to make it easier to send us exactly what you need.',
  'New',
  'all'
),
(
  'Two more Business tools on Growth',
  'On your report you can now draft a warm reply to a customer inquiry in seconds, and generate a helpful set of FAQs for your site in one tap. Both are ready to copy, or add the FAQs straight to your site.',
  'New',
  'growth'
);
