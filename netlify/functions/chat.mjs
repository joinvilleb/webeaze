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

HELP ARTICLES — link to these using the format help.html#/slug when relevant:
- How WebEaze works → help.html#/getting-started
- Choosing a plan → help.html#/which-plan-should-i-choose
- Free mockup call → help.html#/free-mockup-call
- Not happy with your website → help.html#/not-happy-with-website
- How to request updates → help.html#/how-to-request-updates
- Turnaround times → help.html#/turnarounds-and-common-requests
- Managing your plan → help.html#/manage-your-plan
- Cancelling → help.html#/cancel-your-plan
- Money-back guarantee → help.html#/money-back-guarantee
- Discounts for nonprofits/seasonal → help.html#/discounts-nonprofits-seasonal
- What you own → help.html#/what-do-i-own
- Domain expiry → help.html#/domain-expiry
- Email hosting → help.html#/email-hosting
- How long SEO takes → help.html#/how-long-does-seo-take
- Getting more Google reviews → help.html#/get-more-google-reviews
- Landing pages for promotions → help.html#/landing-page-for-promotion
- Contact form going to spam → help.html#/contact-form-going-to-spam
- Site is down → help.html#/site-is-down
- Response times → help.html#/response-time
- Privacy policy & cookie banner → help.html#/privacy-policy-cookie-banner
- ADA accessibility → help.html#/ada-accessibility
- Full help center → help.html

KEY PAGES:
- Free mockup / get started → consultation.html
- Submit a request → website-request.html
- View pricing → pricing.html
- Add-on fees → fee-schedule.html

RULES:
- Keep replies to 2–4 sentences unless a detailed comparison is genuinely needed
- Always link to a relevant help article or page when it would help the customer
- Never invent prices or features not listed above
- If unsure, say "I'd recommend reaching out directly" and link to website-request.html
- Write in plain conversational sentences, no bullet lists, headers, or bold text`;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ok = (data) => ({
  statusCode: 200,
  headers: HEADERS,
  body: JSON.stringify(data),
});

export const handler = async (event) => {
  console.log('chat.mjs called, method:', event.httpMethod);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return ok({ error: 'POST only' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    return ok({ error: 'API key not configured — set ANTHROPIC_API_KEY in Netlify env vars and redeploy.' });
  }

  let message, history;
  try {
    ({ message, history } = JSON.parse(event.body || '{}'));
  } catch {
    return ok({ error: 'Invalid JSON body' });
  }

  if (!message?.trim()) {
    return ok({ error: 'Message required' });
  }

  const messages = [
    ...(Array.isArray(history) ? history.slice(-10) : []),
    { role: 'user', content: message.trim().slice(0, 600) },
  ];

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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

    const data = await res.json();
    console.log('Anthropic status:', res.status);

    if (!res.ok) {
      console.error('Anthropic error:', JSON.stringify(data));
      return ok({ error: 'Anthropic error: ' + (data.error?.message || res.status) });
    }

    const reply = data.content?.[0]?.text;
    return ok(reply ? { reply } : { error: 'Empty API response' });

  } catch (e) {
    console.error('Fetch failed:', e.message);
    return ok({ error: 'Fetch failed: ' + e.message });
  }
};
