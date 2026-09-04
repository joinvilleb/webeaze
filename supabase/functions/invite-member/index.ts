// Supabase Edge Function: invite-member
// Admin-only (billy@webeaze.io). Manages additional logins for a client business ("multi-user").
// Each teammate gets their own Supabase auth account, linked to the business via public.client_members
// (see supabase/client_members.sql). They "act as" the client's owner user_id, so RLS (public.acts_as)
// grants them the same access as the primary login.
//
// Body:
//   { action: 'list',   clientId }                 -> { ok, members: [...] }
//   { action: 'invite', clientId, email }          -> { ok, invited, alreadyExisted, member }
//   { action: 'remove', memberId }                 -> { ok, removed }
//
// Secrets: RESEND_API_KEY (the invite email goes through Resend, not Supabase's rate-limited SMTP)
//
// Deploy:  supabase functions deploy invite-member
// (Keep JWT verification ON, the default; callers are the logged-in admin, and we check the email.)

import { createClient } from 'jsr:@supabase/supabase-js@2';

// supabase-js functions.invoke() sends apikey and x-client-info alongside authorization, so the
// browser's preflight asks permission for all four. Allowing only two meant the preflight failed and
// the request never left the browser: "Failed to send a request to the Edge Function", which reads
// like the function is missing when it is deployed and fine. Every other browser-called function in
// this project already lists all four; this one did not.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ADMIN = 'billy@webeaze.io';
const PORTAL_URL = 'https://portal.webeaze.io';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';

