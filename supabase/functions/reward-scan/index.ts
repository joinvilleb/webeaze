// Supabase Edge Function: reward-scan
// Scheduled backstop for the milestone "mystery rewards". Runs with the service role
// (no user context) so it fires even for clients who never open the portal.
//
// For every client it works out which milestones they have earned, from their completed requests and
// how long they have been with us. For each one newly crossed it:
//   - records the grant in `reward_grants` (unique per user+milestone -> never double-sends)
//   - emails the client (a short congratulations, or the reward email for the three that carry a perk)
//   - emails the WebEaze team (so a perk gets applied, and so we know to say well done)
//
// HISTORY IS NOT EMAILED. Every milestone has a knowable earn date: a count milestone is earned on the
// completed_at of the Nth finished request, a time milestone on the anniversary of signing up. Anything
// earned more than GRACE_DAYS ago is recorded silently, so switching this on does not fire eight emails
// at a client who has been here a year.
//
// Keep MILESTONES below in sync with the list in portal/index.html (loadBadges).
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

// Must match portal/index.html loadBadges(). kind 'done' counts completed requests, 'sent' counts all
// requests, 'months' counts months since signup. A reward is a milestone that also carries a perk.
type Milestone = { milestone: string; tgt: number; kind: 'done' | 'sent' | 'months'; reward?: string; blurb: string };
const MILESTONES: Milestone[] = [
  { milestone: 'First request',         tgt: 1,   kind: 'sent',   blurb: 'You sent your first request. This is how everything gets done from here.' },
  { milestone: '5 requests completed',  tgt: 5,   kind: 'done',   blurb: 'Five changes to your website, done and live.' },
  { milestone: '3 months with WebEaze', tgt: 3,   kind: 'months', blurb: 'Three months of your website being looked after.' },
  { milestone: '10 requests completed', tgt: 10,  kind: 'done',   blurb: 'Ten changes done. Most sites never get updated once.' },
  { milestone: '6 months with WebEaze', tgt: 6,   kind: 'months', blurb: 'Half a year with us.' },
  { milestone: '25 requests completed', tgt: 25,  kind: 'done',   blurb: 'Twenty five changes done for you.' },
  { milestone: '1 year with WebEaze',   tgt: 12,  kind: 'months', blurb: 'A whole year. Thank you, genuinely.' },
  { milestone: 'Loyal client',   tgt: 25,  kind: 'done', reward: 'A little thank-you on your next invoice', blurb: '25 completed requests' },
  { milestone: 'WebEaze VIP',    tgt: 50,  kind: 'done', reward: 'A thank-you credit on your next invoice', blurb: '50 completed requests' },
  { milestone: 'WebEaze legend', tgt: 100, kind: 'done', reward: 'A free month, on us', blurb: '100 completed requests' },
];
const GRACE_DAYS = 3;
const DAY = 86400000;

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

