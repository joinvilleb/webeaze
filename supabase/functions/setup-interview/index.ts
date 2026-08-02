// Supabase Edge Function: setup-interview
// Eaze runs a friendly, conversational onboarding: it asks one question at a time, extracts the
// owner's answers into the Site setup fields, and signals when it has enough for the client to
// review and submit. The portal fills its setup form from the `updates` it returns.
//
// Called with the client's JWT.
//   Body:    { history: [{role:'assistant'|'user', text}], collected: { field: value, ... } }
//   Returns: { ok:true, reply: string, updates: { field: value }, done: boolean }
//
// Deploy:  supabase functions deploy setup-interview   (Verify JWT ON; the portal sends a JWT)
// Secrets: ANTHROPIC_API_KEY (already set)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const AI_MODEL = 'claude-haiku-4-5-20251001';

// The fields Eaze fills. These map 1:1 to the portal's setup form (see SETUP_FIELD_MAP there).
const FIELDS = ['business', 'industry', 'about', 'services', 'areas', 'hours', 'colors', 'wants', 'domainNotes', 'instagram', 'inspo'];

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({} as any));
    const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
    const collected = (body.collected && typeof body.collected === 'object') ? body.collected : {};

    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: c } = await service.from('clients').select('name').eq('user_id', user.id).maybeSingle();
    const first = ((c && c.name) || '').trim().split(/\s+/)[0] || '';

    if (!ANTHROPIC_API_KEY) return json({ error: 'AI is not configured' }, 200);

    const system = [
      'You are Eaze, WebEaze\'s assistant, running a warm, quick onboarding interview to build a new website for a small trade business (landscaper, HVAC, plumber, contractor, and the like).',
      'Talk like a helpful human: friendly, plain, encouraging. Ask ONE short question at a time and keep it moving. Never dump a long list of questions. NEVER use em dashes.',
      'Your job is to fill these fields from what the owner tells you: ' + FIELDS.join(', ') + '. Meanings: about = 2 to 3 sentences on what they do and what makes them good (you may polish their words into clean copy); services = the services they offer as a short newline-separated list; areas = towns or region they serve; hours = business hours; colors = brand colors if any; wants = anything specific they want on the site; domainNotes = anything about their domain or current website; instagram/inspo = links if mentioned.',
      'Only ask about fields that are still missing or thin in COLLECTED. Adapt: if they say we already handle their domain, do not push it. If they give extra detail, capture it. Polish rough answers into clean, ready-to-use copy in the updates (especially "about" and "services").',
      'NEVER ask for or accept a password in the chat. If they need to give us a login (hosting, domain, email, a social account), tell them to use the "Need to share a login" box further down this setup page, where it is encrypted in their browser before it is sent. You can note it in domainNotes that a login is coming.',
      'Our contact email is support@webeaze.io (dot IO, never dot com) and the portal is portal.webeaze.io. NEVER invent or guess any contact detail such as an email, phone number, or web address. If you are unsure how to reach us, point them to their client portal.',
      'When you have enough for a strong first draft (at minimum business, about, and services, ideally also areas and hours), set done to true and give a short, warm wrap-up telling them their setup is ready to review just below, they can tweak anything and hit submit.',
      first ? ('The owner\'s first name is ' + first + '; use it naturally once or twice, not every message.') : '',
      'If the conversation is empty, greet them warmly, say you will ask a few quick questions and handle the rest, and ask your first question (their business and what they do).',
      'Return ONLY valid JSON (no markdown, no code fences): {"reply": string, "updates": { field: value, ... only fields you learned or improved THIS turn }, "done": boolean}.',
    ].filter(Boolean).join('\n');

    const convo = history.map((h: any) => (h.role === 'user' ? 'Owner' : 'Eaze') + ': ' + String(h.text || '')).join('\n');
    const userMsg = 'COLLECTED SO FAR:\n' + JSON.stringify(collected, null, 2) + '\n\nCONVERSATION:\n' + (convo || '(empty, this is the very first turn)');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 800, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) { console.error('[setup-interview] anthropic ' + res.status); return json({ error: 'AI request failed' }, 200); }
    const d = await res.json();
    let text = ((d.content && d.content[0] && d.content[0].text) || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } } }
    if (!parsed || typeof parsed !== 'object') parsed = { reply: 'Tell me a bit about your business and what you do.', updates: {}, done: false };

    const reply = String(parsed.reply || '').replace(/\s*—\s*/g, ', ').replace(/webeaze\.com/gi, 'webeaze.io').trim() || 'Got it. What else should people know about your business?';
    const updates: Record<string, string> = {};
    if (parsed.updates && typeof parsed.updates === 'object') {
      for (const k of FIELDS) {
        if (parsed.updates[k] != null && String(parsed.updates[k]).trim()) updates[k] = String(parsed.updates[k]).replace(/\s*—\s*/g, ', ').slice(0, 1500);
      }
    }
    return json({ ok: true, reply, updates, done: !!parsed.done });
  } catch (e) {
    console.error('[setup-interview] error:', e);
    return json({ error: String(e).slice(0, 160) }, 200);
  }
});
