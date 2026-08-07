// Supabase Edge Function: inbound-note
// Turns a client's EMAIL REPLY into a note in their portal conversation, automatically.
//
// Flow: a Google Apps Script on the support@webeaze.io inbox (time trigger) posts each new
// inbound message here. We match the sender to an ACTIVE client, strip the quoted history /
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

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-inbound-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!INBOUND_SECRET || req.headers.get('x-inbound-secret') !== INBOUND_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── Team reply: our own email to a client (sent from support@webeaze.io). Mirror it into the
    // thread as a WebEaze note so the conversation is two-sided. Matched by the RECIPIENT, since the
    // sender is us. No request classification and no extra email (the client already got our reply). ──
    if (body.team === true) {
      const recips = parseRecipients(body.to || '');
      if (!recips.length) return json({ ok: true, skipped: 'team reply with no recipient' });
      let teamClient: any = null;
      for (const r of recips) {
        if (r.endsWith('@webeaze.io')) continue;   // skip ourselves / internal addresses on the line
        const { data: cs } = await service.from('clients')
          .select('id, user_id, email, status, name').ilike('email', r);
        const active = (cs ?? []).find((c) => (c.status || '').toLowerCase() === 'active');
        if (active) { teamClient = active; break; }
      }
      if (!teamClient) return json({ ok: true, skipped: 'no active client in recipients' });
      const teamNote = stripQuoted(body.text || '');
      if (!teamNote) return json({ ok: true, skipped: 'empty after stripping quotes' });
      const { error: teamErr } = await service.from('client_notes').insert({
        user_id: teamClient.user_id,
        client_id: teamClient.id,
        note: teamNote,
        author: 'team',   // our reply — renders as a WebEaze bubble on their side of the thread
      });
      if (teamErr) { console.error('[inbound-note] team insert failed:', teamErr); return json({ error: 'insert failed' }, 500); }
      console.log('[inbound-note] added TEAM note for ' + (teamClient.name || teamClient.email));
      return json({ ok: true, added: true, team: true, client: teamClient.name || teamClient.email });
    }

    const email = parseEmail(body.from || '');
    if (!email || !email.includes('@')) return json({ ok: true, skipped: 'no sender email' });
    if (email.endsWith('@webeaze.io')) return json({ ok: true, skipped: 'from us' });

    // Match the sender to an ACTIVE client (case-insensitive email).
    const { data: clients } = await service.from('clients')
      .select('id, user_id, email, status, name')
      .ilike('email', email);
    const client = (clients ?? []).find((c) => (c.status || '').toLowerCase() === 'active');
    if (!client) return json({ ok: true, skipped: 'no active client for ' + email });

    const note = stripQuoted(body.text || '');
    if (!note) return json({ ok: true, skipped: 'empty after stripping quotes' });

    const { error } = await service.from('client_notes').insert({
      user_id: client.user_id,
      client_id: client.id,
      note,
      author: 'client',   // it is the client's own message, so it shows on their side of the thread
    });
    if (error) { console.error('[inbound-note] insert failed:', error); return json({ error: 'insert failed' }, 500); }

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
