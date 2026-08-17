// Supabase Edge Function: track-lead
// Records a lead event (form submit / click-to-call / click-to-email / contact-CTA) sent by the
// WebEaze track.js snippet running on a client's website. Public endpoint, called cross-origin from
// client sites, so it allows any origin and never returns an error the browser would log.
//
// Body: { key: '<client user_id>', type: 'form'|'call'|'email'|'contact', page?: string,
//         name?, email?, phone?, message? }   the last four (form details) are kept for Growth clients only
//
// This function only RECORDS the lead. The owner is NOT emailed per-lead (that would flood a busy site).
// Every lead shows in their portal in real time, and the lead-digest function sends one end-of-day
// summary email after business hours.
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
    const { data: client } = await service.from('clients').select('user_id, site_url, plan').eq('user_id', key).maybeSingle();
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

    // No per-lead email on purpose. The owner sees every lead live in their portal, and the lead-digest
    // function sends one end-of-day recap, so a busy site never floods their inbox.
    return ok({ ok: true, recorded: type });
  } catch (_e) {
    return ok({ ok: true });   // never surface an error to a visitor's browser console
  }
});
