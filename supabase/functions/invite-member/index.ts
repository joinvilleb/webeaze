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
// Deploy:  supabase functions deploy invite-member
// (Keep JWT verification ON, the default; callers are the logged-in admin, and we check the email.)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ADMIN = 'billy@webeaze.io';
const PORTAL_URL = 'https://portal.webeaze.io';
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

      // Find or create the teammate's auth account. inviteUserByEmail creates the user AND emails them
      // a set-password link; if they already have an account it errors, so we look them up instead and
      // send a magic sign-in link so they know they now have access.
      let memberUserId: string | null = null;
      let alreadyExisted = false;
      const inv = await service.auth.admin.inviteUserByEmail(email, { redirectTo: PORTAL_URL });
      if (inv.data?.user) {
        memberUserId = inv.data.user.id;
      } else {
        const existing = await findUserByEmail(service, email);
        if (!existing) return json({ ok: false, error: inv.error?.message || 'Could not invite that email.' });
        memberUserId = existing.id;
        alreadyExisted = true;
        await service.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: PORTAL_URL } }).catch(() => {});
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
      return json({ ok: true, invited: true, alreadyExisted, member });
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
