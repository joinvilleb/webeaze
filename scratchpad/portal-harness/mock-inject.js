// Fake Supabase for rendering the REAL portal/index.html and admin.html in headless Chrome.
// Every table returns its fixture (filters are ignored), writes succeed. See README.md.
(function () {
  const UID = 'user-1';
  const ADMIN = location.pathname.indexOf('admin') > -1;
  const ME = ADMIN ? { id: 'admin-1', email: 'billy@webeaze.io' } : { id: UID, email: window.__MOCK_EMAIL || 'kristen@example.com' };
  const long = 'Okay, I have several questions so I can make sure we have everything we need. 1) Do you want Precision Painting on the new flyer? 2) Is there anything you want added? 3) Anything taken off? 4) Which photos? 5) Same font as your website? 6) Should we handle printing, and how many? 7) When do you need them? 8) Where should they be delivered?';
  const FIX = {
    clients: [
      { id: 'c1', user_id: UID, name: 'Kristen Alvarez', business_name: 'Alvarez Landscaping', email: 'kristen@example.com', plan: 'Growth', plan_amount: 149, billing_period: 'monthly', site_url: 'https://alvarezlandscaping.com', status: 'active', onboarding_step: null, created_at: '2026-03-02T12:00:00Z', next_billing_date: '2026-10-02' },
      { id: 'c2', user_id: 'u2', name: 'Dennis Whitmore', business_name: 'Bear Carpet Care', email: 'dennis@example.com', plan: 'Growth', plan_amount: 149, billing_period: 'monthly', site_url: 'https://bearcarpetcare.com', status: 'active', created_at: '2025-11-02T12:00:00Z' },
      { id: 'c3', user_id: 'u3', name: 'Maria Fuentes', business_name: 'Fresh Look Interiors', email: 'maria@example.com', plan: 'Essential', plan_amount: 79, billing_period: 'monthly', site_url: 'https://freshlook.com', status: 'active', created_at: '2026-01-14T12:00:00Z' },
    ],
    site_submissions: [{ id: 's1', user_id: UID, submitted_at: '2026-03-05T12:00:00Z', logo_url: '',
      contact: { name: 'Kristen Alvarez', email: 'kristen@example.com', phone: '302 555 0134', business: 'Alvarez Landscaping', industry: 'landscaping' },
      domain_info: { situation: 'own', access: 'credentials', existing: 'keep-content', notes: '' },
      brand: { colors: 'Green and cream', vibes: ['clean'], instagram: 'instagram.com/alvarez' },
      content: { about: 'Family run landscaping.', services: 'Mowing, mulch', areas: 'Camden, Dover', hours: 'Mon to Fri 7 to 5', wants: '', inspo: '', testimonials: '', photos: [] } }],
    update_requests: [
      { id: 'q9', user_id: UID, type: 'SEO or metadata', status: 'Done', notes: 'Please add this review to my website as a testimonial: "Christi did an amazing job."', resolution: 'Added the review to your home page testimonials.', created_at: '2026-09-02T12:00:00Z', updated_at: '2026-09-08T15:00:00Z', completed_at: '2026-09-08T15:00:00Z' },
      { id: 'q1', user_id: UID, type: 'Content update', status: 'Needs info', notes: 'Hey billy, my cousin said he sent you some stuff for my flyers. I need to get new flyers asap.', needs_info_message: long, needs_info_at: '2026-09-10T14:00:00Z', created_at: '2026-09-03T12:00:00Z', updated_at: '2026-09-12T15:00:00Z' },
      { id: 'q2', user_id: UID, type: 'New page', status: 'In progress', notes: 'gallery page -remove the old images -take one picture of each service', created_at: '2026-08-28T12:00:00Z', updated_at: '2026-08-29T12:00:00Z' },
      { id: 'q7', user_id: UID, type: 'Other', status: 'In progress', addon: 'Logo Design', addon_stage: 1,
        addon_stages: ['Brief', 'Concepts', 'Your review', 'Final files'], scheduled_for: '2026-10-02',
        notes: 'Add-on purchase: Logo Design ($359 paid). Approved and paid in the portal. [invoice in_1Qtest]\n\nYour business name, exactly as it should appear\nAlvarez Landscaping LLC\n\nAny colours or styles you love, or cannot stand?\nGreens and browns. Nothing script, it never reads on a truck door.',
        created_at: '2026-09-19T12:00:00Z', updated_at: '2026-09-22T12:00:00Z' },
    ],
    request_messages: [
      { id: 'm1', request_id: 'q1', user_id: UID, sender: 'team', body: long, created_at: '2026-09-10T14:00:00Z' },
      { id: 'm2', request_id: 'q1', user_id: UID, sender: 'client', body: 'I want everything to match my webpage exactly.', created_at: '2026-09-10T16:10:00Z' },
      { id: 'm3', request_id: 'q1', user_id: UID, sender: 'team', body: 'Did you want to keep Organizing on the flyer?', created_at: '2026-09-12T09:00:00Z' },
      { id: 'm4', request_id: 'q1', user_id: UID, sender: 'client', body: 'Yes, keep organizing. Is the feather teal or black?', created_at: '2026-09-12T11:00:00Z' },
      { id: 'm5', request_id: 'q1', user_id: UID, sender: 'team', body: 'Teal feather, tri fold. Quote coming today.', created_at: '2026-09-12T15:00:00Z' },
    ],
    request_attachments: [],
    client_resources: [
      { id: 'r1', user_id: UID, label: 'Job photos, spring 2026', url: 'https://drive.google.com/drive/folders/1a2b3c', note: 'Use the Dover before and afters.', file_name: null, added_by: 'client', created_at: '2026-09-01T12:00:00Z' },
      { id: 'r2', user_id: UID, label: 'Gate code for Dover', url: null, note: '4412 then #.', file_name: null, added_by: 'team', created_at: '2026-07-11T12:00:00Z' },
    ],
    client_notes: [
      { id: 'n1', user_id: UID, client_id: 'c1', author: 'team', note: 'Hi Kristen, your new gallery page is taking shape. Send over any job photos you would like on it whenever you are ready.', attachments: null, source_message_id: null, created_at: '2026-09-04T14:00:00Z' },
      { id: 'n2', user_id: UID, client_id: 'c1', author: 'client', note: 'Here is our updated price list for the fall. The photos are all in our shared folder: https://drive.google.com/drive/folders/1a2b3c', attachments: [{ url: 'https://example.com/note/price-list-fall-2026.pdf', filename: 'Price list fall 2026.pdf' }], source_message_id: null, created_at: '2026-09-05T16:20:00Z' },
      { id: 'n3', user_id: UID, client_id: 'c1', author: 'client', note: 'Thanks! Also, can you help with Google reviews? A couple of customers said they could not find where to leave one.', attachments: null, source_message_id: 'client:18f2a', created_at: '2026-09-09T13:05:00Z' },
      { id: 'n4', user_id: UID, client_id: 'c1', author: 'team', note: 'Yes. Here is your direct review link to share with customers: https://g.page/r/alvarez-landscaping/review', attachments: null, source_message_id: 'team:18f2c', created_at: '2026-09-09T15:40:00Z' },
    ],
    client_costs: [{ id: 'k1', user_id: UID, label: 'alvarezlandscaping.com', kind: 'domain', provider: 'Cloudflare', cycle: 'yearly', amount: 14.99, renews_on: '2026-11-14', client_visible: true }],
    client_members: [
      { id: 'mm1', owner_user_id: UID, member_user_id: UID, email: 'kristen@example.com', name: 'Kristen Alvarez', role: 'owner', accepted_at: '2026-03-02T12:00:00Z' },
      { id: 'mm2', owner_user_id: UID, member_user_id: 'u9', email: 'jose@example.com', name: 'Jose Ramirez', role: 'member', accepted_at: '2026-04-01T12:00:00Z' },
    ],
    portal_updates: [
      { id: 'pu1', published: true, published_at: '2026-09-11T12:00:00Z', tag: 'New', title: 'Files and links for us', category: 'product', audience: 'all', body: 'Keep your photo folder, menu and notes on your Business info page.' },
      { id: 'pu2', published: true, published_at: '2026-09-02T12:00:00Z', tag: 'Holiday hours', title: 'We are closed Thanksgiving week', category: 'company', audience: 'all', body: 'Our team is away 26 to 28 November.' },
    ],
    lead_events: [{ id: 'le1', user_id: UID, type: 'form', created_at: '2026-09-09T12:00:00Z' }],
    addon_lead_times: [
      { addon: 'Logo Design', lead_days: 7, stages: ['Brief','Concepts','Your review','Final files'] },
      { addon: 'New Website Build', lead_days: 21, stages: ['Brief','Design','Build','Your review','Live'] },
    ],
    addon_orders: [],
    addon_prices: [
      { addon: 'New Website Build', stripe_price_id: 'price_1QaBcDeFgHiJkLmN', amount_usd: 949, invoiceable: true, lead_days: 21 },
      { addon: 'Logo Design', stripe_price_id: null, amount_usd: 359, invoiceable: true, lead_days: 7 },
      { addon: 'Remove Footer Credit', stripe_price_id: 'price_1QxYzAbCdEfGhIjK', amount_usd: 179, invoiceable: true },
      { addon: 'Booking System', stripe_price_id: null, amount_usd: 389, invoiceable: false },
      { addon: 'Additional Page', stripe_price_id: null, amount_usd: 229, invoiceable: false },
    ],
    site_issues: [], chat_messages: [], referrals: [], prospects: [], prospect_targets: [], reward_grants: [], mockups: [],
  };
  // A fixture set (see fixtures-mike.js) replaces whole tables.
  if (window.__FIX_OVERRIDE) Object.assign(FIX, window.__FIX_OVERRIDE);
  const ok = (data) => ({ data, error: null, count: Array.isArray(data) ? data.length : 0, status: 200 });
  // Filters apply only when the fixture rows carry that column, so an unmodelled filter never empties
  // a table. That keeps "this month vs last month" counts honest without modelling every query.
  function builder(table) {
    let rows = (FIX[table] || []).slice();
    let head = false;
    const self = {};
    const has = (c) => rows.length && Object.prototype.hasOwnProperty.call(rows[0], c);
    const cmp = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) ? Date.parse(v) : v;
    const filt = (c, fn) => { if (has(c)) rows = rows.filter(r => fn(cmp(r[c]))); return self; };
    self.eq = (c, v) => filt(c, x => String(x) === String(v));
    self.neq = (c, v) => filt(c, x => String(x) !== String(v));
    self.gt = (c, v) => filt(c, x => x != null && x > cmp(v));
    self.gte = (c, v) => filt(c, x => x != null && x >= cmp(v));
    self.lt = (c, v) => filt(c, x => x != null && x < cmp(v));
    self.lte = (c, v) => filt(c, x => x != null && x <= cmp(v));
    self.in = (c, v) => filt(c, x => (v || []).map(String).includes(String(x)));
    self.is = (c, v) => filt(c, x => (v === null ? x == null : x === v));
    self.order = (c, o) => { if (has(c)) { const d = (o && o.ascending === false) ? -1 : 1; rows.sort((a, b) => (cmp(a[c]) > cmp(b[c]) ? d : cmp(a[c]) < cmp(b[c]) ? -d : 0)); } return self; };
    self.limit = (n) => { rows = rows.slice(0, n); return self; };
    self.select = (_c, opts) => { if (opts && opts.head) head = true; return self; };
    ['not','or','range','contains','filter','match','ilike','like','returns','throwOnError','insert','update','upsert','delete','abortSignal'].forEach((m) => { self[m] = () => self; });
    const res = () => head ? { data: null, error: null, count: rows.length, status: 200 } : ok(rows);
    self.single = () => Promise.resolve(ok(rows[0] || null));
    self.maybeSingle = () => Promise.resolve(ok(rows[0] || null));
    self.then = (r, j) => Promise.resolve(res()).then(r, j);
    self.catch = (f) => Promise.resolve(res()).catch(f);
    return self;
  }
  const chan = { on() { return chan; }, subscribe() { return chan; }, unsubscribe() { return Promise.resolve(); } };
  const client = {
    from: builder, rpc: () => Promise.resolve(ok([])), channel: () => chan, removeChannel: () => {},
    auth: {
      getUser: () => Promise.resolve({ data: { user: ME }, error: null }),
      getSession: () => Promise.resolve({ data: { session: { user: ME, access_token: 'tok' } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: () => Promise.resolve({ error: null }), updateUser: () => Promise.resolve({ data: {}, error: null }),
      signInWithPassword: () => Promise.resolve({ data: {}, error: null }), refreshSession: () => Promise.resolve({ data: {}, error: null }),
    },
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }), getPublicUrl: (p) => ({ data: { publicUrl: 'https://example.com/' + p } }) }) },
    functions: { invoke: () => Promise.resolve({ data: {}, error: null }) },
  };
  window.supabase = { createClient: () => client };
})();