// Send the invite ourselves rather than leaning on Supabase's built-in mailer.
//
// inviteUserByEmail() both creates the account AND sends the email, using the project's auth SMTP.
// On a project without custom SMTP that is Supabase's shared sender, which is rate limited to a
// couple of messages an hour and silently drops the rest, so invites "worked" (the account and the
// membership were created) while the person never heard a thing. generateLink() gives us the same
// action link without sending anything, and Resend, which every other client email already goes
// through, actually delivers it.
async function sendInviteEmail(to: string, link: string, businessName: string, existing: boolean) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set on invite-member, so the invite email cannot be sent.');
  const esc = (t: string) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const biz = esc(businessName || 'your business');
  const html = '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1e222b;line-height:1.65;max-width:520px;">'
    + '<p style="margin:0 0 12px;">Hi,</p>'
    + '<p style="margin:0 0 14px;">You have been given access to the WebEaze portal for <strong>' + biz + '</strong>. '
    + (existing ? 'You already have an account, so this link signs you straight in.' : 'Use the link below to set a password and sign in.') + '</p>'
    + '<p style="margin:0 0 18px;"><a href="' + link + '" style="display:inline-block;background:#7851a9;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;">'
    + (existing ? 'Sign in to the portal' : 'Set your password') + '</a></p>'
    + '<p style="margin:0 0 14px;color:#6b7280;font-size:13px;">The link expires in 24 hours. If it has, ask for a new invite.</p>'
    + '<p style="margin:0;color:#6b7280;font-size:13px;">The WebEaze team</p></div>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify({ from: FROM, to: [to], subject: 'Your WebEaze portal access', html }),
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text()).slice(0, 160));
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MEMBER_COLS = 'id, email, role, member_user_id, invited_at, accepted_at';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  try {
    // Verify the caller is the admin, using their own JWT (never the service role for identity).
    const authed = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );
    const { data: { user } } = await authed.auth.getUser();
    if (!user || user.email !== ADMIN) return json({ ok: false, error: 'not authorized' }, 403);

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({} as any));
    const action = String(body.action || '').trim();

    // ── List a business's team ────────────────────────────────────────────
    if (action === 'list') {
      const clientId = String(body.clientId || '');
      if (!clientId) return json({ ok: false, error: 'Missing clientId.' });
      const { data, error } = await service.from('client_members')
        .select(MEMBER_COLS)
        .eq('client_id', clientId)
        .order('role', { ascending: true })
        .order('invited_at', { ascending: true });
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true, members: data || [] });
    }

    // ── Invite (or re-link) a teammate ────────────────────────────────────
    if (action === 'invite') {
      const clientId = String(body.clientId || '');
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'Enter a valid email address.' });
      if (email === ADMIN) return json({ ok: false, error: 'That is the admin account.' });

      const { data: client } = await service.from('clients')
        .select('id, user_id, name').eq('id', clientId).maybeSingle();
      if (!client) return json({ ok: false, error: 'Client not found.' });
      if (!client.user_id) return json({ ok: false, error: 'That client has no primary login yet. Set one up first.' });

      // Find or create the teammate's auth account, and get a link WITHOUT Supabase mailing anything.
      // 'invite' creates the user and returns the set-password link; it errors when the account
      // already exists, in which case a magic link signs them straight in.
      let memberUserId: string | null = null;
      let alreadyExisted = false;
      let actionLink: string | null = null;

      const inv = await service.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo: PORTAL_URL } });
      if (inv.data?.user && inv.data?.properties?.action_link) {
        memberUserId = inv.data.user.id;
        actionLink = inv.data.properties.action_link;
      } else {
        const existing = await findUserByEmail(service, email);
        if (!existing) return json({ ok: false, error: inv.error?.message || 'Could not create an account for that email.' });
        memberUserId = existing.id;
        alreadyExisted = true;
        const magic = await service.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: PORTAL_URL } });
        actionLink = magic.data?.properties?.action_link ?? null;
        if (!actionLink) return json({ ok: false, error: magic.error?.message || 'Could not create a sign-in link for that email.' });
      }
      if (memberUserId === client.user_id) return json({ ok: false, error: 'That email is already the primary login.' });

      // Link the membership (or refresh an existing one). accepted_at is set now so access works the
      // moment they complete the invite and set a password.
      const now = new Date().toISOString();
      const { data: existingRow } = await service.from('client_members')
        .select('id').eq('owner_user_id', client.user_id).eq('member_user_id', memberUserId).maybeSingle();

      let member;
      if (existingRow) {
        const { data, error } = await service.from('client_members')
          .update({ email, role: 'member', accepted_at: now, client_id: client.id })
          .eq('id', existingRow.id).select(MEMBER_COLS).maybeSingle();
        if (error) return json({ ok: false, error: error.message });
        member = data;
      } else {
        const { data, error } = await service.from('client_members')
          .insert({ client_id: client.id, owner_user_id: client.user_id, member_user_id: memberUserId, email, role: 'member', accepted_at: now })
          .select(MEMBER_COLS).maybeSingle();
        if (error) return json({ ok: false, error: error.message });
        member = data;
      }
      // Membership is saved, so access already works. The email is what tells them, and a failure
      // here is worth reporting rather than swallowing: an invite nobody receives is not an invite.
      try {
        await sendInviteEmail(email, actionLink!, client.name || '', alreadyExisted);
      } catch (mailErr) {
        return json({ ok: true, invited: true, alreadyExisted, member, emailed: false,
          error: 'Access granted, but the email did not send: ' + String((mailErr as any)?.message || mailErr) });
      }
      return json({ ok: true, invited: true, alreadyExisted, emailed: true, member });
    }

    // ── Remove a teammate ─────────────────────────────────────────────────
    if (action === 'remove') {
      const memberId = String(body.memberId || '');
      if (!memberId) return json({ ok: false, error: 'Missing memberId.' });
      const { data: m } = await service.from('client_members').select('id, role').eq('id', memberId).maybeSingle();
      if (!m) return json({ ok: false, error: 'Member not found.' });
      if (m.role === 'owner') return json({ ok: false, error: 'You cannot remove the primary login.' });
      const { error } = await service.from('client_members').delete().eq('id', memberId);
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true, removed: true });
    }

    return json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});

// supabase-js admin has no getUserByEmail, so page through listUsers to find one. The user base is
// small, so a few pages is plenty.
async function findUserByEmail(service: any, email: string) {
  for (let page = 1; page <= 15; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u: any) => (u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}
