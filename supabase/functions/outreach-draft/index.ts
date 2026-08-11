// Supabase Edge Function: outreach-draft
// Stage 2 of the lead-acquisition machine. Takes the top un-worked `prospects`, finds an email
// for the ones with a website, and writes a personalized cold-email sequence (first touch + 2
// follow-ups) tailored to that exact business and the gap we found (no website / slow site).
//
// Prospects with a website  -> scrape a contact email, draft an email sequence, status 'drafted'.
// Prospects with no website  -> no email to find, flagged channel 'call' (a call list), status 'queued'.
//
// Entry (POST):  { action:'draft', limit? }   limit defaults to 5 (your ~5-10/day pace).
// Auth: admin (billy@webeaze.io) JWT, OR x-cron-secret (so a daily cron can keep the queue full).
// Secrets (all already set): ANTHROPIC_API_KEY, CRON_SECRET.
//
// Deploy: supabase functions deploy outreach-draft   (Verify JWT OFF — self-auths like prospect-scan)
// Table:  supabase/prospects.sql  (adds the `outreach` + `channel` columns)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const ADMIN_EMAIL = 'billy@webeaze.io';
const AI_MODEL = 'claude-sonnet-5';
const PREVIEW_URL = 'https://getwebeaze.com';   // the free-preview landing page, for a follow-up link

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Best-effort: fetch the prospect's site and pull a real contact email. Prefers role-based
// addresses on the business's own domain; skips the usual junk (asset files, tracker noreplies).
async function scrapeEmail(website: string): Promise<string | null> {
  try {
    const full = /^https?:\/\//i.test(website) ? website : 'https://' + website;
    const res = await fetch(full, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebEazeBot/1.0)' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400000);
    const found = new Set<string>();
    for (const m of html.matchAll(/mailto:([^"'?>\s]+@[^"'?>\s]+)/gi)) found.add(m[1].toLowerCase());
    for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(m[0].toLowerCase());
    const junk = /(\.(png|jpe?g|webp|gif|svg)$|sentry|wixpress|no-?reply|example\.|@\dx|godaddy|squarespace\.com|cloudflare)/i;
    const host = full.replace(/^https?:\/\//, '').replace(/\/.*/, '').replace(/^www\./, '');
    const cands = [...found].filter((e) => !junk.test(e) && e.length < 60);
    cands.sort((a, b) => {
      const sc = (e: string) => (e.endsWith('@' + host) ? 2 : 0) + (/^(info|contact|hello|office|admin|sales|team|hi)@/.test(e) ? 1 : 0);
      return sc(b) - sc(a);
    });
    return cands[0] || null;
  } catch { return null; }
}

// Ask Claude for a short, genuine cold-email sequence tailored to this business + gap.
async function draftSequence(p: any): Promise<any | null> {
  if (!ANTHROPIC_API_KEY) { console.warn('[outreach] ANTHROPIC_API_KEY not set'); return null; }
  const facts = {
    business: p.name, trade: p.category || null, area: p.area || null,
    hasWebsite: !!p.website, website: p.website || null,
    mobileSpeed: p.speed_mobile ?? null, googleRating: p.rating ?? null, reviewCount: p.review_count ?? null,
    whyWeReachedOut: p.score_reasons || [],
  };
  const system = [
    "You are Billy, the founder of WebEaze, a friendly web design and website-care service for small local businesses.",
    "WebEaze builds and manages a professional site for one flat price from $169/month: custom design, hosting, unlimited updates, and local SEO, no contracts. We show a free preview of their new site before they pay a cent.",
    "Write a SHORT, genuine cold outreach email to this business owner, plus two brief follow-ups. It must read like a real person who actually looked at their business, not a mass blast.",
    "Reference the SPECIFIC reason we reached out (they have no website, or their current site is slow/dated) in plain, non-technical language. No hype, no jargon, no fake urgency, no walls of text.",
    "The goal is a reply that leads to a quick friendly call, not an instant sale. First email: under 90 words, warm, and end with a low-friction question that invites a reply, like offering to hop on a quick call or send them a free no-obligation preview of what their new site could look like (do NOT put a link in the first email). One follow-up may mention they can see a free preview at " + PREVIEW_URL + ".",
    "NEVER use em dashes anywhere. End every email with a two-line sign-off: 'Billy' on one line, then 'WebEaze Web Design' on the next line, with nothing after it (do not add a URL yourself).",
    "Return ONLY valid JSON (no markdown, no code fences): { subject, body, followups: [ { subject, body, waitDays }, { subject, body, waitDays } ] }. Bodies are plain text; use \\n for line breaks. waitDays is days to wait after the previous email (e.g. 3 then 4). Tailor every line to this exact trade.",
  ].join(' ');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 900, system, messages: [{ role: 'user', content: 'Business to write to:\n' + JSON.stringify(facts, null, 2) }] }),
    });
    if (!res.ok) { console.error('[outreach] Anthropic ' + res.status + ': ' + (await res.text()).slice(0, 200)); return null; }
    const d = await res.json();
    // Claude 5 can return a leading thinking block; join ALL text blocks or the copy comes back empty.
    let text = Array.isArray(d.content) ? d.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const o = JSON.parse(text);
    if (!o || !o.subject || !o.body) return null;
    return {
      subject: String(o.subject).slice(0, 160),
      body: String(o.body).slice(0, 2000),
      followups: Array.isArray(o.followups) ? o.followups.slice(0, 2).map((f: any) => ({
        subject: String(f.subject || o.subject).slice(0, 160),
        body: String(f.body || '').slice(0, 2000),
        waitDays: Math.min(14, Math.max(1, Number(f.waitDays) || 3)),
      })) : [],
      model: AI_MODEL,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) { console.error('[outreach] draft failed:', e); return null; }
}

async function doDraft(sb: any, limit: number) {
  // No-website prospects can't be emailed, so bulk-route them to the call list in one query (no AI
  // needed). Otherwise, because they score highest (+50), they'd fill every draft batch as "calls"
  // and the email candidates would never get reached.
  await sb.from('prospects')
    .update({ channel: 'call', status: 'queued', updated_at: new Date().toISOString() })
    .eq('status', 'new').is('website', null);

  // Now draft the highest-scoring prospects that HAVE a website (i.e. an email path).
  const { data: rows, error } = await sb.from('prospects')
    .select('id, name, category, area, website, email, speed_mobile, rating, review_count, score_reasons')
    .eq('status', 'new').not('website', 'is', null).is('outreach', null)
    .order('score', { ascending: false }).limit(Math.min(Math.max(1, limit | 0), 15));
  if (error) throw new Error('select: ' + error.message);
  if (!rows?.length) return { drafted: 0, calls: 0, prospects: [] };

  const out: any[] = [];
  let drafted = 0, calls = 0;
  for (const p of rows) {
    // Find an email if they have a website (and we don't already have one).
    let email = p.email || null;
    if (!email && p.website) email = await scrapeEmail(p.website);

    if (!email) {
      // No reachable email -> this one is a phone lead, not an email lead.
      await sb.from('prospects').update({ channel: 'call', status: 'queued', updated_at: new Date().toISOString() }).eq('id', p.id);
      calls++; out.push({ name: p.name, channel: 'call', reason: 'no email found' });
      continue;
    }

    const seq = await draftSequence(p);
    if (!seq) { out.push({ name: p.name, channel: 'email', error: 'draft failed' }); continue; }
    await sb.from('prospects').update({ email, channel: 'email', outreach: seq, status: 'drafted', updated_at: new Date().toISOString() }).eq('id', p.id);
    drafted++; out.push({ name: p.name, channel: 'email', email, subject: seq.subject });
  }
  return { drafted, calls, prospects: out };
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
    const out = await doDraft(service, Number(body.limit) || 5);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error('outreach-draft error:', e);
    return json({ error: String(e) }, 500);
  }
});
