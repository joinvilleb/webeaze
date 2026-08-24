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
// NOTE: the amount handed to this is now the DISCOUNTED one, so a Growth client with 30% off is
// $174.30 and matches nothing here. That is fine and deliberate: planFromSub reads the price nickname
// first, so a price named "Growth monthly" is still identified exactly. It only means a discounted
// client on an UNNAMED price falls through to null and keeps whatever plan is already on their record,
// rather than being guessed at from a number that was never their plan's price. Name your prices.
const PLAN_BY_AMOUNT: Record<number, string> = { 169: 'Essential', 1690: 'Essential', 249: 'Growth', 2490: 'Growth' };

// A subscription's coupons applied to its list price, in cents.
//
// price.unit_amount is what the PLAN costs, not what this client pays. A discounted client keeps the
// standard price object and carries a coupon alongside it, so reading unit_amount alone reports the
// full price for everyone on a negotiated rate.
//
// Handles both shapes: `discount` (a single one, older API) and `discounts` (an array, newer), and
// both kinds of coupon: percent_off and amount_off. Percentages are applied before fixed amounts,
// which is Stripe's own order. Never returns less than zero.
function applyDiscounts(cents: number, sub: any): number {
  const nowSec = Math.floor(Date.now() / 1000);
  // A discount that has already ENDED must not be applied. A "repeating for 3 months" coupon keeps its
  // discount object on the subscription with an `end` in the past, and a one-off promotion likewise.
  // Applying those quotes a promotional price back to a client who has since returned to full rate,
  // which is worse than the bug this function exists to fix: it under-reports what they actually pay.
  const live = (d: any) => !d || typeof d.end !== 'number' || d.end > nowSec;
  const list: any[] = [];
  if (sub && sub.discount && live(sub.discount)) list.push(sub.discount);
  if (sub && Array.isArray(sub.discounts)) {
    // `discounts` can hold ids (unexpanded) or objects. Only objects carry a coupon we can read.
    for (const d of sub.discounts) if (d && typeof d === 'object' && live(d)) list.push(d);
  }
  if (!list.length) return cents;
  let out = cents;
  const coupons = list.map((d) => (d && d.coupon) || d).filter(Boolean);
  for (const c of coupons) if (typeof c.percent_off === 'number' && c.percent_off > 0) out -= out * (c.percent_off / 100);
  for (const c of coupons) if (typeof c.amount_off === 'number' && c.amount_off > 0) out -= c.amount_off;
  return Math.max(0, Math.round(out));
}
// What Stripe will actually bill this subscription next period, in cents, or null if it cannot say.
//
// This is the honest answer and it replaces arithmetic. Deriving a price from unit_amount and then
// applying coupons ourselves means re-implementing Stripe's billing engine and getting it subtly
// wrong: coupons, credits, tax, per-item discounts, currency rounding. The upcoming invoice IS the
// number, computed by the people who charge the card.
//
// PRORATION is the one trap. Mid-cycle plan changes put one-off adjustment lines on the upcoming
// invoice, so its total is not the recurring price. Those lines are dropped and only the recurring
// subscription lines are counted, each net of its own discounts.
async function upcomingRecurringCents(cust: string, subId: string): Promise<number | null> {
  try {
    const inv = await stripeGet('invoices/upcoming?customer=' + encodeURIComponent(cust) + '&subscription=' + encodeURIComponent(subId));
    const lines = (inv && inv.lines && inv.lines.data) || [];
    // No lines at all: nothing to reason about, so the invoice total is the best available answer.
    if (!lines.length) return typeof inv.total === 'number' ? inv.total : null;
    const recurring = lines.filter((l: any) => l && l.proration !== true);
    // Lines exist but every one is a proration adjustment. There is no recurring amount on this
    // invoice, and returning its total would report a one-off mid-cycle adjustment as their monthly
    // price. Give up and let the caller fall back to the subscription items instead.
    if (!recurring.length) return null;
    let cents = 0;
    for (const l of recurring) {
      const gross = typeof l.amount === 'number' ? l.amount : 0;
      const off = Array.isArray(l.discount_amounts)
        ? l.discount_amounts.reduce((t: number, d: any) => t + ((d && d.amount) || 0), 0) : 0;
      cents += gross - off;
    }
    return cents > 0 ? cents : null;
  } catch (e) {
    // No upcoming invoice (cancelled, or nothing scheduled) is normal, not an error worth failing on.
    console.warn('[payment-status] no upcoming invoice for ' + subId + ': ' + String(e).slice(0, 120));
    return null;
  }
}
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
      // discounts IS expanded, and has to be: without it Stripe returns discount ids rather than the
      // coupon objects, so a discounted client would silently fall back to the list price. It is only
      // two levels deep, well inside Stripe's four-level expand limit.
      const subs = await stripeGet('subscriptions?customer=' + encodeURIComponent(cust) + '&status=all&limit=20&expand[]=data.discounts');
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
          // Then apply any coupon. unit_amount is the LIST price: a client on Growth with 30% off
          // still carries the $249 price object, and the discount lives beside it. Reading only
          // unit_amount reported the full price for every discounted client, forever, and no amount
          // of refreshing changed it because the number we were reading was never their number.
          amountCents = cents > 0 ? applyDiscounts(cents, s) : null;
        }
      }
      // Ask Stripe what it will actually bill, and prefer that over anything we worked out ourselves.
      // The items-and-coupons calculation above stays only as a fallback for a subscription with no
      // upcoming invoice, because a number derived from a price object is a guess about billing and
      // this is the billing.
      let amountSource = 'items';
      if (chosen) {
        const billed = await upcomingRecurringCents(cust, chosen.id);
        if (billed != null) { amountCents = billed; amountSource = 'upcoming-invoice'; }
      }

      // One invoice read doing two jobs: the card-failure backstop, and the plain record of what this
      // customer has actually been charged. "What have they been paying" should be answerable from
      // here rather than by opening Stripe and reading it off by eye.
      let recentlyPaid: Array<{ date: string | null; paid: number }> = [];
      {
        const inv = await stripeGet('invoices?customer=' + encodeURIComponent(cust) + '&limit=6');
        const rows = (inv && inv.data) || [];
        const latest = rows[0];
        if (!needs && latest && latest.status === 'open' && latest.attempt_count > 0 && latest.amount_remaining > 0) needs = true;
        recentlyPaid = rows
          .filter((i: any) => i && i.status === 'paid' && (i.amount_paid || 0) > 0)
          .slice(0, 4)
          .map((i: any) => ({ date: i.created ? new Date(i.created * 1000).toISOString().slice(0, 10) : null, paid: (i.amount_paid || 0) / 100 }));
      }
      const nextBillingDate = nextTs ? new Date(nextTs * 1000).toISOString().slice(0, 10) : null;
      const billingPeriod = interval === 'year' ? 'yearly' : (interval === 'month' ? 'monthly' : null);
      const planAmount = amountCents != null ? Math.round(amountCents / 100) : null;
      // Read from `chosen`, the same subscription the amount and interval came from. Picking it
      // separately with .find() meant a client mid-change (two live subscriptions) could get the
      // name of one and the price of the other, and both were written to their record.
      const plan = chosen ? planFromSub(chosen, planAmount) : (list.length ? planFromSub(list[0], planAmount) : null);

      // Cache Stripe's real figures back onto the client (only what changed) so admin, the churn radar
      // and the client's own portal all quote the same number, and Billy never types it manually.
      //
      // NOT nested under `if (nextBillingDate)` any more, and that mattered. The price only got
      // written back when Stripe also returned a next billing date, so a subscription without one
      // (cancelling at period end, or a newer Stripe API shape that moved current_period_end onto the
      // item) kept whatever amount was last typed on the record. For a client on a negotiated rate
      // that meant their portal quoted the standard price back at them indefinitely. The date is the
      // optional part here; the money is not.
      const patch: Record<string, unknown> = {};
      if (nextBillingDate && String(c.next_billing_date || '').slice(0, 10) !== nextBillingDate) patch.next_billing_date = nextBillingDate;
      if (billingPeriod && c.billing_period !== billingPeriod) patch.billing_period = billingPeriod;
      // The real Stripe amount, whatever it is. This is the whole point for a client who is not on a
      // list price. A custom arrangement is left alone: its billing_label and hourly rate are the real
      // terms and a subscription figure would misrepresent them.
      if (planAmount != null && !String(c.billing_label || '').trim() && Number(c.plan_amount) !== planAmount) {
        patch.plan_amount = planAmount;
      }
      // The plan name itself, which is what actually gates features in the portal.
      if (plan && !String(c.billing_label || '').trim() && String(c.plan || '') !== plan) {
        patch.plan = plan;
        console.log('[payment-status] plan changed in Stripe: ' + (c.plan || 'none') + ' -> ' + plan);
      }
      if (Object.keys(patch).length) {
        // Logged, not swallowed. A failed write here is why a record silently drifts from Stripe.
        const { error: upErr } = await service.from('clients').update(patch).eq('user_id', targetUserId);
        if (upErr) console.error('[payment-status] could not write back ' + JSON.stringify(Object.keys(patch)) + ': ' + upErr.message);
      }

      // Show the working. When a client's price looks wrong there is no way to tell from the outside
      // whether the list price, a coupon, or a stale record is to blame, and every guess costs a round
      // trip. This says exactly what Stripe returned and what was done to it.
      const dbg = chosen ? {
        subscription: chosen.id,
        status: chosen.status,
        lineItems: ((chosen.items && chosen.items.data) || []).map((it: any) => ({
          price: it.price && it.price.id,
          nickname: (it.price && it.price.nickname) || null,
          unitAmount: (it.price && it.price.unit_amount) != null ? (it.price.unit_amount / 100) : null,
          quantity: it.quantity || 1,
        })),
        listTotal: ((chosen.items && chosen.items.data) || []).reduce((t: number, it: any) =>
          t + (((it.price && it.price.unit_amount) || 0) * (it.quantity || 1)), 0) / 100,
        discounts: ([] as any[])
          .concat(chosen.discount ? [chosen.discount] : [])
          .concat(Array.isArray(chosen.discounts) ? chosen.discounts.filter((d: any) => d && typeof d === 'object') : [])
          .map((d: any) => ({
            id: d.id,
            percentOff: (d.coupon && d.coupon.percent_off) ?? d.percent_off ?? null,
            amountOff: ((d.coupon && d.coupon.amount_off) ?? d.amount_off ?? null),
            ends: typeof d.end === 'number' ? new Date(d.end * 1000).toISOString().slice(0, 10) : 'never',
            expired: typeof d.end === 'number' && d.end <= Math.floor(Date.now() / 1000),
          })),
        afterDiscounts: planAmount,
        amountSource,
        recentlyPaid,
        onRecordBefore: c.plan_amount ?? null,
      } : null;
      console.log('[payment-status] ' + targetUserId + ' ' + JSON.stringify(dbg));

      return json({ ok: true, needsCardUpdate: needs, nextBillingDate, billingPeriod, planAmount, plan, source: 'stripe', debug: dbg });
    } catch (e) {
      console.error('[payment-status] stripe error:', e);
      return json({ ok: true, needsCardUpdate: false, nextBillingDate: null, billingPeriod: null, source: 'error' });   // never break the portal
    }
  } catch (e) {
    console.error('[payment-status] error:', e);
    return json({ ok: true, needsCardUpdate: false, source: 'error' });
  }
});
