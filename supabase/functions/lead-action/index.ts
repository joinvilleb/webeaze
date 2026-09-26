// One tap from an email, no login: "I've reached them", or won/lost.
//
// WHY THIS EXISTS: the portal has recorded 2,771 inquiries in 90 days and exactly 5 of them were
// ever marked as handled. The pipeline was not wrong, it was just asking a landscaper to stop what
// he is doing, find his password, open the portal and tick a box about a customer he already rang
// two days ago. So the weekly nudge was telling clients they had ignored inquiries they had in fact
// answered, which is the fastest way to make someone stop believing the whole feature.
//
// The link carries a token derived from the row id and the action with an HMAC of CRON_SECRET, so
// it cannot be guessed or edited into someone else's inquiry, and no session is involved. The key
// never leaves the server. Nothing here can delete or read anything: it sets one of three fields on
// one row.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { leadToken } from '../_shared/lead-token.ts';

const SECRET = Deno.env.get('CRON_SECRET') ?? '';
const PORTAL = 'https://portal.webeaze.io';
const ACTIONS = new Set(['contacted', 'won', 'lost']);

// A whole page for one tap would be overkill, but a blank screen after tapping a link in an email
// reads as broken, so it says what happened and offers the one next step.
function page(title: string, body: string, ok = true): Response {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>'
    + '<link rel="preconnect" href="https://fonts.googleapis.com">'
    + '<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'font-family:Poppins,system-ui,sans-serif;background:#f5f6fa;color:#1a1a2e;padding:24px;text-align:center}'
    + '.c{max-width:420px}.i{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;'
    + 'justify-content:center;margin:0 auto 18px;font-size:24px;background:' + (ok ? '#e8f7ef;color:#15803d' : '#fdecec;color:#c2352f') + '}'
    + 'h1{font-size:1.25rem;margin:0 0 10px}p{color:#5b6079;line-height:1.6;margin:0 0 22px;font-size:.95rem}'
    + 'a{display:inline-block;background:#7851a9;color:#fff;text-decoration:none;font-weight:600;'
    + 'font-size:.92rem;padding:11px 22px;border-radius:10px}</style></head><body><div class="c">'
    + '<div class="i">' + (ok ? '&#10003;' : '!') + '</div><h1>' + title + '</h1><p>' + body + '</p>'
    + '<a href="' + PORTAL + '/#leads">Open your inquiries</a></div></body></html>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim();
  const action = (url.searchParams.get('a') || '').trim();
  const token = (url.searchParams.get('t') || '').trim();

  if (!SECRET) return page('Something went wrong', 'We could not record that just now. You can still mark it in your portal.', false);
  if (!id || !ACTIONS.has(action) || !token) {
    return page('That link looks incomplete', 'Open your portal and you can mark it there in a tap.', false);
  }
  const expected = await leadToken(id, action, SECRET);
  // Constant time-ish: compare the whole string, never bail early on the first wrong character.
  if (expected.length !== token.length ||
      expected.split('').reduce((acc, ch, i) => acc | (ch.charCodeAt(0) ^ token.charCodeAt(i)), 0) !== 0) {
    return page('That link has expired', 'Open your portal and you can mark it there in a tap.', false);
  }

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: lead } = await svc.from('lead_events').select('id, name, contacted_at, outcome').eq('id', id).maybeSingle();
  if (!lead) return page('We could not find that inquiry', 'It may have been removed. Your other inquiries are in the portal.', false);

  const who = lead.name ? String(lead.name).split(/\s+/)[0] : 'them';
  const patch: Record<string, unknown> = {};
  // Marking it won or lost implies you spoke to them, so the contact stamp comes along rather than
  // making someone tap twice to say one thing.
  if (!lead.contacted_at) patch.contacted_at = new Date().toISOString();
  if (action === 'won' || action === 'lost') patch.outcome = action;

  const { error } = await svc.from('lead_events').update(patch).eq('id', id);
  if (error) return page('We could not record that', 'You can still mark it in your portal.', false);

  if (action === 'won') return page('Nice one', 'Marked as won, so it stops showing as waiting. Your win rate in the portal now includes it.');
  if (action === 'lost') return page('Noted', 'Marked as lost. We will stop asking about this one.');
  return page('Got it', 'Marked as reached, so we will stop mentioning ' + (lead.name ? who : 'this one') + '.');
});
