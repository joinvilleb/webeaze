// Supabase Edge Function: postcard-send
//
// Mails a postcard through PostGrid to the next few businesses on the admin Growth "Postcard list":
// the best-scored prospects in the City of Miami, Maryland, Pennsylvania or New Jersey that have not
// been mailed yet. Replaces the cold-email machine (switched off 2026-09-22).
//
//   { action: 'weekly' }   the daily cron. Does nothing unless switched on in admin, it is the chosen
//                          weekday (US Eastern), and the last run was 6+ days ago.
//   { action: 'preview' }  admin: who this week's cards would go to. Mails nothing.
//   { action: 'send' }     admin: send this week's batch now (same checks as weekly, minus the day).
//
// Every card costs real money, so nothing goes out until Billy switches it on in admin and fills in
// the PostGrid template and return address there. With a test key (test_...) PostGrid builds the
// cards but never mails them, and prospects are NOT marked mailed, so it can be tried safely.
//
// Settings: public.postcard_settings (supabase/postcard_automation.sql), edited in admin.
// Secrets:  POSTGRID_API_KEY (set in the Supabase dashboard, never in the portal), CRON_SECRET.
// Deploy:   supabase functions deploy postcard-send --no-verify-jwt   (self-auths like prospect-scan)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const POSTGRID_KEY = Deno.env.get('POSTGRID_API_KEY') ?? '';
const ADMIN_EMAIL = 'billy@webeaze.io';
const API = 'https://api.postgrid.com/print-mail/v1/postcards';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Same rules as the admin list, so the preview and the list can never disagree about who is in.
const REGIONS = [/, Miami, FL \d{5}/, /, MD \d{5}/, /, PA \d{5}/, /, NJ \d{5}/];
const OPEN = ['new', 'queued', 'drafted'];

// "123 Main St, Ste 4, Miami, FL 33130, USA" -> PostGrid's address fields.
function split(addr: string) {
  const parts = String(addr || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length && /^(USA|United States)$/i.test(parts[parts.length - 1])) parts.pop();
  const m = (parts.pop() || '').match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  const city = parts.pop() || '';
  return { line1: parts[0] || '', line2: parts.slice(1).join(', '), city, state: m ? m[1] : '', zip: m ? m[2] : '' };
}

