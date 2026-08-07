// Supabase Edge Function: payment-status
// Asks Stripe whether the caller's account has a LIVE payment problem, so the portal can show a
// "please update your card" nudge to only the clients who actually need it, with no manual flagging.
// A subscription in past_due / unpaid / incomplete means a recurring charge failed and the card on
// file needs attention. Read-only; it never writes to Stripe or the DB.
//
// It also pulls the REAL next billing date from Stripe (subscription current_period_end) so admins
// never enter it by hand, and caches it back onto clients.next_billing_date / billing_period when it
// changed (so the admin view + churn radar use it too).
//
// Body: {} (uses the caller's JWT) or { targetUserId } when billy@webeaze.io previews a client.
// Returns: { ok, needsCardUpdate, nextBillingDate: 'YYYY-MM-DD'|null, billingPeriod: 'monthly'|'yearly'|null, source }
//
// Deploy:  supabase functions deploy payment-status   (Verify JWT can stay ON; the portal sends a JWT)
// Secret:  STRIPE_SECRET_KEY (already set, same key create-invoice uses)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function stripeGet(path: string): Promise<any> {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY },
  });
  if (!res.ok) throw new Error('stripe ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}

// Statuses that mean a payment has failed and the card on file needs updating.
const FAILING = new Set(['past_due', 'unpaid', 'incomplete']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({} as any));
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const targetUserId = (body.targetUserId && user.email === 'billy@webeaze.io') ? body.targetUserId : user.id;

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: c } = await service.from('clients').select('stripe_customer_id, next_billing_date, billing_period').eq('user_id', targetUserId).maybeSingle();
    const cust = c && c.stripe_customer_id;
    if (!cust || !STRIPE_SECRET_KEY) return json({ ok: true, needsCardUpdate: false, nextBillingDate: null, billingPeriod: null, source: 'none' });

    try {
      const subs = await stripeGet('subscriptions?customer=' + encodeURIComponent(cust) + '&status=all&limit=20');
      const list = subs.data || [];
      // A subscription in past_due / unpaid / incomplete means the card on file bounced.
      let needs = list.some((s: any) => FAILING.has(s.status));
      // Next billing date + interval = the soonest upcoming period end among LIVE (active/trialing)
      // subscriptions. This is Stripe's real renewal date, so no one has to enter it by hand.
      let nextTs: number | null = null, interval: string | null = null;
      for (const s of list) {
        if (s.status !== 'active' && s.status !== 'trialing') continue;
        const item = s.items && s.items.data && s.items.data[0];
        const cpe = s.current_period_end || (item && item.current_period_end) || null;
        if (cpe && (nextTs == null || cpe < nextTs)) {
          nextTs = cpe;
          interval = (item && item.price && item.price.recurring && item.price.recurring.interval) || (s.plan && s.plan.interval) || null;
        }
      }
      // Backstop: flag if the latest invoice is still open and unpaid after an attempt.
      if (!needs) {
        const inv = await stripeGet('invoices?customer=' + encodeURIComponent(cust) + '&limit=1');
        const latest = inv.data && inv.data[0];
        if (latest && latest.status === 'open' && latest.attempt_count > 0 && latest.amount_remaining > 0) needs = true;
      }
      const nextBillingDate = nextTs ? new Date(nextTs * 1000).toISOString().slice(0, 10) : null;
      const billingPeriod = interval === 'year' ? 'yearly' : (interval === 'month' ? 'monthly' : null);

      // Cache Stripe's real date back onto the client (only when it changed) so admin + churn radar
      // use it too, and Billy never enters it manually for a Stripe client.
      if (nextBillingDate) {
        const patch: Record<string, unknown> = {};
        if (String(c.next_billing_date || '').slice(0, 10) !== nextBillingDate) patch.next_billing_date = nextBillingDate;
        if (billingPeriod && c.billing_period !== billingPeriod) patch.billing_period = billingPeriod;
        if (Object.keys(patch).length) { try { await service.from('clients').update(patch).eq('user_id', targetUserId); } catch (_e) { /* best effort */ } }
      }

      return json({ ok: true, needsCardUpdate: needs, nextBillingDate, billingPeriod, source: 'stripe' });
    } catch (e) {
      console.error('[payment-status] stripe error:', e);
      return json({ ok: true, needsCardUpdate: false, nextBillingDate: null, billingPeriod: null, source: 'error' });   // never break the portal
    }
  } catch (e) {
    console.error('[payment-status] error:', e);
    return json({ ok: true, needsCardUpdate: false, source: 'error' });
  }
});
