const SPAM_SERVICE = /\b(seo|search engine optimi[sz]ation|digital marketing|online marketing|website (design|development|redesign)|web (design|development|developer)|app development|mobile app|social[- ]?media (marketing|management|automation)|email marketing|sms marketing|bulk (email|sms)|lead generation|lead gen|link ?building|backlinks?|guest post|ai chat ?bots?|crm|appointment setting|influencer marketing|content (creation|writing)|virtual assistants?|data entry|logo design|call[- ]?cent(er|re))\b/gi;
const SPAM_OFFER = /\b(we (offer|provide|sell|specialis[sz]e|are an? [\w ]{0,40}(company|agency|team|firm|studio))|we can (help|fix|do|handle|redesign|rebuild|build|develop|rank|boost|grow|increase|double|generate)|we help|we work with|our (agency|company|team|platform|software|system|tool|service)s?)\b/i;
const SPAM_JOB_NOUN = /\b(carpet|rug|upholstery|sofa|couch|mattress|tile|grout|roof|gutter|shingle|siding|drain|pipe|leak|boiler|furnace|hvac|ac unit|air con|plumb|electric|wiring|outlet|lawn|garden|hedge|tree|fence|deck|patio|driveway|drywall|paint|floor|window|door|basement|attic|kitchen|bathroom|bedroom|garage|showroom|office|apartment|condo|house|home|property|stain|mould|mold|damp|flood|clean|repair|install|replace|quote|estimate|job|appointment|booking)\b/i;
const SPAM_SITUATED = /(\b\d{2,5}\s?(sq\.? ?(ft|m)|square (feet|foot|metres|meters))|\b\d+\s?(bed|bath|room|storey|story|floor)s?\b|\b(today|tomorrow|tonight|this (week|weekend|morning|afternoon|month)|next (week|month)|mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(asap|urgent|emergency|right away|as soon as)\b|\b\d{1,2}\s?(am|pm)\b)/i;
const SPAM_FIRST_PERSON = /\b(my|our|i need|i want|i'?m looking|we need|we want|we just|we have|can you|do you|could you|would you)\b/i;
const SPAM_BOOKING = /\b(calendly\.com|cal\.com|savvycal\.com|tidycal\.com|meetings\.hubspot\.com|koalendar\.com|zcal\.co|book(ing)?\.?(with)?me\.com|youcanbook\.me|acuityscheduling\.com\/schedule)/i;
const SPAM_SELF_PITCH = /\b(freelance[r]?|freelancing|i'?m a (writer|designer|developer|marketer|copywriter|consultant|va|virtual assistant)|looking for (new )?(work|opportunities|clients|projects|gigs)|open to (new )?(work|opportunities|projects)|my (services|rates|portfolio|availability)|hire me|take me on|years of experience (in|with|writing|designing)|decade of experience|available for (work|hire|projects))\b/i;
const SPAM_BUYING = /\b(i need|i'?d like|i want|we need|we'?d like|can you (help|build|make|do|fix|quote)|could you (help|build|make|do|fix)|how much|what do you charge|what would it cost|looking to (get|have|buy|book)|need (a|an|some)|do you (do|offer|sell|clean|fix|install|serve|take|handle))\b/i;
const SPAM_SHORTENER = /^(bit\.ly|bitly\.com|tinyurl\.com|t\.co|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly|rb\.gy|shorturl\.at|tiny\.cc|lnkd\.in|short\.io|s\.id|trib\.al|goo\.gl)$/i;
const SPAM_VENDOR_ADDR = /(seo|smm|leadgen|lead-gen|growth-?agency|digital-?marketing|web-?dev|web-?design|web-?solutions|backlink|link-?building|outreach|coldmail|mailerpro|marketingpro|app-?dev|technologies)/i;

function leadSpamCheck(l) {
  const msg = String((l && l.message) || '');
  const email = String((l && l.email) || '').toLowerCase();
  const name = String((l && l.name) || '');
  const low = msg.toLowerCase();
  let score = 0; const why = [];
  const add = (n, reason) => { score += n; if (n > 0) why.push(reason); };
  // Some signals admit no innocent reading. A crypto offer, a shortened link, pharmacy spam or a
  // link to the sender's own booking page is not a customer who happens to write in the first
  // person, so these skip the suppressors rather than being argued down by them.
  let hard = false;
  const addHard = (n, reason) => { hard = true; add(n, reason); };

  SPAM_SERVICE.lastIndex = 0;
  const services = [...new Set((msg.match(SPAM_SERVICE) || []).map(s => s.toLowerCase()))];
  // A message with BOTH a selling verb and a marketing service in it is talking AT the business, not
  // asking it for work. No genuine inquiry in testing had both, so this is the one place the
  // suppressors are allowed to be overruled. Without it a pitch that says "book 30+ extra JOBS a
  // month this WEEK" borrows the trade's own vocabulary and cancels its own score.
  const pitching = SPAM_OFFER.test(msg) && services.length > 0;

  // A pitch for the sender's own labour is written entirely in the first person ("I have nearly a
  // decade of experience", "I'm currently looking"), so first person was cancelling exactly the
  // messages it was meant to protect. It only counts as a customer signal when nobody is selling.
  // Asking for work to be done outranks describing yourself, so a tradesperson or a writer who
  // needs a website reads as the customer they are.
  const buying = SPAM_BUYING.test(msg);
  const selling = !buying && (SPAM_BOOKING.test(msg) || SPAM_SELF_PITCH.test(msg));

  // ── Suppressors. A real inquiry names a job, places it, or owns it. ──
  let suppress = 0;
  if (SPAM_JOB_NOUN.test(msg)) suppress -= 4;
  if (SPAM_SITUATED.test(msg)) suppress -= 3;
  if (SPAM_FIRST_PERSON.test(msg) && !selling) suppress -= 2;

  // ── Signals ──
  if (selling && SPAM_BOOKING.test(msg)) addHard(5, 'links to their own booking page');
  if (selling && SPAM_SELF_PITCH.test(msg)) {
    const hits = (msg.match(new RegExp(SPAM_SELF_PITCH.source, 'gi')) || []).length;
    add(hits >= 2 ? 6 : 4, 'offers you their services');
  }
  if (pitching) add(4, 'pitches a service at you');
  if (services.length >= 3) add(3, 'lists several services');

  if (/\byour (web ?site|site|business|company|page|listing)\b[^.!?]{0,60}\b(is|isn'?t|is not|does ?n'?t|could|can|should|needs to)\b[^.!?]{0,40}\b(rank|ranking|showing|appear|traffic|visible|page ?1|first page)\b/i.test(msg)
      || /\b(guarantee[ds]?|get you|put you|rank you)\b[^.!?]{0,40}\b(page ?1|first page|top of google|#1|number one)\b/i.test(msg)) {
    add(4, 'unsolicited comment on your Google ranking');
  }
  // "Do you accept bitcoin?" is a real question a real customer asks, so payment talk is carved out.
  if (/\b(crypto(currenc(y|ies))?|bitcoin|forex|binary options|trading (bot|signals)|investment opportunit(y|ies)|guaranteed (returns?|profits?|roi)|passive income|double your (money|investment)|financial freedom)\b/i.test(msg)
      && !/\b(accept|take|pay(ing)? (with|in)|payment[s]? in)\b[^.?!]{0,25}(bitcoin|crypto)/i.test(msg)) {
    addHard(5, 'an investment or crypto offer');
  }
  const hosts = (msg.match(/https?:\/\/([^\s/"'<>]+)/gi) || []).map(u => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase());
  if (hosts.some(h => SPAM_SHORTENER.test(h))) addHard(5, 'a shortened link');
  if (/(\bunsubscribe\b|opt[- ]out of (these|this|our)|\{\{?\s*(first_?name|name|company|business)\s*\}?\}|%%\w+%%|\[(first ?name|company|business)\]|view (this|it) in your browser)/i.test(msg)) {
    add(4, 'bulk-mail wording');
  }
  // "Free estimate", "free quote" and "free consultation" are what real customers ask for, so they
  // are deliberately absent from this pattern; only the sales-call vocabulary is here.
  if (/\b((are|would) you (be )?(open to|available for|interested in)\s+(an?\s+)?(quick |short |brief )?(\d{1,2}[- ]?(minute|min)\s*)?(call|chat|demo|meeting)|\d{1,2}[- ]?(minute|min) (call|chat|demo)|hop on a (quick )?call|book a (quick )?(call|demo)|schedule a (call|demo|meeting)|no upfront (cost|fee)|pay (only )?per (booked )?(job|lead|appointment)|free (seo |website |site |marketing )?(audit|analysis|report|proposal)|risk[- ]free trial)\b/i.test(msg)) {
    add(3, 'asks you onto a sales call');
  }
  if (/((redesign|re-?design|build|develop|rebuild|revamp|create)\b[^.!?]{0,40}\b(your )?(web ?sites?|web ?pages?|apps?|logos?|online stores?)\b[^.!?]{0,40}\b(for|at|from|starting at|just|only)\s*\$ ?\d{2,5})|(\$ ?\d{2,5} ?(only|usd)?[^.!?]{0,30}\b(web ?site|web ?design|app|logo)\b)/i.test(msg)) {
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
  if (/\b(viagra|cialis|xanax|tramadol|payday loans?|escort service|adult dating|porn|xxx video|webcam girls)\b/i.test(msg)) addHard(5, 'known spam wording');
  if (name && /\b(team|department|marketing|sales|agency|solutions|technologies)\b/i.test(name) && !SPAM_JOB_NOUN.test(msg)) add(2, 'sent by a company, not a person');

  // why.length is how many signals fired, because add() only records a reason for a positive one.
  // Two independent signals is its own kind of evidence: one signal beside a customer-ish phrase is
  // genuinely ambiguous, two is a pitch that happens to be politely worded.
  score += hard ? 0
    : why.length >= 2 ? Math.max(suppress, -1)
    : (pitching || selling) ? Math.max(suppress, -2)
    : suppress;

  return { score, spam: score >= 5, why: why.slice(0, 2) };
}


module.exports={leadSpamCheck};