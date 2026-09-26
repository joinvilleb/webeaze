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
//   5) Needs-info     — 3 days after we asked a client a question and got nothing back. The request
//                      is parked until they answer, and the original ask is quoted so they do not
//                      have to go looking for what we wanted. Needs supabase/needs_info_followup.sql.
//   6) Cold leads     — 2 days after a WRITTEN inquiry (form or email) that is not marked handled.
//                      Deliberately cautious: almost nobody marks leads contacted (5 of 2105 when
//                      this was written), so "not marked" cannot be read as "ignored". Hence: written
//                      inquiries only, since a missed call is not something we can chase; a reminder
//                      to mark them rather than an accusation; at most one email per client a week;
//                      and one nudge per lead ever. Needs supabase/lead_followup.sql.
//   7) Waiting on us  — an internal note to the team listing every conversation where the client
//                      spoke last over a day ago (portal Messages and request threads). No client
//                      ever sees this one, and it repeats daily until the queue is clear.
//
// Deploy:   supabase functions deploy lifecycle-emails --no-verify-jwt
// Secrets:  CRON_SECRET, RESEND_API_KEY  (+ platform SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// Schedule: pg_cron daily, x-cron-secret header — see supabase/lifecycle_emails.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { leadActionUrl } from '../_shared/lead-token.ts';
import { emailCopy } from '../_shared/email-template.ts';

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

