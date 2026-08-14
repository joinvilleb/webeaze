-- Referral lifecycle emails, restyled to match the rest of the WebEaze emails.
--
-- ⚠ THIS FILE IS THE FUNCTION *BODY* ONLY (starts at `declare`, ends at `end;`).
--   Paste it into Supabase Dashboard → Database → Functions → notify_referral_status → Edit,
--   replacing everything in the Definition box. That editor adds the
--   `CREATE OR REPLACE FUNCTION ... AS $$ ... $$` wrapper itself, which is why pasting a full
--   CREATE statement there fails with: syntax error at or near "declare".
--
--   If you would rather use the SQL Editor, wrap it yourself:
--     create or replace function public.<your function name>() returns trigger
--     language plpgsql security definer as $$ <everything below> $$;
--   Confirm the real name first, since the trigger is bound to it:
--     select tgname, p.proname from pg_trigger t
--       join pg_proc p on p.oid = t.tgfoid where tgrelid = 'public.referrals'::regclass;
--
-- Three emails, all on public.referrals:
--   1. status -> 'Pending'      "Your referral is being tracked"      (signed up, 7-day clock running)
--   2. status -> 'Signed up'    "Your $50 referral reward is ready"   (confirmed, asks for payout details)
--   3. reward_paid -> true      "Your $50 reward has been sent"
--
-- WHAT CHANGED, beyond the styling:
--   a) Email 1 could never fire. The admin status dropdown only ever wrote 'Referred' or 'Signed up',
--      so `new.status = 'Pending'` was unreachable. portal/admin.html now offers Pending as the
--      middle state, which is what the copy was always written for.
--   b) Email 2 was skipped when a referral was INSERTED straight as 'Signed up' (which the admin Add
--      form allows). On insert OLD is null, so `old.status != 'Signed up'` evaluates to NULL, not
--      true, and the branch was skipped. Guarded the way branches 1 and 3 already were.
--   c) The "learn more" link pointed at webeaze.tawk.help/article/referral. Now webeaze.io/referral-faq.
--   d) Styling: Verdana + a purple gradient banner + nested grey cards replaced with the same shell
--      every other WebEaze email uses (Helvetica stack, 560px column, logo and wordmark at the top,
--      no color except the wordmark and links, real bullet lists).

declare
  referrer_email text;
  referrer_name  text;
  first_name     text;
  referred       text;
  shell_top      text;
  shell_bottom   text;
  inner_html     text;
  email_body     jsonb;
