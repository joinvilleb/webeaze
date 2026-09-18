// Screenshot fixture set: "Mike Reyes, Bear Carpet Cleaning", a Growth client a year in.
// This is the business the help-page and marketing screenshots show. Everything is invented.
// build-mock.js --set mike loads this before mock-inject.js; dates are relative to now so the
// home page always reads as "this month".
(function () {
  const UID = 'user-1';
  const DAY = 86400000;
  const now = Date.now();
  const ago = (d, h) => new Date(now - d * DAY - (h || 0) * 3600000).toISOString();
  const ymd = (d) => ago(d).slice(0, 10);
  window.__MOCK_EMAIL = 'mike@bearcarpetcleaning.com';

  // Leads: 14 this month-to-date-ish, 11 in the 30 days before, spread over the day.
  const LTYPES = ['form', 'call', 'form', 'email', 'call', 'booking', 'form'];
  const NAMES = ['Laura Chen', 'David Ortiz', 'Priya Patel', 'Tom Walsh', 'Angela Brooks', 'Marcus Lee', 'Sofia Ramos', 'Greg Hall', 'Nina Fischer', 'Carlos Vega', 'Emily Stone', 'Raj Mehta', 'Hannah Kim', 'Luis Moreno'];
  const MSGS = ['Hi, can I get a quote for three bedrooms and a hallway? We have a dog, so a couple of stains too.',
    'Do you clean sectional sofas? Looking for something next week.',
    'Need an area rug cleaned before a family visit on the 28th.',
    'Is pet odour removal a separate charge?'];
  const lead_events = [];
  for (let i = 0; i < 25; i++) {
    const d = i < 14 ? Math.floor(i * 0.95) : 16 + Math.floor((i - 14) * 1.3);
    const t = LTYPES[i % LTYPES.length];
    lead_events.push({ id: 'le' + i, user_id: UID, type: t, page: ['/', '/contact', '/services', '/upholstery'][i % 4],
      name: t === 'form' ? NAMES[i % NAMES.length] : null, email: t === 'form' ? NAMES[i % NAMES.length].toLowerCase().replace(' ', '.') + '@gmail.com' : null,
      phone: null, message: t === 'form' ? MSGS[i % MSGS.length] : null, target: t === 'call' ? '(305) 555-0100' : t === 'email' ? 'mike@bearcarpetcleaning.com' : null,
      device: i % 3 ? 'mobile' : 'desktop', source: ['google', 'direct', 'google', 'facebook'][i % 4],
      created_at: ago(d, 2 + (i % 7)), contacted_at: i > 3 ? ago(d, 1) : null, outcome: i > 6 && i % 3 === 0 ? 'won' : null });
  }

  const series = [];
  for (let d = 58; d >= 1; d--) {
    const base = 150 + Math.round(40 * Math.sin(d / 5)) + (58 - d) * 1.4;
    series.push({ date: ymd(d), impressions: Math.round(base), clicks: Math.max(1, Math.round(base * 0.045 + (d % 3))) });
  }
  const monthly = [];
  for (let m = 12; m >= 0; m--) {
    const dt = new Date(now); dt.setDate(1); dt.setMonth(dt.getMonth() - m);
    monthly.push({ month: dt.toISOString().slice(0, 7), impressions: 2600 + (12 - m) * 260, clicks: 110 + (12 - m) * 11 });
  }
  const checked = ago(0, 5);
  const metrics = {
    accessibility: { checkedAt: checked, issues: [], score: 96 },
    bestPractices: { checkedAt: checked, score: 100 },
    seo: { checkedAt: checked, issues: [], score: 100 },
    cwv: null,
    speed: { checkedAt: checked, desktop: { cls: 0.01, lcpSeconds: 0.9, score: 98 }, mobile: { cls: 0.02, lcpSeconds: 2.1, score: 91 } },
    pages: { checkedAt: checked, count: 8, source: 'sitemap', pages: ['/', '/services', '/upholstery', '/area-rugs', '/pet-stains', '/about', '/reviews', '/contact'] },
    reviews: { checkedAt: checked, count: 63, matched: 'Bear Carpet Cleaning', newCount: 3, placeId: 'mock', rating: 4.9, recent: [
      { author: 'Jennifer M.', id: 'rv1', rating: 5, text: 'Mike and his crew got out stains I had given up on. On time, careful with the furniture, and fair on price.', when: '2 days ago' },
      { author: 'Robert K.', id: 'rv2', rating: 5, text: 'Booked online for Saturday morning and they were done by lunch. Carpets look new.', when: '1 week ago' },
      { author: 'Alicia T.', id: 'rv3', rating: 5, text: 'Our sofa had years of dog in it. It smells like nothing now. Highly recommend.', when: '2 weeks ago' },
      { author: 'Dan P.', id: 'rv4', rating: 4, text: 'Great job on the rugs. Arrived a little late but called ahead.', when: '3 weeks ago' },
      { author: 'Maria G.', id: 'rv5', rating: 5, text: 'Friendly, fast and the results speak for themselves.', when: '1 month ago' } ] },
    search: { checkedAt: checked, clicks: 312, ctr: 4.1, deltaPct: 19, impressions: 7610, position: 9.4, property: 'sc-domain:bearcarpetcleaning.com',
      startDate: series[0].date, endDate: series[series.length - 1].date, series, monthly,
      topQueries: [
        { query: 'carpet cleaning coral gables', clicks: 64, impressions: 890, position: 3.1, change: 2 },
        { query: 'upholstery cleaning near me', clicks: 41, impressions: 1320, position: 7.8, change: 4 },
        { query: 'bear carpet cleaning', clicks: 38, impressions: 72, position: 1, change: 0 },
        { query: 'pet stain removal carpet', clicks: 22, impressions: 640, position: 8.6, change: -1 },
        { query: 'area rug cleaning miami', clicks: 17, impressions: 910, position: 12.4, change: 3 } ] },
    competitors: { category: 'Carpet cleaning service', checkedAt: checked,
      self: { name: 'Bear Carpet Cleaning', rating: 4.9, count: 63, speed: 91 },
      competitors: [ { name: 'Sunshine Steam Clean', rating: 4.6, count: 118, speed: 54 }, { name: 'Gables Carpet Pros', rating: 4.8, count: 41, speed: 72 }, { name: 'Miami Rug Masters', rating: 4.4, count: 87, speed: 63 } ] },
    opportunities: { generatedAt: checked, items: [
      { impact: 8, title: 'Add a page for area rug cleaning in Miami', why: 'People find you for "area rug cleaning miami" about 900 times a month, but you sit on page two with no page about it.', requestType: 'New page or section', requestSummary: 'Please add a page about area rug cleaning in Miami, with prices and a few photos.' },
      { impact: 7, title: 'Show your 63 reviews on the home page', why: 'You out-rate every nearby competitor, but visitors cannot see it until they reach the reviews page.', requestType: 'Content update', requestSummary: 'Please add a reviews strip with our Google rating to the home page.' } ] },
    nudges: { generatedAt: checked, month: new Date(now).toLocaleString('en-US', { month: 'long' }), items: [
      { impact: 7, title: 'Promote fall pet stain specials', why: 'Searches for pet stain removal pick up every October in your area.', requestType: 'Content update', requestSummary: 'Please add a fall pet stain special banner to the home page.' } ] },
    report: { generatedAt: checked, headline: 'Search traffic is up 19% on last month', searched: 'carpet cleaning coral gables',
      summary: 'More people are finding you on Google, mostly for upholstery and carpet cleaning in Coral Gables. Your site loads fast on phones and your rating is the best nearby.',
      recommendations: ['Add a page for area rug cleaning', 'Show your reviews on the home page', 'Ask recent customers for a Google review'] },
  };

  const needsInfo = 'Happy to build this. Could you send four or five before and after photos, and tell us roughly what you charge so we can put a starting price on the page?';
  window.__FIX_OVERRIDE = {
    clients: [
      { id: 'c1', user_id: UID, name: 'Mike Reyes', business_name: 'Bear Carpet Cleaning', email: 'mike@bearcarpetcleaning.com', plan: 'Growth', plan_amount: 149, billing_period: 'monthly', site_url: 'https://bearcarpetcleaning.com', status: 'active', onboarding_step: null, host_provider: 'Cloudflare Pages', domain_provider: 'GoDaddy', created_at: ago(390), next_billing_date: ymd(-17) },
      { id: 'c2', user_id: 'u2', name: 'Dana Wills', business_name: 'Fresh Look Interiors', email: 'dana@example.com', plan: 'Essential', plan_amount: 79, billing_period: 'monthly', site_url: 'https://freshlook.example', status: 'active', created_at: ago(200) },
    ],
    site_submissions: [{ id: 's1', user_id: UID, submitted_at: ago(380), logo_url: '',
      contact: { name: 'Mike Reyes', email: 'mike@bearcarpetcleaning.com', phone: '(305) 555-0100', business: 'Bear Carpet Cleaning', industry: 'Carpet and upholstery cleaning' },
      domain_info: { situation: 'own', access: 'credentials', existing: 'keep-content', notes: 'Domain is with GoDaddy under the business account.' },
      brand: { colors: 'Deep green and warm cream', vibes: ['friendly', 'rugged'], instagram: '@bearcarpetcleaning' },
      content: { about: 'Family run carpet and upholstery cleaning serving Coral Gables and the surrounding area since 2011.', services: 'Carpet cleaning\nUpholstery cleaning\nPet stain and odour removal\nArea rug cleaning', areas: 'Coral Gables, Coconut Grove, South Miami', hours: 'Mon to Sat, 7am to 6pm', wants: 'A booking button on every page, and a gallery of before and after photos.', inspo: '', testimonials: '', photos: [] } }],
    update_requests: [
      { id: 'q1', user_id: UID, type: 'New page or section', status: 'Needs info', notes: 'Can we add a page for upholstery cleaning with a few before and after photos?', needs_info_message: needsInfo, needs_info_at: ago(2, 3), client_reply: null, created_at: ago(3), updated_at: ago(2, 3), seen_at: ago(3) },
      { id: 'q2', user_id: UID, type: 'Content update', status: 'In progress', notes: 'Please update the hours on the contact page. We now open at 7am on Saturdays.', scheduled_for: ymd(2), created_at: ago(4, 4), updated_at: ago(1, 3), seen_at: ago(1, 3) },
      { id: 'q3', user_id: UID, type: 'Bug or broken element', status: 'Done', notes: 'The contact form on mobile was cutting off the message box.', resolution: 'We fixed the message box on mobile. It now expands as you type on every screen size.', created_at: ago(9), updated_at: ago(7), completed_at: ago(7) },
      { id: 'q4', user_id: UID, type: 'SEO or visibility', status: 'Done', notes: 'Can you make sure we show up for pet stain removal? A lot of our jobs are pets.', resolution: 'Added a Pet stain and odour removal section to your services page and updated the page titles so Google connects you with it.', created_at: ago(29), updated_at: ago(27), completed_at: ago(27) },
      { id: 'q5', user_id: UID, type: 'New page or section', status: 'Done', notes: 'We need a proper Services page that lists everything we do with prices.', resolution: 'Built the new Services page, linked it from the main menu, and added it to your sitemap so Google picks it up.', created_at: ago(48), updated_at: ago(46), completed_at: ago(46) },
    ],
    request_messages: [
      { id: 'm1', request_id: 'q1', user_id: UID, sender: 'team', body: needsInfo, created_at: ago(2, 3) },
      { id: 'm2', request_id: 'q2', user_id: UID, sender: 'client', body: 'Actually make it 6:30am on Saturdays, not 7. We start earlier in summer.', created_at: ago(0, 5) },
    ],
    request_attachments: [],
    client_notes: [
      { id: 'n1', user_id: UID, client_id: 'c1', author: 'team', note: 'Hi Mike, your new Services page is live. Send over any job photos you would like on it whenever you are ready.', attachments: null, source_message_id: null, created_at: ago(9, 5) },
      { id: 'n2', user_id: UID, client_id: 'c1', author: 'client', note: 'Here is our updated price list for the fall. The job photos are all in our shared folder: https://drive.google.com/drive/folders/bear-jobs', attachments: [{ url: 'https://example.com/note/fall-price-list.pdf', filename: 'Fall price list 2026.pdf' }], source_message_id: null, created_at: ago(8, 2) },
      { id: 'n3', user_id: UID, client_id: 'c1', author: 'client', note: 'Thanks! Also, can you help with Google reviews? A couple of customers said they could not find where to leave one.', attachments: null, source_message_id: 'client:mock1', created_at: ago(5, 6) },
      { id: 'n4', user_id: UID, client_id: 'c1', author: 'team', note: 'Yes. Here is your direct review link to share with customers: https://g.page/r/bear-carpet-cleaning/review', attachments: null, source_message_id: 'team:mock2', created_at: ago(5, 3) },
      { id: 'n5', user_id: UID, client_id: 'c1', author: 'client', note: 'Perfect, thanks. One more thing: can we put that review link on the thank you page after someone books?', attachments: null, source_message_id: null, created_at: ago(1, 6) },
    ],
    client_resources: [
      { id: 'r1', user_id: UID, label: 'Job photos', url: 'https://drive.google.com/drive/folders/bear-jobs', note: 'Before and afters from every job this year.', file_name: null, added_by: 'client', created_at: ago(8) },
      { id: 'r2', user_id: UID, label: 'Google review link', url: 'https://g.page/r/bear-carpet-cleaning/review', note: null, file_name: null, added_by: 'team', created_at: ago(5) },
    ],
    client_costs: [{ id: 'k1', user_id: UID, label: 'bearcarpetcleaning.com', kind: 'domain', provider: 'GoDaddy', cycle: 'yearly', amount: 21.99, renews_on: ymd(-60), client_visible: true }],
    client_members: [
      { id: 'mm1', owner_user_id: UID, member_user_id: UID, email: 'mike@bearcarpetcleaning.com', name: 'Mike Reyes', role: 'owner', accepted_at: ago(390) },
      { id: 'mm2', owner_user_id: UID, member_user_id: 'u9', email: 'dana@bearcarpetcleaning.com', name: 'Dana Reyes', role: 'member', accepted_at: ago(120) },
      { id: 'mm3', owner_user_id: UID, member_user_id: null, email: 'office@bearcarpetcleaning.com', name: null, role: 'member', accepted_at: null, created_at: ago(2) },
    ],
    client_metrics: [{ user_id: UID, metrics, refreshed_at: checked }],
    lead_events,
    referrals: [
      { id: 'rf1', referrer_user_id: UID, referred_name: 'Coral Gables Pool Service', status: 'Signed up', reward_amount: 149, reward_paid: true, created_at: ago(70) },
      { id: 'rf2', referrer_user_id: UID, referred_name: 'Grove Handyman Co.', status: 'Pending', reward_amount: 149, reward_paid: false, created_at: ago(6) },
    ],
    portal_updates: [
      { id: 'pu1', published: true, published_at: ago(1), tag: 'New', title: 'Messages', category: 'product', audience: 'all', body: 'Website notes is now Messages: questions, files and your email replies in one place.' },
      { id: 'pu2', published: true, published_at: ago(6), tag: 'New', title: 'Files and links for us', category: 'product', audience: 'all', body: 'Keep your photo folder, price list and logo files on your Business info page.' },
      { id: 'pu3', published: true, published_at: ago(12), tag: 'Holiday hours', title: 'We are closed Thanksgiving week', category: 'company', audience: 'all', body: 'Our team is away 26 to 28 November. Requests sent that week are picked up on the 30th.' },
    ],
    site_checks: [{ user_id: UID, is_up: true, last_checked: ago(0, 1) }],
    portal_tour: [{ user_id: UID, completed_at: ago(380) }],
    chat_messages: [], site_issues: [], notification_reads: [], support_overrides: [], social_posts: [], site_blocks: [],
  };
})();
