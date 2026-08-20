// Supabase Edge Function: track-lead
// Records a lead event (form submit / click-to-call / click-to-email / contact-CTA) sent by the
// WebEaze track.js snippet running on a client's website. Public endpoint, called cross-origin from
// client sites, so it allows any origin and never returns an error the browser would log.
//
// Body: { key: '<client user_id>', type: 'form'|'call'|'email'|'contact', page?: string,
//         name?, email?, phone?, message? }   the last four (form details) are kept for Growth clients only
//
// A FORM lead emails the client instantly (Growth/Elite only, since only those plans store the
// enquirer's details); every other type is recorded silently. The lead-digest function still sends
// the end-of-day recap for everyone, so a busy site gets one summary rather than a flood.
// Why instant: for a trade business the job usually goes to whoever calls back first, so a digest at
// 5pm is worthless for a lead that arrived at 8am.
//
// Deploy:  supabase functions deploy track-lead --no-verify-jwt
// (--no-verify-jwt because the caller is an anonymous visitor on the client's site, not a
//  logged-in Supabase user. The `key` identifies the client; the origin is checked below.)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['form', 'call', 'email', 'contact', 'order']);

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

// Email the client the moment a real enquiry lands, with everything needed to answer it from the
// phone in their hand: who, what they said, and one-tap call / reply links.
async function alertLead(client: any, lead: any) {
  if (!RESEND_API_KEY) return;
  const to = [client && client.email, client && client.second_email].filter(Boolean);
  if (!to.length) return;
  const who = lead.name || 'Someone';
  const first = String((client && client.name) || '').trim().split(/\s+/)[0] || 'there';
  const ctx = [lead.device === 'mobile' ? 'on a phone' : lead.device === 'tablet' ? 'on a tablet' : lead.device === 'desktop' ? 'on a computer' : '',
    lead.source && lead.source !== 'direct' ? 'from ' + lead.source.replace(/^www\./, '') : ''].filter(Boolean).join(', ');
  const btn = (href: string, label: string, bg: string) =>
    '<a href="' + esc(href) + '" style="display:inline-block;background:' + bg + ';color:#ffffff;text-decoration:none;'
    + 'border-radius:9px;padding:12px 20px;font-weight:700;font-size:15px;margin:0 8px 8px 0;">' + esc(label) + '</a>';
  const actions = [
    lead.phone ? btn('tel:' + String(lead.phone).replace(/[^0-9+]/g, ''), 'Call ' + (lead.name || 'them'), '#7851a9') : '',
    lead.email ? btn('mailto:' + lead.email + '?subject=' + encodeURIComponent('Re: your enquiry'), 'Reply by email', '#4b5563') : '',
  ].join('');
  const row = (k: string, v: string) => v
    ? '<tr><td style="padding:5px 14px 5px 0;color:#6b7094;font-size:14px;white-space:nowrap;">' + k + '</td>'
      + '<td style="padding:5px 0;color:#1f2333;font-size:15px;font-weight:600;">' + v + '</td></tr>' : '';
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">'
    + '<style>:root{color-scheme:light dark}@media (prefers-color-scheme:dark){'
    + '.wz-page{background:#0f1116!important}.wz-card{background:#1a1d25!important;border-color:#2b2f3d!important}'
    + '.wz-t,.wz-t *{color:#e9eaf2!important}.wz-m,.wz-m *{color:#a7adc6!important}.wz-box{background:#22262f!important}}</style>'
    + '</head><body class="wz-page" style="margin:0;background:#f4f5fa;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="wz-page" style="background:#f4f5fa;">'
    + '<tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" class="wz-card" style="width:100%;max-width:520px;background:#ffffff;border:1px solid #e4e7f1;border-radius:14px;">'
    + '<tr><td style="padding:26px 24px;font-family:Helvetica,Arial,sans-serif;">'
    + '<p class="wz-m" style="margin:0 0 4px;font-size:13px;color:#6b7094;">Hi ' + esc(first) + ', a new enquiry just came in</p>'
    + '<h1 class="wz-t" style="margin:0 0 14px;font-size:21px;color:#1f2333;">' + esc(who) + ' wants to hear from you</h1>'
    + (lead.message ? '<div class="wz-box" style="background:#f8f9fc;border-radius:10px;padding:14px 16px;margin:0 0 16px;">'
        + '<p class="wz-t" style="margin:0;font-size:15px;line-height:1.55;color:#1f2333;white-space:pre-wrap;">' + esc(lead.message) + '</p></div>' : '')
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">'
    + row('Phone', esc(lead.phone)) + row('Email', esc(lead.email))
    + row('Page', esc(lead.page)) + row('Context', esc(ctx)) + '</table>'
    + actions
    + '<p class="wz-m" style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7094;">'
    + 'Replying quickly is the single biggest thing that wins this job. Everything is also in your '
    + '<a href="https://portal.webeaze.io" style="color:#7851a9;font-weight:600;">portal</a>.</p>'
    + '</td></tr></table></td></tr></table></body></html>';
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify({ from: FROM, to, reply_to: lead.email || undefined, subject: 'New enquiry: ' + who + (lead.phone ? ' (' + lead.phone + ')' : ''), html }),
  }).catch(() => {});
}