begin
  select email into referrer_email from auth.users where id = new.referrer_user_id;
  select name  into referrer_name  from public.clients where user_id = new.referrer_user_id limit 1;
  if referrer_email is null then return new; end if;   -- nothing to send to

  first_name := coalesce(nullif(split_part(coalesce(referrer_name, ''), ' ', 1), ''), 'there');
  referred   := coalesce(nullif(new.referred_name, ''), 'the business you referred');

  -- Shared shell. Matches supabase/functions/lifecycle-emails (Helvetica, 560px, logo, plain body).
  shell_top :=
    '<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="color-scheme" content="light">' ||
    '<style>:root{color-scheme:light;}</style></head>' ||
    '<body style="margin:0;background:#ffffff;">' ||
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2333;">' ||
    '<div style="border-bottom:1px solid #eeeeee;padding-bottom:15px;margin-bottom:26px;">' ||
      '<img src="https://webeaze.io/images/webeaze-transparent-copy.png" alt="" width="24" height="27" style="vertical-align:middle;margin-right:8px;" />' ||
      '<span style="font-size:17px;font-weight:800;letter-spacing:-.02em;color:#1f2333;vertical-align:middle;">Web<span style="color:#7851a9;">Eaze</span></span>' ||
    '</div>';

  shell_bottom :=
    '<p style="margin:0 0 4px;">Best,</p><p style="margin:0;">WebEaze Web Design</p>' ||
    '<p style="margin:28px 0 0;font-size:12px;color:#9599b8;">WebEaze Web Design, 109 Pleasant Hill Drive, Camden-Wyoming, Delaware 19934, USA</p>' ||
    '</div></body></html>';

  -- ── 1. Signed up, 7-day clock running ────────────────────────────────────
  if new.status = 'Pending' and (old.status is null or old.status is distinct from 'Pending') then
    inner_html :=
      '<p style="margin:0 0 16px;">Hi ' || first_name || ',</p>' ||
      '<p style="margin:0 0 16px;">Good news. ' || referred || ' just signed up with us, so your referral is now being tracked.</p>' ||
      '<p style="margin:0 0 16px;">Once they have been with us for 7 days your $50 reward is confirmed, and we will email you to arrange the payment.</p>' ||
      '<p style="margin:0 0 20px;">Nothing for you to do in the meantime. If you have any questions, reply to this email.</p>';
    email_body := json_build_object(
      'from', 'WebEaze <support@webeaze.io>',
      'to', array[referrer_email],
      'subject', 'Your referral is being tracked',
      'html', shell_top || inner_html || shell_bottom
    )::jsonb;
    perform net.http_post(url := 'https://webeaze-mailer.webeaze-web-design.workers.dev'::text, body := email_body);
  end if;

  -- ── 2. Confirmed: ask for payout details ─────────────────────────────────
  if new.status = 'Signed up' and (old.status is null or old.status is distinct from 'Signed up') then
    inner_html :=
      '<p style="margin:0 0 16px;">Hi ' || first_name || ',</p>' ||
      '<p style="margin:0 0 16px;">Good news. ' || referred || ' has been with us a full week, so your referral is confirmed.</p>' ||
      '<p style="margin:0 0 16px;">We''ll send you <strong>$50</strong> in the form of an electronic payment to your preferred method.</p>' ||
      '<p style="margin:0 0 10px;">Reply to this email with the following information:</p>' ||
      '<ul style="margin:0 0 16px;padding-left:22px;">' ||
        '<li style="margin-bottom:8px;">Your preferred payment method: Venmo, Cash App, PayPal, or Zelle.</li>' ||
        '<li style="margin-bottom:8px;">Your username or contact details for that method. <u>Do not include passwords or other sensitive information</u>.</li>' ||
      '</ul>' ||
      '<p style="margin:0 0 16px;">We''ll process the payment and email you to confirm within 1 working day of receiving your response.</p>' ||
      '<p style="margin:0 0 16px;">There is no cap on how many businesses you can refer, so this can keep paying off. Check the <a href="https://webeaze.io/referral-faq" style="color:#7851a9;font-weight:600;text-decoration:none;">referral FAQs</a> if you have questions.</p>' ||
      '<p style="margin:0 0 20px;">Thanks for putting our name forward. It genuinely means a lot to us.</p>';
    email_body := json_build_object(
      'from', 'WebEaze <support@webeaze.io>',
      'to', array[referrer_email],
      'subject', 'Your $50 referral reward is ready',
      'html', shell_top || inner_html || shell_bottom
    )::jsonb;
    perform net.http_post(url := 'https://webeaze-mailer.webeaze-web-design.workers.dev'::text, body := email_body);
  end if;

  -- ── 3. Payment sent ──────────────────────────────────────────────────────
  if new.reward_paid = true and (old.reward_paid is null or old.reward_paid = false) then
    inner_html :=
      '<p style="margin:0 0 16px;">Hi ' || first_name || ',</p>' ||
      '<p style="margin:0 0 16px;">Your $50 referral reward for ' || referred || ' has been sent to the payment details you gave us.</p>' ||
      '<p style="margin:0 0 16px;">Depending on the payment method, it can take a little time to land. If you do not see it within a few days, reply to this email and we will investigate.</p>' ||
      '<p style="margin:0 0 20px;">Thanks again for spreading the word. Refer another business and the same reward applies, with no limit.</p>';
    email_body := json_build_object(
      'from', 'WebEaze <support@webeaze.io>',
      'to', array[referrer_email],
      'subject', 'Your $50 reward has been sent',
      'html', shell_top || inner_html || shell_bottom
    )::jsonb;
    perform net.http_post(url := 'https://webeaze-mailer.webeaze-web-design.workers.dev'::text, body := email_body);
  end if;

  return new;
end;
