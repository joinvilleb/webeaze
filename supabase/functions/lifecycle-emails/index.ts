// Supabase Edge Function: lifecycle-emails
// One daily cron-driven job that sends three time-based client emails, each at most once (deduped via
// per-email timestamp columns on clients, see supabase/lifecycle_emails.sql):
//   1) Win-back      — ~20-30 days after a client was marked inactive, before their files are deleted
//                      at day 30. A gentle "come back, no rebuild needed" nudge.
//   2) Onboarding    — ~5-14 days after signup if they never submitted their Site Setup (we can't
//                      start building without it).
//   3) Review+refer  — ~14-45 days after their site launched: how's it going + a soft review + referral ask.
//   4) Portal nudge  — 3-30 days after signup if auth shows they have NEVER signed in. Everything we
//                      build for them lives behind that login, so a client who never opens it gets
//                      no value from the plan. Needs supabase/portal_nudge.sql for the dedupe column.
//
// Deploy:   supabase functions deploy lifecycle-emails --no-verify-jwt
// Secrets:  CRON_SECRET, RESEND_API_KEY  (+ platform SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// Schedule: pg_cron daily, x-cron-secret header — see supabase/lifecycle_emails.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';
const REVIEW_URL = 'https://g.page/r/CRQ-nUd9fR9bEAI/review';
const DAY = 86400000;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const firstName = (name?: string) => (String(name || '').trim().split(/\s+/)[0] || 'there');
const iso = (ms: number) => new Date(ms).toISOString();

async function sendEmail(to: string[], subject: string, inner: string) {
  if (!RESEND_API_KEY || !to.length) return false;
  const html = '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2333;">' +
    inner +
    '<p style="margin:0 0 4px;">Best,</p><p style="margin:0;">WebEaze Web Design</p>' +
    '<p style="margin:28px 0 0;font-size:12px;color:#9599b8;">WebEaze Web Design, 109 Pleasant Hill Drive, Camden-Wyoming, Delaware 19934, USA</p>' +
    '</div>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!res.ok) { console.error('[lifecycle] resend ' + res.status + ': ' + (await res.text()).slice(0, 160)); return false; }
    return true;
  } catch (e) { console.error('[lifecycle] send failed:', e); return false; }
}
const btn = (href: string, label: string) =>
  '<p style="margin:0 0 20px;"><a href="' + href + '" style="display:inline-block;background:#7851a9;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">' + label + '</a></p>';
const link = (href: string, label: string) => '<a href="' + href + '" style="color:#7851a9;font-weight:600;text-decoration:none;">' + label + '</a>';

