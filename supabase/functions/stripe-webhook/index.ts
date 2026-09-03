// Supabase Edge Function: stripe-webhook
// Turns a paid Stripe subscription into a working portal account, without anyone touching admin.
//
// Until now a new client was onboarded by hand: Billy filled in the Add client form after seeing the
// payment, which meant the gap between someone paying and being able to log in was however long it
// took him to notice. This closes that gap.
//
// FIRST PAYMENT ONLY. `invoice.paid` fires every single month, so acting on all of them would email a
// fresh portal invite to every client on every renewal for as long as they stay. The event we want is
// the one Stripe marks `billing_reason: 'subscription_create'`, which happens exactly once per
// subscription, on the payment that starts it.
//
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
// (--no-verify-jwt because the caller is Stripe, not a logged-in user. The signature below is what
//  authenticates it, and without STRIPE_WEBHOOK_SECRET set the function refuses every request.)
//
// Secrets: STRIPE_SECRET_KEY (already set), STRIPE_WEBHOOK_SECRET (new, from the Stripe dashboard
//          when you add the endpoint), RESEND_API_KEY (already set).
//
// In Stripe: Developers > Webhooks > Add endpoint
//   URL:    https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/stripe-webhook
//   Events: invoice.paid

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const PORTAL_URL = 'https://portal.webeaze.io';
const ADMIN_EMAIL = 'billy@webeaze.io';
const FROM = 'WebEaze <support@webeaze.io>';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

async function stripeGet(path: string): Promise<any> {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY },
  });
  if (!res.ok) throw new Error('stripe ' + res.status + ' on ' + path);
  return await res.json();
}

