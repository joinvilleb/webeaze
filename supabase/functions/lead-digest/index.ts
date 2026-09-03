// Supabase Edge Function: lead-digest
// End-of-day lead summary. Runs once a day after business hours and emails each client a recap of the
// leads their website captured that day, instead of pinging them on every single lead. Every lead is
// already recorded live by track-lead and shows in the client's portal; this is the one email that says
// "here is who reached out today, follow up now." Growth/Elite clients get each lead's contact details
// and a one-tap call/reply; other plans get the count and a nudge to open their portal. A client with
// no leads that day gets no email, and neither does one who switched the daily summary off on the
// Leads page of their portal (public.email_prefs.lead_digest, see supabase/email_prefs.sql).
//
// Deploy:  supabase functions deploy lead-digest --no-verify-jwt
// Secrets: CRON_SECRET, RESEND_API_KEY  (+ the platform SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// Schedule: see supabase/lead_digest.sql (pg_cron, daily after 5pm ET, x-cron-secret header)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const TYPE_LABEL: Record<string, string> = { form: 'form submission', call: 'phone call', email: 'email click', contact: 'quote or booking request' };

// What the leads with NO contact details actually were, in plain words.
//
// A tap on your phone number or your email link is a real lead, but it leaves us nothing to show:
// no name, no message, nothing to open in the portal. The digest used to lump these into a vague
// "N more waiting in your portal", which sent people looking for something that was not there.
// Better to say what happened and where the details live: their phone or their inbox.
const ANON_PHRASE: Record<string, (n: number) => string> = {
  call: (n) => n === 1 ? 'Someone tapped your phone number' : n + ' people tapped your phone number',
  email: (n) => n === 1 ? 'Someone clicked your email link' : n + ' people clicked your email link',
};
function anonSummary(leads: any[]): string {
  const anon = leads.filter((l: any) => !(l.name || l.email || l.phone || l.message));
  if (!anon.length) return '';
  const byType: Record<string, number> = {};
  anon.forEach((l: any) => { byType[l.type] = (byType[l.type] || 0) + 1; });
  const parts = Object.keys(byType).map((t) => {
    const n = byType[t];
    const phrase = ANON_PHRASE[t];
    return phrase ? phrase(n) : (n === 1 ? 'Someone got in touch' : n + ' people got in touch');
  });
  const tail = parts.some((x) => /phone/.test(x))
    ? ', so look for them in your call log rather than the portal.'
    : ', so there is no message to read.';
  return parts.join(' and ') + tail;
}
const plural = (n: number, w: string) => n + ' ' + w + (n === 1 ? '' : 's');