async function pickNext(service: any, n: number) {
  const out: any[] = [];
  for (let from = 0; from < 10000 && out.length < n; from += 1000) {
    const { data, error } = await service.from('prospects')
      .select('id, name, category, address, outreach, score')
      .in('status', OPEN).not('address', 'is', null)
      .order('score', { ascending: false }).range(from, from + 999);
    if (error) throw new Error('prospects: ' + error.message);
    for (const p of data || []) {
      const a = split(p.address);
      if (REGIONS.some((r) => r.test(p.address)) && a.line1 && a.zip) { out.push(p); if (out.length >= n) break; }
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Eastern-time weekday, 0 = Sunday. The cron fires in UTC; the choice in admin is a US day.
function easternWeekday() {
  const d = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(d);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const cronSecret = req.headers.get('x-cron-secret') ?? '';
  const byCron = !!CRON_SECRET && cronSecret === CRON_SECRET;
  let byAdmin = false;
  if (!byCron) {
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    byAdmin = user?.email === ADMIN_EMAIL;
  }
  if (!byCron && !byAdmin) return json({ ok: false, error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const { data: s, error: sErr } = await service.from('postcard_settings').select('*').eq('id', 'default').maybeSingle();
    if (sErr || !s) return json({ ok: false, error: 'Run supabase/postcard_automation.sql first.' }, 500);
    const live = POSTGRID_KEY.startsWith('live_');
    const perRun = Math.max(1, Math.min(50, Number(s.per_run) || 5));

    if (action === 'preview') {
      const next = await pickNext(service, perRun);
      return json({ ok: true, keySet: !!POSTGRID_KEY, live, enabled: !!s.enabled,
        next: next.map((p) => ({ id: p.id, name: p.name, address: p.address, score: p.score })) });
    }
    // What PostGrid itself has, newest first. Answers "I hit send but I cannot find them": a card that
    // exists here is real, wherever the dashboard files it (single API orders are not Campaigns).
    if (action === 'recent') {
      if (!byAdmin) return json({ ok: false, error: 'Unauthorized' }, 401);
      if (!POSTGRID_KEY) return json({ ok: false, error: 'Add the POSTGRID_API_KEY secret in Supabase first.' }, 400);
      const r = await fetch(API + '?limit=' + Math.max(1, Math.min(20, Number(body.limit) || 5)), { headers: { 'x-api-key': POSTGRID_KEY } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, error: String((j && j.error && (j.error.message || j.error.type)) || ('HTTP ' + r.status)).slice(0, 200) }, 400);
      const rows = (j.data || []).map((p: any) => ({
        id: p.id, status: p.status, live: p.live, createdAt: p.createdAt,
        to: (p.to && (p.to.companyName || [p.to.firstName, p.to.lastName].filter(Boolean).join(' '))) || '',
        url: p.url || null,
      }));
      return json({ ok: true, live, count: rows.length, postcards: rows });
    }
    if (action !== 'weekly' && action !== 'send') return json({ ok: false, error: 'Unknown action.' }, 400);
    if (action === 'send' && !byAdmin) return json({ ok: false, error: 'Unauthorized' }, 401);

    // Everything that has to be true before a card costs money.
    // The schedule needs the switch on; Send now from admin is its own explicit, confirmed choice.
    if (action === 'weekly') {
      if (!s.enabled) return json({ ok: true, skipped: 'Weekly postcards are switched off.' });
      if (easternWeekday() !== Number(s.weekday)) return json({ ok: true, skipped: 'Not the chosen day.' });
      if (s.last_run_at && Date.now() - new Date(s.last_run_at).getTime() < 6 * 86400000) return json({ ok: true, skipped: 'Already ran this week.' });
    }
    if (!POSTGRID_KEY) return json({ ok: false, error: 'Add the POSTGRID_API_KEY secret in Supabase first.' }, 400);
    if (!s.front_template || !s.back_template || !s.from_contact) {
      return json({ ok: false, error: 'Fill in the front template, back template and return address in admin first.' }, 400);
    }

    const next = await pickNext(service, perRun);
    const sent: any[] = [], failed: any[] = [];
    for (const p of next) {
      const a = split(p.address);
      const form = new URLSearchParams();
      form.set('to[companyName]', p.name);
      form.set('to[addressLine1]', a.line1);
      if (a.line2) form.set('to[addressLine2]', a.line2);
      form.set('to[city]', a.city);
      form.set('to[provinceOrState]', a.state);
      form.set('to[postalOrZip]', a.zip);
      form.set('to[countryCode]', 'US');
      form.set('from', s.from_contact);
      form.set('frontTemplate', s.front_template);
      form.set('backTemplate', s.back_template);
      form.set('size', s.size || '6x4');
      form.set('mailingClass', s.mailing_class || 'first_class');
      form.set('description', 'WebEaze postcard: ' + p.name);
      // Usable in the PostGrid design as {{businessName}}, {{city}}, {{category}} (or {{to.companyName}}).
      form.set('mergeVariables[businessName]', p.name);
      form.set('mergeVariables[city]', a.city);
      form.set('mergeVariables[category]', p.category || '');
      form.set('metadata[prospect_id]', p.id);
      let res: Response, j: any = {};
      try {
        res = await fetch(API, {
          method: 'POST',
          headers: {
            'x-api-key': POSTGRID_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
            // A retried run within 24h returns the same card instead of mailing a second one.
            'Idempotency-Key': 'wz-postcard-' + p.id + (live ? '' : '-test'),
          },
          body: form,
        });
        j = await res.json().catch(() => ({}));
      } catch (e) { failed.push({ name: p.name, error: 'Could not reach PostGrid: ' + String(e).slice(0, 120) }); break; }

      if (res.ok && j.id) {
        sent.push({ name: p.name, id: j.id, status: j.status });
        // Only a LIVE card counts as mailed. A test card must not shrink the real list.
        if (live) {
          await service.from('prospects').update({
            status: 'sent', last_sent_at: new Date().toISOString(),
            outreach: { ...(p.outreach || {}), postcard: { id: j.id, status: j.status, size: s.size, sentAt: new Date().toISOString() } },
          }).eq('id', p.id);
        }
        continue;
      }
      const msg = String((j && j.error && (j.error.message || j.error.type)) || ('HTTP ' + res.status)).slice(0, 200);
      failed.push({ name: p.name, error: msg });
      // A bad key or a PostGrid outage stops the run rather than failing all five the same way.
      if (res.status === 401 || res.status === 403 || res.status >= 500) break;
      // A rejected address will be rejected every week, so take that business off the list.
      if (live && /address|zip|postal|province|state|city/i.test(msg)) {
        await service.from('prospects').update({ status: 'skipped', notes: 'PostGrid could not mail this address: ' + msg }).eq('id', p.id);
      }
    }

    const run = { at: new Date().toISOString(), live, by: byCron ? 'schedule' : 'admin', sent, failed };
    if (sent.length || failed.length) await service.from('postcard_settings').update({ last_run_at: run.at, last_run: run }).eq('id', 'default');
    return json({ ok: failed.length === 0 || sent.length > 0, ...run });
  } catch (e) {
    console.error('[postcard-send]', e);
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 200) }, 500);
  }
});