// signoff: the emails whose wording is editable in admin pass their own (it is a slot); every other
// send leaves it out and keeps the default below, so nothing about them changes.
async function sendEmail(to: string[], subject: string, inner: string, signoff?: string) {
  if (!RESEND_API_KEY || !to.length) return false;
  const html = '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2333;">' +
    inner +
    (signoff || '<p style="margin:0 0 4px;">Best,</p><p style="margin:0;">WebEaze Web Design</p>') +
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

// -- Editable wording ------------------------------------------------------
// Slots are prose, never HTML, so a link inside a sentence cannot be typed into one. Instead the
// slot marks WHERE the link goes with a placeholder, the var behind that placeholder is this
// invisible mark, and the code swaps the mark for the real anchor. Move the placeholder and the
// link moves with it; delete it and the sentence simply loses its link.
const LINK_MARK = '\u0001';
const withLink = (html: string, href: string, label: string) => html.split(LINK_MARK).join(link(href, label));
// A subject line is a mail header, where a control character is illegal: if a link placeholder is
// ever pasted into one, drop the mark rather than post it.
const noMarks = (s: string) => s.split(LINK_MARK).join('');
// The same two paragraphs sendEmail writes by default, but from the slot.
const signoffHtml = (copy: any, vars: any) =>
  (copy.text('signoff', vars) || 'Best,\nWebEaze Web Design').split('\n')
    .map((line: string, i: number) => '<p style="' + (i === 0 ? 'margin:0 0 4px;' : 'margin:0;') + '">' + line.trim() + '</p>').join('');

async function coldLeadsEmail(svc: any, c: any, rows: any[]) {
  const copy = await emailCopy(svc, 'lifecycle-leads', {
    subject: '{{inquiry_count}} {{inquiry_word}} {{is_are}} still waiting for you',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: '{{inquiry_count}} {{inquiry_word}} came in through your website and we have not heard how {{it}} went.',
      more_line: 'and {{more_count}} more',
      follow_up: 'Already spoken to {{them}}? Tap below and we will stop mentioning {{it}}. If not, most people ring two or three businesses and go with whoever answers first, so today is worth more than tomorrow.',
      button: 'Open your inquiries',
      closer: 'We send this at most once a week, and never twice about the same inquiry.',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  // One inquiry or several changes six words, so the words are vars and the sentence stays one slot.
  const many = rows.length !== 1;
  const vars = {
    first_name: firstName(c.name),
    inquiry_count: many ? String(rows.length) : 'An',
    inquiry_word: many ? 'inquiries' : 'inquiry',
    is_are: many ? 'are' : 'is',
    isnt_arent: many ? 'aren\'t' : 'isn\'t',
    them: many ? 'them all' : 'them',
    it: many ? 'them' : 'it',
  };
  const KIND: Record<string, string> = { form: 'a form inquiry', call: 'a phone call', email: 'an email', booking: 'a booking click' };
  // One tap per inquiry, not one for the batch: "mark them all handled" is a lie the moment one of
  // them is still open, and a client who cannot answer honestly answers not at all. Signed links, so
  // no login and nothing guessable. Without a secret we simply omit them rather than send dead links.
  const CRON = Deno.env.get('CRON_SECRET') ?? '';
  const FN_BASE = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  const list = (await Promise.all(rows.slice(0, 6).map(async (l) => {
    const when = new Date(l.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const who = esc(l.name || KIND[l.type] || 'An inquiry');
    let taps = '';
    if (CRON && FN_BASE) {
      const [reached, won] = await Promise.all([
        leadActionUrl(FN_BASE, String(l.id), 'contacted', CRON),
        leadActionUrl(FN_BASE, String(l.id), 'won', CRON),
      ]);
      taps = '<span style="white-space:nowrap;">'
        + '<a href="' + reached + '" style="color:#7851a9;font-weight:600;text-decoration:none;">Reached them</a>'
        + '<span style="color:#c9cdd8;"> | </span>'
        + '<a href="' + won + '" style="color:#15803d;font-weight:600;text-decoration:none;">Won the job</a>'
        + '</span>';
    }
    return '<p style="margin:0 0 10px;">' + who + ' &middot; ' + esc(when)
      + (taps ? '<br>' + taps : '') + '</p>';
  }))).join('');
  const more = rows.length > 6 ? '<p style="margin:0 0 8px;color:#5b6079;">' + copy.text('more_line', { ...vars, more_count: rows.length - 6 }) + '</p>' : '';
  const inner =
    '<p style="margin:0 0 16px;">' + copy.text('greeting', vars).replace(/\s+([,.!?])/g, '$1') + '</p>' +
    copy.paras('lead', vars, 'margin:0 0 16px;') +
    list + more +
    copy.paras('follow_up', vars, 'margin:16px 0;') +
    btn(PORTAL_URL + '/#leads', copy.text('button', vars)) +
    copy.paras('closer', vars, 'margin:0 0 16px;');
  return { subject: copy.subject(vars), inner, signoff: signoffHtml(copy, vars) };
}

async function winbackEmail(svc: any, c: any) {
  const copy = await emailCopy(svc, 'lifecycle-winback', {
    subject: 'We\'d love to have you back at WebEaze',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: 'It has been a couple of weeks since your plan with us ended, and we wanted to reach out once more before your website files are removed.',
      offer: 'If you\'d like to come back, we can reactivate your site and pick up right where we left off, no rebuild needed.',
      button: 'Reactivate my website',
      policy: 'Please note: after 30 days from cancellation, website files are permanently deleted and there are no extensions/exceptions to this policy.',
      closer: 'Either way, thank you for having been part of us, and we wish you the best in your future endeavors.',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  const vars = { first_name: firstName(c.name) };
  const inner =
    '<p style="margin:0 0 16px;">' + copy.text('greeting', vars).replace(/\s+([,.!?])/g, '$1') + '</p>' +
    copy.paras('lead', vars, 'margin:0 0 16px;') +
    copy.paras('offer', vars, 'margin:0 0 16px;') +
    btn(PORTAL_URL, copy.text('button', vars)) +
    copy.paras('policy', vars, 'margin:0 0 16px;') +
    copy.paras('closer', vars, 'margin:0 0 16px;');
  return { subject: copy.subject(vars), inner, signoff: signoffHtml(copy, vars) };
}
async function onboardingEmail(svc: any, c: any) {
  const copy = await emailCopy(svc, 'lifecycle-onboarding', {
    subject: 'Let\'s get your website started',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: 'Welcome again! We noticed your Site Setup isn\'t finished yet. We can\'t start building your website until we have a few details about your business, so you\'re happy with the final result.',
      nudge: 'It only takes a few minutes. The sooner you complete it, the sooner your site goes live.',
      button: 'Finish your Site Setup',
      closer: 'If you have questions or need help getting started, reply to this email and we\'ll help you out.',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  const vars = { first_name: firstName(c.name) };
  const inner =
    '<p style="margin:0 0 16px;">' + copy.text('greeting', vars).replace(/\s+([,.!?])/g, '$1') + '</p>' +
    copy.paras('lead', vars, 'margin:0 0 16px;') +
    copy.paras('nudge', vars, 'margin:0 0 16px;') +
    btn(PORTAL_URL + '/#setup', copy.text('button', vars)) +
    copy.paras('closer', vars, 'margin:0 0 16px;');
  return { subject: copy.subject(vars), inner, signoff: signoffHtml(copy, vars) };
}
// The follow-up quotes the ORIGINAL question. A bare "we are still waiting on you" makes them open
// the portal to find out what for, which is the friction that stalled the request in the first place.
// Wording comes from admin when it has been edited there; these are the defaults and the last resort
// if the registry cannot be read. See supabase/functions/_shared/email-template.ts.
async function needsInfoEmail(svc: any, c: any, r: any) {
  const copy = await emailCopy(svc, 'lifecycle-chase', {
    subject: 'Still waiting on you: {{request_type}}',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: 'We\'re still waiting to hear back on your {{request_type_lower}} request. It\'s paused until we do.',
      asked_label: 'This is what we asked:',
      button: 'Answer in your portal',
      closer: 'You can also just reply to this email and we\'ll pick it up from there.',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  const vars = {
    first_name: firstName(c.name),
    request_type: String(r.type || 'your request'),
    request_type_lower: String(r.type || 'request').toLowerCase(),
  };
  const inner =
    '<p style="margin:0 0 16px;">' + copy.text('greeting', vars).replace(/\s+([,.!?])/g, '$1') + '</p>' +
    copy.paras('lead', vars, 'margin:0 0 14px;') +
    copy.paras('asked_label', vars, 'margin:0 0 8px;') +
    '<div style="background:#f7f7fa;border:1px solid #e4e7f1;border-left:3px solid #7851a9;border-radius:8px;padding:14px 16px;margin:0 0 18px;white-space:pre-wrap;">' +
      esc(r.needs_info_message) + '</div>' +
    btn(PORTAL_URL + '/#history/' + encodeURIComponent(String(r.id)), copy.text('button', vars)) +
    copy.paras('closer', vars, 'margin:16px 0 0;');
  return { subject: copy.subject(vars), inner, signoff: signoffHtml(copy, vars) };
}
async function portalEmail(svc: any, c: any) {
  const copy = await emailCopy(svc, 'lifecycle-setup', {
    subject: 'Your WebEaze portal is waiting',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: 'We set your client portal up when you joined, but it looks like you haven\'t opened it yet. Everything we do for you lives in there.',
      list_intro: 'It\'s where you:',
      list_items: 'Send us website changes and watch them get done\nSee who has been contacting you through your site\nCheck how your site is performing on Google',
      button: 'Open your portal',
      closer: 'If you can\'t get in, or never received your login, just reply to this email and we\'ll sort it out.',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  const vars = { first_name: firstName(c.name) };
  // One line per bullet, so a bullet can be added or dropped without a deploy.
  const items = copy.text('list_items', vars).split('\n').map((s: string) => s.trim()).filter(Boolean)
    .map((s: string) => '<li style="margin-bottom:8px;">' + s + '</li>').join('');
  const inner =
    '<p style="margin:0 0 16px;">' + copy.text('greeting', vars).replace(/\s+([,.!?])/g, '$1') + '</p>' +
    copy.paras('lead', vars, 'margin:0 0 16px;') +
    copy.paras('list_intro', vars, 'margin:0 0 8px;') +
    (items ? '<ul style="margin:0 0 16px;padding-left:20px;">' + items + '</ul>' : '') +
    btn(PORTAL_URL, copy.text('button', vars)) +
    copy.paras('closer', vars, 'margin:0 0 16px;');
  return { subject: copy.subject(vars), inner, signoff: signoffHtml(copy, vars) };
}
async function reviewEmail(svc: any, c: any) {
  const copy = await emailCopy(svc, 'lifecycle-check', {
    subject: 'How is your website working out?',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: 'Your website has been live for a couple of weeks now. How\'s it going? We hope it\'s already bringing you new leads and customers.',
      asks_intro: 'Two quick things, only if you\'re happy so far:',
      review_ask: 'A quick {{review_link}} genuinely means a lot to a small team like ours.',
      review_link_text: 'Google review',
      referral_ask: 'Know another business owner who needs a site? {{referral_link}} and you get a free month when they sign up.',
      referral_link_text: 'Refer them',
      closer: 'And if you\'d like any changes, just send us a request in your {{portal_link}}. That\'s what we\'re here for.',
      portal_link_text: 'portal',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  const vars = { first_name: firstName(c.name), review_link: LINK_MARK, referral_link: LINK_MARK, portal_link: LINK_MARK };
  const inner =
    '<p style="margin:0 0 16px;">' + copy.text('greeting', vars).replace(/\s+([,.!?])/g, '$1') + '</p>' +
    copy.paras('lead', vars, 'margin:0 0 16px;') +
    copy.paras('asks_intro', vars, 'margin:0 0 8px;') +
    '<ul style="margin:0 0 16px;padding-left:20px;">' +
      '<li style="margin-bottom:8px;">' + withLink(copy.text('review_ask', vars), REVIEW_URL, copy.text('review_link_text', vars)) + '</li>' +
      '<li style="margin-bottom:8px;">' + withLink(copy.text('referral_ask', vars), PORTAL_URL + '/#referrals', copy.text('referral_link_text', vars)) + '</li>' +
    '</ul>' +
    withLink(copy.paras('closer', vars, 'margin:0 0 16px;'), PORTAL_URL, copy.text('portal_link_text', vars));
  return { subject: noMarks(copy.subject(vars)), inner, signoff: signoffHtml(copy, vars) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now();
  const sent = { winback: 0, onboarding: 0, review: 0, portal: 0, needsInfo: 0, coldLeads: 0, waitingOnUs: 0 };

  try {
    // 1) WIN-BACK: cancelled 20-30 days ago, still inactive, has an email, not yet sent.
    const { data: wb } = await svc.from('clients')
      .select('id, name, email, second_email')
      .eq('status', 'inactive').is('winback_email_at', null)
      .not('cancelled_at', 'is', null).gte('cancelled_at', iso(now - 30 * DAY)).lte('cancelled_at', iso(now - 20 * DAY));
    for (const c of wb ?? []) {
      const to = [c.email, c.second_email].filter(Boolean) as string[];
      if (!to.length) continue;
      const mail = await winbackEmail(svc, c);
      if (await sendEmail(to, mail.subject, mail.inner, mail.signoff)) {
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
      const mail = await onboardingEmail(svc, c);
      if (await sendEmail(to, mail.subject, mail.inner, mail.signoff)) {
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
      const mail = await reviewEmail(svc, c);
      if (await sendEmail(to, mail.subject, mail.inner, mail.signoff)) {
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
      const mail = await portalEmail(svc, c);
      if (await sendEmail(to, mail.subject, mail.inner, mail.signoff)) {
        await svc.from('clients').update({ portal_nudge_at: iso(now) }).eq('id', c.id);
        sent.portal++;
      }
    }

    // ── 5) Needs info, still unanswered ──
    // Three days, not two: a question asked on a Friday should not chase them on a Sunday, and a
    // trade business is out on jobs. One reminder only, stamped so it never becomes a drip.
    try {
      const { data: parked, error: parkedErr } = await svc.from('update_requests')
        .select('id, user_id, type, needs_info_message, needs_info_at, client_reply')
        .eq('status', 'Needs info')
        .not('needs_info_message', 'is', null)
        .is('client_reply', null)
        .is('needs_info_reminded_at', null)
        .lte('needs_info_at', iso(now - 3 * DAY));
      if (parkedErr) {
        console.warn('[lifecycle] needs-info follow-up skipped:', parkedErr.message);   // columns not migrated yet
      } else {
        for (const r of parked ?? []) {
          const { data: c } = await svc.from('clients')
            .select('id, name, email, second_email, status').eq('user_id', r.user_id).maybeSingle();
          if (!c || !c.email || c.status === 'inactive') continue;
          const to = [c.email, c.second_email].filter(Boolean) as string[];
          const mail = await needsInfoEmail(svc, c, r);
          if (await sendEmail(to, mail.subject, mail.inner, mail.signoff)) {
            await svc.from('update_requests').update({ needs_info_reminded_at: iso(now) }).eq('id', r.id);
            sent.needsInfo++;
          }
        }
      }
    } catch (e) { console.error('[lifecycle] needs-info follow-up failed:', e); }

    // ── 6) Inquiries the client never got back to ──
    // The lead inbox is only worth anything if someone rings these people. Two days, so a Friday
    // inquiry is not chased on a Saturday morning, and one nudge per lead so it never becomes a drip.
    try {
      const { data: cold, error: coldErr } = await svc.from('lead_events')
        .select('id, user_id, type, name, created_at')
        .in('type', ['form', 'email'])   // a missed call is not ours to chase, and a booking click is not a question
        .is('contacted_at', null)
        .is('outcome', null)
        .is('lead_nudged_at', null)
        .lte('created_at', iso(now - 2 * DAY))
        .gte('created_at', iso(now - 14 * DAY));   // older than a fortnight is history, not a to-do
      if (coldErr) {
        console.warn('[lifecycle] cold-lead follow-up skipped:', coldErr.message);   // lead_followup.sql not run
      } else {
        const byUser: Record<string, any[]> = {};
        for (const l of cold ?? []) (byUser[l.user_id] = byUser[l.user_id] || []).push(l);
        for (const uid of Object.keys(byUser)) {
          const rows = byUser[uid];
          // One of these a week, at most. The stamp on their other leads is the throttle, so no extra
          // column is needed: if we nudged this client in the last 7 days, leave them alone.
          const { data: recent } = await svc.from('lead_events')
            .select('id').eq('user_id', uid).gte('lead_nudged_at', iso(now - 7 * DAY)).limit(1);
          if (recent && recent.length) continue;
          const { data: c } = await svc.from('clients')
            .select('id, name, email, second_email, status, plan').eq('user_id', uid).maybeSingle();
          if (!c || !c.email || c.status === 'inactive') continue;
          if (!/growth|elite/i.test(String(c.plan || ''))) continue;   // only plans with the lead inbox
          // An explicit opt-out of lead email covers this too. No row means they never chose, and a
          // missed customer is worth one email.
          const { data: pref } = await svc.from('email_prefs').select('lead_digest').eq('user_id', uid).maybeSingle();
          if (pref && pref.lead_digest === false) continue;
          const to = [c.email, c.second_email].filter(Boolean) as string[];
          const mail = await coldLeadsEmail(svc, c, rows);
          if (await sendEmail(to, mail.subject, mail.inner, mail.signoff)) {
            await svc.from('lead_events').update({ lead_nudged_at: iso(now) }).in('id', rows.map((r) => r.id));
            sent.coldLeads++;
          }
        }
      }
    } catch (e) { console.error('[lifecycle] cold-lead follow-up failed:', e); }

    // ── 7) Conversations waiting on us (internal) ──
    // Same rule as the Needs you queue in admin: the last word was theirs. This is the safety net for
    // the day nobody opens the admin page.
    try {
      const dayAgo = iso(now - DAY);
      const [notesR, msgsR, openR, clientsR] = await Promise.all([
        svc.from('client_notes').select('client_id, author, note, created_at').order('created_at', { ascending: false }).limit(500),
        svc.from('request_messages').select('request_id, sender, body, created_at').order('created_at', { ascending: false }).limit(800),
        svc.from('update_requests').select('id, type, user_id, status').neq('status', 'Done'),
        svc.from('clients').select('id, user_id, name, email, status'),
      ]);
      const clients = clientsR.data ?? [];
      const byId: Record<string, any> = {}, byUser: Record<string, any> = {};
      clients.forEach((c: any) => { byId[String(c.id)] = c; byUser[String(c.user_id)] = c; });
      const waiting: { who: string; what: string; at: string }[] = [];
      const seenNote: Record<string, boolean> = {};
      for (const n of notesR.data ?? []) {
        if (!n.client_id || seenNote[n.client_id]) continue;
        seenNote[n.client_id] = true;                       // newest first, so this is the last word
        if (n.author !== 'client' || n.created_at > dayAgo) continue;
        const c = byId[String(n.client_id)];
        if (!c || c.status === 'inactive') continue;
        waiting.push({ who: c.name || c.email || 'Client', what: 'Message: ' + String(n.note || '').replace(/\s+/g, ' ').slice(0, 90), at: n.created_at });
      }
      const openById: Record<string, any> = {};
      (openR.data ?? []).forEach((r: any) => { openById[String(r.id)] = r; });
      const seenReq: Record<string, boolean> = {};
      for (const m of msgsR.data ?? []) {
        if (seenReq[m.request_id]) continue;
        seenReq[m.request_id] = true;
        if (m.sender !== 'client' || m.created_at > dayAgo) continue;
        const r = openById[String(m.request_id)];
        if (!r) continue;                                   // request already done
        const c = byUser[String(r.user_id)];
        if (!c || c.status === 'inactive') continue;
        waiting.push({ who: c.name || c.email || 'Client', what: (r.type || 'Request') + ': ' + String(m.body || '').replace(/\s+/g, ' ').slice(0, 90), at: m.created_at });
      }
      if (waiting.length) {
        waiting.sort((a, b) => (a.at < b.at ? -1 : 1));
        // This one is our own alert, so it keeps its own key and its own words: nothing here is
        // shared with the chase we send the client, which must never change when this is reworded.
        const copy = await emailCopy(svc, 'team-waiting', {
          subject: 'Waiting on you: {{waiting_count}} {{reply_word}}',
          slots: {
            lead: '{{waiting_count}} {{conversation_word}} {{is_are}} waiting on a reply from us, oldest first.',
            row_waiting: 'waiting {{days}} {{day_word}}',
            button: 'Open the queue',
            signoff: 'Best,\nWebEaze Web Design',
          },
        });
        const many = waiting.length !== 1;
        const vars = {
          waiting_count: waiting.length,
          reply_word: many ? 'replies' : 'reply',
          conversation_word: many ? 'conversations' : 'conversation',
          is_are: many ? 'are' : 'is',
        };
        const rows = waiting.map((w) => {
          const days = Math.max(1, Math.round((now - new Date(w.at).getTime()) / DAY));
          return '<p style="margin:0 0 10px;"><b>' + esc(w.who) + '</b> &middot; '
            + copy.text('row_waiting', { ...vars, days, day_word: days === 1 ? 'day' : 'days' })
            + '<br><span style="color:#5b6079;">' + esc(w.what) + '</span></p>';
        }).join('');
        const inner = copy.paras('lead', vars, 'margin:0 0 16px;') + rows
          + btn('https://portal.webeaze.io/admin#pulse', copy.text('button', vars));
        if (await sendEmail(['billy@webeaze.io'], copy.subject(vars), inner, signoffHtml(copy, vars))) sent.waitingOnUs++;
      }
    } catch (e) { console.error('[lifecycle] waiting-on-us digest failed:', e); }

    console.log('[lifecycle] sent', JSON.stringify(sent));
    return json({ ok: true, sent });
  } catch (e) {
    console.error('[lifecycle] error:', e);
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});
