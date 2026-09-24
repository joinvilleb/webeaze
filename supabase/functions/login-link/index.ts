// Supabase Edge Function: login-link
// Emails a one-tap sign-in link, so nobody has to remember a password.
//
// WHY: the people using this portal are tradesmen and shop owners checking their site from a phone,
// months apart. A forgotten password is the normal case, not the exception, and every reset is three
// screens and a new password to forget again. A link in their inbox skips all of it.
//
// It goes through Resend with a link minted by the admin API, NOT supabase.auth.signInWithOtp():
// Supabase's built-in SMTP is rate limited to a handful an hour, which is exactly how the invite
// emails "did not work" before they moved to Resend.
//
// Two rules keep this from becoming a way to send mail to strangers:
//   1. the address must belong to an ACTIVE client or an accepted teammate, and
//   2. one link per address per minute (public.login_link_requests).
// Either way the answer is the same {ok:true}: whether an address has an account is not something an
// unauthenticated caller gets to learn.
//
// Body:   { email }
// Deploy: supabase functions deploy login-link --no-verify-jwt
// Needs:  supabase/login_link_requests.sql, RESEND_API_KEY

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { emailCopy } from '../_shared/email-template.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';
const THROTTLE_MS = 60 * 1000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// See wzMail in portal/index.html: stops the inbox preview reading on into the body.
const PREVIEW_PAD = new Array(161).join('&#847;&zwnj;&nbsp;');

async function sendLink(service: any, to: string, link: string, name: string) {
  const first = String(name || '').trim().split(/\s+/)[0];
  // Wording comes from admin when it has been edited there; these are the defaults and the last
  // resort if the registry cannot be read. See supabase/functions/_shared/email-template.ts.
  const copy = await emailCopy(service, 'sign-in-link', {
    subject: 'Your sign-in link',
    slots: {
      greeting: 'Hey {{first_name}},',
      lead: 'Here\'s your way in. No password needed.',
      button: 'Open my portal',
      fine_print: 'The link works for one hour and only from this email. If you didn\'t ask for it, you can ignore this: nobody can get in without it.',
      signoff: 'Best,\nWebEaze Web Design',
    },
  });
  const vars = { first_name: first || '' };
  // "Hey {{first_name}}," with no name on file would read "Hey ,".
  const greeting = copy.text('greeting', vars).replace(/\s+([,.!?])/g, '$1');
  const signoff = (copy.text('signoff', vars) || 'Best,\nWebEaze Web Design').split('\n')
    .map((line, i) => '<p style="' + (i === 0 ? 'margin:28px 0 4px;' : 'margin:0;') + '">' + line.trim() + '</p>').join('');
  const html =
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Tap to sign in. The link works for one hour.</div>' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + PREVIEW_PAD + '</div>' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2333;">' +
    '<p style="margin:0 0 12px;">' + greeting + '</p>' +
    copy.paras('lead', vars, 'margin:0 0 20px;') +
    '<p style="margin:0 0 20px;"><a href="' + link + '" style="display:inline-block;background:#7851a9;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">' + copy.text('button', vars) + '</a></p>' +
    copy.paras('fine_print', vars, 'margin:0 0 16px;color:#6b7094;font-size:13px;') +
    signoff +
    '<p style="margin:28px 0 0;font-size:12px;color:#9599b8;">WebEaze Web Design, 109 Pleasant Hill Drive, Camden-Wyoming, Delaware 19934, USA</p>' +
    '</div>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify({ from: FROM, to: [to], subject: copy.subject(vars), html }),
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text()).slice(0, 160));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  // Every answer below is {ok:true}. The caller is not signed in, so it learns nothing either way.
  try {
    const body = await req.json().catch(() => ({} as any));
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ ok: true });
    if (!RESEND_API_KEY) { console.error('[login-link] RESEND_API_KEY missing'); return json({ ok: true }); }

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // One a minute per address. Written BEFORE the send, so a burst of taps cannot race past it.
    const { data: prev } = await service.from('login_link_requests').select('sent_at').eq('email', email).maybeSingle();
    if (prev && prev.sent_at && Date.now() - new Date(prev.sent_at).getTime() < THROTTLE_MS) {
      return json({ ok: true, throttled: true });
    }
    await service.from('login_link_requests').upsert({ email, sent_at: new Date().toISOString() }, { onConflict: 'email' });

    // The address has to belong to someone we actually work for: an active client, or a teammate
    // they invited. Anything else and we send nothing at all.
    const { data: client } = await service.from('clients')
      .select('name, status, email').ilike('email', email).maybeSingle();
    let name = '';
    let allowed = !!(client && (client.status || '').toLowerCase() !== 'inactive');
    if (client) name = client.name || '';
    if (!allowed) {
      const { data: member } = await service.from('client_members')
        .select('email, accepted_at, owner_user_id').ilike('email', email).maybeSingle();
      if (member && member.accepted_at) {
        const { data: owner } = await service.from('clients')
          .select('name, status').eq('user_id', member.owner_user_id).maybeSingle();
        if (owner && (owner.status || '').toLowerCase() !== 'inactive') { allowed = true; name = owner.name || ''; }
      }
    }
    if (!allowed) return json({ ok: true });

    const magic = await service.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: PORTAL_URL } });
    const link = magic.data?.properties?.action_link;
    if (!link) { console.error('[login-link] generateLink failed:', magic.error?.message); return json({ ok: true }); }

    await sendLink(service, email, link, name);
    console.log('[login-link] sent to ' + email);
    return json({ ok: true, sent: true });
  } catch (e) {
    console.error('[login-link] error:', e);
    return json({ ok: true });   // never leak the reason to an unauthenticated caller
  }
});
