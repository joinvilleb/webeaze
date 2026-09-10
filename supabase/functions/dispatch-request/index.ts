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

// ── The client's "it is done" email ─────────────────────────────────────────
// admin.html sends this whenever a request is completed by hand. This function completes requests
// with nobody watching, and the database trigger that used to cover EVERY completion was dropped in
// supabase/request_done_email.sql when the better email moved into the admin page. So without this,
// an AI change is published to a client's live site, their portal flips to Complete, and nothing
// ever tells them. That is exactly what happened: a request closed here sent no email at all.
//
// The same block lives in request-draft/index.ts. Keep the two in step.
const MAILER_URL = 'https://webeaze-mailer.webeaze-web-design.workers.dev';
const escHtml = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

// Two of the dropdown's stored values are unfit for a subject line: "Other" names our form rather
// than their request, and the urgent option stores an em dash, which we do not use in copy.
function doneSubject(type: unknown) {
  const t = String(type ?? '').trim();
  if (/site down/i.test(t)) return 'Urgent fix';
  if (!t || /^other$/i.test(t)) return 'Your request';
  return t;
}

// Their own words, quoted back, because a completion email can land a week after they wrote it and
// "Complete: Content update" tells them nothing about WHICH content update. Cuts at a paragraph if
// one is close to the limit, otherwise at a word, never mid-word. A cut that lands inside a URL
// drops the URL instead of shortening it: a truncated address still links, to somewhere wrong.
function trimForEmail(text: unknown, max: number) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const para = head.lastIndexOf('\n\n');
  if (para > max * 0.5) return head.slice(0, para).trim() + '\n\n...';
  const sp = head.lastIndexOf(' ');
  if (sp > 0) return head.slice(0, sp).trim() + '...';
  return head.replace(/(?:https?:\/\/|www\.)\S*$/i, '').trim() + '...';
}

// A blank line between two thoughts is how it was written; run together it reads as one wall.
function emailParas(text: unknown, css = 'margin:0 0 12px;') {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  return blocks.map((b, i) => '<p style="' + css + (i === blocks.length - 1 ? 'margin-bottom:0;' : '') + '">'
    + escHtml(b).replace(/\n/g, '<br>') + '</p>').join('');
}

// r: { id, type, notes, resolution }   c: the clients row (email, second_email, name)
async function sendDoneEmail(r: any, c: any) {
  // The partner address matters here: on a managed account the person who submitted is often not the
  // account holder. Duplicates are dropped so nobody reads the same message twice.
  const to = [c?.email, c?.second_email].map((a: unknown) => String(a ?? '').trim()).filter(Boolean)
    .filter((a: string, i: number, all: string[]) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
  if (!to.length) { console.warn('[done email] no address on file for request ' + r?.id); return false; }
  const first = String(c?.name ?? '').trim().split(/\s+/)[0] || '';
  const asked = trimForEmail(r?.notes, 500);   // enough to recognise it; the rest is one click away
  const what = String(r?.resolution ?? '').trim();
  const link = 'https://portal.webeaze.io/#history/' + encodeURIComponent(String(r?.id ?? ''));
  const preheader = (what || 'Your request is complete.').replace(/\s+/g, ' ').slice(0, 140);
  const html =
    // Given nothing to show, a mail app scrapes the first words of the body for the line next to the
    // subject, which is the greeting. This hands it the sentence that actually says what happened.
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + escHtml(preheader) + '</div>' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2333;">' +
    '<p style="margin:0 0 12px;">Hey' + (first ? ' ' + escHtml(first) : '') + ',</p>' +
    '<p style="margin:0 0 16px;">Your request is complete.</p>' +
    (asked
      ? '<p style="margin:0 0 8px;"><b>What you asked for</b></p>'
        + '<div style="background:#f7f7fa;border:1px solid #e4e7f1;border-left:3px solid #cfd3e2;border-radius:8px;padding:14px 16px;margin:0 0 18px;">'
        + emailParas(asked, 'margin:0 0 10px;') + '</div>'
      : '') +
    (what ? '<p style="margin:0 0 8px;"><b>What we changed</b></p>' + emailParas(what) : '') +
    // emailParas zeroes the last paragraph's bottom margin, so the button needs its own top margin
    // or it sits flush against the final line.
    '<div style="margin:20px 0 0;"><a href="' + link + '" style="display:inline-block;background:#7851a9;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">See it in your portal</a></div>' +
    '<p style="margin:28px 0 4px;">Best,</p><p style="margin:0;">WebEaze Web Design</p>' +
    '</div>';
  try {
    const res = await fetch(MAILER_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'WebEaze <support@webeaze.io>', to, subject: 'Complete: ' + doneSubject(r?.type), html }),
    });
    if (!res.ok) { console.error('[done email] mailer ' + res.status + ': ' + (await res.text()).slice(0, 160)); return false; }
    return true;
  } catch (e) { console.error('[done email] send failed:', e); return false; }
}

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

  const { data: c } = await service.from('clients').select('email, second_email, name, site_url').eq('user_id', userId).maybeSingle();
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
    const resolution = 'This has been updated and is now live on your site.';
    const { error: upErr } = await service.from('update_requests')
      .update({ status: 'Done', resolution, completed_at: new Date().toISOString() }).eq('id', requestId);
    if (upErr) console.warn('[dispatch] could not mark done:', upErr.message);
    // Tell them. Nobody has a browser open on this path, so admin.html's email never runs, and the
    // change is already live on their site.
    else await sendDoneEmail({ id: requestId, type, notes: description, resolution }, c);
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
