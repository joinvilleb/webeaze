// Supabase Edge Function: request-draft
// Sends ONE client request to the webeaze-request-bot, which has Claude read the client's repo and
// open a pull request with the change. Billy reviews the diff and merges. Nothing goes live here.
//
// Why this exists at all: the bot was written to be triggered by a HubSpot form webhook, and clients
// submit in the portal, so it had never once run on a real request. This is the missing wire.
//
// Why it is a button and not a trigger: three independent reviews of this system reached the same
// conclusion. At current volume roughly one request a week is genuinely automatable, so the prize is
// 20 to 30 minutes a week, while an always-on version costs more than that in daily reading. The
// bot's only unattended merge in production shipped 48 lines of corrupted text to a live homepage.
// A human on every publish is proportionate until there is a track record.
//
// Why an edge function rather than calling the worker from admin.html: BOT_SECRET must never reach a
// browser. The worker edits client repos, so anyone holding that secret can rewrite a live site.
//
// Entry (POST), admin only:
//   { requestId }            draft a change for this update_requests row
//   { requestId, revert:true } undo the last commit on that client's repo
//
// Deploy:  supabase functions deploy request-draft   (Verify JWT ON; admin calls it with a JWT)
// Secret:  BOT_SECRET  (the SAME value set on the worker: wrangler secret put BOT_SECRET)
// SQL:     supabase/request_ai.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';

const BOT_URL = 'https://webeaze-request-bot.webeaze-web-design.workers.dev/';
const BOT_SECRET = Deno.env.get('BOT_SECRET') ?? '';
const ADMIN = 'billy@webeaze.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Requests the bot has no business attempting. It can only edit text in files that already exist:
// it cannot create or delete a page, upload an image, touch DNS, or fix a site that is down. Sending
// it these produces a confidently wrong pull request, which costs more to review than to ignore.
const UNSUITABLE = /^(site down|hosting|domain|billing|other)/i;
function unsuitableReason(type: string, notes: string): string | null {
  const t = String(type || '');
  if (UNSUITABLE.test(t)) return 'This is a ' + t.toLowerCase() + ' request, which is not a text edit to an existing page.';
  if (String(notes || '').trim().length < 15) return 'There is not enough detail here for anything to be changed reliably.';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    // Admin only, and deliberately not a role check: exactly one person should be able to make an AI
    // commit to a client's website.
    if (user.email !== ADMIN) return json({ error: 'Forbidden' }, 403);
    if (!BOT_SECRET) return json({ ok: false, reason: 'not-configured', message: 'BOT_SECRET is not set on this function. It must match the worker\'s BOT_SECRET.' });

    const body = await req.json().catch(() => ({} as any));
    const requestId = String(body.requestId || '').trim();
    if (!requestId) return json({ ok: false, reason: 'no-request' });

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: r } = await service.from('update_requests')
      .select('id, user_id, type, notes, status').eq('id', requestId).maybeSingle();
    if (!r) return json({ ok: false, reason: 'not-found' });

    const { data: c } = await service.from('clients')
      .select('name, email, site_url, business_name').eq('user_id', r.user_id).maybeSingle();
    if (!c) return json({ ok: false, reason: 'no-client' });
    if (!c.site_url) return json({ ok: false, reason: 'no-site', message: 'This client has no site URL on file, so there is no site to edit.' });

    const revert = !!body.revert;
    if (!revert) {
      const why = unsuitableReason(r.type, r.notes);
      if (why) return json({ ok: false, reason: 'unsuitable', message: why });
    }

    const payload: Record<string, unknown> = revert
      ? { action: 'revert', site_url: c.site_url }
      : {
          site_url: c.site_url,
          email: c.email || '',
          request_type: r.type || 'Content update',
          request_description: r.notes || '',
          firstname: String(c.name || '').split(/\s+/)[0] || 'Client',
          lastname: String(c.name || '').split(/\s+/).slice(1).join(' '),
        };

    let out: any = {};
    let httpStatus = 0;
    try {
      const res = await fetch(BOT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webeaze-secret': BOT_SECRET },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),   // a 12 turn agent loop over a real repo is not quick
      });
      httpStatus = res.status;
      out = await res.json().catch(() => ({}));
    } catch (e) {
      console.error('[request-draft] bot call failed:', e);
      return json({ ok: false, reason: 'bot-unreachable', message: String((e as any)?.message || e).slice(0, 160) });
    }
    if (httpStatus === 401) {
      return json({ ok: false, reason: 'bot-unauthorized', message: 'The bot rejected our secret. BOT_SECRET here must match BOT_SECRET on the worker.' });
    }

    // Record what happened, so the card shows it after a reload and a second click does not re-run a
    // draft that already exists. Best effort: a missing column must not lose the pull request link.
    // Merging is not publishing on every site. bearcarpetcare's pages are generated and need a build
    // run; hairresponse does not deploy on push. Carrying that note onto the card is the difference
    // between a change going live and quietly sitting in a merged branch.
    const note = [
      String(out.reason || out.skipped || out.error || '').trim(),
      out.afterMerge ? 'After merging: ' + String(out.afterMerge).trim() : '',
    ].filter(Boolean).join(' ');
    const patch: Record<string, unknown> = {
      ai_status: revert ? 'reverted' : (out.merged ? 'merged' : out.pr ? 'drafted' : out.escalated ? 'escalated' : out.ok === false ? 'failed' : 'no-change'),
      ai_reason: note.slice(0, 400) || null,
      ai_pr_url: out.pr || null,
      ai_at: new Date().toISOString(),
    };
    try { await service.from('update_requests').update(patch).eq('id', requestId); }
    catch (e) { console.warn('[request-draft] could not record outcome:', e); }

    return json({ ok: true, bot: out, status: patch.ai_status, pr: out.pr || null });
  } catch (e) {
    console.error('[request-draft] error:', e);
    return json({ ok: false, reason: 'error', message: String((e as any)?.message || e).slice(0, 200) });
  }
});
