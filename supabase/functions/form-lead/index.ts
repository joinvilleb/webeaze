// Supabase Edge Function: form-lead
// The delivery endpoint for a WebEaze client's website contact form. The form POSTs here instead of
// to a third party, so a lead exists if and only if a real submission arrived — no browser-side
// guessing, nothing to miss.
//
//   <form action="https://<project>.supabase.co/functions/v1/form-lead/<client user_id>" method="POST">
//
// The <client user_id> is the same value already used as track.js's data-key, so there is nothing new
// to look up or keep in sync.
//
// WHY THIS EXISTS: track.js infers leads from click and submit events in the visitor's browser. An ad
// blocker, a closed tab, a JS error or a slow beacon and the lead is gone with no trace anywhere. This
// endpoint is the submission itself, so the count in the portal is the same fact as the email in the
// owner's inbox.
//
// WHAT IT DOES ON EVERY PLAN: stores that a form lead happened, and emails the client the full
// submission. Their contact form is not a feature we can gate — gating it would mean throwing away a
// customer's inquiry — so delivery is unconditional.
// WHAT IS GROWTH/ELITE ONLY: keeping the visitor's name/email/phone/message in the portal's lead
// inbox. On other plans we store the event without personal details, matching track-lead exactly.
//
// Compatible with the Formspree conventions the existing forms already use, so migrating a form is a
// one-line change to `action`:
//   _gotcha   honeypot; if filled we accept and silently discard
//   _subject  overrides the email subject
//   _next     where to send the browser afterwards (must be on the client's own domain)
//
// Deploy:  supabase functions deploy form-lead --no-verify-jwt
// (--no-verify-jwt because the caller is an anonymous visitor submitting a form, not a logged-in user.)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const BUCKET = 'form-uploads';

const MAX_BODY = 12 * 1024 * 1024;    // 12MB total, so a couple of photos or a resume fit
const MAX_FILES = 6;
const MAX_FILE = 6 * 1024 * 1024;
// Above this many form leads in an hour for one client we stop EMAILING (an inbox being flooded
// helps nobody) but we still record every one. This is deliberately not a gate on recording: the
// client's id is printed in their own page source, so anyone can manufacture traffic, and a cap that
// discards submissions would hand a stranger a switch that silently disconnects a business's phone.
const MAX_EMAIL_PER_HOUR = 200;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, accept',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const host = (u: string) => (u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Good enough to keep a malformed address out of an email header. A typo like "john@ gmail.com" is
// rejected by Resend with a 422 that fails the WHOLE notification, so one slip in a visitor's typing
// would otherwise destroy the inquiry it was attached to.
const MAILBOX = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;
const clean = (v: unknown, max: number) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };

// Field names the forms in the wild actually use, including the human-readable ones ("Full Name",
// "Email Address", "Phone Number"). Matching is case- and punctuation-insensitive.
const norm = (k: string) => k.toLowerCase().replace(/[^a-z]/g, '');
const IS_EMAIL = (k: string) => /email|mail/.test(norm(k));
const IS_PHONE = (k: string) => /^(phone|telephone|tel|mobile|cell)/.test(norm(k)) || /phonenumber|mobilenumber/.test(norm(k));
const IS_NAME = (k: string) => /^(name|fullname|yourname|firstname|lastname|contactname)$/.test(norm(k));
const IS_MESSAGE = (k: string) => /message|comment|detail|note|inquiry|enquiry|question|describe|project|howcanwehelp/.test(norm(k));
const IS_META = (k: string) => k.startsWith('_') || /^(g-recaptcha-response|cf-turnstile-response|viewstyle)$/i.test(k);

function textResponse(status: number, body: string, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', ...extra } });
}
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// A built-in thank-you page, used only when the client's site gave us nowhere to send the visitor
// back to. Plain, readable, and it never leaves the visitor staring at raw JSON.
const thanksPage = (business: string) =>
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title>'
  + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#f4f5fa;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1f2333;}'
  + '.c{max-width:420px;padding:36px 28px;background:#fff;border:1px solid #e4e7f1;border-radius:14px;text-align:center;}'
  + 'h1{margin:0 0 10px;font-size:22px;}p{margin:0;color:#6b7094;font-size:15px;line-height:1.6;}'
  + '@media(prefers-color-scheme:dark){body{background:#0f1116;color:#e9eaf2}.c{background:#1a1d25;border-color:#2b2f3d}p{color:#a7adc6}}'
  + '</style></head><body><div class="c"><h1>Thank you</h1>'
  + '<p>Your message has reached ' + esc(business || 'us') + '. Someone will be in touch shortly.</p>'
  + '</div></body></html>';

