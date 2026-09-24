// Supabase Edge Function: change-email
//
// Lets a client move their own sign-in email, without being able to lock themselves out by typing it
// wrong. The change NEVER happens when they press the button:
//
//   action: 'request'  (signed in)   -> parks the request, emails a confirm link to the NEW address,
//                                       and tells the OLD address it was asked for.
//   action: 'confirm'  (token only)  -> proves they can read the new inbox, then moves the login.
//   action: 'status'   (signed in)   -> the address auth REALLY holds, plus any change still waiting.
//   action: 'cancel'   (signed in)   -> drops a waiting change; the emailed link stops working.
//
// 'status' exists because the portal could not tell anyone where their change had got to. The panel
// showed the old address with no sign a change was in flight, and after confirming on a phone the
// tab left open on a laptop went on showing the replaced address, because the session's token still
// carries the email it was minted with. The portal polls this while the panel is open.
//
// A request that is never confirmed expires after an hour and nothing changes. A typo therefore
// costs them one unread email instead of their account.
//
// WHY NOT sb.auth.updateUser({ email }): that goes through the project's auth SMTP, which is the
// shared Supabase sender here. invite-member already documents what that does: the account changes
// and the person never hears a thing, because the mailer drops most of what it is given. Every other
// client email in this project goes through Resend, so this one does too.
//
// Secrets: RESEND_API_KEY
// Deploy:  supabase functions deploy change-email --no-verify-jwt
//   (JWT off because 'confirm' arrives from a link in an inbox, with no session. 'request' checks
//    the caller's token by hand below.)

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { emailCopy } from '../_shared/email-template.ts';

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
const TTL_MINUTES = 60;

const esc = (t: string) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function send(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set on change-email.');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  if (!r.ok) throw new Error('Resend rejected the message: ' + (await r.text()).slice(0, 200));
}

