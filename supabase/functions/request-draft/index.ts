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
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
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
// NOT anchored, deliberately. The client-facing option is "Urgent — site down", so an anchored
// ^(site down|...) matched nothing and handed a live outage to an AI to go and edit files with.
// Matching anywhere in the label is what actually catches the types on offer.
const UNSUITABLE = /(site down|hosting|domain|billing|urgent)/i;
function unsuitableReason(type: string, notes: string): string | null {
  const t = String(type || '');
  if (/^other$/i.test(t.trim())) return 'This is an "Other" request, so there is nothing specific enough to act on automatically.';
  if (UNSUITABLE.test(t)) return 'This is a ' + t.toLowerCase() + ' request, which is not a text edit to an existing page.';
  if (String(notes || '').trim().length < 15) return 'There is not enough detail here for anything to be changed reliably.';
  return null;
}

// ── The client's "it is done" email ─────────────────────────────────────────
// admin.html sends this whenever a request is completed by hand. This function completes requests
// with nobody watching, and the database trigger that used to cover EVERY completion was dropped in
// supabase/request_done_email.sql when the better email moved into the admin page. So without this,
// an AI change is published to a client's live site, their portal flips to Complete, and nothing
// ever tells them. That is exactly what happened: a request closed here sent no email at all.
//
// The same block lives in dispatch-request/index.ts. Keep the two in step.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // Two ways in. The admin's own JWT, for the "Draft with AI" button; or the cron secret, for the
    // database trigger that fires the moment a client submits a request. Nothing else.
    const viaCron = !!CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET;
    if (!viaCron) {
      const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
      const { data: { user } } = await authed.auth.getUser();
      if (!user) return json({ error: 'Unauthorized' }, 401);
      // Admin only, and deliberately not a role check: exactly one person should be able to make an AI
      // commit to a client's website.
      if (user.email !== ADMIN) return json({ error: 'Forbidden' }, 403);
    }
    if (!BOT_SECRET) return json({ ok: false, reason: 'not-configured', message: 'BOT_SECRET is not set on this function. It must match the worker\'s BOT_SECRET.' });

    const body = await req.json().catch(() => ({} as any));
    const requestId = String(body.requestId || '').trim();
    if (!requestId) return json({ ok: false, reason: 'no-request' });

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: r } = await service.from('update_requests')
      .select('id, user_id, type, notes, status, ai_at').eq('id', requestId).maybeSingle();
    if (!r) return json({ ok: false, reason: 'not-found' });
    // The trigger fires once per insert, but a retry, a restored backup or a manual re-run must not
    // open a second pull request for the same request. The button can still force a redraft.
    if (viaCron && r.ai_at) return json({ ok: true, skipped: 'already-drafted' });

    const { data: c } = await service.from('clients')
      .select('name, email, second_email, site_url, business_name').eq('user_id', r.user_id).maybeSingle();
    if (!c) return json({ ok: false, reason: 'no-client' });
    if (!c.site_url) return json({ ok: false, reason: 'no-site', message: 'This client has no site URL on file, so there is no site to edit.' });

    // What the client has given us to work from: the Drive folder, the menu, the brand files. It is
    // sent as context appended to the description rather than as a new field, because the worker
    // builds its prompt (and the pull request body Billy reads) from the description alone. Framed
    // explicitly as reference, or the bot reads "our menu is at this link" as a thing to go and add.
    let refBlock = '';
    try {
      const { data: res, error: resErr } = await service.from('client_resources')
        .select('label, url, note, file_name').eq('user_id', r.user_id)
        .order('created_at', { ascending: false }).limit(8);
      if (!resErr && res && res.length) {
        const lines = res.map((x: any) => {
          const where = x.file_name || x.url || '';
          return '- ' + String(x.label || '').slice(0, 80)
            + (where ? ': ' + String(where).slice(0, 200) : '')
            + (x.note ? ' (' + String(x.note).replace(/\s+/g, ' ').slice(0, 140) + ')' : '');
        }).join('\n');
        refBlock = '\n\n--- Reference material the client has on file. Context only, NOT part of the request ---\n'
          + lines.slice(0, 900);
      }
    } catch (_e) { /* client_resources.sql not run yet: the request stands on its own */ }

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
          request_description: (r.notes || '') + refBlock,
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
    // MERGED means it is live on their site, so the request is genuinely finished and should say so
    // rather than sitting in the client's portal as "In progress" for work already published.
    //
    // Only on a real merge. A pull request waiting for review is not done, and "afterMerge" sites
    // (bearcarpetcare, hairresponse) still need a build or a deploy, so a merge there is not live and
    // must not be marked complete.
    if (out.merged && !out.afterMerge && r.status !== 'Done') {
      patch.status = 'Done';
      patch.completed_at = new Date().toISOString();
      // What the client reads in their portal. The bot's own one-line summary when the safety
      // reviewer produced one, because it is written for a non-technical owner.
      patch.resolution = String(out.summary || '').trim()
        || 'We made this change and it is live on your site now.';
    }
    let recorded = true;
    try {
      const { error: upErr } = await service.from('update_requests').update(patch).eq('id', requestId);
      if (upErr) { recorded = false; console.warn('[request-draft] could not record outcome:', upErr.message); }
    } catch (e) { recorded = false; console.warn('[request-draft] could not record outcome:', e); }

    // Tell the client. Only when the completion was actually written: an email saying it is done,
    // over a portal still showing In progress, is worse than no email.
    const emailed = (recorded && patch.status === 'Done')
      ? await sendDoneEmail({ id: requestId, type: r.type, notes: r.notes, resolution: patch.resolution }, c)
      : false;

    return json({ ok: true, bot: out, status: patch.ai_status, pr: out.pr || null, completed: !!patch.status, emailed });
  } catch (e) {
    console.error('[request-draft] error:', e);
    return json({ ok: false, reason: 'error', message: String((e as any)?.message || e).slice(0, 200) });
  }
});