const host = (u: string) => (u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return ok({ ok: true, skipped: 'method' });
  try {
    // The snippet sends text/plain (a safelisted content type) to avoid a CORS preflight;
    // req.json() parses the body regardless of the header.
    const body = await req.json().catch(() => ({} as any));
    const key = String(body.key || '').trim().toLowerCase();
    const type = String(body.type || '').trim().toLowerCase();
    if (!UUID.test(key) || !TYPES.has(type)) return ok({ ok: true, skipped: 'bad params' });

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: client } = await service.from('clients').select('user_id, site_url, plan, name, business_name, email, second_email').eq('user_id', key).maybeSingle();
    if (!client) return ok({ ok: true, skipped: 'no client' });

    // Light spam guard: if we know the client's site host, only accept events posted from it.
    const siteHost = host(client.site_url || '');
    const originHost = host(req.headers.get('origin') || req.headers.get('referer') || '');
    if (siteHost && originHost && originHost !== siteHost) return ok({ ok: true, skipped: 'origin' });

    const page = String(body.page || '').slice(0, 300) || null;
    const clean = (v: unknown, max: number) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };

    // Completed e-commerce order (WooCommerce "order received" page). The amount is the sale total and
    // order_ref is the store order id — the client's OWN revenue data, not visitor PII, so it's kept for
    // every plan. De-dupe on order_ref so a refresh/return to the thank-you page never re-counts a sale.
    let amount: number | null = null, orderRef: string | null = null;
    if (type === 'order') {
      const n = Number(body.amount);
      amount = Number.isFinite(n) && n >= 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
      orderRef = clean(body.order_ref, 80);
      if (orderRef) {
        const { data: dup } = await service.from('lead_events')
          .select('id').eq('user_id', key).eq('order_ref', orderRef).maybeSingle();
        if (dup) return ok({ ok: true, skipped: 'dup order' });
      }
    }

    // Growth/Elite clients get the actual lead details (a follow-up inbox in the portal). Every other
    // plan stores only the count, so a visitor's personal details are never kept for a plan that would
    // not use them. Details only come from a form submit (calls/emails/CTA clicks carry none).
    const adv = /growth|elite/i.test(String(client.plan || ''));
    const name = adv && type === 'form' ? clean(body.name, 120) : null;
    const email = adv && type === 'form' ? clean(body.email, 160) : null;
    const phone = adv && type === 'form' ? clean(body.phone, 40) : null;
    const message = adv && type === 'form' ? clean(body.message, 1200) : null;
    const hasDetails = !!(name || email || phone || message);

    // Context, not identity: device, where the visit came from, and which of the client's own
    // numbers/addresses was tapped. None of it describes the person, so unlike the form details above
    // it is kept for every plan. It is also what makes a call lead readable at all, since a tap on a
    // phone number carries nothing else.
    const DEVICES = new Set(['mobile', 'tablet', 'desktop']);
    const dev = clean(body.device, 12);
    const device = dev && DEVICES.has(dev) ? dev : null;
    const source = clean(body.source, 80);
    const target = clean(body.target, 160);

    const row: Record<string, unknown> = { user_id: key, type, page };
    if (device) row.device = device;
    if (source) row.source = source;
    if (target) row.target = target;
    if (type === 'order') { if (amount != null) row.amount = amount; if (orderRef) row.order_ref = orderRef; }
    if (hasDetails) { row.name = name; row.email = email; row.phone = phone; row.message = message; }

    const ins = await service.from('lead_events').insert(row);
    if (ins.error) {
      const msg = String(ins.error.message || '').toLowerCase();
      // A unique-violation on an order = the de-dupe backstop firing; do not re-insert a bare row.
      if (type === 'order' && (ins.error.code === '23505' || msg.includes('duplicate') || msg.includes('unique'))) {
        return ok({ ok: true, skipped: 'dup order' });
      }
      // Otherwise the newer columns probably are not there yet (migration not run) — fall back to a
      // count-only row so lead recording never breaks.
      await service.from('lead_events').insert({ user_id: key, type, page });
    }

    // A form lead is the one type worth interrupting someone for. The daily digest still runs, but a
    // digest at 5pm is no use for a lead that arrived at 8am: for a trade business the job usually
    // goes to whoever calls back first, and every hour of delay is a job someone else takes.
    // Only 'form' alerts: a click-to-call or a CTA tap carries no name, number or message, so an
    // instant alert about one would say nothing actionable and would train them to ignore the rest.
    // hasDetails is only ever true on Growth/Elite (the name/email/phone/message above are gated on
    // `adv`), so this is inherently a Growth benefit: on Essential we do not store who they are, so
    // there would be nothing worth putting in an alert anyway.
    if (type === 'form' && hasDetails) {
      await alertLead(client, { name, email, phone, message, page, device, source }).catch(() => {});
    }
    return ok({ ok: true, recorded: type });
  } catch (_e) {
    return ok({ ok: true });   // never surface an error to a visitor's browser console
  }
});
