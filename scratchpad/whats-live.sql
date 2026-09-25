-- Paste into the Supabase SQL editor. Reports which migrations have actually landed,
-- so "have I run that one?" stops being a guess. Read-only; changes nothing.
select 'addon_prices.sql'            as migration,
       to_regclass('public.addon_prices') is not null                                       as live
union all select 'addon_delivery.sql (columns)',
       exists (select 1 from information_schema.columns
               where table_name='update_requests' and column_name='addon_stages')
union all select 'addon_delivery.sql (review email)',
       exists (select 1 from information_schema.columns
               where table_name='update_requests' and column_name='addon_notified_stage')
union all select 'addon_delivery.sql (brief table)',
       to_regclass('public.addon_orders') is not null
union all select 'turnaround_stats_auto.sql',
       exists (select 1 from pg_proc where proname='refresh_turnaround_stats')
union all select 'request_logged_by_admin.sql',
       exists (select 1 from information_schema.columns
               where table_name='update_requests' and column_name='logged_by_admin')
union all select 'request_feedback_notes.sql',
       exists (select 1 from information_schema.columns
               where table_name='update_requests' and column_name='feedback_note')
union all select 'account_devices.sql',
       exists (select 1 from pg_proc where proname='my_sessions')
union all select 'email_overrides.sql',
       to_regclass('public.email_overrides') is not null
union all select 'postcard_automation.sql',
       to_regclass('public.postcard_settings') is not null
union all select 'client_members_profile.sql',
       exists (select 1 from information_schema.columns
               where table_name='client_members' and column_name='name')
order by live, migration;
