-- Instant acknowledgement to whoever fills in a client's website form.
--
-- WHY: for a landscaper or an HVAC company, answering in five minutes rather than an hour is most of
-- whether they win the job, and we already receive every form submission the moment it happens. This
-- lets the site say "we've got it" while the owner is still up a ladder.
--
-- OFF BY DEFAULT ON PURPOSE. This sends mail to the client's customers in the client's name, so it
-- is never switched on by a deploy. Billy turns it on per client from the admin, after agreeing the
-- wording with them.
alter table public.clients
  add column if not exists lead_autoreply boolean not null default false,
  add column if not exists lead_autoreply_text text;

comment on column public.clients.lead_autoreply is
  'Send an instant acknowledgement to anyone who submits this client''s website form. Off unless the client has agreed to it.';
comment on column public.clients.lead_autoreply_text is
  'The client''s own wording for that acknowledgement. Null uses the default sentence.';
