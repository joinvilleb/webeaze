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
//   6) Cold leads     — 2 days after a WRITTEN enquiry (form or email) that is not marked handled.
//                      Deliberately cautious: almost nobody marks leads contacted (5 of 2105 when
//                      this was written), so "not marked" cannot be read as "ignored". Hence: written
//                      enquiries only, since a missed call is not something we can chase; a reminder
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

function coldLeadsInner(c: any, rows: any[]) {
  const KIND: Record<string, string> = { form: 'a form enquiry', call: 'a phone call', email: 'an email', booking: 'a booking click' };
  const list = rows.slice(0, 6).map((l) => {
    const when = new Date(l.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    return '<p style="margin:0 0 8px;">' + esc(l.name || KIND[l.type] || 'An enquiry') + ' &middot; ' + esc(when) + '</p>';
  }).join('');
  const more = rows.length > 6 ? '<p style="margin:0 0 8px;color:#5b6079;">and ' + (rows.length - 6) + ' more</p>' : '';
  return '<p style="margin:0 0 16px;">Hey ' + esc(firstName(c.name)) + ',</p>' +
    '<p style="margin:0 0 16px;">' + (rows.length === 1 ? 'An enquiry came in through your website this week and is not marked as handled yet.' : rows.length + ' enquiries came in through your website this week and are not marked as handled yet.') + '</p>' +
    list + more +
    '<p style="margin:16px 0;">If you have already got back to ' + (rows.length === 1 ? 'them' : 'them all') + ', mark ' + (rows.length === 1 ? 'it' : 'them') + ' done in your portal and we will stop mentioning ' + (rows.length === 1 ? 'it' : 'them') + '. If not, most people ring two or three businesses and go with whoever answers first, so today is worth more than tomorrow.</p>' +
    btn(PORTAL_URL + '/#leads', 'Open your leads') +
    '<p style="margin:0 0 16px;">We send this at most once a week, and never twice about the same enquiry.</p>';
}

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
// The follow-up quotes the ORIGINAL question. A bare "we are still waiting on you" makes them open
// the portal to find out what for, which is the friction that stalled the request in the first place.
function needsInfoInner(c: any, r: any) {
  return '<p style="margin:0 0 16px;">Hey ' + esc(firstName(c.name)) + ',</p>' +
    '<p style="margin:0 0 14px;">We are still waiting to hear back on your ' +
      esc(String(r.type || 'request').toLowerCase()) + ' request. It is paused until we do.</p>' +
    '<p style="margin:0 0 8px;">This is what we asked:</p>' +
    '<div style="background:#f7f7fa;border:1px solid #e4e7f1;border-left:3px solid #7851a9;border-radius:8px;padding:14px 16px;margin:0 0 18px;white-space:pre-wrap;">' +
      esc(r.needs_info_message) + '</div>' +
    btn(PORTAL_URL + '/#history/' + encodeURIComponent(String(r.id)), 'Answer in your portal') +
    '<p style="margin:16px 0 0;">You can also just reply to this email and we will pick it up from there.</p>';
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
          if (await sendEmail(to, 'Still waiting on you: ' + String(r.type || 'your request'), needsInfoInner(c, r))) {
            await svc.from('update_requests').update({ needs_info_reminded_at: iso(now) }).eq('id', r.id);
            sent.needsInfo++;
          }
        }
      }
    } catch (e) { console.error('[lifecycle] needs-info follow-up failed:', e); }

    // ── 6) Enquiries the client never got back to ──
    // The lead inbox is only worth anything if someone rings these people. Two days, so a Friday
    // enquiry is not chased on a Saturday morning, and one nudge per lead so it never becomes a drip.
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
          if (await sendEmail(to, rows.length === 1 ? 'An enquiry is still waiting for you' : rows.length + ' enquiries are still waiting for you', coldLeadsInner(c, rows))) {
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
        const rows = waiting.map((w) => {
          const days = Math.max(1, Math.round((now - new Date(w.at).getTime()) / DAY));
          return '<p style="margin:0 0 10px;"><b>' + esc(w.who) + '</b> &middot; waiting ' + days + (days === 1 ? ' day' : ' days')
            + '<br><span style="color:#5b6079;">' + esc(w.what) + '</span></p>';
        }).join('');
        const inner = '<p style="margin:0 0 16px;">' + waiting.length + (waiting.length === 1 ? ' conversation is' : ' conversations are')
          + ' waiting on a reply from us, oldest first.</p>' + rows
          + btn('https://portal.webeaze.io/admin#pulse', 'Open the queue');
        if (await sendEmail(['billy@webeaze.io'], 'Waiting on you: ' + waiting.length + (waiting.length === 1 ? ' reply' : ' replies'), inner)) sent.waitingOnUs++;
      }
    } catch (e) { console.error('[lifecycle] waiting-on-us digest failed:', e); }

    console.log('[lifecycle] sent', JSON.stringify(sent));
    return json({ ok: true, sent });
  } catch (e) {
    console.error('[lifecycle] error:', e);
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});
