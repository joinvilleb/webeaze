-- Weekly postcards through PostGrid (2026-09-22).
--
-- postcard-send mails a postcard to the next few businesses on the admin Growth "Postcard list". This
-- file adds the settings it reads (edited in admin, never here) and a daily check that sends on the
-- chosen weekday. It ships SWITCHED OFF: nothing is mailed until Billy turns it on in admin and fills
-- in the PostGrid template and return address. The PostGrid key is a Supabase secret
-- (POSTGRID_API_KEY), not a column, so it never reaches a browser.
--
-- Safe to run more than once.

create table if not exists public.postcard_settings (
  id              text primary key default 'default',
  enabled         boolean  not null default false,
  per_run         smallint not null default 5 check (per_run between 1 and 50),
  weekday         smallint not null default 1 check (weekday between 0 and 6),   -- 0 Sunday .. 6 Saturday, US Eastern
  front_template  text,                                                           -- PostGrid template id, e.g. template_...
  back_template   text,
  from_contact    text,                                                           -- PostGrid contact id of the return address
  size            text     not null default '6x4' check (size in ('6x4', '9x6', '11x6')),
  mailing_class   text     not null default 'first_class' check (mailing_class in ('first_class', 'standard_class')),
  last_run_at     timestamptz,
  last_run        jsonb,
  updated_at      timestamptz not null default now()
);
insert into public.postcard_settings (id) values ('default') on conflict (id) do nothing;

alter table public.postcard_settings enable row level security;
drop policy if exists "postcard_settings admin" on public.postcard_settings;
create policy "postcard_settings admin" on public.postcard_settings
  for all using ((auth.jwt() ->> 'email') = 'billy@webeaze.io')
  with check ((auth.jwt() ->> 'email') = 'billy@webeaze.io');
grant select, insert, update on public.postcard_settings to authenticated;

-- Daily at 14:00 UTC (10am Eastern in summer, 9am in winter). The function itself decides whether
-- today is the day, so changing the weekday in admin needs no SQL. The cron secret is copied from the
-- scan's existing job, so there is no placeholder to fill in (a forgotten <CRON_SECRET> once left the
-- whole outreach machine failing silently for days).
do $$
declare cmd text; secret text;
begin
  select command into cmd from cron.job where jobname = 'prospect-scan-daily';
  secret := substring(cmd from $re$'x-cron-secret'\s*,\s*'([^']+)'$re$);
  if secret is null or secret like '<%' then
    raise exception 'Could not read the cron secret from prospect-scan-daily. Schedule postcard-send-daily by hand with the real CRON_SECRET.';
  end if;
  perform cron.schedule('postcard-send-daily', '0 14 * * *', format($job$
    select net.http_post(
      url     := 'https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/postcard-send',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',%L),
      body    := jsonb_build_object('action','weekly'),
      timeout_milliseconds := 60000
    );
  $job$, secret));
end $$;

notify pgrst, 'reload schema';

-- Check:
select id, enabled, per_run, weekday, size, mailing_class from public.postcard_settings;
select jobname, schedule from cron.job where jobname = 'postcard-send-daily';
