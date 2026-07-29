// Supabase Edge Function: growth-report
// Powers the automatic "Growth Report" — pulls real performance/growth data for a
// client's site, stores a snapshot in `client_metrics`, and can email a summary.
//
// Two entry modes:
//   1) On-demand (client taps "Refresh" / "Email me my report" in the portal):
//      called WITH the user's JWT. Body: { action: 'refresh' | 'email' }.
//      Refreshes just that client, emails them when action === 'email'.
//   2) Monthly (pg_cron): called WITH the x-cron-secret header. Body: { mode:'monthly' }.
//      Refreshes every client with a site_url and emails each their summary.
//
// Sources (Slice 1 wires speed; the rest are ready to switch on once keys/setup exist):
//   - speed   : Google PageSpeed Insights   (needs GOOGLE_PSI_KEY — one key, all clients)  [LIVE]
//   - reviews : Google Places                (needs GOOGLE_PLACES_KEY + clients.google_place_id) [STUB]
//   - search  : Google Search Console API    (needs a service account verified per site)         [STUB]
//   - uptime  : surfaced in the portal from the existing monitor; included here if provided
//
// Deploy:  supabase functions deploy growth-report
// Secrets: supabase secrets set RESEND_API_KEY=re_xxx CRON_SECRET=... GOOGLE_PSI_KEY=...
//          (optional later) GOOGLE_PLACES_KEY=...
// Schedule: see supabase/growth_report.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const PSI_KEY = Deno.env.get('GOOGLE_PSI_KEY') ?? '';
const PLACES_KEY = Deno.env.get('GOOGLE_PLACES_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ── Source: PageSpeed Insights (real speed + Core Web Vitals) ──
async function pullSpeed(url: string) {
  if (!url) { console.warn('[growth] pullSpeed: no site_url'); return null; }
  if (!PSI_KEY) { console.warn('[growth] pullSpeed: GOOGLE_PSI_KEY secret is not set'); return null; }
  const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;   // PageSpeed needs a full URL
  const run = async (strategy: 'mobile' | 'desktop') => {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(full)}&strategy=${strategy}&category=performance&key=${PSI_KEY}`;
    const res = await fetch(api);
    if (!res.ok) throw new Error(`PSI ${strategy} ${res.status}: ${(await res.text()).slice(0, 180)}`);
    const d = await res.json();
    const lh = d.lighthouseResult ?? {};
    const score = Math.round((lh.categories?.performance?.score ?? 0) * 100);
    const lcp = lh.audits?.['largest-contentful-paint']?.numericValue ?? null;   // ms
    const cls = lh.audits?.['cumulative-layout-shift']?.numericValue ?? null;
    return { score, lcpSeconds: lcp != null ? +(lcp / 1000).toFixed(1) : null, cls: cls != null ? +cls.toFixed(3) : null };
  };
  try {
    const [mobile, desktop] = await Promise.all([run('mobile'), run('desktop')]);
    return { mobile, desktop, checkedAt: new Date().toISOString() };
  } catch (e) {
    console.error('pullSpeed failed', e);
    return null;
  }
}

// ── Source: Google reviews (STUB — switch on with GOOGLE_PLACES_KEY + client.google_place_id) ──
async function pullReviews(placeId?: string | null) {
  if (!PLACES_KEY || !placeId) return null;
  try {
    const api = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total&key=${PLACES_KEY}`;
    const res = await fetch(api);
    const d = await res.json();
    if (d.result) return { rating: d.result.rating ?? null, count: d.result.user_ratings_total ?? null, checkedAt: new Date().toISOString() };
  } catch (e) { console.error('pullReviews failed', e); }
  return null;
}

// ── Source: Search Console real numbers (STUB — needs a service account verified per site) ──
async function pullSearch(_url: string) {
  // TODO: sign a JWT for the service account, call the Search Console API
  // (searchanalytics.query) for the last 28 days of clicks/impressions/position.
  return null;
}

