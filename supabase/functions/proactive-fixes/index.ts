// Supabase Edge Function: proactive-fixes
// Cron-triggered "quiet maintenance pass". For each active client with a site_url it asks the
// webeaze-request-bot to run a SAFE scan and fix only unambiguous small things (a stale copyright
// year, a promo or date that has clearly already passed, a broken internal link, an image missing
// alt text). The bot self-gates by CLIENTS_JSON, so clients it does not manage simply no-op. When
// the bot pushes a change live (merged), we log a friendly "recently handled" note in site_issues
// so the client sees we looked after them, without ever being pestered.
//
// Entry modes (all require the x-cron-secret header === CRON_SECRET):
//   body.action:'list' → return the user_ids only, so a caller can fan out one client at a time
//   body.only:<user_id> → run just that one client (single-client fan-out, like growth-report)
//   (default)           → run every active client with a site_url
//
// Deploy:   supabase functions deploy proactive-fixes --no-verify-jwt
// Schedule: pg_cron, weekly, x-cron-secret header (see supabase/site_issues.sql note below).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const BOT_URL = 'https://webeaze-request-bot.webeaze-web-design.workers.dev/';

// The one instruction we hand the bot. Deliberately narrow: fix only what is unambiguous, edit
// as little as possible, and never touch design, branding, or wording when in any doubt.
const SCAN_REQUEST = [
  'Please run a quiet, SAFE maintenance pass over the site and fix ONLY unambiguous small things:',
  '1) an out-of-date copyright or footer year (bring it to the current year),',
  '2) seasonal promos, sale banners, or event dates that have clearly already passed,',
  '3) broken internal links,',
  '4) images that are missing alt text.',
  'Make the smallest possible edits. Skip anything you are unsure about. Do NOT redesign anything,',
  'do NOT change branding, and do NOT rewrite or reword content. If nothing clearly needs fixing,',
  'make no changes at all.',
].join(' ');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// KILL SWITCH, and it is off by default on purpose.
//
// This function asks an AI to edit real clients' live websites every Monday, with no request from
// the client and no human looking at the result. It has been scheduled and running this whole time;
// it was harmless only because CLIENTS_JSON was empty, so every client resolved to no repo. The
// moment that secret is populated, this goes live across every active client at once.
//
// That safety must not be an accident of an unset config. To enable it, deliberately:
//   supabase secrets set PROACTIVE_FIXES_ENABLED=true
// and only once the bot has a track record of good changes that a human approved first.
const PROACTIVE_ENABLED = (Deno.env.get('PROACTIVE_FIXES_ENABLED') ?? '').toLowerCase() === 'true';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);
  if (!PROACTIVE_ENABLED) {
    console.warn('[proactive-fixes] skipped: PROACTIVE_FIXES_ENABLED is not true');
    return json({ ok: true, skipped: 'disabled', note: 'Set PROACTIVE_FIXES_ENABLED=true to allow unattended edits to client sites.' });
  }

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const body = await req.json().catch(() => ({} as any));
    const only = (body && typeof body.only === 'string') ? body.only : null;

    let cq = service.from('clients')
      .select('user_id, id, email, name, site_url, status')
      .not('site_url', 'is', null).neq('status', 'inactive');
    if (only) cq = cq.eq('user_id', only);
    const { data: clients } = await cq;

    // List mode: hand back the user_ids so the caller can fan out one client at a time.
    if (body && body.action === 'list') {
      return json({ ok: true, users: (clients ?? []).map((c: { user_id: string }) => c.user_id) });
    }

    let ran = 0, fixed = 0;
    for (const c of clients ?? []) {
      try {
        if (!c.email) continue;   // the bot keys off the client's email
        ran++;

        // Hand it to the bot (the bot self-gates: only clients in its CLIENTS_JSON are serviced).
        let bot: any = {};
        try {
          const res = await fetch(BOT_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: c.email,
              request_description: SCAN_REQUEST,
              request_type: 'Content update',
              firstname: (c.name || '').split(/\s+/)[0] || 'Client',
            }),
          });
          bot = await res.json().catch(() => ({}));
        } catch (e) {
          console.error('[proactive-fixes] bot call failed', c.user_id, String(e).slice(0, 160));
          continue;
        }

        // Only log when the bot actually pushed a change live. No merge (a no-op, an escalation,
        // or just a PR) means nothing to tell the client about.
        if (bot && bot.merged) {
          const note = (bot.summary && String(bot.summary).trim())
            || 'We ran a quiet maintenance pass and tidied a few small things on your site.';
          await service.from('site_issues').insert({
            user_id: c.user_id,
            client_id: c.id ?? null,
            kind: 'proactive',
            status: 'fixed',
            client_note: note,
            fixed_at: new Date().toISOString(),
            notified: true,
          });
          fixed++;
        }
      } catch (e) { console.error('[proactive-fixes] client failed', c.user_id, e); }
    }

    return json({ ok: true, ran, fixed });
  } catch (e) {
    console.error('[proactive-fixes] error:', e);
    return json({ ok: false, error: String(e).slice(0, 160) }, 200);
  }
});