async function sendEmail(payload: Record<string, unknown>) {
  if (!RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const AI_MODEL = 'claude-sonnet-5';
const stripDash = (s: string) => String(s || '').replace(/\s*—\s*/g, ', ');

// Pre-draft a warm, ready-to-send reply for one lead, tailored to HOW it came in, so the owner can act
// straight from the email. Best-effort: returns null on any failure (the card then just shows contacts).
async function draftReply(bizName: string, lead: any): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const CHANNEL: Record<string, string> = {
    form: lead.message ? ('They sent this through the website contact form: "' + String(lead.message).slice(0, 800) + '"') : 'They submitted the website contact form but left no message.',
    call: 'They clicked to call the business from the website, so they are ready to talk.',
    email: 'They clicked to email the business from the website.',
    contact: 'They clicked to book an appointment or request a quote from the website.',
  };
  const enquiry = (lead.name ? ('Their name: ' + String(lead.name).slice(0, 80) + '\n') : '') + (CHANNEL[lead.type] || 'A customer reached out through the website.');
  const system = "You are a small trade business owner writing a warm, professional follow-up reply to a customer inquiry you just received. Thank them, acknowledge what they asked about, and move things forward with a clear next step (a quick call, a quote, or a visit). Sound like a real, friendly, confident person, not a corporate script. Keep it short and ready to send. Do NOT invent specific facts like prices or dates unless the inquiry gives them. NEVER use em dashes. Return ONLY the reply text, no subject line, preamble, or quotes.";
  const userMsg = 'Business name: ' + bizName + '\nThe customer inquiry:\n' + enquiry;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 800, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const text = (Array.isArray(d.content) ? d.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '').trim();
    return text ? stripDash(text) : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Window: the trailing 24h. The cron fires once a day, so this is exactly one day's leads with no gap
  // or overlap. An optional { hours } in the body lets a manual test widen the window.
  const body = await req.json().catch(() => ({} as any));
  const hours = Math.min(Math.max(Number(body?.hours) || 24, 1), 168);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const clientsP = service.from('clients').select('user_id, name, email, second_email, plan, status, site_url').neq('status', 'inactive');
  // Pull the window's leads with details; if the detail columns are not there yet, fall back to counts.
  let leadsR = await service.from('lead_events').select('user_id, type, page, name, email, phone, message, created_at').gte('created_at', since).order('created_at', { ascending: false });
  if (leadsR.error) leadsR = await service.from('lead_events').select('user_id, type, page, created_at').gte('created_at', since).order('created_at', { ascending: false });
  const clientsR = await clientsP;
  // Clients who switched the daily digest off in their portal (Leads -> "Email me a daily summary").
  // No row means opted in, so nothing needs backfilling; a missing table means nobody has opted out yet.
  const optedOut = new Set<string>();
  {
    const { data: prefs } = await service.from('email_prefs').select('user_id, lead_digest').eq('lead_digest', false);
    (prefs || []).forEach((p: any) => { if (p.user_id) optedOut.add(p.user_id); });
  }

  const clientBy: Record<string, any> = {};
  (clientsR.data || []).forEach((c: any) => { if (c.user_id) clientBy[c.user_id] = c; });

  // Group the window's leads by client (skip any whose client is inactive, unknown, or opted out).
  const byClient: Record<string, any[]> = {};
  (leadsR.data || []).forEach((l: any) => {
    if (!l.user_id || !clientBy[l.user_id] || optedOut.has(l.user_id)) return;
    (byClient[l.user_id] || (byClient[l.user_id] = [])).push(l);
  });

  const targets = Object.keys(byClient);
  if (!targets.length) return json({ ok: true, clients: 0, optedOut: optedOut.size, note: 'no leads in window' });

  let sent = 0;
  // Send in small concurrent batches so a growing client base never times out or trips Resend limits.
  const BATCH = 6;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    await Promise.all(slice.map(async (uid) => {
      const c = clientBy[uid];
      if (!c.email) return;
      const leads = byClient[uid];
      const adv = /growth|elite/i.test(String(c.plan || ''));
      const first = String(c.name || '').trim().split(/\s+/)[0] || 'there';
      const n = leads.length;

      // Summary line: count by type.
      const counts: Record<string, number> = {};
      leads.forEach((l: any) => { counts[l.type] = (counts[l.type] || 0) + 1; });
      // One sentence, not three. The subject already says "Your website got 1 lead today", the
      // headline said "You got 1 new lead today.", and then a bare fragment said "1 quote or booking
      // request." Three lines to convey one fact, the first two nearly identical.
      const parts = Object.keys(counts).map((t) => plural(counts[t], TYPE_LABEL[t] || t));
      const breakdown = parts.length > 1
        ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
        : (parts[0] || '');
      // "1 phone call" reads badly mid sentence; "a phone call" reads like a person wrote it.
      const one = breakdown.replace(/^1 /, /^[aeiou]/i.test(breakdown.slice(2)) ? 'an ' : 'a ');
      const headline = n === 1
        ? ('You got a new lead today' + (one ? ': ' + one : '') + '.')
        : ('You got ' + n + ' new leads today' + (breakdown ? ': ' + breakdown : '') + '.');

      // Growth/Elite: one card per lead with contact details, a ready-to-send AI-drafted reply, and a
      // one-tap Call / Reply now (pre-filled with the draft) so they can act straight from the email.
      let detailBlock = '';
      let contactable = 0;   // leads with a name, number, email or message: someone you can act on
      if (adv) {
        const withDetails = leads.filter((l: any) => l.name || l.email || l.phone || l.message);
        const shown = withDetails.slice(0, 20);
        contactable = shown.length;
        // Pre-draft a reply for the most recent few leads worth replying to (capped to bound cost/time).
        const toDraft = shown.filter((l: any) => l.message || l.email).slice(0, 5);
        const drafts = new Map<any, string>();
        await Promise.all(toDraft.map(async (l: any) => { const r = await draftReply(c.name || '', l); if (r) drafts.set(l, r); }));
        const btn = (href: string, label: string) => '<a href="' + href + '" style="display:inline-block;background:#7851a9;color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:8px 16px;border-radius:8px;margin:10px 8px 0 0;">' + label + '</a>';
        const cards = shown.map((l: any) => {
          const rows: string[] = [];
          if (l.name) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;">Name</td><td style="padding:4px 0;font-weight:700;font-size:14px;">' + esc(l.name) + '</td></tr>');
          if (l.phone) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;">Phone</td><td style="padding:4px 0;font-weight:700;font-size:14px;"><a href="tel:' + esc(l.phone) + '" style="color:#7851a9;text-decoration:none;">' + esc(l.phone) + '</a></td></tr>');
          if (l.email) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;">Email</td><td style="padding:4px 0;font-weight:700;font-size:14px;"><a href="mailto:' + esc(l.email) + '" style="color:#7851a9;text-decoration:none;">' + esc(l.email) + '</a></td></tr>');
          if (l.message) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;vertical-align:top;">Message</td><td style="padding:4px 0;font-size:14px;">' + esc(l.message) + '</td></tr>');
          const draft = drafts.get(l);
          const draftBlock = draft
            ? '<div style="background:#ffffff;border:1px solid #ece9f4;border-radius:8px;padding:10px 12px;margin-top:10px;"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7851a9;margin-bottom:5px;">Suggested reply, ready to send</div><div style="font-size:13px;color:#1e222b;line-height:1.55;white-space:pre-wrap;">' + esc(draft) + '</div></div>'
            : '';
          const ctas: string[] = [];
          if (l.phone) ctas.push(btn('tel:' + esc(l.phone), 'Call ' + esc(l.name || l.phone)));
          if (l.email) {
            const to = String(l.email).replace(/[<>"\s]/g, '');
            const mailto = 'mailto:' + to + '?subject=' + encodeURIComponent('Re: your inquiry') + '&amp;body=' + encodeURIComponent(draft || ('Hi ' + (l.name || 'there') + ',\n\n'));
            ctas.push(btn(mailto, draft ? 'Reply now' : 'Reply to ' + esc(l.name || l.email)));
          }
          return '<div style="background:#f7f6fb;border:1px solid #ece9f4;border-radius:10px;padding:12px 14px;margin:0 0 10px;"><table style="border-collapse:collapse;"><tbody>' + rows.join('') + '</tbody></table>' + draftBlock + '<div>' + ctas.join('') + '</div></div>';
        }).join('');
        // Leads BEYOND the 20 we showed. It used to be n - shown.length, where n is every lead and
        // shown is only the ones with contact details, so a single anonymous lead produced no card and
        // was then announced as "1 more waiting in your portal": the same lead, counted twice, in an
        // email whose whole job is to tell you how many you got.
        const moreN = withDetails.length - shown.length;
        const moreLine = moreN > 0 ? '<p style="font-size:13px;color:#6b7280;margin:2px 0 0;">And ' + moreN + ' more in your portal.</p>' : '';
        // Leads with nothing to show: someone tapped the phone number or the email link. There is no
        // card to render and nothing waiting for them in the portal either, so say what happened
        // instead of implying there is more to read.
        const anonN = n - withDetails.length;
        const anonLine = anonN > 0
          ? '<p style="font-size:14px;color:#6b7280;margin:' + (cards ? '10px' : '0') + ' 0 0;">' + anonSummary(leads) + '</p>'
          : '';
        detailBlock = cards + moreLine + anonLine;
      }

      const inner = '<p style="margin:0 0 12px;">Hi ' + esc(first) + ',</p>'
        + '<p style="margin:0 0 6px;"><strong style="font-size:17px;">' + headline + '</strong></p>'
        + detailBlock
        // Only push follow-up when there is someone to follow up WITH. Telling a client to move fast
        // on a lead that left no name and no number is advice they cannot act on, and it sends them
        // into the portal looking for contact details that were never captured.
        + (contactable > 0
            ? '<p style="margin:14px 0 16px;">The faster you follow up, the more likely you are to win the job.</p>'
            : adv
              ? '<p style="margin:14px 0 16px;">Nothing to reply to on this one, but it is a sign your site is doing its job.</p>'
              : '<p style="margin:6px 0 16px;">Open your portal to see them and follow up.</p>')
        + '<p style="margin:0 0 18px;"><a href="' + PORTAL_URL + '" style="display:inline-block;background:#7851a9;color:#fff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:9px;">Open your portal</a></p>';

      const subject = n === 1 ? 'Your website got 1 lead today' : 'Your website got ' + n + ' leads today';

      await sendEmail({
        from: FROM,
        to: [c.email, c.second_email].filter(Boolean),
        subject,
        html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e222b;line-height:1.6;max-width:520px;">'
          + inner
          + '<p style="color:#6b7280;font-size:12.5px;border-top:1px solid #eee;padding-top:12px;margin-top:8px;">This is your daily lead summary from WebEaze. Every lead is also in <a href="' + PORTAL_URL + '" style="color:#7851a9;text-decoration:underline;">your portal</a> in real time. To stop these daily emails, open <a href="' + PORTAL_URL + '/#leads" style="color:#7851a9;text-decoration:underline;">Leads in your portal</a> and switch off the daily summary.</p>'
          + '<p style="color:#6b7280;font-size:12.5px;">The WebEaze team</p>'
          + '</div>',
      });
      sent++;
    }));
  }

  return json({ ok: true, clients: targets.length, sent, optedOut: optedOut.size });
});
