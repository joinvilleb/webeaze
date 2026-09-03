// Supabase Edge Function: billing-info
// Powers the portal's "Manage plan" panel, so a client can see their plan, their renewal and their
// full invoice history WITHOUT being dropped into Stripe's own portal to hunt for it.
//
// Two actions:
//   { action: 'summary' }            -> plan, renewal, card status, and the last 12 invoices with
//                                       their hosted + PDF links (up to 36). Read-only.
//   { action: 'portal', flow? }      -> a Stripe Billing Portal URL. `flow` deep-links straight to
//                                       the right page instead of the portal's front door:
//                                         'subscription_update'  change plan
//                                         'payment_method_update' update the card
//                                         'subscription_cancel'   cancel (portal shows the retention flow)
//                                       Omit `flow` for the normal portal home.
//
// Why both: reading is nicer in our own UI (no bounce, matches the portal), but ACTUALLY changing a
// subscription or storing a card has to happen on Stripe. Deep-linking means the client lands on the
// exact page rather than a menu.
//
// Called with the client's JWT. Body may include { targetUserId } when billy@webeaze.io previews.
//
// Deploy:  supabase functions deploy billing-info   (Verify JWT ON; the portal sends a JWT)
// Secret:  STRIPE_SECRET_KEY (the same key create-invoice and payment-status use)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const PORTAL_URL = 'https://portal.webeaze.io';
const ADMIN = 'billy@webeaze.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function form(params: Record<string, string | number>) {
  return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
}
async function stripeGet(path: string): Promise<any> {
  const res = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY } });
  const d = await res.json();
  if (!res.ok) throw new Error((d && d.error && d.error.message) || ('Stripe ' + res.status));
  return d;
}
async function stripePost(path: string, body: Record<string, string | number>): Promise<any> {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body),
  });
  const d = await res.json();
  if (!res.ok) throw new Error((d && d.error && d.error.message) || ('Stripe ' + res.status));
  return d;
}

// A subscription's coupons applied to its list price. price.unit_amount is what the PLAN costs, not
// what this client pays: a discounted client keeps the standard price object and carries a coupon
// beside it, so reading unit_amount alone quotes the full price back to someone paying less.
function applyDiscounts(cents, sub) {
  const nowSec = Math.floor(Date.now() / 1000);
  // An ENDED discount must not be applied: a repeating coupon keeps its discount object with an
  // `end` in the past, and quoting that price to a client back on full rate under-reports what
  // they pay.
  const live = (d) => !d || typeof d.end !== 'number' || d.end > nowSec;
  const list = [];
  if (sub && sub.discount && live(sub.discount)) list.push(sub.discount);
  if (sub && Array.isArray(sub.discounts)) for (const d of sub.discounts) if (d && typeof d === 'object' && live(d)) list.push(d);
  if (!list.length) return cents;
  let out = cents;
  const coupons = list.map((d) => (d && d.coupon) || d).filter(Boolean);
  for (const c of coupons) if (typeof c.percent_off === 'number' && c.percent_off > 0) out -= out * (c.percent_off / 100);
  for (const c of coupons) if (typeof c.amount_off === 'number' && c.amount_off > 0) out -= c.amount_off;
  return Math.max(0, Math.round(out));
}
// What Stripe will actually bill this subscription next period, in cents, or null if it cannot say.
// Mirrors upcomingRecurringCents in payment-status/index.ts: if you change one, change both. They
// disagreeing is what put "$89.00/month" in the Manage plan panel while the client's own card said
// $129, because one asked Stripe and the other did the arithmetic itself.
//
// Proration is the trap: a mid-cycle change adds one-off lines whose total is not the recurring price.
async function upcomingRecurringCents(cust: string, subId: string): Promise<number | null> {
  try {
    const inv = await stripeGet('invoices/upcoming?customer=' + encodeURIComponent(cust) + '&subscription=' + encodeURIComponent(subId));
    const lines = (inv && inv.lines && inv.lines.data) || [];
    if (!lines.length) return typeof inv.total === 'number' ? inv.total : null;
    const recurring = lines.filter((l: any) => l && l.proration !== true);
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
    console.warn('[billing-info] no upcoming invoice for ' + subId + ': ' + String(e).slice(0, 120));
    return null;
  }
}
const FAILING = new Set(['past_due', 'unpaid', 'incomplete']);
const money = (cents: number | null | undefined, cur: string) =>
  cents == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency: (cur || 'usd').toUpperCase() }).format(cents / 100);


