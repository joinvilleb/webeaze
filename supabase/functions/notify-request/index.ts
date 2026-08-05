// Supabase Edge Function: notify-request
// Handles two kinds of notifications, both authenticated (the caller must be a
// logged-in user; their email is read from the JWT so it can't be spoofed):
//
//   1) A website-update request  -> emails the WebEaze team + a confirmation to the client
//   2) A milestone reward unlock -> emails the WebEaze team only (so they can apply it)
//
// The Resend API key lives in Supabase secrets (RESEND_API_KEY), never in the browser.
//
// Deploy:   supabase functions deploy notify-request
// Secret:   supabase secrets set RESEND_API_KEY=re_xxx

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const TEAM_EMAIL = 'support@webeaze.io';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const br = (s: unknown) => esc(s).replace(/\n/g, '<br>');

async function sendEmail(payload: Record<string, unknown>) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // Verify the caller and trust the email from the token.
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user?.email) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json();

    // ── 2) Milestone reward unlocked — notify the team only ──
    if (body.kind === 'reward') {
      const reward = body.reward || 'a reward';
      const milestone = body.milestone || '';
      await sendEmail({
        from: FROM,
        to: [TEAM_EMAIL],
        reply_to: user.email,
        subject: '🎁 Reward unlocked: ' + reward + ' — ' + user.email,
        html:
          `<p><strong>${esc(user.email)}</strong> just unlocked a portal reward.</p>` +
          `<p><strong>Milestone:</strong> ${esc(milestone)}</p>` +
          `<p><strong>Reward to apply:</strong> ${esc(reward)}</p>` +
          `<p style="color:#6b7094">Apply it to their account (e.g. a Stripe credit/coupon) and let them know.</p>`,
      });
      return json({ ok: true });
    }

    // ── 1) New website-update request ──
    const { type, notes, priority } = body;
    if (!type || !notes) return json({ error: 'Missing type or notes' }, 400);

    const isUrgent = priority === 'Urgent';
    const submittedOn = new Date().toLocaleString('en-US', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'America/New_York',
    });

    // Notify the WebEaze team
    await sendEmail({
      from: FROM,
      to: [TEAM_EMAIL],
      reply_to: user.email,
      subject: (isUrgent ? '🚨 URGENT — ' : '') + 'New portal request: ' + type,
      html:
        `<p><strong>From:</strong> ${esc(user.email)}</p>` +
        `<p><strong>Type:</strong> ${esc(type)}</p>` +
        `<p><strong>Priority:</strong> ${esc(priority || 'Normal')}</p>` +
        `<p><strong>Submitted:</strong> ${esc(submittedOn)} ET</p>` +
        `<p><strong>Details:</strong><br>${br(notes)}</p>`,
    });

    // CC a partner if the client set a second email on their account (column may not be migrated yet).
    let secondEmail: string | null = null;
    try { const { data: cli } = await supabase.from('clients').select('second_email').eq('user_id', user.id).maybeSingle(); secondEmail = (cli && (cli as any).second_email) || null; } catch (_e) { /* ignore */ }

    // Confirmation + summary to the client
    await sendEmail({
      from: FROM,
      to: [user.email, secondEmail].filter(Boolean),
      subject: 'We got your request: ' + type,
      html:
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f1228">' +
          '<h2 style="color:#7851a9;margin:0 0 6px">Thanks — we\'ve got your request!</h2>' +
          '<p style="color:#6b7094;font-size:14px;line-height:1.6;margin:0 0 20px">' +
            'Our team has received your request and will be in touch soon' +
            (isUrgent ? ' — we\'ve flagged this as <strong>urgent</strong> and will prioritize it.' : '.') +
          '</p>' +
          '<div style="background:#f8f9fc;border:1px solid #e4e7f1;border-radius:12px;padding:18px 20px;margin-bottom:20px">' +
            '<p style="margin:0 0 10px;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#a0a6c4">Your request summary</p>' +
            `<p style="margin:0 0 8px;font-size:14px"><strong>Type:</strong> ${esc(type)}</p>` +
            `<p style="margin:0 0 8px;font-size:14px"><strong>Submitted:</strong> ${esc(submittedOn)} ET</p>` +
            `<p style="margin:0;font-size:14px"><strong>Details:</strong><br>${br(notes)}</p>` +
          '</div>' +
          '<p style="color:#6b7094;font-size:13px;line-height:1.6;margin:0">' +
            `You can track this request anytime in your <a href="${PORTAL_URL}" style="color:#7851a9;font-weight:bold;text-decoration:none">WebEaze Portal</a>. ` +
            'No need to reply to this email — but if you need to add anything, just submit another request or reach out to your team.' +
          '</p>' +
        '</div>',
    });

    return json({ ok: true });
  } catch (e) {
    console.error('notify-request error:', e);
    return json({ error: String(e) }, 500);
  }
});
