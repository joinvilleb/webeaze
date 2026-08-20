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

const FAILING = new Set(['past_due', 'unpaid', 'incomplete']);
const money = (cents: number | null | undefined, cur: string) =>
  cents == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency: (cur || 'usd').toUpperCase() }).format(cents / 100);

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

    // ── Summary: what they are on, and what they have been charged ──
    const [subs, invs] = await Promise.all([
      stripeGet('subscriptions?customer=' + encodeURIComponent(cust) + '&status=all&limit=20'),
      // Grouped by year in the portal, so pull a few years rather than the last twelve.
      stripeGet('invoices?customer=' + encodeURIComponent(cust) + '&limit=36'),
    ]);
    const list = subs.data || [];
    const live = list.find((s: any) => s.status === 'active' || s.status === 'trialing') || null;
    const item = live && live.items && live.items.data && live.items.data[0];
    const interval = (item && item.price && item.price.recurring && item.price.recurring.interval) || null;
    const cents = live ? ((live.items.data || []).reduce((t: number, it: any) => t + (((it.price && it.price.unit_amount) || 0) * (it.quantity || 1)), 0)) : null;
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
