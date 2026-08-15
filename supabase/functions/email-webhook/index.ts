// Supabase Edge Function: email-webhook
// Receives Resend delivery webhooks and records them per recipient in public.email_events, so the
// admin can see what actually reached a client, and flag an address that is bouncing.
//
// Setup:
//   1. Run supabase/email_events.sql
//   2. supabase functions deploy email-webhook --no-verify-jwt      <- MUST be no-verify-jwt:
//      Resend is an outside caller and has no Supabase JWT. Its own signature is the auth here.
//   3. Resend dashboard -> Webhooks -> add endpoint:
//        https://gmgzhjxfypuyzzgqwona.supabase.co/functions/v1/email-webhook
//      Subscribe to: email.sent, email.delivered, email.bounced, email.complained,
//                    email.opened, email.clicked, email.delivery_delayed
//   4. supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...   (shown when you create the endpoint)
//   5. Turn on open and click tracking in Resend, otherwise those two events never fire.
//
// Note on opens: Apple Mail Privacy Protection pre-fetches tracking pixels, so a share of "opened"
// events are Apple's servers rather than a person. Clicks are the trustworthy signal.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const WEBHOOK_SECRET = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// Resend signs with Svix: base64 HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed by the secret
// after its "whsec_" prefix is stripped and the rest base64-decoded.
async function verifySvix(secret: string, id: string, ts: string, body: string, header: string): Promise<boolean> {
  try {
    const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    // The header carries one or more space-separated "v1,<sig>" pairs.
    for (const part of header.split(' ')) {
      const [, value] = part.split(',');
      if (value && value === expected) return true;
    }
    return false;
  } catch (_e) { return false; }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const body = await req.text();

  // Signature check first: this endpoint is public, so anything unsigned is refused outright.
  if (!WEBHOOK_SECRET) { console.error('[email-webhook] RESEND_WEBHOOK_SECRET is not set'); return json({ error: 'Not configured' }, 500); }
  const id = req.headers.get('svix-id') ?? '';
  const ts = req.headers.get('svix-timestamp') ?? '';
  const sigHeader = req.headers.get('svix-signature') ?? '';
  if (!id || !ts || !sigHeader) return json({ error: 'Unsigned' }, 401);
  // Reject anything older than 5 minutes so a captured request cannot be replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return json({ error: 'Stale' }, 401);
  if (!(await verifySvix(WEBHOOK_SECRET, id, ts, body, sigHeader))) return json({ error: 'Bad signature' }, 401);

  let payload: any;
  try { payload = JSON.parse(body); } catch { return json({ error: 'Bad JSON' }, 400); }

  const type = String(payload?.type || '');            // e.g. "email.delivered"
  const d = payload?.data || {};
  const event = type.startsWith('email.') ? type.slice(6) : type;
  const recipients: string[] = Array.isArray(d.to) ? d.to : (d.to ? [d.to] : []);
  if (!event || !recipients.length) return json({ ok: true, skipped: 'nothing to record' });

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  // One row per recipient: a message sent to a client and their second_email should show on both.
  const rows = recipients.map((to: string) => ({
    email: String(to).trim().toLowerCase(),
    event,
    subject: d.subject ? String(d.subject).slice(0, 200) : null,
    message_id: d.email_id ? String(d.email_id) : null,
    link: (d.click && d.click.link) ? String(d.click.link).slice(0, 400) : null,
    occurred_at: d.created_at ? new Date(d.created_at).toISOString() : new Date().toISOString(),
  }));

  // Webhooks retry, so a duplicate is expected rather than exceptional: ignore it and move on.
  const { error } = await service.from('email_events').upsert(rows, {
    onConflict: 'message_id,event,occurred_at', ignoreDuplicates: true,
  });
  if (error) {
    console.error('[email-webhook] insert failed:', error.message);
    return json({ error: 'Insert failed' }, 500);   // non-2xx makes Resend retry
  }
  return json({ ok: true, recorded: rows.length, event });
});