// Stripe signs the RAW body, so this must run before any parsing. Implemented directly rather than
// pulling in the Stripe SDK: it is one HMAC, and the SDK's Node crypto path is awkward under Deno.
async function verifySignature(raw: string, header: string): Promise<boolean> {
  if (!WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = parts['t'], v1 = parts['v1'];
  if (!t || !v1) return false;
  // Reject anything older than five minutes, so a captured request cannot be replayed later.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare: a fast reject leaks which prefix was right.
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// The plan comes from what the product is CALLED in Stripe, because that is the one place the tier is
// stated rather than inferred. Reading it from the amount would put every discounted client on the
// wrong plan, and there are already clients paying a custom price.
const PLANS = ['Elite', 'Growth', 'Essential'];   // longest/most specific first
function planFromName(...names: (string | null | undefined)[]): string | null {
  for (const n of names) {
    if (!n) continue;
    const hit = PLANS.find((p) => new RegExp('\\b' + p + '\\b', 'i').test(n));
    if (hit) return hit;
  }
  return null;
}

async function emailAdmin(subject: string, lines: string[]) {
  if (!RESEND_API_KEY) return;
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const html = '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2333;">'
    + lines.map((l) => '<p style="margin:0 0 8px;">' + esc(l) + '</p>').join('') + '</div>';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify({ from: FROM, to: [ADMIN_EMAIL], subject, html }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const raw = await req.text();
  const ok = await verifySignature(raw, req.headers.get('stripe-signature') || '');
  // Fails closed. With no secret configured this endpoint accepts nothing, rather than trusting any
  // caller who can find the URL to create portal logins.
  if (!ok) return json({ error: 'Bad signature' }, 400);

  let event: any;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Bad payload' }, 400); }

  // Always 200 from here on. A non-2xx makes Stripe retry, and retrying a bug just repeats it.
  try {
    if (event.type !== 'invoice.paid') return json({ ok: true, ignored: event.type });

    const inv = event.data && event.data.object;
    if (!inv) return json({ ok: true, ignored: 'no invoice' });
    if (inv.billing_reason !== 'subscription_create') {
      return json({ ok: true, ignored: 'not the first payment', billing_reason: inv.billing_reason });
    }

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const custId = typeof inv.customer === 'string' ? inv.customer : (inv.customer && inv.customer.id);

    // Who paid. customer_email is not always populated, so fall back to the customer object.
    let email = String(inv.customer_email || '').trim().toLowerCase();
    let name = String(inv.customer_name || '').trim();
    if ((!email || !name) && custId) {
      const cust = await stripeGet('customers/' + custId).catch(() => null);
      if (cust) { email = email || String(cust.email || '').trim().toLowerCase(); name = name || String(cust.name || '').trim(); }
    }
    if (!email) { await emailAdmin('Stripe payment with no email', ['A subscription was paid but Stripe had no email on it, so no portal account was created.', 'Customer: ' + custId]); return json({ ok: true, skipped: 'no email' }); }

    // Already a client? Then this is someone onboarded by hand, or a webhook Stripe is retrying.
    // Either way do not create a second account or send another invite; just make sure the record
    // knows its Stripe customer, which is what billing-info and payment-status look it up by.
    const { data: existing } = await service.from('clients')
      .select('user_id, email, stripe_customer_id').or('email.eq.' + email + ',stripe_customer_id.eq.' + (custId || 'none'))
      .maybeSingle();
    if (existing) {
      if (custId && !existing.stripe_customer_id) {
        await service.from('clients').update({ stripe_customer_id: custId }).eq('user_id', existing.user_id);
      }
      return json({ ok: true, skipped: 'client already exists', linked: !existing.stripe_customer_id });
    }

    // What they bought. The recurring line is the subscription itself; a proration or one-off sitting
    // on the same invoice is not the plan.
    const lines = (inv.lines && inv.lines.data) || [];
    const line = lines.find((l: any) => l && l.proration !== true) || lines[0] || null;
    const price = line && line.price;
    const interval = price && price.recurring && price.recurring.interval;
    // 'yearly', not 'annual': that is the value admin writes and the portal compares against.
    const billingPeriod = interval === 'year' ? 'yearly' : 'monthly';

    let productName: string | null = null;
    const productId = price && (typeof price.product === 'string' ? price.product : (price.product && price.product.id));
    if (productId) {
      const prod = await stripeGet('products/' + productId).catch(() => null);
      productName = prod && prod.name;
    }
    const plan = planFromName(productName, price && price.nickname, inv.description);

    // What they actually pay per period, after any discount, in whole currency units.
    const gross = typeof (line && line.amount) === 'number' ? line.amount : (inv.total || 0);
    const off = Array.isArray(line && line.discount_amounts)
      ? line.discount_amounts.reduce((t: number, d: any) => t + ((d && d.amount) || 0), 0) : 0;
    const planAmount = Math.round(Math.max(0, gross - off)) / 100;

    let nextBilling: string | null = null;
    const subId = typeof inv.subscription === 'string' ? inv.subscription : (inv.subscription && inv.subscription.id);
    if (subId) {
      const sub = await stripeGet('subscriptions/' + subId).catch(() => null);
      if (sub && sub.current_period_end) nextBilling = new Date(sub.current_period_end * 1000).toISOString().slice(0, 10);
    }

    // Create the login and send the invite. inviteUserByEmail both creates the auth user and emails
    // them the link, which is the same call the admin Add client flow ends up making.
    const inv2 = await service.auth.admin.inviteUserByEmail(email, { redirectTo: PORTAL_URL });
    let userId = inv2.data && inv2.data.user && inv2.data.user.id;
    if (!userId) {
      // Most likely they already have an auth account from a previous life (a teammate invite, say).
      // Find them and carry on rather than leaving a paying customer with no portal.
      const list = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = list.data && list.data.users && list.data.users.find((u: any) => (u.email || '').toLowerCase() === email);
      userId = found && found.id;
      if (userId) await service.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: PORTAL_URL } }).catch(() => {});
    }
    if (!userId) {
      await emailAdmin('Could not create a portal login', ['Stripe took a first payment but the portal account could not be created.', email, String((inv2.error && inv2.error.message) || 'unknown error')]);
      return json({ ok: true, skipped: 'no auth user', error: (inv2.error && inv2.error.message) || null });
    }

    const row: Record<string, unknown> = {
      user_id: userId,
      email,
      name: name || email.split('@')[0],
      status: 'active',
      billing_period: billingPeriod,
      stripe_customer_id: custId || null,
    };
    if (plan) row.plan = plan;
    if (planAmount > 0) row.plan_amount = planAmount;
    if (nextBilling) row.next_billing_date = nextBilling;

    const ins = await service.from('clients').insert(row);
    if (ins.error) {
      await emailAdmin('Portal account half-created', ['The login was created and the invite sent, but the client record failed to save. Add it by hand in admin.', email, ins.error.message]);
      return json({ ok: true, invited: true, clientRow: false, error: ins.error.message });
    }

    await emailAdmin('New client from Stripe: ' + (name || email), [
      (name || email) + ' paid their first subscription invoice, so a portal account was created and the invite has been sent.',
      'Email: ' + email,
      'Plan: ' + (plan || 'not set, the Stripe product name did not say') + ' at $' + planAmount + '/' + (billingPeriod === 'yearly' ? 'year' : 'month'),
      'Stripe product: ' + (productName || 'unknown'),
      'Still to add: their website address, and the business name.',
    ]);

    return json({ ok: true, created: true, email, plan, planAmount, billingPeriod });
  } catch (e) {
    console.error('[stripe-webhook]', e && (e as Error).message);
    await emailAdmin('Stripe webhook failed', ['A subscription payment came in but the portal account was not created.', String((e as Error).message).slice(0, 300)]);
    return json({ ok: false, error: String((e as Error).message).slice(0, 200) });
  }
});
