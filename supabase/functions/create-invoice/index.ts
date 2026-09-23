// Supabase Edge Function: create-invoice
// Turns a portal add-on into a real Stripe invoice, emailed to the client, with nothing for us to do.
//
// Called with the client's JWT.  Body: { addon: string, amount?: number }
//   The client confirms in the portal first ("Before you pay"), then this runs: it builds the invoice
//   from the add-on's Stripe product, finalizes it, and has Stripe email it. The portal also shows a
//   Pay now link, so they can pay there and then or come back to the email later. Nothing is ever
//   charged without them entering a card on Stripe's own page.
//
// WHERE THE PRICE COMES FROM, in order:
//   1. addon_prices.stripe_price_id  -> the real product, so the invoice carries its name and logo
//   2. addon_prices.amount_usd       -> a plain line at the price we hold server-side
//   3. nothing on file               -> tell the portal to file a request instead
// The `amount` in the body is only used to notice a mismatch worth flagging. It is never billed: the
// browser used to set the invoice total, which meant the page could name its own price.
//
// Returns: { ok:true, invoiceId, url?, emailed? } or { ok:false, fallback:'request', reason }
//
// Deploy:  supabase functions deploy create-invoice   (Verify JWT ON; the portal sends a JWT)
// Secrets: STRIPE_SECRET_KEY, RESEND_API_KEY
// Needs:   supabase/addon_prices.sql
//
// Note for test mode: Stripe sends no emails on test keys, even though the send call succeeds.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const TEAM = 'billy@webeaze.io';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (t: unknown) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

// Stripe wants application/x-www-form-urlencoded; this flattens nested params (metadata[key]).
function form(params: Record<string, string | number>) {
  return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
}
async function stripe(path: string, body: Record<string, string | number> = {}) {
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
    const shown = Math.round(Number(body.amount) || 0);   // what the card said, for cross-checking only
    if (!addon) return json({ ok: false, fallback: 'request', reason: 'bad input' });

    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: c } = await service.from('clients').select('name, email, stripe_customer_id').eq('user_id', user.id).maybeSingle();

    // If we can't invoice, tell the portal to file a request so the client is still taken care of.
    if (!STRIPE_SECRET_KEY) return json({ ok: false, fallback: 'request', reason: 'no stripe key' });
    if (!c || !c.stripe_customer_id) return json({ ok: false, fallback: 'request', reason: 'no stripe customer' });

    // What this add-on costs, decided here rather than in the page that asked.
    const { data: ap } = await service.from('addon_prices').select('stripe_price_id, amount_usd, invoiceable').eq('addon', addon).maybeSingle();
    if (!ap) return json({ ok: false, fallback: 'request', reason: 'addon not in addon_prices' });
    if (!ap.invoiceable) return json({ ok: false, fallback: 'request', reason: 'addon is quoted, not fixed price' });
    const priceId = String(ap.stripe_price_id || '').trim();
    const amount = Math.round(Number(ap.amount_usd) || 0);
    if (!priceId && amount <= 0) return json({ ok: false, fallback: 'request', reason: 'no price on file' });

    // 1) the line item, from the product where we have one. 2) the invoice, not yet finalized.
    const item: Record<string, string | number> = { customer: c.stripe_customer_id };
    if (priceId) { item.price = priceId; item.quantity = 1; }
    else { item.amount = amount * 100; item.currency = 'usd'; item.description = addon; }
    await stripe('invoiceitems', item);

    const billed = priceId ? null : amount;   // with a price ID, Stripe's number is the one that counts
    const inv = await stripe('invoices', {
      customer: c.stripe_customer_id,
      collection_method: 'send_invoice',
      days_until_due: 7,
      auto_advance: 'false',   // we send it ourselves below, so this can never charge on its own
      description: 'Add-on requested from the client portal: ' + addon,
      'metadata[source]': 'portal-addon',
      'metadata[addon]': addon,
      // The webhook needs to know whose work this is once it is paid.
      'metadata[user_id]': user.id,
      'metadata[client_name]': String(c.name || c.email || ''),
      'metadata[amount_usd]': String(billed ?? ''),
      'metadata[priced_from]': priceId ? 'stripe_price' : 'addon_prices',
    });

    // Send, which also finalizes it. This is the step that actually puts the invoice in their inbox:
    // finalizing alone does not email anything, so for a while the portal promised a copy by email
    // that Stripe was never asked to send. If the send fails we still finalize, so the Pay now link
    // in the portal works and they are not stranded.
    let payUrl = '', emailed = false, total = billed;
    try {
      const sent = await stripe('invoices/' + inv.id + '/send');
      payUrl = String(sent.hosted_invoice_url || '');
      total = Math.round(Number(sent.amount_due || 0) / 100) || billed;
      emailed = true;
    } catch (e) {
      console.error('[create-invoice] send failed, finalizing instead:', e);
      try {
        const fin = await stripe('invoices/' + inv.id + '/finalize', { auto_advance: 'false' });
        payUrl = String(fin.hosted_invoice_url || '');
        total = Math.round(Number(fin.amount_due || 0) / 100) || billed;
      } catch (e2) { console.error('[create-invoice] finalize failed too, leaving it a draft:', e2); }
    }

    // Worth knowing about: the price on the card and the price on the invoice disagree. It means the
    // portal's ADD_ONS and Stripe have drifted, and the client just saw the older of the two.
    const mismatch = (shown > 0 && total && Math.abs(shown - total) >= 1)
      ? '<p><strong>Heads up:</strong> the portal showed $' + shown + ' but the invoice is $' + total + '. Worth lining those up.</p>' : '';
    const how = priceId ? '' : '<p class="n">Priced from <code>addon_prices</code>, not a Stripe product. Paste this add-on\'s price ID in admin under Money to put it on the real product.</p>';
    await emailTeam(
      (emailed ? 'Invoice sent: ' : 'Invoice ready (not emailed): ') + addon + ' for ' + (c.name || c.email || 'a client'),
      '<p><strong>' + esc(c.name || c.email) + '</strong> bought <strong>' + esc(addon) + '</strong>' + (total ? ' ($' + total + ')' : '') + '.</p>'
      + (emailed
        ? '<p>Stripe has emailed it to them and they can pay from the portal too. You get another email the moment it is paid, and the work files itself as a request. Nothing for you to send.</p>'
        : (payUrl
          ? '<p>It is finalized and they have a Pay now link in the portal, but Stripe did not email it. Worth sending from the dashboard.</p>'
          : '<p>It is sitting in Stripe as a <strong>draft</strong>. Review it and hit Send.</p>'))
      + mismatch + how);

    return json({ ok: true, invoiceId: inv.id, url: payUrl || null, emailed, amount: total || null });
  } catch (e) {
    console.error('[create-invoice] error:', e);
    // On any Stripe error, fall back to a request so the client is never left stuck.
    return json({ ok: false, fallback: 'request', reason: String(e).slice(0, 140) });
  }
});
