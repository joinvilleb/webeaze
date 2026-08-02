// Supabase Edge Function: dispatch-request
// Fired by a Database Webhook whenever a row is inserted into update_requests (from the portal
// form OR from Eaze filing a request). It looks up the client's email, hands the request to the
// webeaze-request-bot, and, if the bot auto-merged the change live, marks the request Done so the
// client sees it handled. Requests for non-git-backed clients (not in the bot's CLIENTS_JSON), or
// ones the bot escalates, simply stay pending for Billy, nothing breaks.
//
// Deploy:  supabase functions deploy dispatch-request --no-verify-jwt
// Auth:    the webhook must send header  x-dispatch-secret: <CRON_SECRET>  (reuses the existing secret)
// Webhook: Database -> Webhooks -> on public.update_requests, event INSERT, POST to this function URL,
//          add HTTP header x-dispatch-secret with your CRON_SECRET value.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const DISPATCH_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const BOT_URL = 'https://webeaze-request-bot.webeaze-web-design.workers.dev/';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-dispatch-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!DISPATCH_SECRET || req.headers.get('x-dispatch-secret') !== DISPATCH_SECRET) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({} as any));
    const record = body.record || body;   // DB webhook wraps the row in `record`; also allow a direct call
    const userId = record.user_id;
    const requestId = record.id;
    const type = record.type || 'General update';
    const description = String(record.notes || record.description || '').trim();
    if (!userId || !description) return json({ ok: true, skipped: 'missing user or description' });
    // Only act on brand-new requests, not ones already resolved.
    if (record.status && !['Received', 'New', 'In progress'].includes(record.status)) return json({ ok: true, skipped: `status ${record.status}` });

    // ── Safety gate ──────────────────────────────────────────────────────────────────────
    // The bot self-gates by CLIENTS_JSON (opted-in clients) and escalates anything complex, but
    // some requests must NEVER be auto-actioned regardless. These stay pending for Billy. Widen
    // this as trust grows (e.g. re-allow bugs once site-watch auto-rollback ships).
    const tl = String(type).toLowerCase();
    if (tl.includes('urgent') || tl.includes('down'))    return json({ ok: true, skipped: 'emergency: needs a human now' });
    if (tl.includes('bug') || tl.includes('broken'))     return json({ ok: true, skipped: 'bug fix: human until auto-rollback exists' });
    if (tl === 'other')                                  return json({ ok: true, skipped: 'ambiguous type: human triage' });
    if (record.attachment_url)                           return json({ ok: true, skipped: 'has an attachment for a human to place' });
    if (record.scheduled_for)                            return json({ ok: true, skipped: 'scheduled for a future date' });

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: c } = await service.from('clients').select('email, name').eq('user_id', userId).maybeSingle();
    if (!c?.email) return json({ ok: true, skipped: 'no client email' });

    // Hand it to the bot (the bot self-gates: only clients in its CLIENTS_JSON are serviced).
    let bot: any = {};
    try {
      const res = await fetch(BOT_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: c.email,
          request_description: description,
          request_type: type,
          firstname: (c.name || '').split(/\s+/)[0] || 'Client',
        }),
      });
      bot = await res.json().catch(() => ({}));
    } catch (e) {
      return json({ ok: true, botError: String(e).slice(0, 160) });
    }

    // If the bot pushed the change live, close the loop: mark the request Done for the client.
    if (bot && bot.merged && requestId) {
      await service.from('update_requests').update({
        status: 'Done',
        resolution: 'This has been updated and is now live on your site.',
        completed_at: new Date().toISOString(),
      }).eq('id', requestId);
    }
    // Drop a lightweight signal the site-watch auto-rollback watchdog looks for (a live auto-change
    // just landed). No client_note, so it does NOT show in "Recently handled" (the completed
    // request already covers that); it exists only so a site going down soon after can be reverted.
    if (bot && bot.merged) {
      await service.from('site_issues').insert({
        user_id: userId, kind: 'auto_edit', status: 'fixed',
        detail: 'auto-actioned request ' + (requestId || ''),
        fixed_at: new Date().toISOString(), notified: true,
      });
    }
    // Bot opened a PR (no auto-merge) or escalated → leave the request pending for Billy.

    return json({ ok: true, handled: bot.merged ? 'merged' : (bot.escalated ? 'escalated' : (bot.pr ? 'pr' : 'noop')), bot });
  } catch (e) {
    console.error('[dispatch-request] error:', e);
    return json({ ok: false, error: String(e).slice(0, 160) }, 200);
  }
});