// The plain milestone email. Short on purpose: it is a pat on the back, not an announcement.
function milestoneEmailHtml(name: string, title: string, blurb: string) {
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /></head>',
    '<body style="margin:0;padding:0;background:#f8f9fc;font-family:Helvetica,Arial,sans-serif;">',
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fc;padding:40px 16px;">',
    '<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">',
    '<tr><td style="background:#ffffff;border:1px solid #e4e7f1;border-radius:16px;padding:40px 36px;">',
    '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#7851a9;margin-bottom:10px;">Milestone unlocked</div>',
    '<h1 style="font-size:20px;font-weight:800;color:#0f1228;margin:0 0 12px;">' + esc(title) + '</h1>',
    '<p style="font-size:14px;color:#6b7094;line-height:1.65;margin:0 0 20px;">' + (name ? 'Nice one, ' + esc(name) + '. ' : '') + esc(blurb) + '</p>',
    '<p style="font-size:14px;color:#6b7094;line-height:1.65;margin:0 0 24px;">Keep going and there are three rewards waiting further along, at 25, 50 and 100 completed requests. You can see how close you are in your portal.</p>',
    '<p style="margin:0 0 4px;"><a href="' + PORTAL_URL + '/#milestones" style="display:inline-block;background:#7851a9;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 24px;border-radius:10px;">See your milestones</a></p>',
    '</td></tr><tr><td align="center" style="padding-top:24px;">',
    '<p style="font-size:12px;color:#a0a6c4;margin:0;">WebEaze Web Design, 109 Pleasant Hill Drive, Camden-Wyoming, Delaware 19934, USA</p>',
    '</td></tr></table></td></tr></table></body></html>',
  ].join('');
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

    // Every request, with the dates that decide WHEN a milestone was earned.
    const { data: allReqs, error: reqErr } = await sb
      .from('update_requests').select('user_id, status, created_at, completed_at');
    if (reqErr) throw reqErr;
    const doneAt: Record<string, number[]> = {};   // completed timestamps, oldest first
    const sentAt: Record<string, number[]> = {};   // created timestamps, oldest first
    for (const r of allReqs ?? []) {
      (sentAt[r.user_id] = sentAt[r.user_id] || []).push(new Date(r.created_at).getTime());
      if (r.status === 'Done') (doneAt[r.user_id] = doneAt[r.user_id] || []).push(new Date(r.completed_at || r.created_at).getTime());
    }
    for (const k of Object.keys(doneAt)) doneAt[k].sort((a, b) => a - b);
    for (const k of Object.keys(sentAt)) sentAt[k].sort((a, b) => a - b);

    // All clients.
    const { data: clients, error: clErr } = await sb
      .from('clients').select('id, user_id, email, name, status, created_at, second_email');
    if (clErr) throw clErr;

    // Already-granted rewards (dedup).
    const { data: grants } = await sb.from('reward_grants').select('user_id, milestone');
    const granted = new Set((grants ?? []).map((g) => `${g.user_id}|${g.milestone}`));

    const now = Date.now();
    let sent = 0, backfilled = 0;
    for (const c of clients ?? []) {
      if ((c.status || '').toLowerCase() === 'inactive') continue;
      const done = doneAt[c.user_id] || [];
      const made = sentAt[c.user_id] || [];
      const joined = c.created_at ? new Date(c.created_at).getTime() : now;
      const monthsActive = Math.floor((now - joined) / (30.44 * DAY));

      for (const r of MILESTONES) {
        // Earned yet, and if so, when? The date is what keeps history quiet.
        let earnedAt: number | null = null;
        if (r.kind === 'done' && done.length >= r.tgt) earnedAt = done[r.tgt - 1];
        else if (r.kind === 'sent' && made.length >= r.tgt) earnedAt = made[r.tgt - 1];
        else if (r.kind === 'months' && monthsActive >= r.tgt) earnedAt = joined + Math.round(r.tgt * 30.44 * DAY);
        if (earnedAt == null) continue;
        if (granted.has(`${c.user_id}|${r.milestone}`)) continue;
        const historical = earnedAt < now - GRACE_DAYS * DAY;

        // Record first so a retry can't double-send; the unique(user_id, milestone)
        // constraint also guards against two overlapping runs.
        const { error: insErr } = await sb.from('reward_grants').insert({
          user_id: c.user_id, client_id: c.id, milestone: r.milestone, reward: r.reward ?? null,
        });
        if (insErr) continue; // already granted or write failed -> don't email

        // Earned before we were watching: recorded, never announced.
        if (historical) { backfilled++; continue; }

        const to = [c.email, c.second_email].filter(Boolean) as string[];
        if (to.length) {
          try {
            await sendEmail(r.reward
              ? { from: FROM, to, subject: 'You unlocked a reward!', html: clientEmailHtml(r.reward) }
              : { from: FROM, to, subject: r.milestone + ' - nice work', html: milestoneEmailHtml(String(c.name || '').split(' ')[0], r.milestone, r.blurb) });
          } catch (e) { console.error('client email failed', to[0], e); }
        }
        // Always tell the team, perk or not: a milestone is a good reason to say something human.
        try {
          await sendEmail({
            from: FROM, to: [TEAM_EMAIL], reply_to: c.email || undefined,
            subject: (r.reward ? '🎁 Reward to apply: ' + r.reward : '🏅 Milestone: ' + r.milestone) + ' (' + (c.name || c.email || c.user_id) + ')',
            html:
              `<p><strong>${esc(c.name || c.email || c.user_id)}</strong> just reached <strong>${esc(r.milestone)}</strong>.</p>` +
              (r.reward
                ? `<p><strong>Reward to apply:</strong> ${esc(r.reward)}</p><p style="color:#6b7094">Apply it (a Stripe credit or coupon) and post a message to their account so they see it.</p>`
                : `<p style="color:#6b7094">They have been emailed. A one-line message from you in their portal goes a long way here.</p>`),
          });
        } catch (e) { console.error('team email failed', e); }

        sent++;
      }
    }
    return json({ ok: true, scanned: (clients ?? []).length, sent, backfilled });
  } catch (e) {
    console.error('reward-scan error:', e);
    return json({ error: String(e) }, 500);
  }
});
