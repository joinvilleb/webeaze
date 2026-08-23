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
const BOT_SECRET = Deno.env.get('BOT_SECRET') ?? '';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-dispatch-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Process ONE request through the bot with the full safety gate. Returns a small result object.
// opts.skipSchedule bypasses the "scheduled for a future date" skip (used by the sweep, where the
// scheduled date has already arrived).
async function dispatchOne(service: any, record: any, opts: { skipSchedule?: boolean } = {}) {
  const userId = record.user_id;
  const requestId = record.id;
  const type = record.type || 'General update';
  const description = String(record.notes || record.description || '').trim();
  if (!userId || !description) return { ok: true, skipped: 'missing user or description' };
  if (record.status && !['Received', 'New', 'In progress'].includes(record.status)) return { ok: true, skipped: `status ${record.status}` };

  // ── Safety gate ── some requests must NEVER be auto-actioned; they stay pending for Billy.
  const tl = String(type).toLowerCase();
  if (tl.includes('urgent') || tl.includes('down'))    return { ok: true, skipped: 'emergency: needs a human now' };
  if (tl.includes('bug') || tl.includes('broken'))     return { ok: true, skipped: 'bug fix: human until auto-rollback exists' };
  if (tl === 'other')                                  return { ok: true, skipped: 'ambiguous type: human triage' };
  if (record.attachment_url)                           return { ok: true, skipped: 'has an attachment for a human to place' };
  if (record.scheduled_for && !opts.skipSchedule)      return { ok: true, skipped: 'scheduled for a future date' };

  const { data: c } = await service.from('clients').select('email, name, site_url').eq('user_id', userId).maybeSingle();
  // site_url is what the bot keys on now, so a client with no site cannot be actioned at all. Email
  // alone is no longer enough to find their repo.
  if (!c || (!c.site_url && !c.email)) return { ok: true, skipped: 'no client site url or email' };

  // Say so loudly. An empty BOT_SECRET sends an empty header, the worker returns Unauthorized, and
  // the old code reported that as "noop" -- identical to the bot deciding there was nothing to do.
  // A configuration mistake must not be indistinguishable from a considered decision.
  if (!BOT_SECRET) {
    return { ok: false, reason: 'not-configured', message: 'BOT_SECRET is empty in this function. Set it in Supabase (Edge Functions -> Secrets) to the same value as the worker, then REDEPLOY this function: the value is read once at startup, so an already-running copy keeps the old empty one.' };
  }

  // Hand it to the bot (the bot self-gates: only clients in its CLIENTS_JSON are serviced).
  let bot: any = {};
  try {
    // BOT_SECRET is now required by the worker. It used to accept any caller, which meant anyone who
    // learned the URL could have an AI commit to a client's live site. Without this header the bot
    // returns Unauthorized and this function reports "noop", which looks exactly like a request the
    // bot chose not to action.
    //
    // site_url identifies the client now: the bot keys on the domain, because an email changes and on
    // a managed account the person submitting is not the account holder. Email is still sent as a
    // fallback for any entry not yet migrated.
    const res = await fetch(BOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webeaze-secret': BOT_SECRET },
      body: JSON.stringify({ site_url: c.site_url || '', email: c.email, request_description: description, request_type: type, firstname: (c.name || '').split(/\s+/)[0] || 'Client' }),
    });
    bot = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: true, botError: String(e).slice(0, 160) };
  }

  // If the bot pushed the change live, close the loop: mark the request Done for the client.
  if (bot && bot.merged && requestId) {
    await service.from('update_requests').update({ status: 'Done', resolution: 'This has been updated and is now live on your site.', completed_at: new Date().toISOString() }).eq('id', requestId);
  }
  // Lightweight signal the auto-rollback watchdog looks for (a live auto-change just landed).
  if (bot && bot.merged) {
    await service.from('site_issues').insert({ user_id: userId, kind: 'auto_edit', status: 'fixed', detail: 'auto-actioned request ' + (requestId || ''), fixed_at: new Date().toISOString(), notified: true });
  }
  // "noop" used to swallow every failure the bot reported. A rejected secret, a domain missing from
  // CLIENTS_JSON and a genuine no-change all looked the same from here, which is what made this take
  // an evening to find. Anything the bot flags as not-ok is now named as an error.
  if (bot && bot.ok === false) {
    return { ok: false, handled: 'bot-refused', reason: bot.error || bot.skipped || 'unknown', bot };
  }
  return { ok: true, handled: bot.merged ? 'merged' : (bot.escalated ? 'escalated' : (bot.pr ? 'pr' : 'noop')), bot };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!DISPATCH_SECRET || req.headers.get('x-dispatch-secret') !== DISPATCH_SECRET) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({} as any));
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── Scheduled sweep (daily pg_cron): fire every request whose scheduled_for has now arrived. ──
    // Fixed-date automations (seasonal promo take-downs, "publish this Monday", holiday closures) are
    // filed with a future scheduled_for and skipped on insert; this is what actually runs them on the day.
    if (body.mode === 'scheduled') {
      const nowISO = new Date().toISOString();
      const { data: due } = await service.from('update_requests')
        .select('*').eq('status', 'Received').not('scheduled_for', 'is', null).lte('scheduled_for', nowISO).limit(50);
      const results: any[] = [];
      for (const rec of (due || [])) {
        try {
          const r = await dispatchOne(service, rec, { skipSchedule: true });
          // Whatever the bot did, this request is no longer "future": if it didn't auto-merge (and so
          // wasn't marked Done), clear scheduled_for so it becomes a normal pending request and never
          // gets swept again on the next run.
          if ((r as any).handled !== 'merged') await service.from('update_requests').update({ scheduled_for: null }).eq('id', rec.id);
          results.push({ id: rec.id, ...r });
        } catch (e) { results.push({ id: rec.id, error: String(e).slice(0, 120) }); }
      }
      return json({ ok: true, mode: 'scheduled', due: (due || []).length, results });
    }

    // ── Normal: a single request from the DB webhook (or a direct call). ──
    const record = body.record || body;   // DB webhook wraps the row in `record`
    return json(await dispatchOne(service, record));
  } catch (e) {
    console.error('[dispatch-request] error:', e);
    return json({ ok: false, error: String(e).slice(0, 160) }, 200);
  }
});