async function refreshClient(sb: any, c: { user_id: string; id?: string; site_url?: string; google_place_id?: string | null }) {
  const url = c.site_url || '';
  const [speed, reviews] = await Promise.all([pullSpeed(url), pullReviews(c.google_place_id), ]);
  const search = await pullSearch(url);
  const metrics = { speed, reviews, search };
  await sb.from('client_metrics').upsert({
    user_id: c.user_id, client_id: c.id ?? null, site_url: url,
    metrics, refreshed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  return metrics;
}

async function sendEmail(payload: Record<string, unknown>) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

function summaryHtml(name: string, url: string, m: any) {
  const tile = (label: string, value: string, sub = '') =>
    `<td style="padding:8px;" width="50%"><div style="background:#f8f9fc;border:1px solid #e4e7f1;border-radius:12px;padding:16px 18px;">` +
    `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#a0a6c4;margin-bottom:5px;">${esc(label)}</div>` +
    `<div style="font-size:22px;font-weight:800;color:#0f1228;">${esc(value)}</div>` +
    (sub ? `<div style="font-size:12px;color:#6b7094;margin-top:2px;">${esc(sub)}</div>` : '') + `</div></td>`;
  const s = m.speed;
  const rows: string[] = [];
  if (s?.mobile) rows.push(tile('Site speed (mobile)', s.mobile.score + '/100', s.mobile.lcpSeconds != null ? s.mobile.lcpSeconds + 's to load' : ''));
  if (s?.desktop) rows.push(tile('Site speed (desktop)', s.desktop.score + '/100', ''));
  if (m.reviews?.rating != null) rows.push(tile('Google rating', m.reviews.rating + ' ★', (m.reviews.count ?? 0) + ' reviews'));
  if (m.search?.clicks != null) rows.push(tile('Search clicks', String(m.search.clicks), 'last 28 days'));
  const grid = rows.length
    ? '<table width="100%" cellpadding="0" cellspacing="0">' + rows.map((t, i) => (i % 2 === 0 ? '<tr>' : '') + t + (i % 2 === 1 || i === rows.length - 1 ? '</tr>' : '')).join('') + '</table>'
    : '<p style="font-size:14px;color:#6b7094;">Your latest metrics are refreshing. Open your portal to see them.</p>';
  return [
    '<!DOCTYPE html><html><head><meta charset="UTF-8" /></head><body style="margin:0;background:#f8f9fc;font-family:Helvetica,Arial,sans-serif;">',
    '<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">',
    '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;"><tr><td style="background:#fff;border:1px solid #e4e7f1;border-radius:16px;padding:36px 32px;">',
    '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#7851a9;margin-bottom:10px;">Your growth report</div>',
    `<h1 style="font-size:20px;font-weight:800;color:#0f1228;margin:0 0 6px;">How ${esc(url || 'your site')} is doing</h1>`,
    '<p style="font-size:14px;color:#6b7094;line-height:1.6;margin:0 0 22px;">Here is a snapshot of your website performance and growth, kept in shape by your WebEaze plan.</p>',
    grid,
    `<p style="font-size:13px;color:#a0a6c4;line-height:1.6;margin:22px 0 0;">See the full, live report any time in your <a href="${PORTAL_URL}" style="color:#7851a9;font-weight:700;text-decoration:none;">Client Portal</a>.</p>`,
    '</td></tr><tr><td align="center" style="padding-top:22px;"><p style="font-size:12px;color:#a0a6c4;margin:0;">WebEaze Web Design, 109 Pleasant Hill Drive, Camden-Wyoming, Delaware 19934, USA</p></td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const body = await req.json().catch(() => ({}));
    const cronSecret = req.headers.get('x-cron-secret') ?? '';

    // ── Monthly cron: refresh + email everyone ──
    if (cronSecret && cronSecret === CRON_SECRET) {
      const { data: clients } = await service.from('clients').select('user_id, id, email, name, site_url, google_place_id').not('site_url', 'is', null);
      let sent = 0;
      for (const c of clients ?? []) {
        try {
          const metrics = await refreshClient(service, c);
          if (c.email) { await sendEmail({ from: FROM, to: [c.email], subject: 'Your monthly growth report', html: summaryHtml(c.name || '', c.site_url || '', metrics) }); sent++; }
        } catch (e) { console.error('monthly client failed', c.user_id, e); }
      }
      return json({ ok: true, refreshed: (clients ?? []).length, emailed: sent });
    }

    // ── On-demand: authenticate the caller, act on their own client only ──
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user }, error: uErr } = await authed.auth.getUser();
    if (uErr || !user) return json({ error: 'Unauthorized' }, 401);

    // Clients refresh their own record; the admin account may refresh any client (targetUserId).
    const targetUserId = (body.targetUserId && user.email === 'billy@webeaze.io') ? body.targetUserId : user.id;
    const { data: c } = await service.from('clients').select('user_id, id, email, name, site_url, google_place_id').eq('user_id', targetUserId).maybeSingle();
    if (!c) return json({ error: 'No client record' }, 404);

    const metrics = await refreshClient(service, c);
    let note = !c.site_url ? 'This client has no Site URL set — add one in the admin editor.'
      : (!PSI_KEY ? 'GOOGLE_PSI_KEY secret is not set on the function.'
      : (metrics.speed ? '' : 'PageSpeed returned no data. Check the Site URL is a reachable https page and the PageSpeed Insights API is enabled for your key.'));

    // Email is sent to the client's own address on file. Report exactly what happened
    // (sent + to whom, or why not) rather than assuming success.
    let emailed = false;
    let emailedTo: string | null = null;
    if (body.action === 'email') {
      if (!c.email) {
        note = note || 'No email address is on this client record, so nothing was sent.';
      } else {
        try {
          await sendEmail({ from: FROM, to: [c.email], subject: 'Your growth report', html: summaryHtml(c.name || '', c.site_url || '', metrics) });
          emailed = true; emailedTo = c.email;
        } catch (e) {
          console.error('[growth] email send failed:', e);
          note = 'The report could not be emailed right now (' + String(e).slice(0, 120) + ').';
        }
      }
    }
    return json({ ok: true, metrics, note, emailed, emailedTo });
  } catch (e) {
    console.error('growth-report error:', e);
    return json({ error: String(e) }, 500);
  }
});
