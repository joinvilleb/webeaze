// Supabase Edge Function: outreach-send
// The FREE sender (no Instantly). Sends the drafted cold emails straight from your getwebeaze.com
// mailbox over Gmail SMTP, and schedules the follow-ups itself. Run it once a day from cron.
//
// Each run, within a daily cap:
//   1) sends any DUE follow-ups first (a reply, marked by setting status='replied', stops them)
//   2) then sends first-touch emails to freshly 'drafted' prospects
// Plain text only (best deliverability + reads personal). No links in the first email (the copy
// already avoids them).
//
// Entry (POST): { action:'send', limit? }   Omit `limit` and it AUTO-RAMPS the daily cap on its own
//   as the mailbox proves itself: 2/day for about the first week, then 4, 6, 8, 10 as cumulative
//   sends grow. Pass an explicit `limit` only to override. A brand-new mailbox that blasts on day
//   one gets flagged, so the slow auto-ramp keeps you safe with zero babysitting.
//
// Auth: admin (billy@webeaze.io) JWT, OR x-cron-secret.
// Secrets: GMAIL_USER (the getwebeaze.com mailbox), GMAIL_APP_PASSWORD (a Google App Password),
//          OUTREACH_FROM_NAME (optional, defaults 'Billy'), CRON_SECRET.
//
// Deploy: supabase functions deploy outreach-send   (Verify JWT OFF — self-auths)

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const GMAIL_USER = Deno.env.get('GMAIL_USER') ?? '';
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD') ?? '';
const FROM_NAME = Deno.env.get('OUTREACH_FROM_NAME') ?? 'Billy';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const ADMIN_EMAIL = 'billy@webeaze.io';
const GAP_MS = 2500;   // small pause between sends so it never looks like a burst

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// We send plain text (best for cold email) PLUS a minimal HTML alternative whose only difference is
// that the "WebEaze Web Design" sign-off links to the site. No styling, images, or tracking, so it
// still reads like a personal note.
const SITE_URL = 'https://webeaze.io';
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function bodyToHtml(body: string): string {
  const linked = escHtml(body).replace(/WebEaze Web Design/g,
    '<a href="' + SITE_URL + '" style="color:#7851a9;text-decoration:none;">WebEaze Web Design</a>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.55;">' + linked.replace(/\r?\n/g, '<br>') + '</div>';
}

// Auto-ramp: the daily cap grows as the mailbox earns trust, measured by cumulative first-touches
// already sent (a reputation proxy). ~2/day for the first week (14 sends), then 4, 6, 8, 10. Self-
// correcting — if you pause, it doesn't leap ahead, because it's tied to real volume, not the calendar.
async function autoCap(sb: any): Promise<number> {
  const { count } = await sb.from('prospects').select('id', { count: 'exact', head: true }).gte('sent_step', 1);
  const n = count || 0;
  if (n < 14) return 2;    // ~first week at 2/day
  if (n < 30) return 4;
  if (n < 50) return 6;
  if (n < 80) return 8;
  return 10;
}

async function doSend(sb: any, dailyCap: number) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  const from = `${FROM_NAME} <${GMAIL_USER}>`;
  const client = new SMTPClient({ connection: { hostname: 'smtp.gmail.com', port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } } });

  let sent = 0;
  const logRows: any[] = [];
  const mail = async (to: string, subject: string, body: string) => {
    await client.send({ from, to, replyTo: from, subject: subject || '(no subject)', content: body, html: bodyToHtml(body) });
  };

  try {
    // ── 1) Due follow-ups (oldest first). status 'sent' + not yet replied + more steps to go. ──
    const { data: fRows } = await sb.from('prospects')
      .select('id, name, email, outreach, sent_step, last_sent_at')
      .eq('status', 'sent').eq('channel', 'email').in('sent_step', [1, 2])
      .order('last_sent_at', { ascending: true }).limit(60);
    for (const p of (fRows || [])) {
      if (sent >= dailyCap) break;
      const fu = (p.outreach?.followups || [])[p.sent_step - 1];
      if (!fu || !fu.body) { await sb.from('prospects').update({ sent_step: 3 }).eq('id', p.id); continue; }   // no more follow-ups
      const waitMs = (Number(fu.waitDays) || 3) * 86400000;
      const due = !p.last_sent_at || (new Date(p.last_sent_at).getTime() + waitMs) <= Date.now();
      if (!due) continue;
      try {
        await mail(p.email, fu.subject || p.outreach.subject, fu.body);
        await sb.from('prospects').update({ sent_step: p.sent_step + 1, last_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', p.id);
        sent++; logRows.push({ name: p.name, step: 'follow-up ' + p.sent_step, ok: true });
        await sleep(GAP_MS);
      } catch (e) { logRows.push({ name: p.name, step: 'follow-up ' + p.sent_step, ok: false, error: String(e).slice(0, 140) }); }
    }

    // ── 2) First touches to freshly drafted prospects, highest score first. ──
    if (sent < dailyCap) {
      const { data: dRows } = await sb.from('prospects')
        .select('id, name, email, outreach')
        .eq('status', 'drafted').eq('channel', 'email').not('email', 'is', null).not('outreach', 'is', null)
        .order('score', { ascending: false }).limit(dailyCap - sent);
      for (const p of (dRows || [])) {
        if (sent >= dailyCap) break;
        const o = p.outreach || {};
        if (!o.body) continue;
        try {
          await mail(p.email, o.subject, o.body);
          await sb.from('prospects').update({ status: 'sent', sent_step: 1, last_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', p.id);
          sent++; logRows.push({ name: p.name, step: 'first', ok: true });
          await sleep(GAP_MS);
        } catch (e) { logRows.push({ name: p.name, step: 'first', ok: false, error: String(e).slice(0, 140) }); }
      }
    }
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
  return { sent, cap: dailyCap, detail: logRows };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const cronSecret = req.headers.get('x-cron-secret') ?? '';
  let authorized = !!CRON_SECRET && cronSecret === CRON_SECRET;
  if (!authorized) {
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    authorized = user?.email === ADMIN_EMAIL;
  }
  if (!authorized) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const cap = body.limit ? Math.max(1, Number(body.limit)) : await autoCap(service);   // auto-ramp unless overridden
    const out = await doSend(service, cap);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error('outreach-send error:', e);
    return json({ error: String(e) }, 500);
  }
});
