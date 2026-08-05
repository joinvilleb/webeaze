-- Second email per client: CC a partner / spouse / office manager on the emails a client gets, without
-- giving them a second login. Set it in the admin client editor ("Second email"); it is added as a
-- recipient on lead alerts, the monthly report, "we replied", request updates, and notes.
--
-- Until this runs, the admin editor simply skips the field (the save drops it and keeps everything else),
-- so nothing breaks. Run this once in the Supabase SQL editor.

alter table public.clients add column if not exists second_email text;