// ── Plans, so a change can happen in the portal instead of on Stripe ─────────
// Explicit price ids first: changing what someone is billed must be deterministic, and a name match
// is a guess. Discovery by product name is only the fallback for a price created later.
const PLANS: Array<{ key: string; plan: string; interval: 'monthly' | 'yearly'; price: string }> = [
  { key: 'essential-monthly', plan: 'Essential', interval: 'monthly', price: 'price_1R3rU7C23hYItUA5rD5idQDE' },
  { key: 'essential-yearly',  plan: 'Essential', interval: 'yearly',  price: 'price_1TehCLC23hYItUA54WNEy0jI' },
  { key: 'growth-monthly',    plan: 'Growth',    interval: 'monthly', price: 'price_1R1ES2C23hYItUA5IuzCWiXa' },
  { key: 'growth-yearly',     plan: 'Growth',    interval: 'yearly',  price: 'price_1TehOvC23hYItUA5zAfHYnPk' },
];

// The plan an item represents, by product name then nickname. Only used to work out whether a change
// is an upgrade or a downgrade, so an unknown name simply makes it a downgrade (the safe direction:
// nothing is charged today).
function planNameOf(item: any): string {
  const pr = (item && item.price) || {};
  const t = String((pr.product && pr.product.name) || pr.nickname || '').toLowerCase();
  if (/elite/.test(t)) return 'Elite';
  if (/growth/.test(t)) return 'Growth';
  if (/essential/.test(t)) return 'Essential';
  const cents = pr.unit_amount || 0;
  return (cents === 24900 || cents === 249000) ? 'Growth' : 'Essential';
}

const RANK: Record<string, number> = { Essential: 1, Growth: 2, Elite: 3 };

