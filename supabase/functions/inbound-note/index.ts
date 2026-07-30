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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!INBOUND_SECRET || req.headers.get('x-inbound-secret') !== INBOUND_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = parseEmail(body.from || '');
    if (!email || !email.includes('@')) return json({ ok: true, skipped: 'no sender email' });
    if (email.endsWith('@webeaze.io')) return json({ ok: true, skipped: 'from us' });

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

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

    console.log('[inbound-note] added note for ' + (client.name || email));
    return json({ ok: true, added: true, client: client.name || email });
  } catch (e) {
    console.error('[inbound-note] error:', e);
    return json({ error: String(e) }, 500);
  }
});
