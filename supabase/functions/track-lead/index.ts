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
const TYPES = new Set(['form', 'call', 'email', 'contact']);
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

    // Growth/Elite clients get the actual lead details (a follow-up inbox in the portal). Every other
    // plan stores only the count, so a visitor's personal details are never kept for a plan that would
    // not use them. Details only come from a form submit (calls/emails/CTA clicks carry none).
    const adv = /growth|elite/i.test(String(client.plan || ''));
    const clean = (v: unknown, max: number) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
    const name = adv && type === 'form' ? clean(body.name, 120) : null;
    const email = adv && type === 'form' ? clean(body.email, 160) : null;
    const phone = adv && type === 'form' ? clean(body.phone, 40) : null;
    const message = adv && type === 'form' ? clean(body.message, 1200) : null;
    const hasDetails = !!(name || email || phone || message);

    // If the detail columns are not there yet (migration not run), fall back to the count-only row so
    // lead recording never breaks.
    if (hasDetails) {
      const ins = await service.from('lead_events').insert({ user_id: key, type, page, name, email, phone, message });
      if (ins.error) await service.from('lead_events').insert({ user_id: key, type, page });
    } else {
      await service.from('lead_events').insert({ user_id: key, type, page });
    }

    // No per-lead email on purpose. The owner sees every lead live in their portal, and the lead-digest
    // function sends one end-of-day recap, so a busy site never floods their inbox.
    return ok({ ok: true, recorded: type });
  } catch (_e) {
    return ok({ ok: true });   // never surface an error to a visitor's browser console
  }
});
