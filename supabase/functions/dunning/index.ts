// Supabase Edge Function: dunning
// Chases a failed card so a bounced payment is not silent.
//
// Before this, stripe-webhook listened only for invoice.paid, clients.payment_failed was a checkbox
// an admin ticked by hand, and payment-status could show a "update your card" nudge only to a client
// who happened to open the portal. A card could fail, Stripe could retry and give up, and the first
// anyone heard was the client asking why their site was gone.
//
// Three emails, escalating, each sent at most once per run of failures:
//   stage 1  the moment Stripe reports the failure   friendly, things happen
//   stage 2  three days in                           firmer, names the amount
//   stage 3  seven days in                           says plainly what happens next
// A successful payment closes the case, and anyone who was actually chased gets a short all-clear.
//
// Called two ways:
//   { user_id }  one client, right now. stripe-webhook does this on invoice.payment_failed.
//   {}           the daily sweep, which sends the day-three and day-seven emails.
//
// Deploy:  supabase functions deploy dunning --no-verify-jwt
// Secrets: CRON_SECRET, RESEND_API_KEY (+ platform SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// Needs:   supabase/dunning.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { emailCopy } from '../_shared/email-template.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';
const CARD_URL = PORTAL_URL + '/#billing';
const DAY = 86400000;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const firstName = (name?: string) => (String(name || '').trim().split(/\s+/)[0] || 'there');
const money = (n: unknown) => { const v = Number(n); return v > 0 ? '$' + (Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, '') : ''; };

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
    if (!res.ok) { console.error('[dunning] resend ' + res.status + ': ' + (await res.text()).slice(0, 160)); return false; }
    return true;
  } catch (e) { console.error('[dunning] send failed:', e); return false; }
}
const btn = (href: string, label: string) =>
  '<p style="margin:0 0 20px;"><a href="' + href + '" style="display:inline-block;background:#7851a9;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">' + esc(label) + '</a></p>';
const signoffHtml = (copy: any, vars: any) =>
  (copy.text('signoff', vars) || 'Best,\nWebEaze Web Design').split('\n')
    .map((line: string, i: number) => '<p style="' + (i === 0 ? 'margin:0 0 4px;' : 'margin:0;') + '">' + line.trim() + '</p>').join('');

// Every address we have for them. A billing email that reaches only one inbox is the one that gets
// missed, and this is the message where being missed costs them the site.
function mailTo(c: any): string[] {
  return [c.email, c.second_email].map((e) => String(e || '').trim().toLowerCase())
    .filter((e, i, a) => e && e.includes('@') && a.indexOf(e) === i);
}

