// Supabase Edge Function: churn-digest
// Weekly "reach out before they leave" email to Billy. Scores every active client's churn risk from
// signals WebEaze already stores (how long since their last request, leads drying up, unresolved site
// issues, recent negative feedback, a shaky new-client start, and renewal proximity) and emails the
// ranked list so at-risk clients find him instead of waiting for him to open the admin.
//
// The scoring here is a straight port of admin.html `churnScoreFor` and must be kept in sync with it.
// There is no true client login timestamp, so "activity" uses the client's last request as the proxy.
//
// Deploy:  supabase functions deploy churn-digest --no-verify-jwt
// Secrets: CRON_SECRET, RESEND_API_KEY  (+ the platform SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// Schedule: see supabase/churn_digest.sql (pg_cron, weekly, x-cron-secret header)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const TEAM = 'billy@webeaze.io';
const ADMIN_URL = 'https://portal.webeaze.io/admin.html';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const DAY = 86400000;

type Agg = {
  lastReq: Record<string, number>;
  lastSeen: Record<string, number>;
  neg: Record<string, boolean>;
  reqCount: Record<string, number>;
  leads: Record<string, { last30: number; prev: number; ever: number; lastTs: number }>;
  openIssues: Record<string, number>;
  now: number;
};

// Port of admin.html churnScoreFor. Returns null when there is nothing worth flagging.
function scoreClient(c: any, a: Agg) {
  if (!c || c.status === 'inactive') return null;
  const now = a.now;
  const reasons: string[] = [];
  let score = 0;
  const ageDays = c.created_at ? Math.floor((now - new Date(c.created_at).getTime()) / DAY) : null;
  const launched = !!c.site_url;

  // "Activity" = the most recent of their last request and their last portal login (when we have it),
  // so a client who still logs in but has not filed a request lately is not counted as gone quiet.
  const lastReq = c.user_id ? a.lastReq[c.user_id] : null;
  const lastSeen = c.user_id ? a.lastSeen[c.user_id] : null;
  const lastActivity = Math.max(lastReq || 0, lastSeen || 0) || null;
  const quietDays = lastActivity ? Math.floor((now - lastActivity) / DAY) : (ageDays != null ? ageDays : 0);
  if (launched && ageDays != null && ageDays >= 21) {
    if (quietDays >= 90) { score += 40; reasons.push('No activity in ' + quietDays + ' days'); }
    else if (quietDays >= 60) { score += 28; reasons.push('No activity in ' + quietDays + ' days'); }
    else if (quietDays >= 35) { score += 14; reasons.push('Quiet for ' + quietDays + ' days'); }
  }

  const lv = c.user_id ? a.leads[c.user_id] : null;
  if (launched && lv && lv.ever > 0) {
    if (lv.last30 === 0 && lv.prev > 0) { score += 22; reasons.push('Leads dried up (0 this month)'); }
    else if (lv.last30 === 0 && lv.lastTs && (now - lv.lastTs) > 60 * DAY) { score += 14; reasons.push('No leads in over 60 days'); }
  }

  const oi = (c.user_id && a.openIssues[c.user_id]) || 0;
  if (oi > 0) { score += 10 + Math.min(oi - 1, 3) * 6; reasons.push(oi + ' open ' + (oi === 1 ? 'issue' : 'issues')); }

  if (c.user_id && a.neg[c.user_id]) { score += 18; reasons.push('Left negative feedback recently'); }

  if (ageDays != null && ageDays <= 45) {
    const reqCount = (c.user_id && a.reqCount[c.user_id]) || 0;
    if (!launched && ageDays >= 10 && (c.onboarding_step || 1) <= 2) { score += 16; reasons.push('New, setup not submitted (' + ageDays + 'd in)'); }
    else if (launched && reqCount === 0 && ageDays >= 14) { score += 12; reasons.push('New client, no requests yet'); }
  }

  let renewsInDays: number | null = null;
  if (c.next_billing_date) {
    const d = Math.ceil((new Date(c.next_billing_date).getTime() - now) / DAY);
    if (d >= 0 && d <= 45) renewsInDays = d;
    if (d >= 0 && d <= 14 && score > 0) score += 8;
  }

  if (!reasons.length || score < 30) return null;
  const band = score >= 55 ? 'high' : score >= 40 ? 'medium' : 'watch';
  return { c, score, band, reasons, renewsInDays };
}