// Look each price up so the client is shown Stripe's real number rather than one hardcoded here.
async function loadPlans() {
  const out: any[] = [];
  for (const p of PLANS) {
    try {
      const pr = await stripeGet('prices/' + encodeURIComponent(p.price) + '?expand[]=product');
      if (!pr || pr.active === false) continue;
      out.push({ ...p, amountCents: pr.unit_amount ?? null, currency: pr.currency || 'usd',
        label: (pr.product && pr.product.name) || p.plan });
    } catch (e) { console.error('[billing-info] price ' + p.price + ' did not resolve:', e); }
  }
  if (out.length) return out;
  // Fallback: no configured id resolved (rotated or deleted), so discover by product name.
  console.warn('[billing-info] no configured prices resolved; discovering by product name');
  try {
    const list = await stripeGet('prices?active=true&limit=50&expand[]=data.product');
    for (const pr of (list.data || [])) {
      const name = String((pr.product && pr.product.name) || pr.nickname || '').toLowerCase();
      const plan = /growth/.test(name) ? 'Growth' : /essential/.test(name) ? 'Essential' : null;
      const iv = pr.recurring && pr.recurring.interval;
      if (!plan || (iv !== 'month' && iv !== 'year')) continue;
      const interval = iv === 'year' ? 'yearly' : 'monthly';
      out.push({ key: plan.toLowerCase() + '-' + interval, plan, interval, price: pr.id,
        amountCents: pr.unit_amount ?? null, currency: pr.currency || 'usd', label: (pr.product && pr.product.name) || plan });
    }
  } catch (e) { console.error('[billing-info] price discovery failed:', e); }
  return out;
}
// The live subscription plus the single item a plan change acts on.
async function liveSub(cust: string) {
  const subs = await stripeGet('subscriptions?customer=' + encodeURIComponent(cust) + '&status=all&limit=20');
  const sub = (subs.data || []).find((x: any) => x.status === 'active' || x.status === 'trialing');
  if (!sub) return null;
  const item = sub.items && sub.items.data && sub.items.data[0];
  return item ? { sub, item } : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({} as any));
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const targetUserId = (body.targetUserId && user.email === ADMIN) ? body.targetUserId : user.id;

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: c } = await service.from('clients')
      .select('stripe_customer_id, plan, plan_amount, billing_period, billing_label, next_billing_date')
      .eq('user_id', targetUserId).maybeSingle();
    if (!c) return json({ ok: false, reason: 'no-client' });

    // A custom arrangement is invoiced by hand, so there is no subscription to manage and no Stripe
    // portal that would make sense. Say so plainly rather than opening an empty page.
    const custom = !!String(c.billing_label || '').trim();
    const cust = c.stripe_customer_id;
    if (!STRIPE_SECRET_KEY) return json({ ok: false, reason: 'not-configured' });
    if (custom) return json({ ok: true, custom: true, label: c.billing_label, plan: c.plan, invoices: [] });
    if (!cust) return json({ ok: true, noStripe: true, plan: c.plan, planAmount: c.plan_amount, billingPeriod: c.billing_period, invoices: [] });

    // ── A Stripe portal link, deep-linked to a flow when one was asked for ──
    if (body.action === 'portal') {
      const FLOWS: Record<string, string> = { subscription_update: 'subscription_update', payment_method_update: 'payment_method_update', subscription_cancel: 'subscription_cancel' };
      const params: Record<string, string | number> = { customer: cust, return_url: PORTAL_URL };
      const flow = FLOWS[String(body.flow || '')];
      if (flow) {
        params['flow_data[type]'] = flow;
        params['flow_data[after_completion][type]'] = 'redirect';
        params['flow_data[after_completion][redirect][return_url]'] = PORTAL_URL;
        // Update and cancel both need to know WHICH subscription they act on.
        if (flow === 'subscription_update' || flow === 'subscription_cancel') {
          const subs = await stripeGet('subscriptions?customer=' + encodeURIComponent(cust) + '&status=active&limit=1');
          const sub = subs.data && subs.data[0];
          if (!sub) return json({ ok: false, reason: 'no-subscription' });
          params['flow_data[' + flow + '][subscription]'] = sub.id;
        }
      }
      try {
        const ses = await stripePost('billing_portal/sessions', params);
        return json({ ok: true, url: ses.url });
      } catch (e) {
        // A portal configuration that has not enabled a flow throws here. Fall back to the plain
        // portal so the button still does something useful instead of erroring.
        console.error('[billing-info] portal flow failed, falling back:', e);
        const ses = await stripePost('billing_portal/sessions', { customer: cust, return_url: PORTAL_URL });
        return json({ ok: true, url: ses.url, fellBack: true });
      }
    }

    // ── Which plans they can move to, priced from Stripe ──
    if (body.action === 'plan-options') {
      const live = await liveSub(cust);
      const plans = await loadPlans();
      const currentPrice = live ? (live.item.price && live.item.price.id) : null;
      return json({
        ok: true, hasSubscription: !!live,
        plans: plans.map((p) => ({
          key: p.key, plan: p.plan, interval: p.interval, label: p.label,
          amount: money(p.amountCents, p.currency), amountCents: p.amountCents,
          current: p.price === currentPrice,
        })),
      });
    }

    // ── What exactly this change costs, from Stripe, BEFORE they commit ──
    // A client deciding whether to upgrade deserves the real number, not "you will be charged a
    // prorated amount". Stripe can tell us, so ask it.
    if (body.action === 'plan-preview' || body.action === 'plan-change') {
      const plans = await loadPlans();
      const target = plans.find((p) => p.key === String(body.planKey || ''));
      if (!target) return json({ ok: false, reason: 'unknown-plan' });
      const live = await liveSub(cust);
      if (!live) return json({ ok: false, reason: 'no-subscription' });
      const curPriceId = live.item.price && live.item.price.id;
      if (curPriceId === target.price) return json({ ok: false, reason: 'already-on-it' });

      const curPlan = planNameOf(live.item);
      const up = (RANK[target.plan] || 0) > (RANK[curPlan] || 0)
        || (RANK[target.plan] === RANK[curPlan] && target.interval === 'yearly');   // monthly -> yearly is an upgrade
      const periodEnd = live.sub.current_period_end || (live.item.current_period_end ?? null);

      if (body.action === 'plan-preview') {
        let dueNow: string | null = null;
        if (up) {
          try {
            const q = 'invoices/upcoming?customer=' + encodeURIComponent(cust)
              + '&subscription=' + encodeURIComponent(live.sub.id)
              + '&subscription_items[0][id]=' + encodeURIComponent(live.item.id)
              + '&subscription_items[0][price]=' + encodeURIComponent(target.price)
              + '&subscription_proration_behavior=always_invoice';
            const inv = await stripeGet(q);
            dueNow = money(inv.amount_due ?? null, inv.currency || 'usd');
          } catch (e) { console.error('[billing-info] preview failed:', e); }
        }
        return json({
          ok: true, direction: up ? 'upgrade' : 'downgrade',
          from: curPlan, to: target.plan, interval: target.interval,
          newAmount: money(target.amountCents, target.currency),
          dueNow,                                     // upgrades only; a downgrade charges nothing today
          effective: up ? 'now' : 'period-end',
          effectiveDate: up ? null : (periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null),
        });
      }

      // ── Apply it ──
      if (up) {
        // More plan, starting now, so charge the difference now.
        await stripePost('subscriptions/' + encodeURIComponent(live.sub.id), {
          'items[0][id]': live.item.id,
          'items[0][price]': target.price,
          proration_behavior: 'always_invoice',
          payment_behavior: 'error_if_incomplete',   // a declined card fails loudly instead of leaving a broken sub
        });
        // Record it here, on the one request that knows the change happened. Without this the portal
        // reloaded onto the OLD row, rendered the old plan, and only corrected itself when
        // payment-status came back and forced a SECOND reload: a visible flash of the plan they had
        // just moved off. Best-effort, because Stripe has already been changed and a failed cache
        // write must not report the change as failed; payment-status still repairs it on next load.
        await service.from('clients').update({
          plan: target.plan,
          plan_amount: Math.round((target.amountCents || 0) / 100),
          billing_period: target.interval === 'yearly' ? 'yearly' : 'monthly',
        }).eq('user_id', targetUserId).then(() => {}, () => {});
        return json({ ok: true, applied: 'now', to: target.plan, interval: target.interval });
      }
      // Less plan: they have already paid for this period, so it takes effect when that period ends
      // rather than taking features away today or generating a refund.
      const sched = await stripePost('subscription_schedules', { from_subscription: live.sub.id });
      const phase0 = (sched.phases && sched.phases[0]) || {};
      await stripePost('subscription_schedules/' + encodeURIComponent(sched.id), {
        end_behavior: 'release',
        'phases[0][items][0][price]': curPriceId,
        'phases[0][items][0][quantity]': live.item.quantity || 1,
        'phases[0][start_date]': phase0.start_date,
        'phases[0][end_date]': phase0.end_date ?? periodEnd,
        'phases[1][items][0][price]': target.price,
        'phases[1][items][0][quantity]': 1,
        'phases[1][iterations]': 1,
        proration_behavior: 'none',
      });
      return json({
        ok: true, applied: 'period-end', to: target.plan, interval: target.interval,
        effectiveDate: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null,
      });
    }

    // ── Summary: what they are on, and what they have been charged ──
    const [subs, invs] = await Promise.all([
      stripeGet('subscriptions?customer=' + encodeURIComponent(cust) + '&status=all&limit=20&expand[]=data.discounts'),
      // Grouped by year in the portal, so pull a few years rather than the last twelve.
      stripeGet('invoices?customer=' + encodeURIComponent(cust) + '&limit=36'),
    ]);
    const list = subs.data || [];
    const live = list.find((s: any) => s.status === 'active' || s.status === 'trialing') || null;
    const item = live && live.items && live.items.data && live.items.data[0];
    const interval = (item && item.price && item.price.recurring && item.price.recurring.interval) || null;
    const listCents = live ? ((live.items.data || []).reduce((t: number, it: any) => t + (((it.price && it.price.unit_amount) || 0) * (it.quantity || 1)), 0)) : null;
    // What they actually pay, after any coupon.
    // Ask Stripe what it will bill. The items-and-coupons sum below is only a fallback for a
    // subscription with no upcoming invoice, because a figure derived from a price object is a guess
    // about billing and the invoice is the billing.
    let cents = (listCents != null && live) ? applyDiscounts(listCents, live) : listCents;
    if (live) {
      const billed = await upcomingRecurringCents(cust, live.id);
      if (billed != null) cents = billed;
    }
    const cpe = live ? (live.current_period_end || (item && item.current_period_end) || null) : null;

    const invoices = (invs.data || [])
      // A $0 draft carries no information for a client, and a draft is not a bill yet.
      .filter((i: any) => i.status && i.status !== 'draft' && (i.amount_due > 0 || i.amount_paid > 0))
      .map((i: any) => ({
        id: i.id,
        number: i.number || null,
        date: i.created ? new Date(i.created * 1000).toISOString().slice(0, 10) : null,
        amount: money(i.amount_paid || i.amount_due, i.currency),
        status: i.status,                       // paid | open | uncollectible | void
        paid: i.status === 'paid',
        url: i.hosted_invoice_url || null,
        pdf: i.invoice_pdf || null,
      }));

    return json({
      ok: true,
      plan: c.plan || null,
      amount: money(cents, (live && live.currency) || 'usd'),
      billingPeriod: interval === 'year' ? 'yearly' : (interval === 'month' ? 'monthly' : c.billing_period || null),
      renewsOn: cpe ? new Date(cpe * 1000).toISOString().slice(0, 10) : (c.next_billing_date || null),
      status: live ? live.status : (list[0] && list[0].status) || 'none',
      needsCardUpdate: list.some((s: any) => FAILING.has(s.status)),
      cancelsAtPeriodEnd: !!(live && live.cancel_at_period_end),
      invoices,
    });
  } catch (e) {
    console.error('[billing-info] error:', e);
    return json({ ok: false, reason: 'error', message: String(e && (e as any).message || e).slice(0, 200) });
  }
});
