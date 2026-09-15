// Supabase Edge Function: inbound-note
// Turns a client's EMAIL REPLY into a note in their portal conversation, automatically.
//
// ...unless the email is about ONE REQUEST. Everything we send about a request carries "[#xxxxxxxx]"
// in its subject (reqRef in admin.html, index.html, request-draft, dispatch-request), and a reply
// keeps it. Those replies go into that request's thread (request_messages) instead of the general
// notes, and are never re-classified as a new request. See findRequestForReply.
//
// Flow: a Google Apps Script on the support@webeaze.io inbox (time trigger) posts each new
// inbound message here, including any ATTACHMENTS as base64, which are stored and hung on the note
// so a client can simply email photos in from the job rather than uploading them in the portal. We match the sender to an ACTIVE client, strip the quoted history /
// signature so only their actual reply remains, and insert it into client_notes as author
// 'client' — so it appears in their notes thread exactly like a note they posted in-portal.
//
// Deploy:  supabase functions deploy inbound-note --no-verify-jwt
// Secret:  supabase secrets set INBOUND_SECRET=<a long random string>   (also put it in the Apps Script)
// Auth:    the caller must send header  x-inbound-secret: <INBOUND_SECRET>

import { createClient } from 'jsr:@supabase/supabase-js@2';

const INBOUND_SECRET = Deno.env.get('INBOUND_SECRET') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const AI_MODEL = 'claude-haiku-4-5-20251001';
const REQUEST_TYPES = ['Content update', 'New page or section', 'Design change', 'SEO or metadata', 'Other'];
// The addresses WE send from. Everything else on our own domain is a person, and may well be a client:
// the portal's test account is testing@webeaze.io. Skipping the whole domain silently dropped every
// reply that account sent, which is exactly what made email replies look broken in testing.
const TEAM_SENDERS = /^(support|billy|hello|no-?reply|notifications?)@webeaze\.io$/i;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-inbound-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });


// Photos a client emails in. Trade clients take pictures on the job, on their phone, and the last
// thing they will do is log into a portal to upload them. Anything attached to their reply is stored
// and hung on the note, so "just email us the photos" becomes a real answer.
const IMG = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
async function saveAttachments(service: any, userId: string, list: any[]): Promise<any[]> {
  const out: any[] = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, 10)) {   // a cap, so one thread cannot flood storage
    try {
      const name = String((a && a.filename) || 'photo').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const b64 = String((a && (a.data || a.base64 || a.content)) || '');
      if (!b64) continue;
      const bytes = Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (ch) => ch.charCodeAt(0));
      if (!bytes.length || bytes.length > 12 * 1024 * 1024) continue;   // skip empty and oversized
      const path = userId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + name;
      const { error } = await service.storage.from('request-attachments')
        .upload(path, bytes, { contentType: (a && a.mimeType) || 'application/octet-stream', upsert: false });
      if (error) { console.error('[inbound-note] attachment upload failed:', error.message); continue; }
      const { data: pub } = service.storage.from('request-attachments').getPublicUrl(path);
      out.push({ url: pub.publicUrl, filename: name });
    } catch (e) { console.error('[inbound-note] attachment skipped:', e); }
  }
  return out;
}


// A 23505 on source_message_id means an earlier run already turned this exact email into a note.
// From the caller's point of view that is SUCCESS: the Apps Script should advance past it rather
// than retry forever. Anything else is a real failure.
function isDuplicate(err: any): boolean {
  const c = String((err && err.code) || '');
  const m = String((err && err.message) || '').toLowerCase();
  return c === '23505' || m.includes('duplicate key') || m.includes('client_notes_source_msg_uidx');
}
// source_message_id / attachments may not be migrated yet, so a write mentioning them is retried
// without them rather than failing outright. Dedupe and photos simply wait for the SQL.
async function insertNote(service: any, row: Record<string, unknown>) {
  const first = await service.from('client_notes').insert(row);
  if (!first.error) return { ok: true, duplicate: false, error: null };
  if (isDuplicate(first.error)) return { ok: true, duplicate: true, error: null };
  const msg = String(first.error.message || '').toLowerCase();
  if (msg.includes('source_message_id') || msg.includes('attachments') || msg.includes('schema cache')) {
    const bare: Record<string, unknown> = { ...row };
    delete bare.source_message_id; delete bare.attachments;
    const retry = await service.from('client_notes').insert(bare);
    if (!retry.error) { console.warn('[inbound-note] posted without dedupe/attachments; run supabase/inbound_dedupe.sql'); return { ok: true, duplicate: false, error: null }; }
    return { ok: false, duplicate: false, error: retry.error };
  }
  return { ok: false, duplicate: false, error: first.error };
}

