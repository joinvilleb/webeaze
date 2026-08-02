// Supabase Edge Function: create-invoice
// Creates a DRAFT Stripe invoice for a portal add-on, so Billy just reviews it and hits Send.
// Nothing is charged automatically. Flat-rate add-ons use this; quoted ones file a request instead.
//
// Called with the client's JWT.  Body: { addon: string, amount: number }
// Returns: { ok:true, invoiceId } on success, or { ok:false, fallback:'request', reason } so the
//          portal can quietly file a request instead when we can't invoice (no Stripe customer, etc.).
//
// Deploy:  supabase functions deploy create-invoice   (Verify JWT ON; the portal sends a JWT)
// Secrets: STRIPE_SECRET_KEY (add it in Supabase; same key your billing worker uses),
//          RESEND_API_KEY (already set, for the heads-up email to Billy)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const TEAM = 'billy@webeaze.io';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Stripe wants application/x-www-form-urlencoded; this flattens nested params (metadata[key]).
function form(params: Record<string, string | number>) {
  return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
}
async function stripe(path: string, body: Record<string, string | number>) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ('Stripe ' + res.status));
  return data;
}

async function emailTeam(subject: string, html: string) {
  if (!RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM, to: [TEAM], subject, html }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({} as any));
    const addon = String(body.addon || '').slice(0, 120).trim();
    const amount = Math.round(Number(body.amount) || 0);   // whole dollars
    if (!addon || amount <= 0) return json({ ok: false, fallback: 'request', reason: 'bad input' });

    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: c } = await service.from('clients').select('name, email, stripe_customer_id').eq('user_id', user.id).maybeSingle();

    // If we can't invoice (no Stripe key, or no customer on file), tell the portal to file a
    // request instead so the client still gets taken care of.
    if (!STRIPE_SECRET_KEY) return json({ ok: false, fallback: 'request', reason: 'no stripe key' });
    if (!c || !c.stripe_customer_id) return json({ ok: false, fallback: 'request', reason: 'no stripe customer' });

    // 1) Add the line item to the customer, then 2) create a DRAFT invoice (not auto-charged).
    await stripe('invoiceitems', { customer: c.stripe_customer_id, amount: amount * 100, currency: 'usd', description: addon });
    const inv = await stripe('invoices', {
      customer: c.stripe_customer_id,
      collection_method: 'send_invoice',
      days_until_due: 7,
      auto_advance: 'false',   // stays a DRAFT for Billy to review and send
      description: 'Add-on requested from the client portal: ' + addon,
      'metadata[source]': 'portal-addon',
      'metadata[addon]': addon,
    });

    await emailTeam('Draft invoice ready: ' + addon + ' for ' + (c.name || c.email || 'a client'),
      '<p><strong>' + (c.name || c.email) + '</strong> requested the add-on <strong>' + addon + '</strong> ($' + amount + ').</p>' +
      '<p>A <strong>draft invoice</strong> is waiting in your Stripe dashboard, review it and hit Send when ready.</p>');

    return json({ ok: true, invoiceId: inv.id });
  } catch (e) {
    console.error('[create-invoice] error:', e);
    // On any Stripe error, fall back to a request so the client is never left stuck.
    return json({ ok: false, fallback: 'request', reason: String(e).slice(0, 140) });
  }
});