async function sendEmail(payload: Record<string, unknown>) {
  if (!RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now();
  const since = new Date(now - 120 * DAY).toISOString();
  const [clientsR, reqsR, leadsR, issuesR, actR] = await Promise.all([
    service.from('clients').select('id, user_id, name, email, plan, status, site_url, created_at, next_billing_date, onboarding_step').neq('status', 'inactive'),
    service.from('update_requests').select('user_id, created_at, completed_at, feedback'),
    service.from('lead_events').select('user_id, created_at').gte('created_at', since),
    service.from('site_issues').select('user_id').eq('status', 'open'),
    service.from('client_activity').select('user_id, last_seen'),   // may not exist yet; returns an error object we ignore
  ]);

  const a: Agg = { lastReq: {}, lastSeen: {}, neg: {}, reqCount: {}, leads: {}, openIssues: {}, now };
  (reqsR.data || []).forEach((r: any) => {
    if (!r.user_id) return;
    const t = new Date(r.created_at).getTime();
    if (!a.lastReq[r.user_id] || t > a.lastReq[r.user_id]) a.lastReq[r.user_id] = t;
    a.reqCount[r.user_id] = (a.reqCount[r.user_id] || 0) + 1;
    if (r.feedback === 'down' && r.completed_at && (now - new Date(r.completed_at).getTime()) < 90 * DAY) a.neg[r.user_id] = true;
  });
  (leadsR.data || []).forEach((l: any) => {
    if (!l.user_id) return;
    const t = new Date(l.created_at).getTime();
    const b = a.leads[l.user_id] || (a.leads[l.user_id] = { last30: 0, prev: 0, ever: 0, lastTs: 0 });
    b.ever++; if (t > b.lastTs) b.lastTs = t;
    const age = now - t;
    if (age <= 30 * DAY) b.last30++; else if (age <= 90 * DAY) b.prev++;
  });
  (issuesR.data || []).forEach((i: any) => { if (i.user_id) a.openIssues[i.user_id] = (a.openIssues[i.user_id] || 0) + 1; });
  (actR.data || []).forEach((x: any) => { if (x.user_id && x.last_seen) a.lastSeen[x.user_id] = new Date(x.last_seen).getTime(); });

  const scored = (clientsR.data || [])
    .map((c: any) => scoreClient(c, a))
    .filter(Boolean)
    .sort((x: any, y: any) => (y.score - x.score) || ((x.renewsInDays == null ? 99 : x.renewsInDays) - (y.renewsInDays == null ? 99 : y.renewsInDays)));

  if (!scored.length) return json({ ok: true, count: 0, note: 'no at-risk clients this week' });

  const bandColor: Record<string, string> = { high: '#dc2626', medium: '#d97706', watch: '#ca8a04' };
  const rows = scored.map((x: any) => {
    const c = x.c;
    const nm = esc(c.name || c.email || 'Client');
    const plan = c.plan ? ' <span style="color:#a0a6c4;font-weight:600;">' + esc(c.plan) + '</span>' : '';
    const renew = x.renewsInDays != null ? '<span style="color:#b45309;font-weight:700;white-space:nowrap;">Renews in ' + x.renewsInDays + 'd</span>' : '';
    return '<tr>'
      + '<td style="padding:11px 0;border-top:1px solid #e4e7f1;vertical-align:top;width:14px;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + bandColor[x.band] + ';"></span></td>'
      + '<td style="padding:11px 0 11px 8px;border-top:1px solid #e4e7f1;vertical-align:top;">'
        + '<div style="font-weight:700;font-size:14px;color:#0f1228;">' + nm + plan + '</div>'
        + '<div style="font-size:13px;color:#000;margin-top:2px;">' + x.reasons.slice(0, 3).map(esc).join(' &middot; ') + '</div>'
      + '</td>'
      + '<td style="padding:11px 0;border-top:1px solid #e4e7f1;vertical-align:top;text-align:right;font-size:12px;">' + renew + '</td>'
      + '</tr>';
  }).join('');

  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f1228;">'
    + '<h2 style="font-size:18px;margin:0 0 4px;">Reach out before they leave</h2>'
    + '<p style="font-size:13px;color:#6b7094;margin:0 0 16px;">' + scored.length + ' active client' + (scored.length > 1 ? 's' : '') + ' showing churn signals this week, ranked by risk. Activity is based on their last request, leads, open issues, and renewal date.</p>'
    + '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>'
    + '<p style="margin:20px 0 0;"><a href="' + ADMIN_URL + '" style="display:inline-block;background:#7851a9;color:#fff;text-decoration:none;border-radius:10px;padding:11px 20px;font-size:14px;font-weight:700;">Open the admin</a></p>'
    + '<p style="font-size:11px;color:#a0a6c4;margin-top:18px;">You are getting this because these accounts crossed the churn-risk threshold. A quiet week means no email.</p>'
    + '</div>';

  await sendEmail({
    from: FROM,
    to: [TEAM],
    subject: scored.length + ' client' + (scored.length > 1 ? 's' : '') + ' to check on this week',
    html,
  });

  return json({ ok: true, count: scored.length });
});