// Pull the bare email address out of a "Name <email>" style From header.
function parseEmail(from: string): string {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

// Pull every bare email out of a To/Cc header ("A <a@x.com>, b@y.com") for team-reply matching.
function parseRecipients(to: string): string[] {
  return String(to || '').split(',').map((p) => parseEmail(p)).filter((e) => e.includes('@'));
}

// Keep only the person's actual reply: cut at the first quoted-history / signature marker.
function stripQuoted(raw: string): string {
  let t = String(raw || '').replace(/\r\n/g, '\n');
  const markers: RegExp[] = [
    /\nOn .{1,220}\bwrote:/,               // Gmail / Apple Mail: "On <date>, <name> wrote:"
    /\n-{2,} ?Original Message ?-{2,}/i,   // Outlook "----- Original Message -----"
    /\n_{10,}/,                            // Outlook underscore divider before the quoted block
    /\nFrom: .{1,220}\nSent: /,            // Outlook header block
    /\n\s*>{1,}/,                          // first quoted (">") line
    /\nSent from my /,                     // mobile signature
    /\nGet Outlook for /,                  // mobile signature
  ];
  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  t = t.replace(/\n-- ?\n[\s\S]*$/, '');   // trailing "-- " signature block
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// Ask the model whether this email is actually a website CHANGE REQUEST (they want something
// changed, added, or fixed on their site) versus just a comment, a question, or a thank you.
// Returns { isRequest, type, notes } or null if we cannot classify (no key, error, bad JSON).
async function classifyRequest(text: string): Promise<{ isRequest: boolean; type: string; notes: string } | null> {
  if (!ANTHROPIC_API_KEY) return null;   // no key set, skip this step gracefully
  const system = 'You classify a small business client\'s email reply to their website care team. ' +
    'Decide whether it is a WEBSITE CHANGE REQUEST (they want something changed, added, or fixed on their site) ' +
    'rather than a comment, a question, or a thank you. ' +
    'Reply with STRICT JSON only, no prose and no code fences: ' +
    '{"isRequest": boolean, "type": one of ' + JSON.stringify(REQUEST_TYPES) + ', ' +
    '"notes": a cleaned one paragraph description of what they want done}. ' +
    'If it is not a request, set isRequest to false and notes to an empty string. Do not use em dashes.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: text }] }),
    });
    if (!res.ok) { console.error('[inbound-note] anthropic ' + res.status + ': ' + (await res.text()).slice(0, 200)); return null; }
    const data = await res.json();
    const out = ((data.content && data.content[0] && data.content[0].text) || '').trim();

    // Parse straight, then fall back to the first {...} block if the model wrapped it in prose.
    let parsed: any = null;
    try { parsed = JSON.parse(out); } catch { /* try harder */ }
    if (!parsed || typeof parsed !== 'object') {
      const obj = out.match(/\{[\s\S]*\}/);
      if (obj) { try { parsed = JSON.parse(obj[0]); } catch { /* still bad */ } }
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const type = REQUEST_TYPES.includes(parsed.type) ? parsed.type : 'Other';
    const notes = String(parsed.notes || '').trim().replace(/\s*—\s*/g, ', ');   // strip em dashes (house rule)
    return { isRequest: parsed.isRequest === true, type, notes };
  } catch (e) {
    console.error('[inbound-note] classify error:', e);
    return null;
  }
}