const shell = (body: string) =>
  '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1e222b;line-height:1.65;max-width:520px;">'
  + body
  + '<p style="margin:22px 0 0;color:#6b7280;font-size:13px;">WebEaze</p></div>';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Who is asking: the caller's own token, never anything they typed in the body. getUser reads
    // the user row as it is NOW, so the email it returns is the truth even when their token is old.
    const caller = async () => {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!jwt) return null;
      const { data, error } = await service.auth.getUser(jwt);
      return error ? null : (data?.user ?? null);
    };
    const livePending = async (userId: string) => {
      const { data } = await service.from('email_change_requests')
        .select('token, new_email, created_at, expires_at')
        .eq('user_id', userId).is('used_at', null).gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      return data || [];
    };

    // ── Where is it up to ─────────────────────────────────────────────────
    if (action === 'status') {
      const user = await caller();
      if (!user) return json({ ok: false, error: 'Please sign in again.' }, 401);
      let pending: { email: string; expires_at: string } | null = null;
      try {
        const rows = await livePending(user.id);
        if (rows.length) pending = { email: rows[0].new_email, expires_at: rows[0].expires_at };
      } catch (_e) { /* table not migrated: no change can be waiting either */ }
      return json({ ok: true, email: user.email || '', pending });
    }

    // ── Changed their mind ────────────────────────────────────────────────
    if (action === 'cancel') {
      const user = await caller();
      if (!user) return json({ ok: false, error: 'Please sign in again.' }, 401);
      // Spending the tokens is what cancels it: the link in the inbox is the only way in, and a
      // spent token is refused by 'confirm' above.
      await service.from('email_change_requests')
        .update({ used_at: new Date().toISOString() })
        .eq('user_id', user.id).is('used_at', null);
      return json({ ok: true });
    }

    // ── Ask for the change ────────────────────────────────────────────────
    if (action === 'request') {
      const user = await caller();
      if (!user) return json({ ok: false, error: 'Please sign in again.' }, 401);

      const oldEmail = String(user.email || '').toLowerCase();
      const newEmail = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(newEmail)) return json({ ok: false, error: "That doesn't look like an email address." }, 400);
      if (newEmail === oldEmail) return json({ ok: false, error: "That's already your email address." }, 400);

      // The admin login is the one account this must never touch: admin access across this project
      // is an email string compare, so moving it would revoke the admin panel and un-guard the
      // request-update trigger in one go.
      if (oldEmail === ADMIN || newEmail === ADMIN) {
        return json({ ok: false, error: 'That address cannot be changed here.' }, 403);
      }

      // Taken already? Better to say so now than to fail at the last step.
      const { data: existing } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if ((existing?.users || []).some((u: any) => String(u.email || '').toLowerCase() === newEmail)) {
        return json({ ok: false, error: 'There is already an account on that email address.' }, 409);
      }

      // Asking again supersedes the earlier ask, so there is never more than one live link to a
      // given account: "send it again" must not leave two working links behind it.
      await service.from('email_change_requests')
        .update({ used_at: new Date().toISOString() })
        .eq('user_id', user.id).is('used_at', null)
        .then(null, (e: any) => console.warn('[change-email] superseding earlier asks', String(e).slice(0, 120)));

      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      const expires = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();
      const { error: insErr } = await service.from('email_change_requests').insert({
        token, user_id: user.id, old_email: oldEmail, new_email: newEmail, expires_at: expires,
      });
      if (insErr) {
        console.error('[change-email] could not park the request', insErr.message);
        return json({ ok: false, error: 'Run email_change_requests.sql, then try again.' }, 500);
      }

      const link = PORTAL_URL + '/#confirm-email=' + token;
      // If the confirmation cannot be sent, say exactly that, and spend the token: otherwise the
      // portal would show "Waiting on" an address that never got an email.
      try {
        // Wording comes from admin when it has been edited there; these are the defaults and the last
        // resort if the registry cannot be read. See supabase/functions/_shared/email-template.ts.
        const copy = await emailCopy(service, 'email-change', {
          subject: 'Confirm your new WebEaze email address',
          slots: {
            greeting: 'Hi,',
            lead: 'You asked to sign in to your WebEaze portal with this address instead of {{old_email}}. Confirm it and we will move it across.',
            button: 'Confirm this address',
            fine_print: 'The link works for one hour. Until you use it, nothing changes and you keep signing in with your old address.',
          },
        });
        // The old address is bold inside an editable sentence, and a slot is escaped prose, so no tag
        // can travel through one. The address goes in wrapped in two control characters, which the
        // escaping leaves alone, and those become the <strong> once the sentence is built. Take the
        // placeholder out of the slot and the bold goes with it. The subject gets the plain values: a
        // mail header has no tags in it.
        const vars = { old_email: oldEmail, new_email: newEmail };
        const bodyVars = { old_email: '\u0001' + oldEmail + '\u0002', new_email: '\u0001' + newEmail + '\u0002' };
        const strong = (t: string) => t.split('\u0001').join('<strong>').split('\u0002').join('</strong>');
        await send(newEmail, copy.subject(vars), shell(strong(
          // "Hi {{old_email}}," with nothing to fill in would read "Hi ,".
          '<p style="margin:0 0 12px;">' + copy.text('greeting', bodyVars).replace(/\s+([,.!?])/g, '$1') + '</p>'
          + copy.paras('lead', bodyVars, 'margin:0 0 14px;')
          + '<p style="margin:0 0 18px;"><a href="' + link + '" style="display:inline-block;background:#7851a9;color:#fff;'
          + 'text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;">' + copy.text('button', bodyVars) + '</a></p>'
          + copy.paras('fine_print', bodyVars, 'margin:0 0 6px;color:#6b7280;font-size:13px;'))));
      } catch (e) {
        console.error('[change-email] confirmation send failed', String(e).slice(0, 300));
        await service.from('email_change_requests').update({ used_at: new Date().toISOString() }).eq('token', token)
          .then(null, () => {});
        return json({ ok: false, error: "We couldn't send the confirmation email to that address just now. Check it's typed correctly, or try again in a few minutes." }, 502);
      }

      // The address losing the account hears about it too. A change nobody asked for should not be
      // silent for the person it happens to.
      await send(oldEmail, 'Someone asked to change your WebEaze email', shell(
        '<p style="margin:0 0 12px;">Hi,</p>'
        + '<p style="margin:0 0 14px;">A request was made to change the email you sign in with, from <strong>'
        + esc(oldEmail) + '</strong> to <strong>' + esc(newEmail) + '</strong>.</p>'
        + '<p style="margin:0 0 14px;">If that was you, open the confirmation email we sent to the new address. '
        + '<strong>If it was not you, nothing has changed yet.</strong> Reply to this email and we will lock it down.</p>'))
        .catch((e) => console.warn('[change-email] old-address notice failed', String(e).slice(0, 120)));

      return json({ ok: true, sentTo: newEmail });
    }

    // ── Spend the token ───────────────────────────────────────────────────
    if (action === 'confirm') {
      const token = String(body.token || '');
      if (!token) return json({ ok: false, error: 'That link is missing its code.' }, 400);

      const { data: reqRow } = await service.from('email_change_requests').select('*').eq('token', token).maybeSingle();
      if (!reqRow) return json({ ok: false, error: 'That link is not valid.' }, 404);
      if (reqRow.used_at) return json({ ok: false, error: 'That link has already been used.' }, 410);
      if (new Date(reqRow.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: 'That link has expired. Ask for the change again.' }, 410);
      }

      const { error: authErr } = await service.auth.admin.updateUserById(reqRow.user_id, {
        email: reqRow.new_email,
        email_confirm: true,   // they just proved it by opening this link
      });
      if (authErr) {
        console.error('[change-email] auth update failed', authErr.message);
        return json({ ok: false, error: 'We could not move it across. Reply to this email and we will sort it.' }, 500);
      }

      // The same address is stored in three more places. Leaving them behind would mean their emails
      // keep going to the old inbox while they sign in with the new one.
      await service.from('clients').update({ email: reqRow.new_email }).eq('user_id', reqRow.user_id)
        .then(null, (e: any) => console.warn('[change-email] clients.email', String(e).slice(0, 120)));
      await service.from('client_members').update({ email: reqRow.new_email }).eq('member_user_id', reqRow.user_id)
        .then(null, (e: any) => console.warn('[change-email] client_members.email', String(e).slice(0, 120)));

      await service.from('email_change_requests').update({ used_at: new Date().toISOString() }).eq('token', token);

      await send(reqRow.new_email, 'Your WebEaze email address is updated', shell(
        '<p style="margin:0 0 12px;">Done.</p>'
        + '<p style="margin:0 0 14px;">You now sign in to your portal with <strong>' + esc(reqRow.new_email)
        + '</strong>. Your password has not changed.</p>'
        + '<p style="margin:0 0 18px;"><a href="' + PORTAL_URL + '" style="display:inline-block;background:#7851a9;color:#fff;'
        + 'text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;">Open your portal</a></p>'))
        .catch((e) => console.warn('[change-email] confirmation notice failed', String(e).slice(0, 120)));

      return json({ ok: true, email: reqRow.new_email });
    }

    return json({ ok: false, error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('[change-email]', e);
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
});
