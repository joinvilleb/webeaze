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

// Which plan a Stripe subscription represents. In practice the PRICE NICKNAME does the work: without
// an expand, price.product is only an id string, so the product-name branch is there for a caller
// that does pass an expanded object and is otherwise skipped. Failing both, the amount decides.
// Without this, changing a plan in Stripe updated the money on the client record but left
// clients.plan saying the old thing, so every isAdvancedPlan() gate kept showing the old tier.
// Name your Stripe prices (nickname "Growth monthly", "Essential yearly") and this is exact.
const PLAN_BY_AMOUNT: Record<number, string> = { 169: 'Essential', 1690: 'Essential', 249: 'Growth', 2490: 'Growth' };
function planFromSub(sub: any, dollars: number | null): string | null {
  const items = (sub && sub.items && sub.items.data) || [];
  for (const it of items) {
    const price = it.price || {};
    const product = price.product && typeof price.product === 'object' ? price.product : null;
    const text = String((product && product.name) || price.nickname || '').toLowerCase();
    if (/elite/.test(text)) return 'Elite';
    if (/growth/.test(text)) return 'Growth';
    if (/essential/.test(text)) return 'Essential';
  }
  return dollars != null ? (PLAN_BY_AMOUNT[dollars] || null) : null;
}

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
    // plan_amount and billing_label are read, not just written: the amount is compared before an
    // update so we do not write on every call, and billing_label is what marks a custom arrangement
    // whose price must never be replaced by a subscription figure.
    const { data: c } = await service.from('clients').select('stripe_customer_id, next_billing_date, billing_period, plan_amount, billing_label, plan').eq('user_id', targetUserId).maybeSingle();
    const cust = c && c.stripe_customer_id;
    if (!cust || !STRIPE_SECRET_KEY) return json({ ok: true, needsCardUpdate: false, nextBillingDate: null, billingPeriod: null, source: 'none' });

    try {
      // No expand here. `data.items.data.price.product` is FIVE properties deep and Stripe's limit is
      // four, so the list call 400s and takes the whole function down with it: no card nudge, no
      // renewal date, no plan. (Truncating to `.price` does not work either; price is not expandable
      // on a list.) planFromSub reads the price nickname and falls back to the amount, which needs
      // no expansion at all.
      const subs = await stripeGet('subscriptions?customer=' + encodeURIComponent(cust) + '&status=all&limit=20');
      const list = subs.data || [];
      // A subscription in past_due / unpaid / incomplete means the card on file bounced.
      let needs = list.some((s: any) => FAILING.has(s.status));
      // Next billing date + interval = the soonest upcoming period end among LIVE (active/trialing)
      // subscriptions. This is Stripe's real renewal date, so no one has to enter it by hand.
      let nextTs: number | null = null, interval: string | null = null, amountCents: number | null = null;
      let chosen: any = null;   // the ONE subscription every field below is read from
      for (const s of list) {
        if (s.status !== 'active' && s.status !== 'trialing') continue;
        const item = s.items && s.items.data && s.items.data[0];
        const cpe = s.current_period_end || (item && item.current_period_end) || null;
        if (cpe && (nextTs == null || cpe < nextTs)) {
          nextTs = cpe; chosen = s;
          interval = (item && item.price && item.price.recurring && item.price.recurring.interval) || (s.plan && s.plan.interval) || null;
          // What they are ACTUALLY charged. Summed across items so a subscription carrying an add-on
          // line reports the real total rather than just the base plan, and multiplied by quantity.
          const cents = ((s.items && s.items.data) || []).reduce((t: number, it: any) =>
            t + (((it.price && it.price.unit_amount) || 0) * (it.quantity || 1)), 0);
          amountCents = cents > 0 ? cents : null;
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
      const planAmount = amountCents != null ? Math.round(amountCents / 100) : null;
      // Read from `chosen`, the same subscription the amount and interval came from. Picking it
      // separately with .find() meant a client mid-change (two live subscriptions) could get the
      // name of one and the price of the other, and both were written to their record.
      const plan = chosen ? planFromSub(chosen, planAmount) : (list.length ? planFromSub(list[0], planAmount) : null);

      // Cache Stripe's real date back onto the client (only when it changed) so admin + churn radar
      // use it too, and Billy never enters it manually for a Stripe client.
      if (nextBillingDate) {
        const patch: Record<string, unknown> = {};
        if (String(c.next_billing_date || '').slice(0, 10) !== nextBillingDate) patch.next_billing_date = nextBillingDate;
        if (billingPeriod && c.billing_period !== billingPeriod) patch.billing_period = billingPeriod;
        // Mirror the real Stripe amount too. The date was already trusted from Stripe while the
        // amount was whatever someone last typed, so a plan changed in Stripe left admin quoting the
        // old price and MRR adding up wrong. A custom arrangement is left alone: its billing_label
        // and hourly rate are the real terms and a subscription figure would misrepresent them.
        if (planAmount != null && !String(c.billing_label || '').trim() && Number(c.plan_amount) !== planAmount) {
          patch.plan_amount = planAmount;
        }
        // The plan name itself, which is what actually gates features in the portal.
        if (plan && !String(c.billing_label || '').trim() && String(c.plan || '') !== plan) {
          patch.plan = plan;
          console.log('[payment-status] plan changed in Stripe: ' + (c.plan || 'none') + ' -> ' + plan);
        }
        if (Object.keys(patch).length) { try { await service.from('clients').update(patch).eq('user_id', targetUserId); } catch (_e) { /* best effort */ } }
      }

      return json({ ok: true, needsCardUpdate: needs, nextBillingDate, billingPeriod, planAmount, plan, source: 'stripe' });
    } catch (e) {
      console.error('[payment-status] stripe error:', e);
      return json({ ok: true, needsCardUpdate: false, nextBillingDate: null, billingPeriod: null, source: 'error' });   // never break the portal
    }
  } catch (e) {
    console.error('[payment-status] error:', e);
    return json({ ok: true, needsCardUpdate: false, source: 'error' });
  }
});
