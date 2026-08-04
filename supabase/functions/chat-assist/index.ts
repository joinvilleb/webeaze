// Supabase Edge Function: chat-assist
// The AI concierge in the client portal's live chat. It reads the client's message (plus recent
// history, their account/billing context, and the few most relevant help articles) and decides ONE
// of four things: answer directly, point to a help article, propose a website change for the client
// to confirm, or hand off to the human team. It replies in the WebEaze voice (never "I am a bot") and
// inserts its reply into chat_messages so the portal's realtime shows it like any other message.
// For a website change it does NOT file the update_requests row itself; it returns proposedRequest
// {type, notes} and the portal files it once the client taps to confirm.
//
// Knowledge: it fetches portal.webeaze.io/help-content.json (all 180 help articles, extracted from
// help.html) and retrieves the top few relevant to each question, so it answers refund policy,
// pricing, cancellation, etc. from WebEaze's REAL content, not guesses. Account facts (plan, amount,
// next billing date) come from the clients row.
//
// Plan gating (how support differentiates the plans):
//   - Essential  : AI-only, no live human. Answers / files requests / follows up by email, and may
//                  gently note that Growth adds a real person.
//   - Growth/Elite: AI + human. Escalates to Billy, and steps aside once Billy has personally
//                  replied in a thread (via_ai marker).
//
// Called from the portal with the client's JWT. Body:
//   { message, sessionId, history:[{role,text}], articles:[{slug,title}], targetUserId? }
//
// Deploy:  supabase functions deploy chat-assist   (Verify JWT can stay ON; the portal sends a JWT)
// Secrets: ANTHROPIC_API_KEY, RESEND_API_KEY (both already set)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const AI_MODEL = 'claude-haiku-4-5-20251001';
const FROM = 'WebEaze <support@webeaze.io>';
const TEAM = 'billy@webeaze.io';
const KB_URL = 'https://portal.webeaze.io/help-content.json';
const HELP_BASE = 'https://webeaze.io/help.html#/';   // a help article lives at HELP_BASE + slug
const REQUEST_TYPES = ['Content update', 'New page or section', 'Design change', 'SEO or metadata', 'Bug or broken element', 'Other'];

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function sendTeamEmail(subject: string, html: string) {
  if (!RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM, to: [TEAM], subject, html }),
  }).catch(() => {});
}

