// Supabase Edge Function: renewals
// Warns before something we pay for on a client's behalf runs out.
//
// client_costs has held a renews_on date for every domain, mailbox and platform we buy for a client,
// and nothing has ever read it. It was shown in admin and acted on by nobody, which means a domain
// could lapse in silence, and a lapsed domain takes the website AND the email with it. That is the
// worst failure this company can have, and it is a date in a column.
//
// Daily. Emails Billy, never the client: these are our costs, not theirs.
//
// Warnings step down through 30, 14, 7, 3 and 1 days. The row remembers the smallest one already
// sent, so a day the job does not run is caught up on the next one rather than skipped, and nothing
// is ever sent twice. Overdue rows are repeated daily, because a renewal that has already passed is
// not a reminder any more, it is a problem.
//
// Deploy:  supabase functions deploy renewals --no-verify-jwt
// Secrets: CRON_SECRET, RESEND_API_KEY (+ platform SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// Needs:   supabase/renewals.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const TEAM = 'billy@webeaze.io';
const WARN_AT = [30, 14, 7, 3, 1];

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const money = (n: unknown) => { const v = Number(n); return v > 0 ? '$' + (Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, '') : ''; };

// Today in Eastern, as a plain calendar date. The server runs in UTC, so after 8pm "today" there is
// already tomorrow, and every countdown would be a day short.
function todayET(): Date {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function daysUntil(dateStr: string): number | null {
  const p = String(dateStr || '').slice(0, 10).split('-').map(Number);
  if (p.length !== 3 || !p[0]) return null;
  return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - todayET().getTime()) / 86400000);
}
const pretty = (d: string) => {
  const p = String(d).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

async function sendEmail(subject: string, inner: string) {
  if (!RESEND_API_KEY) return false;
  const html = '<div style="max-width:620px;margin:0 auto;padding:32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2333;">'
    + inner + '<p style="margin:28px 0 0;font-size:12px;color:#9599b8;">Renewal watch runs daily. Dates come from client_costs, which you edit on the client record in admin.</p></div>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM, to: [TEAM], subject, html }),
    });
    if (!res.ok) { console.error('[renewals] resend ' + res.status + ': ' + (await res.text()).slice(0, 160)); return false; }
    return true;
  } catch (e) { console.error('[renewals] send failed:', e); return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (CRON_SECRET && req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    let hasMemory = true;
    let { data: costs, error: costErr } = await svc.from('client_costs')
      .select('id, label, kind, provider, amount, cycle, renews_on, user_id, renewal_warned_days').not('renews_on', 'is', null);
    if (costErr && /renewal_warned_days/.test(costErr.message || '')) {
      hasMemory = false;
      console.warn('[renewals] renewal_warned_days missing, run supabase/renewals.sql');
      ({ data: costs } = await svc.from('client_costs')
        .select('id, label, kind, provider, amount, cycle, renews_on, user_id').not('renews_on', 'is', null));
    }
    if (!costs || !costs.length) return json({ ok: true, watched: 0 });

    // Whose is it. A renewal with no name attached is a renewal you cannot act on.
    const ids = [...new Set(costs.map((c: any) => c.user_id).filter(Boolean))];
    const { data: clients } = await svc.from('clients').select('user_id, name, business_name, email, status').in('user_id', ids);
    const who = new Map((clients || []).map((c: any) => [c.user_id, c]));

    const due: any[] = [], overdue: any[] = [];
    for (const c of costs) {
      const d = daysUntil(c.renews_on);
      if (d == null) continue;
      const client = who.get(c.user_id) || {};
      // An inactive client's costs are a different conversation: we are usually cancelling those.
      if (String(client.status || '').toLowerCase() === 'inactive') continue;
      const row = { ...c, days: d, client: client.business_name || client.name || 'Unknown client' };
      if (d < 0) { overdue.push(row); continue; }
      // The tightest threshold this date has now reached. 13 days out is in the 14-day bucket, so a
      // warning missed on the exact day still goes out.
      const bucket = WARN_AT.filter((w) => d <= w).pop();
      if (bucket == null) {
        // Further out than any warning: this is a renewal that has just been paid and rolled on, so
        // forget what we told them about the old date.
        if (hasMemory && c.renewal_warned_days != null) await svc.from('client_costs').update({ renewal_warned_days: null }).eq('id', c.id);
        continue;
      }
      if (!hasMemory) { if (WARN_AT.includes(d)) due.push(row); continue; }   // exact-day, pre-migration
      const already = c.renewal_warned_days;
      if (already != null && already <= bucket) continue;    // this one, or a tighter one, already went
      due.push(row);
      await svc.from('client_costs').update({ renewal_warned_days: bucket }).eq('id', c.id);
    }
    if (!due.length && !overdue.length) return json({ ok: true, watched: costs.length, sent: false });

    const line = (r: any) => '<tr>'
      + '<td style="padding:7px 10px;border-bottom:1px solid #eceef5;"><strong>' + esc(r.label || r.kind || 'Item') + '</strong>'
      + (r.provider ? '<br><span style="color:#666b8b;font-size:13px;">' + esc(r.provider) + '</span>' : '') + '</td>'
      + '<td style="padding:7px 10px;border-bottom:1px solid #eceef5;">' + esc(r.client) + '</td>'
      + '<td style="padding:7px 10px;border-bottom:1px solid #eceef5;white-space:nowrap;">' + pretty(r.renews_on) + '</td>'
      + '<td style="padding:7px 10px;border-bottom:1px solid #eceef5;white-space:nowrap;font-weight:700;'
      + (r.days < 0 ? 'color:#b91c1c;' : r.days <= 3 ? 'color:#b45309;' : '') + '">'
      + (r.days < 0 ? Math.abs(r.days) + ' day' + (Math.abs(r.days) === 1 ? '' : 's') + ' ago' : r.days === 0 ? 'today' : 'in ' + r.days + ' day' + (r.days === 1 ? '' : 's'))
      + '</td>'
      + '<td style="padding:7px 10px;border-bottom:1px solid #eceef5;white-space:nowrap;">' + esc(money(r.amount)) + '</td></tr>';
    const table = (rows: any[]) => '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 22px;">'
      + '<thead><tr>' + ['What', 'Client', 'Renews', 'When', 'Cost'].map((h) => '<th style="text-align:left;padding:7px 10px;border-bottom:2px solid #e4e7f1;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#666b8b;">' + h + '</th>').join('') + '</tr></thead>'
      + '<tbody>' + rows.sort((a, b) => a.days - b.days).map(line).join('') + '</tbody></table>';

    const worst = overdue.length ? -1 : Math.min(...due.map((r) => r.days));
    const subject = overdue.length
      ? String(overdue.length) + ' renewal' + (overdue.length === 1 ? '' : 's') + ' already past due'
      : 'Renewing in ' + worst + ' day' + (worst === 1 ? '' : 's') + ': ' + (due.find((r) => r.days === worst) || {}).label;

    const inner =
      (overdue.length
        ? '<p style="margin:0 0 6px;font-size:17px;font-weight:700;color:#b91c1c;">Past due</p>'
          + '<p style="margin:0 0 12px;">These renewal dates have gone by. If one is a domain, check it before anything else: a lapsed domain takes the site and the email with it.</p>'
          + table(overdue)
        : '')
      + (due.length
        ? '<p style="margin:0 0 6px;font-size:17px;font-weight:700;">Coming up</p>' + table(due)
        : '')
      + '<p style="margin:0;color:#666b8b;font-size:13px;">Warnings step down through 30, 14, 7, 3 and 1 days, once each. Anything past due is repeated daily until the date is changed.</p>';

    const sent = await sendEmail(subject, inner);
    return json({ ok: true, watched: costs.length, due: due.length, overdue: overdue.length, sent });
  } catch (e) {
    console.error('[renewals] error:', e);
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
});
