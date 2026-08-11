// Supabase Edge Function: outreach-reply
// Closes the loop, hands-off. A Gmail Apps Script on the getwebeaze.com mailbox hands us the
// sender addresses of fresh inbox replies; we flip any matching 'sent' prospect to 'replied' so
// outreach-send stops following up with someone who already answered.
//
// Entry (POST): { emails: [replies...], bounced: [bounced addresses...] }  (or { from } for one reply)
//   emails  -> matching prospects flip to 'replied' (follow-ups stop).
//   bounced -> matching prospects flip to 'bounced' (follow-ups stop, dead address), and one fresh
//              replacement email is sent per bounce so the day's delivered volume stays whole.
// Auth: x-cron-secret header (reuses CRON_SECRET).
//
// Deploy: supabase functions deploy outreach-reply   (Verify JWT OFF)
// Script: supabase/outreach_reply_appscript.gs

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Pull a clean email out of "Name <email@x.com>" or a bare address.
function extractEmail(s: unknown): string | null {
  const m = String(s || '').match(/<([^>]+)>/);
  const raw = (m ? m[1] : String(s || '')).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = req.headers.get('x-cron-secret') ?? '';
  if (!CRON_SECRET || secret !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Replies -> 'replied'. Bounces -> 'bounced'. Both stop follow-ups; only 'sent' prospects flip,
    // so repeat calls are safe no-ops.
    const replyInputs: unknown[] = [];
    if (Array.isArray(body.emails)) replyInputs.push(...body.emails);
    if (body.from) replyInputs.push(body.from);
    const replyEmails = [...new Set(replyInputs.map(extractEmail).filter(Boolean))] as string[];
    const bounceEmails = [...new Set((Array.isArray(body.bounced) ? body.bounced : []).map(extractEmail).filter(Boolean))] as string[];

    let replied: string[] = [];
    if (replyEmails.length) {
      const { data } = await service.from('prospects')
        .update({ status: 'replied', updated_at: new Date().toISOString() })
        .eq('status', 'sent').in('email', replyEmails).select('email');
      replied = (data ?? []).map((r: any) => r.email);
    }

    let bounced: string[] = [];
    if (bounceEmails.length) {
      const { data } = await service.from('prospects')
        .update({ status: 'bounced', updated_at: new Date().toISOString() })
        .eq('status', 'sent').in('email', bounceEmails).select('email');
      bounced = (data ?? []).map((r: any) => r.email);
      // Replace each real bounce with one fresh send so the day's delivered volume stays whole
      // (capped, so a burst of bounces can't trigger a flood).
      const replace = Math.min(bounced.length, 5);
      if (replace > 0) {
        try {
          await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/outreach-send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
            body: JSON.stringify({ limit: replace }),
          });
        } catch (e) { console.error('[outreach-reply] replacement send failed:', e); }
      }
    }

    return json({ ok: true, replied: replied.length, bounced: bounced.length, repliedEmails: replied, bouncedEmails: bounced });
  } catch (e) {
    console.error('outreach-reply error:', e);
    return json({ error: String(e) }, 500);
  }
});
