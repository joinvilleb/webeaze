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

// Dark-mode-safe email shell.
//
// The old client email was a bare <div> with dark text and no background of its own. On a phone in
// dark mode that is the worst case: Apple Mail and Gmail both darken the canvas underneath, and the
// text, which was never given a background to sit on, ends up near-black on near-black.
//
// Two rules make it work:
//   1. prefers-color-scheme overrides for Apple Mail / Outlook, which honour real media queries. The
//      color-scheme meta is what opts us in; without it iOS ignores the block entirely.
//   2. Backgrounds live on the CONTAINERS only (page, card, box), never on a heading or paragraph.
//      A background on a text element survives into dark mode as a white slab under light text,
//      which is worse than the bug being fixed. Gmail and Outlook.com force their own inversion and
//      ignore the media query, and they invert those containers with their contents, so contrast
//      holds there too.
const wzShell = (title: string, inner: string) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body, table, td, p, a, h1, h2 { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  @media (prefers-color-scheme: dark) {
    .wz-page { background: #0f1116 !important; }
    .wz-card { background: #1a1d25 !important; border-color: #2b2f3d !important; }
    .wz-text, .wz-text * { color: #e9eaf2 !important; }
    .wz-muted, .wz-muted * { color: #a7adc6 !important; }
    .wz-brand, .wz-brand * { color: #b99ae6 !important; }
    .wz-box { background: #22262f !important; border-color: #333849 !important; }
    .wz-label { color: #9098b5 !important; }
  }
  @media (max-width: 600px) { .wz-pad { padding: 24px 20px !important; } }
</style>
</head>
<body class="wz-page" style="margin:0;padding:0;background:#f4f5fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="wz-page" style="background:#f4f5fa;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="wz-card" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e4e7f1;border-radius:14px;">
<tr><td class="wz-pad" style="padding:30px 28px;font-family:Helvetica,Arial,sans-serif;">
${inner}
</td></tr></table>
</td></tr></table>
</body></html>`;

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
      html: wzShell('We got your request',
        '<h1 class="wz-brand" style="margin:0 0 8px;font-size:21px;line-height:1.3;font-weight:bold;color:#7851a9;">Thanks, we have got your request</h1>' +
        '<p class="wz-muted" style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#6b7094;">' +
          'Our team has received it and will be in touch soon' +
          (isUrgent ? '. We have flagged this as <strong class="wz-text" style="color:#1f2333;">urgent</strong> and will prioritize it.' : '.') +
        '</p>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="wz-box" style="background:#f8f9fc;border:1px solid #e4e7f1;border-radius:12px;margin:0 0 22px;">' +
          '<tr><td style="padding:18px 20px;font-family:Helvetica,Arial,sans-serif;">' +
            '<p class="wz-label" style="margin:0 0 12px;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.07em;color:#8b91b0;">Your request summary</p>' +
            `<p class="wz-text" style="margin:0 0 9px;font-size:15px;line-height:1.5;color:#1f2333;"><strong>Type:</strong> ${esc(type)}</p>` +
            `<p class="wz-text" style="margin:0 0 9px;font-size:15px;line-height:1.5;color:#1f2333;"><strong>Submitted:</strong> ${esc(submittedOn)} ET</p>` +
            `<p class="wz-text" style="margin:0;font-size:15px;line-height:1.6;color:#1f2333;"><strong>Details:</strong><br>${br(notes)}</p>` +
          '</td></tr>' +
        '</table>' +
        '<p class="wz-muted" style="margin:0;font-size:14px;line-height:1.65;color:#6b7094;">' +
          `You can track this request anytime in your <a class="wz-brand" href="${PORTAL_URL}" style="color:#7851a9;font-weight:bold;text-decoration:underline;">client portal</a>. ` +
          'No need to reply to this email. If you need to add anything, send us another request or reach out to your team.' +
        '</p>'),
    });

    return json({ ok: true });
  } catch (e) {
    console.error('notify-request error:', e);
    return json({ error: String(e) }, 500);
  }
});