function winbackInner(c: any) {
  return '<p style="margin:0 0 16px;">Hey ' + esc(firstName(c.name)) + ',</p>' +
    '<p style="margin:0 0 16px;">It has been a couple of weeks since your plan with us ended, and we wanted to reach out once more before your website files are removed.</p>' +
    '<p style="margin:0 0 16px;">If you would like to come back, we can reactivate your site and pick up right where we left off, no rebuild needed.</p>' +
    btn(PORTAL_URL, 'Reactivate my website') +
    '<p style="margin:0 0 16px;">Please note: after 30 days from cancellation, website files are permanently deleted and there are no extensions/exceptions to this policy.</p>' +
    '<p style="margin:0 0 16px;">Either way, thank you for having been part of us, and we wish you the best in your future endeavors.</p>';
}
function onboardingInner(c: any) {
  return '<p style="margin:0 0 16px;">Hey ' + esc(firstName(c.name)) + ',</p>' +
    '<p style="margin:0 0 16px;">Welcome again! We noticed your Site Setup is not finished yet. We cannot start building your website until we have a few details about your business, to ensure you are happy with the final result.</p>' +
    '<p style="margin:0 0 16px;">It only takes a few minutes. The sooner you complete it, the sooner your site goes live.</p>' +
    btn(PORTAL_URL + '/#setup', 'Finish your Site Setup') +
    '<p style="margin:0 0 16px;">If you have questions or need help getting started, reply to this email and we will help you out.</p>';
}
function portalInner(c: any) {
  return '<p style="margin:0 0 16px;">Hey ' + esc(firstName(c.name)) + ',</p>' +
    '<p style="margin:0 0 16px;">We set your client portal up when you joined, but it looks like you have not opened it yet. Everything we do for you lives in there.</p>' +
    '<p style="margin:0 0 8px;">It is where you:</p>' +
    '<ul style="margin:0 0 16px;padding-left:20px;">' +
      '<li style="margin-bottom:8px;">Send us website changes and watch them get done</li>' +
      '<li style="margin-bottom:8px;">See who has been contacting you through your site</li>' +
      '<li style="margin-bottom:8px;">Check how your site is performing on Google</li>' +
    '</ul>' +
    btn(PORTAL_URL, 'Open your portal') +
    '<p style="margin:0 0 16px;">If you cannot get in, or never received your login, just reply to this email and we will sort it out.</p>';
}
function reviewInner(c: any) {
  return '<p style="margin:0 0 16px;">Hey ' + esc(firstName(c.name)) + ',</p>' +
    '<p style="margin:0 0 16px;">Your website has been live for a couple of weeks now. How is it going? We hope it is already bringing you new leads and customers.</p>' +
    '<p style="margin:0 0 8px;">Two quick things, only if you are happy so far:</p>' +
    '<ul style="margin:0 0 16px;padding-left:20px;">' +
      '<li style="margin-bottom:8px;">A quick ' + link(REVIEW_URL, 'Google review') + ' genuinely means a lot to a small team like ours.</li>' +
      '<li style="margin-bottom:8px;">Know another business owner who needs a site? ' + link(PORTAL_URL + '/#referrals', 'Refer them') + ' and you get a free month when they sign up.</li>' +
    '</ul>' +
    '<p style="margin:0 0 16px;">And if you would like any changes, just send us a request in your ' + link(PORTAL_URL, 'portal') + '. That is what we are here for.</p>';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now();
  const sent = { winback: 0, onboarding: 0, review: 0, portal: 0 };

  try {
    // 1) WIN-BACK: cancelled 20-30 days ago, still inactive, has an email, not yet sent.
    const { data: wb } = await svc.from('clients')
      .select('id, name, email, second_email')
      .eq('status', 'inactive').is('winback_email_at', null)
      .not('cancelled_at', 'is', null).gte('cancelled_at', iso(now - 30 * DAY)).lte('cancelled_at', iso(now - 20 * DAY));
    for (const c of wb ?? []) {
      const to = [c.email, c.second_email].filter(Boolean) as string[];
      if (!to.length) continue;
      if (await sendEmail(to, 'We would love to have you back at WebEaze', winbackInner(c))) {
        await svc.from('clients').update({ winback_email_at: iso(now) }).eq('id', c.id);
        sent.winback++;
      }
    }

    // 2) STUCK ONBOARDING: signed up 5-14 days ago, still active, not launched, never submitted setup.
    const { data: ob } = await svc.from('clients')
      .select('id, user_id, name, email, second_email')
      .neq('status', 'inactive').is('site_url', null).is('onboarding_nudge_at', null)
      .gte('created_at', iso(now - 14 * DAY)).lte('created_at', iso(now - 5 * DAY));
    for (const c of ob ?? []) {
      if (!c.user_id) continue;
      const to = [c.email, c.second_email].filter(Boolean) as string[];
      // Already submitted their setup? Mark handled (so we never re-check) and skip.
      const { data: subm } = await svc.from('site_submissions').select('submitted_at').eq('user_id', c.user_id).maybeSingle();
      if (subm && subm.submitted_at) { await svc.from('clients').update({ onboarding_nudge_at: iso(now) }).eq('id', c.id); continue; }
      if (!to.length) continue;
      if (await sendEmail(to, 'Let us get your website started', onboardingInner(c))) {
        await svc.from('clients').update({ onboarding_nudge_at: iso(now) }).eq('id', c.id);
        sent.onboarding++;
      }
    }

    // 3) REVIEW + REFERRAL: site launched 14-45 days ago, still active, not yet asked.
    const { data: rv } = await svc.from('clients')
      .select('id, name, email, second_email')
      .neq('status', 'inactive').is('review_nudge_at', null)
      .not('launched_at', 'is', null).gte('launched_at', iso(now - 45 * DAY)).lte('launched_at', iso(now - 14 * DAY));
    for (const c of rv ?? []) {
      const to = [c.email, c.second_email].filter(Boolean) as string[];
      if (!to.length) continue;
      if (await sendEmail(to, 'How is your website working out?', reviewInner(c))) {
        await svc.from('clients').update({ review_nudge_at: iso(now) }).eq('id', c.id);
        sent.review++;
      }
    }

    // 4) NEVER OPENED THE PORTAL: created 3-30 days ago, still active, and auth says they have never
    //    signed in. Everything we build sits behind that login, so this is the highest-value nudge
    //    we send. last_sign_in_at is only visible to the service role, hence the per-client lookup.
    const { data: np } = await svc.from('clients')
      .select('id, user_id, name, email, second_email')
      .neq('status', 'inactive').is('portal_nudge_at', null)
      .gte('created_at', iso(now - 30 * DAY)).lte('created_at', iso(now - 3 * DAY));
    for (const c of np ?? []) {
      if (!c.user_id) continue;
      const to = [c.email, c.second_email].filter(Boolean) as string[];
      let signedIn = true;                       // fail safe: never nag someone we cannot verify
      try {
        const { data: u } = await svc.auth.admin.getUserById(c.user_id);
        signedIn = !!(u && u.user && u.user.last_sign_in_at);
      } catch (_e) { signedIn = true; }
      // Already been in? Mark handled so we stop checking them every day.
      if (signedIn) { await svc.from('clients').update({ portal_nudge_at: iso(now) }).eq('id', c.id); continue; }
      if (!to.length) continue;
      if (await sendEmail(to, 'Your WebEaze portal is waiting', portalInner(c))) {
        await svc.from('clients').update({ portal_nudge_at: iso(now) }).eq('id', c.id);
        sent.portal++;
      }
    }

    console.log('[lifecycle] sent', JSON.stringify(sent));
    return json({ ok: true, sent });
  } catch (e) {
    console.error('[lifecycle] error:', e);
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});
