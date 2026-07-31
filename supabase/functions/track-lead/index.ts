// Supabase Edge Function: track-lead
// Records a lead event (form submit / click-to-call / click-to-email) sent by the WebEaze
// track.js snippet running on a client's website. Public endpoint, called cross-origin from
// client sites, so it allows any origin and never returns an error the browser would log.
//
// Body: { key: '<client user_id>', type: 'form' | 'call' | 'email', page?: string }
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
const TYPES = new Set(['form', 'call', 'email']);
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
    const { data: client } = await service.from('clients').select('user_id, site_url').eq('user_id', key).maybeSingle();
    if (!client) return ok({ ok: true, skipped: 'no client' });

    // Light spam guard: if we know the client's site host, only accept events posted from it.
    const siteHost = host(client.site_url || '');
    const originHost = host(req.headers.get('origin') || req.headers.get('referer') || '');
    if (siteHost && originHost && originHost !== siteHost) return ok({ ok: true, skipped: 'origin' });

    await service.from('lead_events').insert({ user_id: key, type, page: String(body.page || '').slice(0, 300) || null });
    return ok({ ok: true, recorded: type });
  } catch (_e) {
    return ok({ ok: true });   // never surface an error to a visitor's browser console
  }
});