// ── The three chases, plus the all-clear. Wording editable in admin like the rest. ──
async function buildEmail(svc: any, c: any, stage: number) {
  const vars = { first_name: firstName(c.name), amount: money(c.plan_amount), business: String(c.business_name || c.name || 'your business') };
  if (stage === 1) {
    const copy = await emailCopy(svc, 'dunning-first', {
      subject: 'Your card didn\'t go through',
      slots: {
        greeting: 'Hey {{first_name}},',
        lead: 'Your card was declined when we tried to take this month\'s payment. It happens all the time, usually an expired card or a bank being careful, and it takes a minute to sort.',
        reassure: 'Nothing has changed with your website and nothing is at risk today. We\'ll try the card again over the next few days.',
        button: 'Update your card',
        closer: 'If the card is fine and you think this is a mistake, just reply to this email and we\'ll look into it with you.',
        signoff: 'Best,\nWebEaze Web Design',
      },
    });
    return { copy, vars, inner:
      '<p style="margin:0 0 16px;">' + copy.text('greeting', vars) + '</p>' +
      copy.paras('lead', vars) + copy.paras('reassure', vars) +
      btn(CARD_URL, copy.text('button', vars)) + copy.paras('closer', vars) };
  }
  if (stage === 2) {
    const copy = await emailCopy(svc, 'dunning-second', {
      subject: 'Still no luck with your card',
      slots: {
        greeting: 'Hey {{first_name}},',
        lead: 'We\'ve tried your card a few times since Tuesday and it\'s still being declined, so this month\'s payment hasn\'t gone through.',
        ask: 'Updating the card takes about a minute and puts everything straight away. Your site, your email and your updates all carry on as normal once it goes through.',
        button: 'Update your card',
        closer: 'If something has changed on your end, or now isn\'t a good time, reply and tell us. We\'d far rather work it out with you than have this run on.',
        signoff: 'Best,\nWebEaze Web Design',
      },
    });
    return { copy, vars, inner:
      '<p style="margin:0 0 16px;">' + copy.text('greeting', vars) + '</p>' +
      copy.paras('lead', vars) + copy.paras('ask', vars) +
      btn(CARD_URL, copy.text('button', vars)) + copy.paras('closer', vars) };
  }
  if (stage === 3) {
    const copy = await emailCopy(svc, 'dunning-final', {
      subject: 'Your website is at risk',
      slots: {
        greeting: 'Hey {{first_name}},',
        lead: 'It\'s been a week and your card is still being declined, so this month\'s payment is outstanding.',
        warn: 'We have to be straight with you about what happens next: once a subscription lapses, the hosting it pays for goes with it, and that takes the website offline. We don\'t want that and we won\'t do it without talking to you first.',
        button: 'Update your card',
        closer: 'If money is tight right now, say so. We\'ve sorted out payment plans with people before and we\'d rather do that than lose you over a bad month.',
        signoff: 'Best,\nWebEaze Web Design',
      },
    });
    return { copy, vars, inner:
      '<p style="margin:0 0 16px;">' + copy.text('greeting', vars) + '</p>' +
      copy.paras('lead', vars) + copy.paras('warn', vars) +
      btn(CARD_URL, copy.text('button', vars)) + copy.paras('closer', vars) };
  }
  const copy = await emailCopy(svc, 'dunning-cleared', {
    subject: 'That\'s sorted, thank you',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: 'Your payment went through, so that\'s all sorted. Nothing more for you to do, and thank you for getting it sorted quickly.',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  return { copy, vars, inner: '<p style="margin:0 0 16px;">' + copy.text('greeting', vars) + '</p>' + copy.paras('lead', vars) };
}

async function chase(svc: any, c: any, stage: number) {
  const to = mailTo(c);
  if (!to.length) { console.warn('[dunning] no address for ' + c.user_id); return false; }
  const { copy, vars, inner } = await buildEmail(svc, c, stage);
  const ok = await sendEmail(to, copy.subject(vars), inner, signoffHtml(copy, vars));
  if (!ok) return false;
  if (stage >= 1 && stage <= 3) {
    await svc.from('clients').update({ dunning_stage: stage, dunning_last_at: new Date().toISOString() }).eq('user_id', c.user_id);
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  // Called by cron and by stripe-webhook, never by a browser, so it is the secret or nothing.
  if (CRON_SECRET && req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({} as any));
  const one = String(body.user_id || '').trim();
  const sel = 'user_id, name, business_name, email, second_email, plan_amount, payment_failed_at, dunning_stage, status';

  try {
    // One client, immediately. Two moments call this: the failure Stripe just reported, and the
    // payment that cleared it.
    if (one) {
      const { data: c } = await svc.from('clients').select(sel).eq('user_id', one).maybeSingle();
      if (!c) return json({ ok: true, skipped: 'no client' });
      // The all-clear. The case is already closed by the time this runs, so it cannot check for an
      // open one: the webhook only asks for this when it just closed a case it had chased.
      if (String(body.mode || '') === 'cleared') {
        const sent = await chase(svc, c, 0);
        return json({ ok: true, sent, stage: 'cleared' });
      }
      if (!c.payment_failed_at) return json({ ok: true, skipped: 'no open case' });
      if (Number(c.dunning_stage) >= 1) return json({ ok: true, skipped: 'already chased' });
      const sent = await chase(svc, c, 1);
      return json({ ok: true, sent, stage: 1 });
    }

    // The daily sweep. Only the follow-ups: stage 1 has already gone out on the webhook.
    const { data: open } = await svc.from('clients').select(sel).not('payment_failed_at', 'is', null);
    const rows = open || [];
    const now = Date.now();
    let sent = 0, skipped = 0;
    for (const c of rows) {
      // An inactive account is not chased for money. They have already gone.
      if (String(c.status || '').toLowerCase() === 'inactive') { skipped++; continue; }
      const days = (now - new Date(c.payment_failed_at).getTime()) / DAY;
      const stage = Number(c.dunning_stage) || 0;
      // Where the calendar says we should be...
      const byTime = days >= 7 ? 3 : days >= 3 ? 2 : 1;
      // ...but never more than one step past where we are. Two cases this gets right that a purely
      // time-based stage gets wrong: if the first email failed to send, the client would otherwise
      // open with "still no luck with your card" having never been told there was any; and if the
      // job misses a few days, they would jump from the friendly note straight to "your website is
      // at risk". Either way they get the sequence in order, a day later than ideal.
      const want = Math.min(stage + 1, byTime);
      if (want <= stage) { skipped++; continue; }
      if (await chase(svc, c, want)) sent++;
    }
    return json({ ok: true, open: rows.length, sent, skipped });
  } catch (e) {
    console.error('[dunning] error:', e);
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
});