// ── Replies that belong to a request ─────────────────────────────────────
// Before this, a client answering our "we need a bit more info" question BY EMAIL landed in their
// general notes, so the request's own conversation showed our question with nothing under it, and
// the classifier below could even file their answer as a brand new request.
function parseRef(subject: unknown): string | null {
  const m = /\[#([0-9a-f]{8})\]/i.exec(String(subject ?? ''));
  return m ? m[1].toLowerCase() : null;
}
// A reply to a needs-info email sent BEFORE the reference existed has no token. If that client has
// exactly ONE request waiting on them and the subject is plainly a reply to that kind of email, it can
// only be the answer to that one. Two candidates and we do not guess: it goes to notes as before.
const NEEDS_INFO_SUBJECT = /need a bit more info/i;
async function findRequestForReply(service: any, userId: string, subject: unknown, allowGuess: boolean) {
  const ref = parseRef(subject);
  if (!ref && !(allowGuess && NEEDS_INFO_SUBJECT.test(String(subject ?? '')))) return null;
  const { data } = await service.from('update_requests')
    .select('id, status').eq('user_id', userId).order('created_at', { ascending: false }).limit(300);
  const rows: any[] = data || [];
  if (ref) return rows.find((r) => String(r.id).replace(/-/g, '').toLowerCase().startsWith(ref)) || null;
  const waiting = rows.filter((r) => r.status === 'Needs info');
  return waiting.length === 1 ? waiting[0] : null;
}
// The Gmail script retries anything that did not answer 2xx, so the same email can arrive twice.
// request_messages has no message-id column to put a unique key on, so an identical message from the
// same side of the same request counts as already posted.
async function postToThread(service: any, request: any, userId: string, sender: 'client' | 'team', text: string, attachments: any[]) {
  const { data: dupe } = await service.from('request_messages')
    .select('id').eq('request_id', request.id).eq('sender', sender).eq('body', text).limit(1);
  if (dupe && dupe.length) return { ok: true, duplicate: true, error: null };
  const { error } = await service.from('request_messages')
    .insert({ request_id: request.id, user_id: userId, sender, body: text });
  if (error) return { ok: false, duplicate: false, error };
  if (attachments.length) {
    const rows = attachments.map((a) => ({ request_id: request.id, user_id: userId, url: a.url, filename: a.filename, from_team: sender === 'team' }));
    let att = await service.from('request_attachments').insert(rows);
    // from_team arrives with request_attachments_from_team.sql; without it, still attach the photos.
    if (att.error) att = await service.from('request_attachments').insert(rows.map(({ from_team: _f, ...rest }) => rest));
    if (att.error) console.error('[inbound-note] thread attachments failed:', att.error.message);
  }
  // Mirror answering in the portal (sendThreadMsg): their latest reply goes on the request, and
  // answering our question unblocks it. A note on work already moving does not reset its status.
  if (sender === 'client') {
    const patch: Record<string, unknown> = { client_reply: text };
    if (request.status === 'Needs info') patch.status = 'Received';
    const { error: upErr } = await service.from('update_requests').update(patch).eq('id', request.id);
    if (upErr) console.error('[inbound-note] request update failed:', upErr.message);
  }
  return { ok: true, duplicate: false, error: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!INBOUND_SECRET || req.headers.get('x-inbound-secret') !== INBOUND_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    // Gmail's per-message id, prefixed by direction: our reply and a client's message can never
    // collide, and the same email can never post twice.
    const rawId = String(body.messageId || '').trim().slice(0, 120);
    const msgId = rawId ? ((body.team ? 'team:' : 'client:') + rawId) : null;
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── Team reply: our own email to a client (sent from support@webeaze.io). Mirror it into the
    // thread as a WebEaze note so the conversation is two-sided. Matched by the RECIPIENT, since the
    // sender is us. No request classification and no extra email (the client already got our reply). ──
    if (body.team === true) {
      const recips = parseRecipients(body.to || '');
      if (!recips.length) return json({ ok: true, skipped: 'team reply with no recipient' });
      let teamClient: any = null;
      for (const r of recips) {
        if (TEAM_SENDERS.test(r)) continue;   // skip our own addresses on the line; a client on our domain still counts
        const { data: cs } = await service.from('clients')
          .select('id, user_id, email, status, name').ilike('email', r);
        const active = (cs ?? []).find((c) => (c.status || '').toLowerCase() === 'active');
        if (active) { teamClient = active; break; }
      }
      if (!teamClient) return json({ ok: true, skipped: 'no active client in recipients' });
      const teamNote = stripQuoted(body.text || '');
      if (!teamNote) return json({ ok: true, skipped: 'empty after stripping quotes' });
      // Only an explicit reference routes OUR mail: the needs-info guess describes a client answering
      // us, and means nothing for a message we sent.
      const teamReq = await findRequestForReply(service, teamClient.user_id, body.subject, false);
      if (teamReq) {
        const t = await postToThread(service, teamReq, teamClient.user_id, 'team', teamNote, []);
        if (t.ok) return json({ ok: true, added: !t.duplicate, thread: true, team: true, client: teamClient.name || teamClient.email });
        console.error('[inbound-note] team thread insert failed, falling back to notes:', t.error);
      }
      const teamRes = await insertNote(service, {
        user_id: teamClient.user_id,
        client_id: teamClient.id,
        note: teamNote,
        author: 'team',   // our reply — renders as a WebEaze bubble on their side of the thread
        source_message_id: msgId,
      });
      if (!teamRes.ok) { console.error('[inbound-note] team insert failed:', teamRes.error); return json({ error: 'insert failed' }, 500); }
      if (teamRes.duplicate) return json({ ok: true, skipped: 'already posted' });
      console.log('[inbound-note] added TEAM note for ' + (teamClient.name || teamClient.email));
      return json({ ok: true, added: true, team: true, client: teamClient.name || teamClient.email });
    }

    const email = parseEmail(body.from || '');
    if (!email || !email.includes('@')) return json({ ok: true, skipped: 'no sender email' });
    if (TEAM_SENDERS.test(email)) return json({ ok: true, skipped: 'from us' });

    // Match the sender to an ACTIVE client (case-insensitive email).
    const { data: clients } = await service.from('clients')
      .select('id, user_id, email, status, name')
      .ilike('email', email);
    const client = (clients ?? []).find((c) => (c.status || '').toLowerCase() === 'active');
    if (!client) return json({ ok: true, skipped: 'no active client for ' + email });

    const attachments = await saveAttachments(service, client.user_id, body.attachments);
    let note = stripQuoted(body.text || '');
    // Photos with no words is a perfectly normal message from a phone, so do not drop it.
    if (!note && attachments.length) {
      note = attachments.length === 1 ? 'Sent a photo.' : 'Sent ' + attachments.length + ' photos.';
    }
    if (!note) return json({ ok: true, skipped: 'empty after stripping quotes' });

    const threadReq = await findRequestForReply(service, client.user_id, body.subject, true);
    if (threadReq) {
      const t = await postToThread(service, threadReq, client.user_id, 'client', note, attachments);
      if (t.ok) {
        console.log('[inbound-note] reply added to request ' + threadReq.id + ' for ' + (client.name || email) + (t.duplicate ? ' (duplicate)' : ''));
        return json({ ok: true, added: !t.duplicate, thread: true, request: threadReq.id, client: client.name || email });
      }
      // Never lose a reply: if the thread write failed it still lands in their notes, as it always did.
      console.error('[inbound-note] thread insert failed, falling back to notes:', t.error);
    }

    const res = await insertNote(service, {
      user_id: client.user_id,
      client_id: client.id,
      note,
      author: 'client',   // it is the client's own message, so it shows on their side of the thread
      attachments: attachments.length ? attachments : null,
      source_message_id: msgId,
    });
    if (!res.ok) { console.error('[inbound-note] insert failed:', res.error); return json({ error: 'insert failed' }, 500); }
    if (res.duplicate) return json({ ok: true, skipped: 'already posted' });

    // The note is saved. Now, if the email is actually asking for a website change, also file it
    // as a real update request so it flows through dispatch-request to the bot. Only file when the
    // model is confident it is a request, so we never double up a plain comment or thank you.
    let filedRequest = false;
    const cls = await classifyRequest(note);
    if (cls && cls.isRequest) {
      const { error: reqErr } = await service.from('update_requests').insert({
        user_id: client.user_id,
        type: cls.type,
        notes: (cls.notes || note) + ' (from an email reply)',
        priority: 'Normal',
        status: 'Received',
      });
      if (reqErr) console.error('[inbound-note] request insert failed:', reqErr);
      else filedRequest = true;
    }

    console.log('[inbound-note] added note for ' + (client.name || email) + (filedRequest ? ' + filed request' : ''));
    return json({ ok: true, added: true, filedRequest, client: client.name || email });
  } catch (e) {
    console.error('[inbound-note] error:', e);
    return json({ error: String(e) }, 500);
  }
});
