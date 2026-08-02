// Supabase Edge Function: ai-assist
// A small AI helper for the client portal. Right now it drafts website copy from a client's rough
// notes during Site setup, so a stuck owner gets clean, editable text instead of abandoning the form.
//
// Called with the client's JWT. Body: { task: 'about' | 'services', input?: string }
// Returns: { ok: true, text: '<drafted copy>' }
//
// Deploy:  supabase functions deploy ai-assist   (Verify JWT can stay ON; the portal sends a JWT)
// Secrets: ANTHROPIC_API_KEY (already set)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const AI_MODEL = 'claude-haiku-4-5-20251001';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({} as any));
    const task = String(body.task || 'about');
    const input = String(body.input || '').slice(0, 2000);

    // Identify the client so we can ground the copy in their business.
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: c } = await service.from('clients').select('name, site_url').eq('user_id', user.id).maybeSingle();
    const biz = (c && c.name) || '';

    if (!ANTHROPIC_API_KEY) return json({ error: 'AI is not configured' }, 200);

    let system: string, userMsg: string;
    if (task === 'services') {
      system = "You are a copywriter for WebEaze, writing for a small trade business. Turn the owner's rough notes into a clean, scannable list of the services they offer, suitable for their website. Plain, confident, everyday language. NEVER use em dashes. Return ONLY the services, one per line, no numbering, no preamble, no closing remark.";
      userMsg = 'Business name: ' + biz + '\nRough notes from the owner:\n' + (input || '(nothing written yet, so infer a few sensible, editable example services from the business name)');
    } else if (task === 'resolution') {
      // Admin-side: draft the client-facing "here is what we did" note from the request.
      system = "You are the WebEaze team writing a short, friendly note to a client telling them what we just took care of on their website, based on their request. One or two sentences, warm and plain, past tense (for example 'We updated your hours to...'). No hype, no jargon, and NEVER use em dashes. Return ONLY the note text, no preamble.";
      userMsg = 'The client\'s request was:\n' + input + '\n\nWrite the note describing this as done.';
    } else if (task === 'request') {
      // Client-side: polish a rough request into a clear one, in the owner's own voice.
      system = "You help a small business owner write a clear website change request for their web team. Rewrite their rough note into a clear, specific, polite request in first person, in their own plain voice. Keep it short. Do NOT invent details they did not give; just make it clean and unambiguous. NEVER use em dashes. Return ONLY the improved request text, no preamble.";
      userMsg = 'Rough request:\n' + input;
    } else if (task === 'triage') {
      // Admin-side: a quick read on an incoming request.
      system = "You are triaging a website change request for the WebEaze team. In at most two short lines, say plainly: what the client wants, whether it is clear enough to action now or needs a quick clarifying question (and if so, exactly what to ask), and rough size (quick tweak, medium, or larger job). Be direct and useful, no fluff. NEVER use em dashes. Return ONLY the assessment.";
      userMsg = 'The request:\n' + input;
    } else if (task === 'review_reply') {
      // Client-side: draft a public reply to a customer review, in the business's voice.
      system = "You write a warm, professional public reply to a customer's online review, on behalf of a small trade business. Match the tone: genuinely grateful for praise, calm and solution-focused for criticism, never defensive or corporate. Two to four sentences, sincere and plain. If the review is negative, apologize briefly and invite them to make it right. NEVER use em dashes. Return ONLY the reply text, no preamble or quotes.";
      userMsg = 'Business name: ' + biz + '\nThe customer review:\n' + input;
    } else {
      system = "You are a copywriter for WebEaze, writing for a small trade business (landscaper, HVAC, plumber, contractor, and the like). Write a warm, confident About section for their website based on the owner's rough notes and business name. At most two short paragraphs. Plain, trustworthy, small-business voice, focused on what they do and why a customer should choose them. No hype, no jargon, no headings, no quotes, and NEVER use em dashes. Return ONLY the About text, ready to drop on the site (the owner will edit it).";
      userMsg = 'Business name: ' + biz + '\nWhat the owner told us:\n' + (input || '(they have not written anything yet, so write general, clearly-editable placeholder copy from the business name that they can refine)');
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) { console.error('[ai-assist] anthropic ' + res.status); return json({ error: 'AI request failed' }, 200); }
    const d = await res.json();
    let text = ((d.content && d.content[0] && d.content[0].text) || '').trim().replace(/\s*—\s*/g, ', ');
    return json({ ok: true, text });
  } catch (e) {
    console.error('[ai-assist] error:', e);
    return json({ error: String(e).slice(0, 160) }, 200);
  }
});