// ── Help knowledge base (fetched once per cold start, cached ~1h) ──
type Article = { s: string; t: string; m: string; b: string };
let _kb: Article[] | null = null;
let _kbAt = 0;
async function loadKB(): Promise<Article[]> {
  if (_kb && Date.now() - _kbAt < 3_600_000) return _kb;
  try {
    const res = await fetch(KB_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) { _kb = await res.json(); _kbAt = Date.now(); }
  } catch (_e) { /* fall back to whatever we have */ }
  return _kb || [];
}
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'is', 'are', 'do', 'does', 'can', 'i', 'my', 'you', 'your', 'how', 'what', 'it', 'on', 'in', 'with', 'me', 'we', 'our', 'if', 'so', 'that', 'this', 'be', 'get', 'have', 'will', 'about']);
function retrieve(kb: Article[], query: string, k = 4): Article[] {
  const toks = [...new Set((query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !STOP.has(t)))];
  if (!toks.length || !kb.length) return [];
  const scored = kb.map((a) => {
    const t = (a.t || '').toLowerCase(), m = (a.m || '').toLowerCase(), b = (a.b || '').toLowerCase(), slug = (a.s || '').replace(/-/g, ' ');
    let score = 0;
    for (const tok of toks) {
      if (t.includes(tok)) score += 5;
      else if (slug.includes(tok)) score += 4;
      else if (m.includes(tok)) score += 2;
      else if (b.includes(tok)) score += 1;
    }
    return { a, score };
  }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score);
  return scored.slice(0, k).map((r) => r.a);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const body = await req.json().catch(() => ({} as any));
    const message = String(body.message || '').trim();
    if (!message) return json({ ok: true, skipped: 'empty' });

    // Identify the client (their JWT). Billy may target a specific client for preview.
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const targetUserId = (body.targetUserId && user.email === 'billy@webeaze.io') ? body.targetUserId : user.id;

    const { data: c } = await service.from('clients').select('user_id, id, name, plan, site_url, email, plan_amount, billing_period, billing_label, next_billing_date, status, created_at, onboarding_step').eq('user_id', targetUserId).maybeSingle();
    if (!c) return json({ error: 'No client record' }, 404);
    const isAdvanced = /growth|elite/i.test(c.plan || '');

    // Yield only when a real human (Billy) has personally replied in THIS thread within 10 min, not
    // just because the admin tab is open. (Billy's messages are via_ai=false; the assistant's true.)
    try {
      const { data: lastTeam } = await service.from('chat_messages')
        .select('created_at, via_ai').eq('user_id', c.user_id).eq('sender', 'webeaze')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (lastTeam && lastTeam.via_ai === false && (Date.now() - new Date(lastTeam.created_at).getTime()) < 10 * 60 * 1000) {
        return json({ ok: true, yielded: true });
      }
    } catch (_e) { /* via_ai column not added yet: let the assistant reply */ }

    if (!ANTHROPIC_API_KEY) return json({ ok: true, skipped: 'no ai key' });

    const { data: reqs } = await service.from('update_requests').select('type, status').eq('user_id', c.user_id).neq('status', 'Done').order('created_at', { ascending: false }).limit(5);
    const openReqs = (reqs ?? []).map((r: any) => r.type + ' (' + r.status + ')');
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
    const isFirstMessage = history.length === 0;   // first message of a fresh conversation

    // Live performance numbers so the assistant can answer "how is my SEO / speed / traffic doing?".
    // Keyword-level detail + trend + the AI report summary are Growth/Elite features, so gate them.
    const { data: cm } = await service.from('client_metrics').select('metrics, refreshed_at').eq('user_id', c.user_id).maybeSingle();
    const met: any = (cm && cm.metrics) || {};
    const se: any = met.search || null;
    const performance: any = {
      lastUpdated: cm?.refreshed_at || null,
      siteSpeed: met.speed ? { mobileScore: met.speed.mobile?.score ?? null, desktopScore: met.speed.desktop?.score ?? null, loadsInSeconds: met.speed.mobile?.lcpSeconds ?? null } : null,
      googleReviews: met.reviews ? { rating: met.reviews.rating ?? null, reviewCount: met.reviews.count ?? null } : null,
      googleSearch: se ? { impressionsLast28Days: se.impressions ?? null, clicksLast28Days: se.clicks ?? null, clickThroughRatePct: se.ctr ?? null, averagePositionInResults: se.position ?? null } : null,
    };
    if (isAdvanced) {
      if (performance.googleSearch && se) performance.googleSearch.impressionsTrendPct = se.deltaPct ?? null;
      if (se) performance.topKeywords = (se.topQueries || []).slice(0, 8).map((q: any) => ({ term: q.query, positionOnGoogle: q.position ?? null, clicksLast28Days: q.clicks ?? null, movedSinceLast: q.change ?? null }));
      performance.latestReportSummary = met.report?.summary || null;
    }

    // Account overview + whether a real person is at the desk right now, so the assistant can speak
    // to the whole account and be honest about live availability.
    let teamOnline = false;
    try {
      const { data: pres } = await service.from('admin_presence').select('last_seen').eq('id', 'billy').maybeSingle();
      teamOnline = !!(pres?.last_seen && (Date.now() - new Date(pres.last_seen).getTime()) < 90000);
    } catch (_e) { /* no presence row */ }
    const supportOpen = typeof body.supportState === 'string' ? (body.supportState === 'open') : null;
    const { count: totalRequests } = await service.from('update_requests').select('id', { count: 'exact', head: true }).eq('user_id', c.user_id);
    const { count: completedRequests } = await service.from('update_requests').select('id', { count: 'exact', head: true }).eq('user_id', c.user_id).eq('status', 'Done');

    // Retrieve the few help articles relevant to what they are asking, and feed the AI the real text.
    const kb = await loadKB();
    const relevant = retrieve(kb, message + ' ' + history.map((h: any) => h.text || '').join(' '), 4);
    const knowledge = relevant.length
      ? relevant.map((a) => 'ARTICLE: ' + a.t + ' [slug: ' + a.s + ']\n' + a.b).join('\n\n---\n\n')
      : '(no closely matching article found)';

    const planLine = isAdvanced
      ? 'This client is on a Growth/Elite plan, so they CAN talk to a real person. If something needs a human (a judgment call, a complaint, a billing dispute, anything you cannot resolve from the knowledge), set action "escalate" and reassure them a teammate will jump in here shortly. Do not pitch upgrades to them; they are already on a top plan.'
      : [
        'This client is on the Essential plan (AI support only, no live human chat). Never promise a call or a live person.',
        'UPSELL, tastefully: your job also includes growing the client. Answer their question first and genuinely well. Then, WHEN IT NATURALLY FITS what they asked, make ONE specific, benefit-led pitch to upgrade to Growth, tied to the exact thing they raised, not a generic nag:',
        '- If they ask about keyword rankings, search trends over time, or how they compare to nearby competitors: tell them those live in the Growth report and briefly what they would see (the searches bringing them customers, where they rank and how it moves, how they stack up locally).',
        '- If they want to talk to a real person, or have a judgment call or strategy question: note that Growth adds direct access to our team by live chat, phone, and video.',
        '- If they ask how to get more customers, more leads, or how to grow: note that Growth includes a tailored action plan each month plus the deeper insights to act on.',
        'Rules for the pitch: at most once per topic (do not repeat it every message), one or two sentences, concrete and confident, never pushy or salesy, and never block their actual answer. If they show interest, you may briefly say they can upgrade any time from Account, Manage billing. If it is a concrete website change, propose it as a request (action "request") so they can confirm. If it truly needs a person, set action "escalate" (the team follows up by email).',
      ].join('\n');

    const system = [
      'You are Eaze, WebEaze\'s AI assistant. WebEaze is a website design and care service for small trade businesses (landscapers, HVAC, plumbers, contractors). You are chatting with a client inside their portal.',
      'Voice: direct and competent. No filler, no emoji, no over-apologizing. Answer first, then any needed context. Plain, everyday language, not agency-speak or jargon. Keep it short, usually 1 to 3 sentences. NEVER use em dashes.',
      (isFirstMessage ? 'This is the first message of a new conversation, so open your reply by briefly introducing yourself as Eaze, WebEaze\'s AI assistant (one short sentence), then answer.' : 'Do not reintroduce yourself; just help.'),
      'Use the KNOWLEDGE section below (WebEaze\'s real help articles) to answer questions about policies, plans, pricing, billing, cancellation, refunds, and how things work. If the answer is there, be specific and accurate, and do not contradict it. The client\'s own plan, price, and next billing date are in the account context, so you can tell them those directly.',
      'You may also answer general small-business and website questions helpfully from your own knowledge. But for anything specific to WebEaze policies, pricing, or this client\'s account that is NOT in the knowledge or context, do not guess: say you will check with the team (use "escalate") rather than invent an answer.',
      'The client\'s REAL website numbers are in ACCOUNT CONTEXT under "performance": site speed scores, Google reviews, and Google Search impressions, clicks, and average ranking' + (isAdvanced ? ', plus their top keyword positions and movement, impressions trend, and latest report summary' : '') + '. When they ask how their site, SEO, speed, traffic, reviews, or ranking is doing, answer with these real numbers and explain in plain, encouraging language what they mean (for example, a speed score of 90+ is excellent, a lower average position number is better). If a value is null, we do not have it yet, so tell them it will fill in after their next report refresh (they can tap Refresh on their report page).' + (isAdvanced ? '' : ' Keyword-level positions and trends are a Growth feature, so do not provide those; you may gently mention Growth includes them.'),
      'The overall account details are in ACCOUNT CONTEXT under "account" (status, member since, whether their website is live or still being built, and how many requests they have made and had completed). Share any of it if they ask about their account.',
      'WebEaze\'s human support hours are Monday to Friday, 9am to 5pm Eastern Time (ET). If someone asks when you are open, tell them that. Team availability is in ACCOUNT CONTEXT under "team": onlineRightNow says whether a WebEaze person is at the desk this moment, withinBusinessHours whether it is business hours. Be accurate, never claim someone is available when onlineRightNow is false.' + (isAdvanced ? ' If they want a real person and onlineRightNow is true, use "escalate" so someone jumps in; if it is false, tell them honestly the team is offline right now and offer to take a message or file their request, and it will be picked up as soon as someone is back.' : ' You are their support here; regardless of team status do not promise a live person, though you may gently note Growth adds one.'),
      'Decide exactly ONE action:',
      '- "answer": help directly, or ask a clarifying question if the request is vague.',
      '- "article": give a brief helpful answer and set article_slug to the single most relevant help article (from the knowledge or relevantArticles). Do NOT paste a link or name the article yourself; the system attaches a clickable link automatically. Use this only if an article clearly fits.',
      '- "request": ONLY when they clearly want a concrete, actionable change to their website (edit text, change hours or pricing shown on the site, add or fix a page, swap a photo, fix something broken). Provide request_type (one of: ' + REQUEST_TYPES.join(', ') + ') and request_summary (a clean one-paragraph description of exactly what they want changed, written in the client\'s own voice). Do NOT say you filed or sent it. Instead, PROPOSE it: your reply should confirm what you understood and invite them to send it, for example "Sounds like you want your hours changed to 9 to 5. Want me to send that to the team?". The client taps a button to confirm, so never claim it is already done. If ambiguous, do NOT propose; use "answer" to ask what they want.',
      '- "escalate": for complaints, billing disputes, account or strategy conversations, or anything you should not resolve yourself.',
      planLine,
      'Return ONLY valid JSON (no markdown, no code fences): {"reply": string, "action": "answer"|"article"|"request"|"escalate", "article_slug": string|null, "request_type": string|null, "request_summary": string|null}',
    ].join('\n');

    const ctx = {
      clientName: c.name || 'there',
      plan: c.plan || 'Essential',
      website: c.site_url || null,
      billing: { amount: c.plan_amount ?? null, period: c.billing_period || null, customLabel: c.billing_label || null, nextBillingDate: c.next_billing_date || null },
      account: {
        status: c.status || 'active',
        memberSince: c.created_at || null,
        websiteStatus: (c.onboarding_step == null ? 'live' : ('being built (step ' + c.onboarding_step + ' of 6)')),
        totalRequestsMade: totalRequests ?? null,
        requestsCompleted: completedRequests ?? null,
      },
      team: { onlineRightNow: teamOnline, withinBusinessHours: supportOpen },
      performance,
      openRequests: openReqs,
      relevantArticles: relevant.map((a) => ({ slug: a.s, title: a.t })),
    };
    const convo = history.map((h: any) => (h.role === 'client' ? 'Client' : 'Team') + ': ' + String(h.text || '')).join('\n');
    const userMsg = 'ACCOUNT CONTEXT:\n' + JSON.stringify(ctx, null, 2) + '\n\nKNOWLEDGE:\n' + knowledge + '\n\nCONVERSATION SO FAR:\n' + (convo ? convo + '\n' : '') + 'Client: ' + message;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!aiRes.ok) { console.error('[chat-assist] anthropic ' + aiRes.status + ': ' + (await aiRes.text()).slice(0, 200)); return json({ ok: false, error: 'ai' }, 200); }
    const aiData = await aiRes.json();
    const text = ((aiData.content && aiData.content[0] && aiData.content[0].text) || '').trim();

    // Robustly extract the JSON object even if the model wrapped it in prose or code fences, and
    // NEVER show raw JSON to the client: parse straight, then the first {...} block, then just pull
    // the "reply" value out, then a generic line as a last resort.
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* try harder */ }
    if (!parsed || typeof parsed !== 'object') {
      const obj = text.match(/\{[\s\S]*\}/);
      if (obj) { try { parsed = JSON.parse(obj[0]); } catch { /* still bad */ } }
    }
    if (!parsed || typeof parsed !== 'object') {
      const rm = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const r = rm ? rm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
      parsed = { reply: r || 'Happy to help, could you tell me a little more about what you need?', action: 'answer' };
    }

    // Strip em dashes (house rule) + fix any wrong .com email/domain, as a safety net if the model slips.
    let reply = (String(parsed.reply || '').trim().replace(/\s*—\s*/g, ', ').replace(/webeaze\.com/gi, 'webeaze.io')) || 'Happy to help with that.';
    const action = String(parsed.action || 'answer');
    let escalated = false;
    // When the client clearly wants a website change, we PROPOSE it and let them confirm with a tap.
    // We do NOT create the update_requests row here; the portal files it on confirm (which then flows
    // through the normal request pipeline, notifications and all). We only hand back the proposal.
    let proposedRequest: { type: string; notes: string } | null = null;

    if (action === 'article' && parsed.article_slug) {
      const found = kb.find((a) => a.s === parsed.article_slug) || relevant.find((a) => a.s === parsed.article_slug);
      if (found) reply += '\n\nHere is a guide that covers it: [' + found.t + '](' + HELP_BASE + found.s + ')';
    } else if (action === 'request' && parsed.request_summary) {
      const type = REQUEST_TYPES.includes(String(parsed.request_type)) ? String(parsed.request_type) : 'Content update';
      const notes = String(parsed.request_summary).slice(0, 1200);
      proposedRequest = { type, notes };
    } else if (action === 'escalate') {
      escalated = true;
      await sendTeamEmail('Chat assistant escalation from ' + (c.name || c.email || 'a client') + (isAdvanced ? '' : ' (Essential)'),
        '<p>The chat assistant handed off a conversation with <strong>' + (c.name || c.email) + '</strong> (' + (c.plan || 'Essential') + '):</p>' +
        '<blockquote style="border-left:3px solid #dc2626;padding:2px 0 2px 12px;color:#333;white-space:pre-wrap;">' + message.replace(/</g, '&lt;') + '</blockquote>' +
        '<p>Jump into the Chat tab in admin to take over.</p>');
    }

    const sessionId = String(body.sessionId || '') || null;
    const ins = await service.from('chat_messages').insert({ user_id: c.user_id, sender: 'webeaze', body: reply, session_id: sessionId, via_ai: true });
    if (ins.error) await service.from('chat_messages').insert({ user_id: c.user_id, sender: 'webeaze', body: reply, session_id: sessionId });

    return json({ ok: true, action, proposedRequest, escalated, grounded: relevant.length });
  } catch (e) {
    console.error('[chat-assist] error:', e);
    return json({ ok: false, error: String(e).slice(0, 160) }, 200);
  }
});
