// Supabase Edge Function: reward-scan
// Scheduled backstop for the milestone "mystery rewards". Runs with the service role
// (no user context) so it fires even for clients who never open the portal.
//
// For every client it counts completed requests (update_requests.status = 'Done').
// For each reward threshold a client has newly crossed, it:
//   - records the grant in `reward_grants` (unique per user+milestone -> never double-sends)
//   - emails the client ("You unlocked a reward!")
//   - emails the WebEaze team (so they can apply the perk + post a note)
//
// Keep REWARDS below in sync with the milestones array in portal/index.html (loadBadges).
//
// Deploy:   supabase functions deploy reward-scan --no-verify-jwt
// Secrets:  supabase secrets set RESEND_API_KEY=re_xxx CRON_SECRET=<long-random-string>
// Schedule: see supabase/reward_grants.sql (pg_cron + pg_net).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const TEAM_EMAIL = 'support@webeaze.io';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';

// Must match portal/index.html loadBadges() rewards (label / tgt / reward).
const REWARDS = [
  { milestone: 'Loyal client',   tgt: 25,  reward: 'A little thank-you on your next invoice' },
  { milestone: 'WebEaze VIP',    tgt: 50,  reward: 'A thank-you credit on your next invoice' },
  { milestone: 'WebEaze legend', tgt: 100, reward: 'A free month, on us' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

async function sendEmail(payload: Record<string, unknown>) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

function clientEmailHtml(reward: string) {
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /></head>',
    '<body style="margin:0;padding:0;background:#f8f9fc;font-family:Helvetica,Arial,sans-serif;">',
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fc;padding:40px 16px;">',
    '<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">',
    '<tr><td style="background:#ffffff;border:1px solid #e4e7f1;border-radius:16px;padding:40px 36px;">',
    '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#7851a9;margin-bottom:10px;">Reward unlocked</div>',
    '<h1 style="font-size:20px;font-weight:800;color:#0f1228;margin:0 0 12px;">A little something for sticking with us</h1>',
    '<p style="font-size:14px;color:#6b7094;line-height:1.65;margin:0 0 24px;">Thanks for being such a loyal WebEaze client. You just unlocked a reward:</p>',
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#faf7fd;border:1px solid #e6dcf3;border-radius:12px;margin-bottom:24px;">',
    '<tr><td style="padding:22px;text-align:center;">',
    '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#a0a6c4;margin-bottom:6px;">Your reward</div>',
    '<div style="font-size:17px;font-weight:800;color:#7851a9;">' + esc(reward) + '</div>',
    '</td></tr></table>',
    '<p style="font-size:14px;color:#6b7094;line-height:1.65;margin:0;">There is nothing you need to do. We will apply it and send a note to your account in the portal once it is done.</p>',
    '<p style="font-size:13px;color:#a0a6c4;line-height:1.6;margin:18px 0 0;">You can see your notes and milestones any time in your ',
    '<a href="' + PORTAL_URL + '" style="color:#7851a9;font-weight:700;text-decoration:none;">Client Portal</a>.</p>',
    '</td></tr><tr><td align="center" style="padding-top:24px;">',
    '<p style="font-size:12px;color:#a0a6c4;margin:0;">WebEaze Web Design, 109 Pleasant Hill Drive, Camden-Wyoming, Delaware 19934, USA</p>',
    '</td></tr></table></td></tr></table></body></html>',
  ].join('');
}

Deno.serve(async (req) => {
  // Only the cron (which knows the shared secret) may trigger this.
  const secret = req.headers.get('x-cron-secret') ?? new URL(req.url).searchParams.get('secret') ?? '';
  if (!CRON_SECRET || secret !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Completed-request count per user.
    const { data: doneReqs, error: reqErr } = await sb
      .from('update_requests').select('user_id').eq('status', 'Done');
    if (reqErr) throw reqErr;
    const countByUser: Record<string, number> = {};
    for (const r of doneReqs ?? []) countByUser[r.user_id] = (countByUser[r.user_id] ?? 0) + 1;

    // All clients.
    const { data: clients, error: clErr } = await sb
      .from('clients').select('id, user_id, email, name');
    if (clErr) throw clErr;

    // Already-granted rewards (dedup).
    const { data: grants } = await sb.from('reward_grants').select('user_id, milestone');
    const granted = new Set((grants ?? []).map((g) => `${g.user_id}|${g.milestone}`));

    let sent = 0;
    for (const c of clients ?? []) {
      const completed = countByUser[c.user_id] ?? 0;
      for (const r of REWARDS) {
        if (completed < r.tgt) continue;
        if (granted.has(`${c.user_id}|${r.milestone}`)) continue;

        // Record first so a retry can't double-send; the unique(user_id, milestone)
        // constraint also guards against two overlapping runs.
        const { error: insErr } = await sb.from('reward_grants').insert({
          user_id: c.user_id, client_id: c.id, milestone: r.milestone, reward: r.reward,
        });
        if (insErr) continue; // already granted or write failed -> don't email

        // Email the client.
        if (c.email) {
          try {
            await sendEmail({ from: FROM, to: [c.email], subject: 'You unlocked a reward!', html: clientEmailHtml(r.reward) });
          } catch (e) { console.error('client email failed', c.email, e); }
        }
        // Email the team so they can apply it.
        try {
          await sendEmail({
            from: FROM, to: [TEAM_EMAIL], reply_to: c.email || undefined,
            subject: '🎁 Reward to apply: ' + r.reward + ' (' + (c.email || c.name || c.user_id) + ')',
            html:
              `<p><strong>${esc(c.name || c.email || c.user_id)}</strong> just unlocked a milestone reward.</p>` +
              `<p><strong>Milestone:</strong> ${esc(r.milestone)} (${r.tgt}+ completed requests)</p>` +
              `<p><strong>Reward to apply:</strong> ${esc(r.reward)}</p>` +
              `<p style="color:#6b7094">Apply it (e.g. a Stripe credit or coupon) and post a note to their account so they see it.</p>`,
          });
        } catch (e) { console.error('team email failed', e); }

        sent++;
      }
    }
    return json({ ok: true, scanned: (clients ?? []).length, sent });
  } catch (e) {
    console.error('reward-scan error:', e);
    return json({ error: String(e) }, 500);
  }
});
