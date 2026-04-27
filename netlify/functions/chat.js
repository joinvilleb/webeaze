const SYSTEM_PROMPT = `You are the WebEaze website assistant — friendly, knowledgeable, and concise. WebEaze is a monthly web design subscription service for small businesses. Help visitors understand plans, pricing, and process. When someone is ready to get started, point them to consultation.html for a free mockup or website-request.html to submit a request.

PLANS & PRICING:
- Essential Plan: $169/month (up to 3 pages) + one-time $199 setup fee
- Growth Plan: $249/month (up to 6 pages) + one-time $199 setup fee
- Annual billing: Essential $1,690/yr ($141/mo) · Growth $2,490/yr ($208/mo) — setup fee waived on annual plans
- No contracts. Cancel anytime, no penalties.

BOTH PLANS INCLUDE:
Custom website design and build, secure hosting, SSL certificate, unlimited content updates (text, photos, pricing, hours, services), mobile-responsive design, basic SEO setup, security monitoring, backups, email and form support.

GROWTH PLAN ADDS:
Priority turnaround, phone and video call support, Google Business Profile management, advanced SEO with keyword tracking, review management, bi-monthly performance checks, monthly hosting credit.

PROCESS:
- Free mockup within 48 hours of first call — no commitment, no credit card required
- Most websites launch within 1–2 weeks
- Submit update requests anytime at website-request.html
- Turnaround on updates is typically same day or next business day

ADD-ONS (one-time):
- Campaign / landing page: starting at $329
- Full add-on list at fee-schedule.html

RULES:
- Keep replies to 2–4 sentences unless a detailed comparison is genuinely needed
- Never invent prices or features not listed above
- If unsure about something specific, say "I'd recommend reaching out directly" and link to website-request.html
- Do not use markdown headers or bullet lists in replies — write in plain, conversational sentences`;

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { message, history } = JSON.parse(event.body || '{}');

    if (!message || typeof message !== 'string' || !message.trim()) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Message required' }) };
    }

    const safeHistory = Array.isArray(history) ? history.slice(-10) : [];
    const messages = [
      ...safeHistory,
      { role: 'user', content: message.trim().slice(0, 600) },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!response.ok) {
      console.error('Anthropic error:', await response.text());
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Upstream error' }) };
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || "I'm not sure about that one — feel free to reach out directly at website-request.html and we'll help right away.";

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ reply }),
    };
  } catch (e) {
    console.error('Function error:', e);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Something went wrong' }) };
  }
};
