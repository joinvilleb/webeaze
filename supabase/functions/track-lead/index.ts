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
const TYPES = new Set(['form', 'call', 'email', 'contact']);
const host = (u: string) => (u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();

// Speed-to-lead: the instant email that tells the owner to call back now.
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const esc = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
const LEAD_ACTION: Record<string, string> = { form: 'just filled out your contact form', call: 'just clicked to call you', email: 'just clicked to email you', contact: 'just clicked to book or request a quote' };

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
    const { data: client } = await service.from('clients').select('user_id, site_url, email, name, second_email').eq('user_id', key).maybeSingle();
    if (!client) return ok({ ok: true, skipped: 'no client' });

    // Light spam guard: if we know the client's site host, only accept events posted from it.
    const siteHost = host(client.site_url || '');
    const originHost = host(req.headers.get('origin') || req.headers.get('referer') || '');
    if (siteHost && originHost && originHost !== siteHost) return ok({ ok: true, skipped: 'origin' });

    const page = String(body.page || '').slice(0, 300) || null;
    await service.from('lead_events').insert({ user_id: key, type, page });

    // Speed-to-lead alert: email the owner immediately so they can call back first. Best-effort and
    // deduped, so a double-click or a burst of the same action within 2 minutes only alerts once.
    try {
      if (RESEND_API_KEY && client.email) {
        const since = new Date(Date.now() - 120000).toISOString();
        const { count } = await service.from('lead_events').select('id', { count: 'exact', head: true }).eq('user_id', key).eq('type', type).gte('created_at', since);
        if ((count || 0) <= 1) {
          const first = String(client.name || '').trim().split(/\s+/)[0] || 'there';
          const act = LEAD_ACTION[type] || 'just took an action on your website';
          const pageLine = page ? (' <span style="color:#6b7280;">(page: ' + esc(page) + ')</span>') : '';
          await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
            body: JSON.stringify({
              from: FROM, to: [client.email, client.second_email].filter(Boolean),
              subject: 'New lead from your website',
              html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e222b;line-height:1.6;max-width:520px;">'
                + '<p>Hi ' + esc(first) + ',</p>'
                + '<p><strong>Someone ' + act + ' from your website.</strong>' + pageLine + '</p>'
                + '<p>The faster you follow up, the more likely you are to win the job, so reach out now while you are top of mind.</p>'
                + '<p style="color:#6b7280;font-size:12.5px;border-top:1px solid #eee;padding-top:12px;margin-top:16px;">You are getting this because a visitor took an action on your website. Reply to this email if you would like to turn these alerts off.</p>'
                + '<p style="color:#6b7280;font-size:12.5px;">The WebEaze team</p>'
                + '</div>',
            }),
          }).catch(() => {});
        }
      }
    } catch (_) { /* never let alerting break lead recording */ }

    return ok({ ok: true, recorded: type });
  } catch (_e) {
    return ok({ ok: true });   // never surface an error to a visitor's browser console
  }
});
