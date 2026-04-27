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

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function ok(data) {
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) };
}

exports.handler = async function(event) {
  console.log('Function called, method:', event.httpMethod);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return ok({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set');
    return ok({ error: 'API key not configured — add ANTHROPIC_API_KEY in Netlify environment variables and redeploy.' });
  }

  let message, history;
  try {
    const body = JSON.parse(event.body || '{}');
    message = body.message;
    history = body.history;
  } catch (e) {
    return ok({ error: 'Invalid request body' });
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    return ok({ error: 'Message is required' });
  }

  const messages = [
    ...(Array.isArray(history) ? history.slice(-10) : []),
    { role: 'user', content: message.trim().slice(0, 600) },
  ];

  try {
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

    const data = await response.json();
    console.log('Anthropic status:', response.status);

    if (!response.ok) {
      console.error('Anthropic error:', JSON.stringify(data));
      return ok({ error: 'Anthropic API error: ' + (data.error?.message || response.status) });
    }

    const reply = data.content?.[0]?.text;
    if (!reply) {
      return ok({ error: 'Empty response from API' });
    }

    return ok({ reply });
  } catch (e) {
    console.error('Fetch error:', e.message);
    return ok({ error: 'Fetch failed: ' + e.message });
  }
};