// Only ever send the visitor somewhere on the client's OWN site. Without this check, `_next` is an
// open redirect on a public unauthenticated endpoint: anyone could post to it to bounce people to a
// phishing page wearing the client's domain in the referrer chain.
function safeNext(next: string | null, siteHost: string, referer: string): string | null {
  const tryUrl = (v: string | null) => {
    if (!v) return null;
    try {
      const u = new URL(v, referer || undefined);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (siteHost && host(u.hostname) !== siteHost) return null;
      return u.toString();
    } catch { return null; }
  };
  // Only honour an explicit _next when we actually know the client's domain to compare it against.
  // With site_url empty, "host matches" is vacuously true and _next becomes an open redirect.
  const chosen = siteHost ? tryUrl(next) : null;
  if (chosen) return chosen;
  const back = tryUrl(referer);
  if (!back) return null;
  try { const u = new URL(back); u.searchParams.set('sent', '1'); return u.toString(); } catch { return back; }
}

async function emailClient(client: any, lead: any, files: { name: string; url: string }[], dropped: string[], subject: string | null) {
  if (!RESEND_API_KEY) return { sent: false, reason: 'no RESEND_API_KEY' };
  const to = [client && client.email, client && client.second_email].filter(Boolean);
  if (!to.length) return { sent: false, reason: 'no client email' };

  const who = lead.name || 'Someone';
  const first = String((client && client.name) || '').trim().split(/\s+/)[0] || 'there';
  const btn = (href: string, label: string, bg: string) =>
    '<a href="' + esc(href) + '" style="display:inline-block;background:' + bg + ';color:#ffffff;text-decoration:none;'
    + 'border-radius:9px;padding:12px 20px;font-weight:700;font-size:15px;margin:0 8px 8px 0;">' + esc(label) + '</a>';
  const row = (k: string, v: string) => v
    ? '<tr><td class="wz-row" style="padding:9px 0;border-bottom:1px solid #eef0f6;">'
      + '<div class="wz-m" style="font-size:12px;line-height:1.45;color:#6b7094;margin:0 0 3px;">' + esc(k) + '</div>'
      + '<div class="wz-t" style="font-size:15px;line-height:1.5;font-weight:600;color:#1f2333;'
      + 'word-break:break-word;overflow-wrap:anywhere;">' + esc(v) + '</div>'
      + '</td></tr>' : '';

  const actions = [
    lead.phone ? btn('tel:' + String(lead.phone).replace(/[^0-9+]/g, ''), 'Call ' + (lead.name || 'them'), '#7851a9') : '',
    lead.email ? btn('mailto:' + lead.email + '?subject=' + encodeURIComponent('Re: your inquiry'), 'Reply by email', '#4b5563') : '',
  ].join('');

  // Everything the visitor typed that is not name/email/phone/message. On a job application that is
  // most of the form, so it is listed in full rather than summarised away.
  const extras = Object.keys(lead.extra || {}).map((k) => row(k, String(lead.extra[k]))).join('');
  const attach = files.length
    ? '<p style="margin:14px 0 0;font-size:14px;color:#6b7094;">Attached: '
      + files.map((f) => (f.url ? '<a href="' + esc(f.url) + '" style="color:#7851a9;font-weight:600;">' + esc(f.name) + '</a>' : esc(f.name)))
        .join(', ') + '</p>' : '';
  // Say what did not make it, so "photos attached" with nothing below it is never a mystery.
  const missing = dropped.length
    ? '<p class="wz-warn" style="margin:10px 0 0;font-size:14px;color:#b45309;">Could not attach: ' + esc(dropped.join(', '))
      + '. Ask them to email it to you directly.</p>' : '';

  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">'
    + '<style>:root{color-scheme:light dark}@media (prefers-color-scheme:dark){'
    + '.wz-page{background:#0f1116!important}.wz-card{background:#1a1d25!important;border-color:#2b2f3d!important}'
    + '.wz-t,.wz-t *{color:#e9eaf2!important}.wz-m,.wz-m *{color:#a7adc6!important}.wz-box{background:#22262f!important}.wz-row{border-color:#2b2f3d!important}.wz-warn,.wz-warn *{color:#fbbf24!important}}</style>'
    + '</head><body class="wz-page" style="margin:0;background:#f4f5fa;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="wz-page" style="background:#f4f5fa;">'
    + '<tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" class="wz-card" style="width:100%;max-width:520px;background:#ffffff;border:1px solid #e4e7f1;border-radius:14px;">'
    + '<tr><td style="padding:26px 24px;font-family:Helvetica,Arial,sans-serif;">'
    + '<p class="wz-m" style="margin:0 0 4px;font-size:13px;color:#6b7094;">Hi ' + esc(first) + ', a new inquiry just came in</p>'
    + '<h1 class="wz-t" style="margin:0 0 14px;font-size:21px;color:#1f2333;">' + esc(who) + ' wants to hear from you</h1>'
    + (lead.message ? '<div class="wz-box" style="background:#f8f9fc;border-radius:10px;padding:14px 16px;margin:0 0 16px;">'
        + '<p class="wz-t" style="margin:0;font-size:15px;line-height:1.55;color:#1f2333;white-space:pre-wrap;">' + esc(lead.message) + '</p></div>' : '')
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px;width:100%;">'
    + row('Phone', lead.phone || '') + row('Email', lead.email || '') + row('Page', lead.page || '') + extras
    + '</table>' + actions + attach + missing
    + '<p class="wz-m" style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7094;">'
    + 'Replying quickly is the single biggest thing that wins this job. Everything is also in your '
    + '<a href="https://portal.webeaze.io" style="color:#7851a9;font-weight:600;">portal</a>.</p>'
    + '</td></tr></table></td></tr></table></body></html>';

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify({
      from: FROM, to,
      // Only a well-formed address may go in this header: Resend rejects the entire message on a
      // malformed one, which would turn a visitor's typo into a lost inquiry. The address is shown in
      // the body regardless, so the owner can still see it either way.
      reply_to: lead.email && MAILBOX.test(lead.email) ? lead.email : undefined,
      subject: subject || ('New inquiry: ' + who + (lead.phone ? ' (' + lead.phone + ')' : '')),
      html,
    }),
  }).catch(() => null);
  return { sent: !!(r && r.ok), reason: r && !r.ok ? 'resend ' + r.status : '' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const wantsJson = (req.headers.get('accept') || '').includes('application/json');
  const referer = req.headers.get('referer') || '';
  const fail = (status: number, msg: string) =>
    wantsJson ? jsonResponse(status, { ok: false, error: msg }) : textResponse(status, '<p>' + esc(msg) + '</p>');

  if (req.method !== 'POST') return fail(405, 'This endpoint only accepts form submissions.');

  const size = Number(req.headers.get('content-length') || '0');
  if (size > MAX_BODY) return fail(413, 'That submission is too large. Please send large files by email instead.');

  // The client is identified by the last path segment: .../form-lead/<user_id>
  const key = (url.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
  if (!UUID.test(key)) return fail(400, 'This form is not configured correctly. Please contact the site owner.');

  try {
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: client } = await service.from('clients')
      .select('user_id, site_url, plan, name, business_name, email, second_email')
      .eq('user_id', key).maybeSingle();
    if (!client) return fail(404, 'This form is not configured correctly. Please contact the site owner.');

    const siteHost = host(client.site_url || '');
    const originHost = host(req.headers.get('origin') || referer);
    // Same rule as track-lead: reject only when we know both and they disagree. A missing Origin is
    // not evidence of anything, and treating it as such would silently drop real submissions.
    if (siteHost && originHost && originHost !== siteHost) return fail(403, 'This form was submitted from an unexpected address.');

    // Read the body in whichever shape the form sent it.
    const ctype = (req.headers.get('content-type') || '').toLowerCase();
    const fields: Record<string, string> = {};
    const uploads: File[] = [];
    // Measure the actual bytes. Content-Length is absent on a chunked request, so the header check
    // above is a courtesy to honest clients, not a bound.
    const raw = await req.arrayBuffer().catch(() => null);
    if (!raw) return fail(400, 'That submission could not be read.');
    if (raw.byteLength > MAX_BODY) return fail(413, 'That submission is too large. Please send large files by email instead.');
    const body = () => new Response(raw, { headers: { 'content-type': req.headers.get('content-type') || '' } });
    if (ctype.includes('application/json')) {
      const j = await body().json().catch(() => ({}));
      for (const k of Object.keys(j || {})) if (j[k] != null && typeof j[k] !== 'object') fields[k] = String(j[k]);
    } else {
      const fd = await body().formData().catch(() => null);
      if (!fd) return fail(400, 'That submission could not be read.');
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') {
          // A group of checkboxes shares one name; keep every answer rather than the last.
          fields[k] = fields[k] ? fields[k] + ', ' + v : v;
        } else if (v && typeof (v as File).arrayBuffer === 'function' && (v as File).size > 0) {
          uploads.push(v as File);
        }
      }
    }

    // Honeypot. A bot fills every field it sees; a person never sees this one. Answer exactly as we
    // would for a real submission so the bot learns nothing, then drop it.
    const gotcha = fields['_gotcha'] || fields['_honey'] || fields['_honeypot'] || '';
    const isSpam = !!String(gotcha).trim();

    // A cross-origin POST sends Referer as the ORIGIN only under the default referrer policy, so the
    // path is usually not knowable from headers. A form can state it with a hidden _page field; the
    // referer path is the fallback and is often just "/".
    const page = clean(fields['_page'] || (referer ? (() => { try { return new URL(referer).pathname; } catch { return ''; } })() : ''), 300);
    const nextTarget = safeNext(fields['_next'] || null, siteHost, referer);
    const subject = clean(fields['_subject'], 160);

    const done = (extra: Record<string, unknown> = {}) => {
      if (wantsJson) return jsonResponse(200, { ok: true, ...extra });
      if (nextTarget) return new Response(null, { status: 303, headers: { ...cors, Location: nextTarget } });
      return textResponse(200, thanksPage(client.business_name || client.name || ''));
    };
    if (isSpam) return done();

    // Pull out the four fields worth structuring; everything else is kept verbatim under its own
    // label, because on a job application the "everything else" IS the submission.
    let name: string | null = null, email: string | null = null, phone: string | null = null, message: string | null = null;
    let firstN = '', lastN = '';
    const extra: Record<string, string> = {};
    for (const k of Object.keys(fields)) {
      const v = (fields[k] || '').trim();
      if (!v || IS_META(k)) continue;
      if (!email && IS_EMAIL(k)) { email = clean(v, 160); continue; }
      if (!phone && IS_PHONE(k)) { phone = clean(v, 40); continue; }
      if (!name && IS_NAME(k)) {
        if (/first/.test(norm(k))) { firstN = v; continue; }
        if (/last/.test(norm(k))) { lastN = v; continue; }
        name = clean(v, 120); continue;
      }
      if (!message && IS_MESSAGE(k)) { message = clean(v, 4000); continue; }
      extra[k.slice(0, 80)] = v.slice(0, 500);
    }
    if (!name && (firstN || lastN)) name = clean((firstN + ' ' + lastN).trim(), 120);
    if (!Object.keys(fields).length && !uploads.length) return fail(400, 'That submission was empty.');

    // Flood control. This only ever suppresses the notification email; the submission is still
    // recorded below, so nothing a visitor sent is thrown away and the client can still see it.
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count: recent } = await service.from('lead_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', key).eq('type', 'form').gte('created_at', hourAgo);
    const floodedInbox = (recent || 0) >= MAX_EMAIL_PER_HOUR;
    if (floodedInbox) console.error('form-lead: EMAIL SUPPRESSED (flood) for', key, 'recent=', recent);

    // Double-submit guard: the same person, minutes apart, is one inquiry rather than two. It runs
    // ONLY when the submission carries something identifying. Without email or phone there is nothing
    // to compare, and a query with no identity filter would match any recent lead at all — turning
    // this guard into a way to discard the next real customer who writes in.
    if (email || phone) {
      const fiveAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      let q = service.from('lead_events').select('id').eq('user_id', key).eq('type', 'form').gte('created_at', fiveAgo);
      q = email ? q.eq('email', email) : q.eq('phone', phone as string);
      const { data: dup } = await q.limit(1);
      if (dup && dup.length) return done({ duplicate: true });
    }

    // Files go to storage so the email can link to them; the raw file never sits in the database.
    const stored: { name: string; path: string; url: string }[] = [];
    const dropped: string[] = [];
    if (uploads.length > MAX_FILES) for (const f of uploads.slice(MAX_FILES)) dropped.push(f.name || 'file');
    for (const f of uploads.slice(0, MAX_FILES)) {
      // Silently losing an attachment is worse than refusing it: the message says "photos attached"
      // and the email looks complete. Whatever we cannot take is named in the email instead.
      if (f.size > MAX_FILE) { dropped.push((f.name || 'file') + ' (too large)'); continue; }
      const safeName = (f.name || 'upload').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
      const path = key + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safeName;
      const up = await service.storage.from(BUCKET).upload(path, new Uint8Array(await f.arrayBuffer()), {
        contentType: f.type || 'application/octet-stream', upsert: false,
      });
      if (up.error) { console.warn('form-lead upload failed:', up.error.message); dropped.push((f.name || 'file') + ' (could not be saved)'); continue; }
      const signed = await service.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30);
      stored.push({ name: f.name || safeName, path, url: (signed.data && signed.data.signedUrl) || '' });
    }

    // Same plan gate as track-lead: the portal keeps the visitor's details only for plans with a lead
    // inbox to put them in. The EMAIL below is sent regardless, because that is the form working.
    const adv = /growth|elite/i.test(String(client.plan || ''));
    const row: Record<string, unknown> = { user_id: key, type: 'form', page };
    if (adv) {
      if (name) row.name = name;
      if (email) row.email = email;
      if (phone) row.phone = phone;
      const extraText = Object.keys(extra).map((k) => k + ': ' + extra[k]).join('\n');
      const full = [message, extraText].filter(Boolean).join('\n\n');
      if (full) row.message = full.slice(0, 4000);
    }
    // Keep the storage PATH, not the signed URL: the URL expires in 30 days, the path does not, so a
    // fresh link can always be minted for a resume someone needs to look at again later.
    if (stored.length) row.attachments = stored.map((f) => ({ name: f.name, path: f.path }));
    const ins = await service.from('lead_events').insert(row);
    if (ins.error) {
      console.warn('form-lead insert failed:', ins.error.message);
      await service.from('lead_events').insert({ user_id: key, type: 'form', page });
    }

    // The submission must reach the owner even if storing it went wrong, so this is last and its
    // failure is reported rather than swallowed.
    const lead = { name, email, phone, message, page, extra };
    let mail = floodedInbox ? { sent: false, reason: 'suppressed' } : await emailClient(client, lead, stored, dropped, subject);
    if (!mail.sent && !floodedInbox) {
      // One retry. Resend failing transiently is common enough, and the cost of not retrying is a
      // customer's inquiry sitting in a log line nobody reads.
      await new Promise((r) => setTimeout(r, 700));
      mail = await emailClient(client, lead, stored, dropped, subject);
    }
    if (!mail.sent && !floodedInbox) {
      console.error('form-lead: EMAIL NOT DELIVERED for', key, mail.reason);
      // Last resort. On plans without the lead inbox we do not normally keep the visitor's details,
      // but the email was the only copy and it did not arrive: keeping it is the only way the inquiry
      // survives at all, and a lost customer is the worse outcome by a distance.
      if (!adv && (name || email || phone || message)) {
        await service.from('lead_events').insert({
          user_id: key, type: 'form', page, name, email, phone,
          message: [message, 'NOTE: email delivery failed, kept so the inquiry is not lost.'].filter(Boolean).join('\n\n').slice(0, 4000),
        }).then(() => {}, () => {});
      }
    }

    return done({ delivered: mail.sent, attachments: stored.length, dropped });
  } catch (e) {
    console.error('form-lead error:', e && (e as Error).message);
    return fail(500, 'Something went wrong sending that. Please try again, or call us instead.');
  }
});
