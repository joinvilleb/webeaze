const SPAM_SERVICE = /\b(seo|search engine optimi[sz]ation|digital marketing|online marketing|website (design|development|redesign)|web (design|development|developer)|app development|mobile app|social[- ]?media (marketing|management|automation)|email marketing|sms marketing|bulk (email|sms)|lead generation|lead gen|link ?building|backlinks?|guest post|ai chat ?bots?|crm|appointment setting|influencer marketing|content (creation|writing)|virtual assistants?|data entry|logo design|call[- ]?cent(er|re))\b/gi;
const SPAM_OFFER = /\b(we (offer|provide|sell|specialis[sz]e|are an? [\w ]{0,40}(company|agency|team|firm|studio))|we can (help|fix|do|handle|redesign|rebuild|build|develop|rank|boost|grow|increase|double|generate)|we help|we work with|our (agency|company|team|platform|software|system|tool|service)s?)\b/i;
// The nouns a trade customer actually types. One of these is near-proof of a real job.
const SPAM_JOB_NOUN = /\b(carpet|rug|upholstery|sofa|couch|mattress|tile|grout|roof|gutter|shingle|siding|drain|pipe|leak|boiler|furnace|hvac|ac unit|air con|plumb|electric|wiring|outlet|lawn|garden|hedge|tree|fence|deck|patio|driveway|drywall|paint|floor|window|door|basement|attic|kitchen|bathroom|bedroom|garage|showroom|office|apartment|condo|house|home|property|stain|mould|mold|damp|flood|clean|repair|install|replace|quote|estimate|job|appointment|booking)\b/i;
// A real enquiry is situated: a size, a date, a time, or a place.
const SPAM_SITUATED = /(\b\d{2,5}\s?(sq\.? ?(ft|m)|square (feet|foot|metres|meters))|\b\d+\s?(bed|bath|room|storey|story|floor)s?\b|\b(today|tomorrow|tonight|this (week|weekend|morning|afternoon|month)|next (week|month)|mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(asap|urgent|emergency|right away|as soon as)\b|\b\d{1,2}\s?(am|pm)\b)/i;
const SPAM_FIRST_PERSON = /\b(my|our|i need|i want|i'?m looking|we need|we want|we just|we have|can you|do you|could you|would you)\b/i;
// Deliberately NOT shorteners: what a phone produces when a customer shares an address, photos or
// their WhatsApp. Treating these as spam would flag exactly the customers who are trying hardest.
const SPAM_SHORTENER = /^(bit\.ly|bitly\.com|tinyurl\.com|t\.co|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly|rb\.gy|shorturl\.at|tiny\.cc|lnkd\.in|short\.io|s\.id|trib\.al|goo\.gl)$/i;
const SPAM_VENDOR_ADDR = /(seo|smm|leadgen|lead-gen|growth-?agency|digital-?marketing|web-?dev|web-?design|web-?solutions|backlink|link-?building|outreach|coldmail|mailerpro|marketingpro|app-?dev|technologies)/i;

function leadSpamCheck(l: any) {
  const msg = String((l && l.message) || '');
  const email = String((l && l.email) || '').toLowerCase();
  const name = String((l && l.name) || '');
  const low = msg.toLowerCase();
  let score = 0; const why = [];
  const add = (n, reason) => { score += n; if (n > 0) why.push(reason); };

  SPAM_SERVICE.lastIndex = 0;
  const services = [...new Set((msg.match(SPAM_SERVICE) || []).map(s => s.toLowerCase()))];
  // A message with BOTH a selling verb and a marketing service in it is talking AT the business, not
  // asking it for work. No genuine enquiry in testing had both, so this is the one place the
  // suppressors are allowed to be overruled. Without it a pitch that says "book 30+ extra JOBS a
  // month this WEEK" borrows the trade's own vocabulary and cancels its own score.
  const pitching = SPAM_OFFER.test(msg) && services.length > 0;

  // ── Suppressors. A real enquiry names a job, places it, or owns it. ──
  let suppress = 0;
  if (SPAM_JOB_NOUN.test(msg)) suppress -= 4;
  if (SPAM_SITUATED.test(msg)) suppress -= 3;
  if (SPAM_FIRST_PERSON.test(msg)) suppress -= 2;
  add(pitching ? Math.max(suppress, -2) : suppress, '');

  // ── Signals ──
  if (pitching) add(4, 'pitches a service at you');
  if (services.length >= 3) add(3, 'lists several services');

  if (/\byour (web ?site|site|business|company|page|listing)\b[^.!?]{0,60}\b(is|isn'?t|is not|does ?n'?t|could|can|should|needs to)\b[^.!?]{0,40}\b(rank|ranking|showing|appear|traffic|visible|page ?1|first page)\b/i.test(msg)
      || /\b(guarantee[ds]?|get you|put you|rank you)\b[^.!?]{0,40}\b(page ?1|first page|top of google|#1|number one)\b/i.test(msg)) {
    add(4, 'unsolicited comment on your Google ranking');
  }
  // "Do you accept bitcoin?" is a real question a real customer asks, so payment talk is carved out.
  if (/\b(crypto(currenc(y|ies))?|bitcoin|forex|binary options|trading (bot|signals)|investment opportunit(y|ies)|guaranteed (returns?|profits?|roi)|passive income|double your (money|investment)|financial freedom)\b/i.test(msg)
      && !/\b(accept|take|pay(ing)? (with|in)|payment[s]? in)\b[^.?!]{0,25}(bitcoin|crypto)/i.test(msg)) {
    add(5, 'an investment or crypto offer');
  }
  const hosts = (msg.match(/https?:\/\/([^\s/"'<>]+)/gi) || []).map(u => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase());
  if (hosts.some(h => SPAM_SHORTENER.test(h))) add(5, 'a shortened link');
  if (/(\bunsubscribe\b|opt[- ]out of (these|this|our)|\{\{?\s*(first_?name|name|company|business)\s*\}?\}|%%\w+%%|\[(first ?name|company|business)\]|view (this|it) in your browser)/i.test(msg)) {
    add(4, 'bulk-mail wording');
  }
  // "Free estimate", "free quote" and "free consultation" are what real customers ask for, so they
  // are deliberately absent from this pattern; only the sales-call vocabulary is here.
  if (/\b(are you (open to|available for|interested in)\s+(an?\s+)?(quick |short |brief )?(\d{1,2}[- ]?(minute|min)\s*)?(call|chat|demo|meeting)|\d{1,2}[- ]?(minute|min) (call|chat|demo)|hop on a (quick )?call|book a (quick )?(call|demo)|schedule a (call|demo|meeting)|no upfront (cost|fee)|pay (only )?per (booked )?(job|lead|appointment)|free (seo |website |site |marketing )?(audit|analysis|report|proposal)|risk[- ]free trial)\b/i.test(msg)) {
    add(3, 'asks you onto a sales call');
  }
  if (/((redesign|re-?design|build|develop|rebuild|revamp|create)\b[^.!?]{0,40}\b(your )?(web ?site|web ?page|app|logo|online store)\b[^.!?]{0,40}\b(for|at|from|starting at|just|only)\s*\$ ?\d{2,5})|(\$ ?\d{2,5} ?(only|usd)?[^.!?]{0,30}\b(web ?site|web ?design|app|logo)\b)/i.test(msg)) {
    add(3, 'quotes you a price for a website');
  }
  // Capped so it can never flag on its own: an interior designer or a church outreach@ address is a
  // perfectly plausible customer.
  if (email && SPAM_VENDOR_ADDR.test(email)) add(3, 'sent from a marketing address');
  const localPart = email.split('@')[0] || '';
  const domain = email.split('@')[1] || '';
  if (/^(test|testing|tester|asdf|qwerty|abc|noreply|no-reply|nobody|fake|dummy|sample)\d*$/i.test(localPart)
      || /^(test\.(com|org|net)|test|asdf\.com|qwerty\.com)$/i.test(domain)) add(3, 'a placeholder email address');
  const bare = low.replace(/[^a-z0-9]/g, '');
  if (!/\?/.test(msg) && /^(test\d*|testing|testmessage|testtest|asd+f*|qwerty\d*|abc(def)?|1234\d*|a{3,}|xyz|helloworld)$/.test(bare)) {
    add(3, 'a placeholder message');
  }
  if (/\b(viagra|cialis|xanax|tramadol|payday loans?|escort service|adult dating|porn|xxx video|webcam girls)\b/i.test(msg)) add(5, 'known spam wording');
  if (name && /\b(team|department|marketing|sales|agency|solutions|technologies)\b/i.test(name) && !SPAM_JOB_NOUN.test(msg)) add(2, 'sent by a company, not a person');

  return { score, spam: score >= 5, why: why.slice(0, 2) };
}

// Supabase Edge Function: lead-digest
// End-of-day lead summary. Runs once a day after business hours and emails each client a recap of the
// leads their website captured that day, instead of pinging them on every single lead. Every lead is
// already recorded live by track-lead and shows in the client's portal; this is the one email that says
// "here is who reached out today, follow up now." Growth/Elite clients get each lead's contact details
// and a one-tap call/reply; other plans get the count and a nudge to open their portal. A client with
// no leads that day gets no email. The email is OPT-IN: only clients who switched it on on the Leads
// page of their portal get it (public.email_prefs.lead_digest = true; no row means no email).
//
// Deploy:  supabase functions deploy lead-digest --no-verify-jwt
// Secrets: CRON_SECRET, RESEND_API_KEY  (+ the platform SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
// Schedule: see supabase/lead_digest.sql (pg_cron, daily after 5pm ET, x-cron-secret header)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const TYPE_LABEL: Record<string, string> = { form: 'form submission', call: 'phone call', email: 'email click', contact: 'quote or booking request' };

// What the leads with NO contact details actually were, in plain words.
//
// A tap on your phone number or your email link is a real lead, but it leaves us nothing to show:
// no name, no message, nothing to open in the portal. The digest used to lump these into a vague
// "N more waiting in your portal", which sent people looking for something that was not there.
// Better to say what happened and where the details live: their phone or their inbox.
const ANON_PHRASE: Record<string, (n: number) => string> = {
  call: (n) => n === 1 ? 'Someone tapped your phone number' : n + ' people tapped your phone number',
  email: (n) => n === 1 ? 'Someone clicked your email link' : n + ' people clicked your email link',
};
function anonSummary(leads: any[]): string {
  const anon = leads.filter((l: any) => !(l.name || l.email || l.phone || l.message));
  if (!anon.length) return '';
  const byType: Record<string, number> = {};
  anon.forEach((l: any) => { byType[l.type] = (byType[l.type] || 0) + 1; });
  const parts = Object.keys(byType).map((t) => {
    const n = byType[t];
    const phrase = ANON_PHRASE[t];
    return phrase ? phrase(n) : (n === 1 ? 'Someone got in touch' : n + ' people got in touch');
  });
  const tail = parts.some((x) => /phone/.test(x))
    ? ', so look for them in your call log rather than the portal.'
    : ', so there is no message to read.';
  return parts.join(' and ') + tail;
}
const plural = (n: number, w: string) => n + ' ' + w + (n === 1 ? '' : 's');

async function sendEmail(payload: Record<string, unknown>) {
  if (!RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const AI_MODEL = 'claude-sonnet-5';
const stripDash = (s: string) => String(s || '').replace(/\s*—\s*/g, ', ');

// Pre-draft a warm, ready-to-send reply for one lead, tailored to HOW it came in, so the owner can act
// straight from the email. Best-effort: returns null on any failure (the card then just shows contacts).
async function draftReply(bizName: string, lead: any): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const CHANNEL: Record<string, string> = {
    form: lead.message ? ('They sent this through the website contact form: "' + String(lead.message).slice(0, 800) + '"') : 'They submitted the website contact form but left no message.',
    call: 'They clicked to call the business from the website, so they are ready to talk.',
    email: 'They clicked to email the business from the website.',
    contact: 'They clicked to book an appointment or request a quote from the website.',
  };
  const enquiry = (lead.name ? ('Their name: ' + String(lead.name).slice(0, 80) + '\n') : '') + (CHANNEL[lead.type] || 'A customer reached out through the website.');
  const system = "You are a small trade business owner writing a warm, professional follow-up reply to a customer inquiry you just received. Thank them, acknowledge what they asked about, and move things forward with a clear next step (a quick call, a quote, or a visit). Sound like a real, friendly, confident person, not a corporate script. Keep it short and ready to send. Do NOT invent specific facts like prices or dates unless the inquiry gives them. NEVER use em dashes. Return ONLY the reply text, no subject line, preamble, or quotes.";
  const userMsg = 'Business name: ' + bizName + '\nThe customer inquiry:\n' + enquiry;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 800, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const text = (Array.isArray(d.content) ? d.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '').trim();
    return text ? stripDash(text) : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Window: the trailing 24h. The cron fires once a day, so this is exactly one day's leads with no gap
  // or overlap. An optional { hours } in the body lets a manual test widen the window.
  const body = await req.json().catch(() => ({} as any));
  const hours = Math.min(Math.max(Number(body?.hours) || 24, 1), 168);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const clientsP = service.from('clients').select('user_id, name, email, second_email, plan, status, site_url').neq('status', 'inactive');
  // Pull the window's leads with details; if the detail columns are not there yet, fall back to counts.
  let leadsR = await service.from('lead_events').select('user_id, type, page, name, email, phone, message, created_at').gte('created_at', since).order('created_at', { ascending: false });
  if (leadsR.error) leadsR = await service.from('lead_events').select('user_id, type, page, created_at').gte('created_at', since).order('created_at', { ascending: false });
  const clientsR = await clientsP;
  // Clients who switched the daily digest ON in their portal (Leads -> "Email me a daily summary").
  //
  // This is opt-IN: no row means no email. It used to be the other way round, collecting the people
  // who had opted out, which meant a client who had never heard of the feature was subscribed to it.
  // A missing table therefore now means nobody is opted in and nothing sends, which is the safe
  // direction to fail: silence is recoverable, mailing everyone who never asked is not.
  const optedIn = new Set<string>();
  {
    // digest_skip_spam is OPT-IN. Dropping a lead out of an email is the one place a wrong guess could
  // cost a real job, so a client has to ask for it. Selected defensively: the column may not exist.
  let prefsRes = await service.from('email_prefs').select('user_id, lead_digest, digest_skip_spam').eq('lead_digest', true);
  if (prefsRes.error) prefsRes = await service.from('email_prefs').select('user_id, lead_digest').eq('lead_digest', true);
  const prefs = prefsRes.data;
  const skipSpamFor = new Set((prefs ?? []).filter((p: any) => p.digest_skip_spam).map((p: any) => p.user_id));
    (prefs || []).forEach((p: any) => { if (p.user_id) optedIn.add(p.user_id); });
  }
  if (!optedIn.size) return json({ ok: true, clients: 0, note: 'nobody is opted in to the daily digest' });

  const clientBy: Record<string, any> = {};
  (clientsR.data || []).forEach((c: any) => { if (c.user_id) clientBy[c.user_id] = c; });

  // Group the window's leads by client (only active, known clients who asked for this email).
  const byClient: Record<string, any[]> = {};
  (leadsR.data || []).forEach((l: any) => {
    if (!l.user_id || !clientBy[l.user_id] || !optedIn.has(l.user_id)) return;
    (byClient[l.user_id] || (byClient[l.user_id] = [])).push(l);
  });

  const targets = Object.keys(byClient);
  if (!targets.length) return json({ ok: true, clients: 0, optedIn: optedIn.size, note: 'no leads in window' });

  let sent = 0;
  // Send in small concurrent batches so a growing client base never times out or trips Resend limits.
  const BATCH = 6;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    await Promise.all(slice.map(async (uid) => {
      const c = clientBy[uid];
      if (!c.email) return;
      let leads = byClient[uid];
      // Same scorer the portal uses, copied rather than imported: an edge function and a static HTML
      // page share no module system. If one is changed the other must be too.
      let skipped = 0;
      if (skipSpamFor.has(uid)) {
        const kept = leads.filter((l: any) => !leadSpamCheck(l).spam);
        skipped = leads.length - kept.length;
        leads = kept;
      }
      if (!leads.length) continue;   // everything today was a pitch, so there is nothing to report
      const adv = /growth|elite/i.test(String(c.plan || ''));
      const first = String(c.name || '').trim().split(/\s+/)[0] || 'there';
      const n = leads.length;

      // Summary line: count by type.
      const counts: Record<string, number> = {};
      leads.forEach((l: any) => { counts[l.type] = (counts[l.type] || 0) + 1; });
      // One sentence, not three. The subject already says "Your website got 1 lead today", the
      // headline said "You got 1 new lead today.", and then a bare fragment said "1 quote or booking
      // request." Three lines to convey one fact, the first two nearly identical.
      const parts = Object.keys(counts).map((t) => plural(counts[t], TYPE_LABEL[t] || t));
      const breakdown = parts.length > 1
        ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
        : (parts[0] || '');
      // "1 phone call" reads badly mid sentence; "a phone call" reads like a person wrote it.
      const one = breakdown.replace(/^1 /, /^[aeiou]/i.test(breakdown.slice(2)) ? 'an ' : 'a ');
      const headline = n === 1
        ? ('You got a new lead today' + (one ? ': ' + one : '') + '.')
        : ('You got ' + n + ' new leads today' + (breakdown ? ': ' + breakdown : '') + '.');

      // Growth/Elite: one card per lead with contact details, a ready-to-send AI-drafted reply, and a
      // one-tap Call / Reply now (pre-filled with the draft) so they can act straight from the email.
      let detailBlock = '';
      let contactable = 0;   // leads with a name, number, email or message: someone you can act on
      if (adv) {
        const withDetails = leads.filter((l: any) => l.name || l.email || l.phone || l.message);
        const shown = withDetails.slice(0, 20);
        contactable = shown.length;
        // Pre-draft a reply for the most recent few leads worth replying to (capped to bound cost/time).
        const toDraft = shown.filter((l: any) => l.message || l.email).slice(0, 5);
        const drafts = new Map<any, string>();
        await Promise.all(toDraft.map(async (l: any) => { const r = await draftReply(c.name || '', l); if (r) drafts.set(l, r); }));
        const btn = (href: string, label: string) => '<a href="' + href + '" style="display:inline-block;background:#7851a9;color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:8px 16px;border-radius:8px;margin:10px 8px 0 0;">' + label + '</a>';
        const cards = shown.map((l: any) => {
          const rows: string[] = [];
          if (l.name) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;">Name</td><td style="padding:4px 0;font-weight:700;font-size:14px;">' + esc(l.name) + '</td></tr>');
          if (l.phone) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;">Phone</td><td style="padding:4px 0;font-weight:700;font-size:14px;"><a href="tel:' + esc(l.phone) + '" style="color:#7851a9;text-decoration:none;">' + esc(l.phone) + '</a></td></tr>');
          if (l.email) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;">Email</td><td style="padding:4px 0;font-weight:700;font-size:14px;"><a href="mailto:' + esc(l.email) + '" style="color:#7851a9;text-decoration:none;">' + esc(l.email) + '</a></td></tr>');
          if (l.message) rows.push('<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-size:13px;vertical-align:top;">Message</td><td style="padding:4px 0;font-size:14px;">' + esc(l.message) + '</td></tr>');
          const draft = drafts.get(l);
          const draftBlock = draft
            ? '<div style="background:#ffffff;border:1px solid #ece9f4;border-radius:8px;padding:10px 12px;margin-top:10px;"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#7851a9;margin-bottom:5px;">Suggested reply, ready to send</div><div style="font-size:13px;color:#1e222b;line-height:1.55;white-space:pre-wrap;">' + esc(draft) + '</div></div>'
            : '';
          const ctas: string[] = [];
          if (l.phone) ctas.push(btn('tel:' + esc(l.phone), 'Call ' + esc(l.name || l.phone)));
          if (l.email) {
            const to = String(l.email).replace(/[<>"\s]/g, '');
            const mailto = 'mailto:' + to + '?subject=' + encodeURIComponent('Re: your inquiry') + '&amp;body=' + encodeURIComponent(draft || ('Hi ' + (l.name || 'there') + ',\n\n'));
            ctas.push(btn(mailto, draft ? 'Reply now' : 'Reply to ' + esc(l.name || l.email)));
          }
          return '<div style="background:#f7f6fb;border:1px solid #ece9f4;border-radius:10px;padding:12px 14px;margin:0 0 10px;"><table style="border-collapse:collapse;"><tbody>' + rows.join('') + '</tbody></table>' + draftBlock + '<div>' + ctas.join('') + '</div></div>';
        }).join('');
        // Leads BEYOND the 20 we showed. It used to be n - shown.length, where n is every lead and
        // shown is only the ones with contact details, so a single anonymous lead produced no card and
        // was then announced as "1 more waiting in your portal": the same lead, counted twice, in an
        // email whose whole job is to tell you how many you got.
        const moreN = withDetails.length - shown.length;
        const moreLine = moreN > 0 ? '<p style="font-size:13px;color:#6b7280;margin:2px 0 0;">And ' + moreN + ' more in your portal.</p>' : '';
        // Leads with nothing to show: someone tapped the phone number or the email link. There is no
        // card to render and nothing waiting for them in the portal either, so say what happened
        // instead of implying there is more to read.
        const anonN = n - withDetails.length;
        const anonLine = anonN > 0
          ? '<p style="font-size:14px;color:#6b7280;margin:' + (cards ? '10px' : '0') + ' 0 0;">' + anonSummary(leads) + '</p>'
          : '';
        detailBlock = cards + moreLine + anonLine;
      }

      const inner = '<p style="margin:0 0 12px;">Hi ' + esc(first) + ',</p>'
        + '<p style="margin:0 0 6px;"><strong style="font-size:17px;">' + headline + '</strong></p>'
        + detailBlock
        // Only push follow-up when there is someone to follow up WITH. Telling a client to move fast
        // on a lead that left no name and no number is advice they cannot act on, and it sends them
        // into the portal looking for contact details that were never captured.
        + (contactable > 0
            ? '<p style="margin:14px 0 16px;">The faster you follow up, the more likely you are to win the job.</p>'
            : adv
              ? '<p style="margin:14px 0 16px;">Nothing to reply to on this one, but it is a sign your site is doing its job.</p>'
              : '<p style="margin:6px 0 16px;">Open your portal to see them and follow up.</p>')
        + '<p style="margin:0 0 18px;"><a href="' + PORTAL_URL + '" style="display:inline-block;background:#7851a9;color:#fff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:9px;">Open your portal</a></p>';

      const subject = n === 1 ? 'Your website got 1 lead today' : 'Your website got ' + n + ' leads today';

      await sendEmail({
        from: FROM,
        to: [c.email, c.second_email].filter(Boolean),
        subject,
        html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e222b;line-height:1.6;max-width:520px;">'
          + inner
          + (skipped ? '<p style="color:#6b7280;font-size:12.5px;">' + skipped + ' suspected sales pitch' + (skipped === 1 ? '' : 'es') + ' left out of this email. ' + (skipped === 1 ? 'It is' : 'They are') + ' still in your portal if you want to look.</p>' : '')
          + '<p style="color:#6b7280;font-size:12.5px;border-top:1px solid #eee;padding-top:12px;margin-top:8px;">This is your daily lead summary from WebEaze. Every lead is also in <a href="' + PORTAL_URL + '" style="color:#7851a9;text-decoration:underline;">your portal</a> in real time. To stop these daily emails, open <a href="' + PORTAL_URL + '/#leads" style="color:#7851a9;text-decoration:underline;">Leads in your portal</a> and switch off the daily summary.</p>'
          + '<p style="color:#6b7280;font-size:12.5px;">The WebEaze team</p>'
          + '</div>',
      });
      sent++;
    }));
  }

  return json({ ok: true, clients: targets.length, sent, optedIn: optedIn.size });
});
