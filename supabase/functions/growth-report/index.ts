// Supabase Edge Function: growth-report
// Powers the automatic "Growth Report" — pulls real performance/growth data for a
// client's site, stores a snapshot in `client_metrics`, and can email a summary.
//
// Two entry modes:
//   1) On-demand (client taps "Refresh" / "Email me my report" in the portal):
//      called WITH the user's JWT. Body: { action: 'refresh' | 'email' }.
//      Refreshes just that client, emails them when action === 'email'.
//   2) Monthly (pg_cron): called WITH the x-cron-secret header. Body: { mode:'monthly' }.
//      Refreshes every client with a site_url and emails each their summary.
//
// Sources (all live; each degrades to null if its key/setup is missing):
//   - speed   : Google PageSpeed Insights   (needs GOOGLE_PSI_KEY — one key, all clients)
//   - reviews : Google Places (New)          (needs GOOGLE_PLACES_KEY + clients.google_place_id, which may be a name/Maps link/Place ID)
//   - search  : Google Search Console API    (needs GSC_SERVICE_ACCOUNT + the service account added to each property)
//   - uptime  : surfaced in the portal from the existing monitor; included here if provided
//
// Deploy:  supabase functions deploy growth-report
// Secrets: RESEND_API_KEY=re_xxx  CRON_SECRET=...  GOOGLE_PSI_KEY=...  GOOGLE_PLACES_KEY=...
//          GSC_SERVICE_ACCOUNT='<the whole service-account JSON>'
// Schedule: see supabase/growth_report.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const PSI_KEY = Deno.env.get('GOOGLE_PSI_KEY') ?? '';
const PLACES_KEY = Deno.env.get('GOOGLE_PLACES_KEY') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const AI_MODEL = 'claude-sonnet-5';   // upgraded from Haiku 4.5 for richer report copy. Runs on a per-client cron fan-out (monthly), so the slightly higher latency/cost per run is fine.
const FROM = 'WebEaze <support@webeaze.io>';
const PORTAL_URL = 'https://portal.webeaze.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// The failing audits Lighthouse weights for a category (accessibility, seo, ...), as short plain
// titles a client can act on, heaviest first.
function catIssuesFrom(lh: any, key: string, max = 4): { title: string }[] {
  const cat = lh?.categories?.[key];
  const audits = lh?.audits || {};
  if (!cat || !Array.isArray(cat.auditRefs)) return [];
  return cat.auditRefs
    .filter((r: any) => (r.weight || 0) > 0 && audits[r.id] && audits[r.id].score !== null && audits[r.id].score < 1)
    .sort((a: any, b: any) => (b.weight || 0) - (a.weight || 0))
    .slice(0, max)
    .map((r: any) => ({ title: String(audits[r.id].title || '').replace(/[`\[\]]/g, '').trim() }))
    .filter((x: any) => x.title);
}
function a11yIssuesFrom(lh: any) { return catIssuesFrom(lh, 'accessibility'); }
// Real-visitor Core Web Vitals from the CrUX field data (present only when Google has enough traffic
// data for the site). Ratings map FAST/AVERAGE/SLOW to good/needs-work/poor.
function cwvFrom(d: any) {
  const le = d?.loadingExperience;
  const mets = le?.metrics; if (!mets) return null;
  const rate = (c: string) => (c === 'FAST' ? 'good' : c === 'SLOW' ? 'poor' : 'ok');
  const lcp = mets.LARGEST_CONTENTFUL_PAINT_MS, cls = mets.CUMULATIVE_LAYOUT_SHIFT_SCORE, inp = mets.INTERACTION_TO_NEXT_PAINT;
  const out: any = { overall: le.overall_category ? rate(le.overall_category) : null };
  if (lcp && lcp.percentile != null) out.lcp = { value: +(lcp.percentile / 1000).toFixed(1), unit: 's', rating: rate(lcp.category) };
  if (cls && cls.percentile != null) out.cls = { value: +(cls.percentile / 100).toFixed(2), unit: '', rating: rate(cls.category) };
  if (inp && inp.percentile != null) out.inp = { value: Math.round(inp.percentile), unit: 'ms', rating: rate(inp.category) };
  return (out.lcp || out.cls || out.inp) ? out : null;
}

// clients.site_url is typed and pasted by hand, so it arrives with stray whitespace and half-written
// protocols. Every source below used to do its own `test(url) ? url : 'https://' + url`, which turned
// a single leading space into "https:// https://site.com" and silently failed the whole refresh:
// no speed, no Search Console match, no page count, for a site that is perfectly live.
function cleanSiteUrl(raw: unknown): string {
  const v0 = String(raw ?? '').replace(/\s+/g, '');            // a URL never contains whitespace
  if (!v0) return '';
  const v = v0.replace(/^(https?):\/*/i, '$1://');
  const withProto = /^https?:\/\//i.test(v) ? v : 'https://' + v.replace(/^\/+/, '');
  try {
    const u = new URL(withProto);
    return u.hostname.indexOf('.') > 0 ? u.href : '';
  } catch { return ''; }
}

// ── Source: PageSpeed Insights (real speed + Core Web Vitals + accessibility) ──
async function pullSpeed(url: string) {
  if (!url) { console.warn('[growth] pullSpeed: no site_url'); return null; }
  if (!PSI_KEY) { console.warn('[growth] pullSpeed: GOOGLE_PSI_KEY secret is not set'); return null; }
  const full = cleanSiteUrl(url);   // PageSpeed needs a full, clean URL
  if (!full) { console.warn('[growth] pullSpeed: site_url is not a usable URL: ' + JSON.stringify(url)); return null; }
  const run = async (strategy: 'mobile' | 'desktop') => {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(full)}&strategy=${strategy}&category=performance&category=accessibility&category=seo&category=best-practices&key=${PSI_KEY}`;
    const res = await fetch(api);
    if (!res.ok) throw new Error(`PSI ${strategy} ${res.status}: ${(await res.text()).slice(0, 180)}`);
    const d = await res.json();
    const lh = d.lighthouseResult ?? {};
    // A missing performance score means Lighthouse could not analyze the page (site briefly down,
    // blocking the crawler, a redirect loop, or a timeout). Treat it as a failed pull and throw, so
    // refreshClient keeps the last good score instead of overwriting it with a fake 0.
    const perf = lh.categories?.performance?.score;
    if (perf == null) throw new Error('PSI ' + strategy + ' returned no score' + (lh.runtimeError ? ' (' + lh.runtimeError.code + ')' : ''));
    const score = Math.round(perf * 100);
    const lcp = lh.audits?.['largest-contentful-paint']?.numericValue ?? null;   // ms
    const cls = lh.audits?.['cumulative-layout-shift']?.numericValue ?? null;
    const catScore = (k: string) => (lh.categories?.[k]?.score != null ? Math.round(lh.categories[k].score * 100) : null);
    return {
      score, lcpSeconds: lcp != null ? +(lcp / 1000).toFixed(1) : null, cls: cls != null ? +cls.toFixed(3) : null,
      a11yScore: catScore('accessibility'), a11yIssues: a11yIssuesFrom(lh),
      seoScore: catScore('seo'), seoIssues: catIssuesFrom(lh, 'seo'),
      bpScore: catScore('best-practices'), cwv: cwvFrom(d),
    };
  };
  // Run each strategy INDEPENDENTLY with one retry, so a transient failure in one (desktop's Lighthouse
  // is heavier and "returns no score" more often) no longer throws away BOTH scores the way a single
  // Promise.all did. A strategy that fails both attempts comes back null; refreshClient then keeps that
  // strategy's last good score instead of blanking it.
  const runSafe = async (strategy: 'mobile' | 'desktop') => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await run(strategy); }
      catch (e) {
        console.warn('[growth] pullSpeed ' + strategy + ' attempt ' + (attempt + 1) + '/2: ' + ((e as any)?.message || e));
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));   // brief backoff, then one retry
      }
    }
    return null;
  };
  const [mobile, desktop] = await Promise.all([runSafe('mobile'), runSafe('desktop')]);
  if (!mobile && !desktop) { console.error('[growth] pullSpeed: both strategies failed for ' + full); return null; }
  const now = new Date().toISOString();
  // Accessibility / SEO / best-practices are DOM-based (same either strategy); take from whichever ran.
  const src: any = mobile || desktop;
  const accessibility = src.a11yScore != null ? { score: src.a11yScore, issues: src.a11yIssues || [], checkedAt: now } : null;
  const seo = src.seoScore != null ? { score: src.seoScore, issues: src.seoIssues || [], checkedAt: now } : null;
  const bestPractices = src.bpScore != null ? { score: src.bpScore, checkedAt: now } : null;
  const cwv = (mobile && mobile.cwv) || (desktop && desktop.cwv) || null;   // real-visitor field data
  return {
    mobile: mobile ? { score: mobile.score, lcpSeconds: mobile.lcpSeconds, cls: mobile.cls } : null,
    desktop: desktop ? { score: desktop.score, lcpSeconds: desktop.lcpSeconds, cls: desktop.cls } : null,
    accessibility, seo, bestPractices, cwv, checkedAt: now,
  };
}

// ── Source: Google reviews (needs GOOGLE_PLACES_KEY + clients.google_place_id) ──
// The stored value can be a Place ID, a Google Maps link, or just the business name —
// so admins never have to hunt for a raw ChIJ… id. A name/URL is resolved via Text Search
// (works for service-area businesses with no street address); a Place ID hits Place Details.
// The most recent Google reviews (up to 5) with their text + rating, for Review Radar. Uses the
// Places (New) `reviews` field (pricier SKU, but one call per client per refresh). Best-effort.
async function fetchRecentReviews(placeId: string): Promise<any[]> {
  if (!placeId || !PLACES_KEY) return [];
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'reviews' },
    });
    if (!res.ok) return [];
    const d = await res.json();
    const list = Array.isArray(d.reviews) ? d.reviews.slice() : [];
    // Places (New) returns reviews by relevance, not recency; sort newest-first so Review Radar
    // surfaces the actual latest review (and matches a rising review count) rather than an old one.
    list.sort((a: any, b: any) => String(b.publishTime || '').localeCompare(String(a.publishTime || '')));
    return list.slice(0, 5).map((r: any) => ({
      rating: r.rating ?? null,
      text: String((r.text && r.text.text) || (r.originalText && r.originalText.text) || '').replace(/\s+/g, ' ').slice(0, 600),
      author: (r.authorAttribution && r.authorAttribution.displayName) || 'A customer',
      when: r.publishTime || null,
      id: r.name || null,
    })).filter((x: any) => x.rating != null || x.text);
  } catch { return []; }
}
async function fetchReviewsByPlaceId(placeId: string) {
  // Places API (New) first.
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'rating,userRatingCount,displayName' },
    });
    if (res.ok) {
      const d = await res.json();
      if (d && (d.rating != null || d.userRatingCount != null)) {
        return { rating: d.rating ?? null, count: d.userRatingCount ?? null, placeId, matched: d.displayName?.text ?? null, recent: await fetchRecentReviews(placeId), checkedAt: new Date().toISOString() };
      }
    } else {
      console.warn('[growth] Places details (New) ' + res.status + ': ' + (await res.text()).slice(0, 160));
    }
  } catch (e) { console.error('[growth] Places details (New) failed:', e); }
  // Legacy Place Details fallback.
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total,name&key=${PLACES_KEY}`);
    const d = await res.json();
    if (d.result) return { rating: d.result.rating ?? null, count: d.result.user_ratings_total ?? null, placeId, matched: d.result.name ?? null, checkedAt: new Date().toISOString() };
    console.warn('[growth] Places details (legacy) status ' + (d.status || 'unknown') + ' ' + (d.error_message || ''));
  } catch (e) { console.error('[growth] Places details (legacy) failed:', e); }
  return null;
}
// Parse whatever an admin pasted for a business (a raw Place ID, a Google Maps link, or a plain name)
// into the best lookup. For a link we prefer an embedded Place ID; otherwise the business name plus
// its coordinates (the precise !3d!4d marker if present, else the @lat,lng viewport center) so the
// name search can be RESTRICTED to that spot and never drift to a same-named business elsewhere.
async function parseMapRef(raw: string): Promise<{ placeId: string | null; textQuery: string; coords: { lat: number; lng: number } | null }> {
  raw = (raw || '').trim();
  if (!raw) return { placeId: null, textQuery: '', coords: null };
  // A raw Place ID is a long, url-safe token with no spaces. Accept ANY prefix (ChIJ, GhIJ, Ei, ...),
  // not just the two most common, so service-area businesses (which often resolve to other id formats)
  // work too. We also keep the raw as a name fallback: pullReviews retries it as a text search if the
  // id does not resolve, so a spaceless business name mistaken for an id still works.
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return { placeId: raw, textQuery: raw, coords: null };
  if (!/^https?:\/\//i.test(raw)) return { placeId: null, textQuery: raw, coords: null };   // a plain name
  // A URL: expand a short share link first (it carries no name/coords until resolved).
  let url = raw;
  if (/goo\.gl\//i.test(raw)) {
    try {
      // Take the 302 Location directly (redirect: 'manual'). The new maps.app.goo.gl links redirect to
      // a clean /maps/place/Name/@lat,lng/...!3d..!4d.. URL, but a *followed* request can bounce to a
      // consent page that carries no name/coords, which is why this used to come back empty.
      const r = await fetch(raw, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
      const loc = r.headers.get('location');
      if (loc) url = loc;
      else if (r.url && r.url !== raw) url = r.url;
    } catch (e) { console.warn('[growth] could not expand short Maps link:', e); }
  }
  // Best case: an explicit Place ID in the URL. Accept place_id= AND placeid= (the "write a review"
  // link, .../writereview?placeid=ChIJ..., is the most reliable way to get a service-area business's
  // Place ID, since those never show up in the Place ID Finder).
  const pid = url.match(/place_?id[:=]([A-Za-z0-9_-]{20,})/i) || url.match(/\b((?:ChIJ|GhIJ)[A-Za-z0-9_-]{20,})\b/);
  if (pid) return { placeId: pid[1], textQuery: '', coords: null };
  // Otherwise: the business name + coordinates.
  let textQuery = '';
  const nameMatch = url.match(/\/place\/([^/@]+)/);
  if (nameMatch) textQuery = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
  if (!textQuery) { const q = url.match(/[?&]q=([^&]+)/); if (q) textQuery = decodeURIComponent(q[1].replace(/\+/g, ' ')); }
  let coords: { lat: number; lng: number } | null = null;
  const marker = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);   // the actual place marker
  if (marker) coords = { lat: parseFloat(marker[1]), lng: parseFloat(marker[2]) };
  else { const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); if (at) coords = { lat: parseFloat(at[1]), lng: parseFloat(at[2]) }; }
  return { placeId: null, textQuery, coords };
}

// Text Search (New) for a business by name. When we have coordinates, first RESTRICT the search to a
// box around them (so a same-named business in another city is excluded), then fall back to a wide
// bias so a slightly-off pin still resolves. Returns the first place (with fieldMask) or null.
async function searchTextPlace(textQuery: string, coords: { lat: number; lng: number } | null, fieldMask: string): Promise<any | null> {
  if (!textQuery || !PLACES_KEY) return null;
  const run = async (body: Record<string, unknown>) => {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': fieldMask, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn('[growth] textSearch ' + res.status + ': ' + (await res.text()).slice(0, 160)); return null; }
    const d = await res.json();
    return (d.places && d.places[0]) || null;
  };
  if (coords) {
    const pad = 0.12;   // ~13km box: excludes other cities, tolerant of an imprecise pin
    const restricted = await run({ textQuery, locationRestriction: { rectangle: { low: { latitude: coords.lat - pad, longitude: coords.lng - pad }, high: { latitude: coords.lat + pad, longitude: coords.lng + pad } } } });
    if (restricted) return restricted;
    return await run({ textQuery, locationBias: { circle: { center: { latitude: coords.lat, longitude: coords.lng }, radius: 50000 } } });
  }
  return run({ textQuery });
}

async function pullReviews(ref?: string | null) {
  const raw = (ref || '').trim();
  if (!raw) { console.warn('[growth] pullReviews: no Place ID / name set'); return null; }
  if (!PLACES_KEY) { console.warn('[growth] pullReviews: GOOGLE_PLACES_KEY secret is not set'); return null; }

  const parsed = await parseMapRef(raw);
  // 1) A direct Place ID is the most reliable path, especially for service-area businesses with no
  //    street address (text search often will not surface those).
  if (parsed.placeId) {
    const byId = await fetchReviewsByPlaceId(parsed.placeId);
    if (byId && (byId.rating != null || byId.count != null)) return byId;
    console.warn('[growth] pullReviews: Place ID "' + parsed.placeId.slice(0, 24) + '" did not resolve to a rating; trying a name search');
  }
  // 2) Fall back to a name search (covers a plain name, or a token that was not really a Place ID).
  const q = parsed.textQuery || (parsed.placeId ? '' : raw);
  if (!q) { console.warn('[growth] pullReviews: could not read a name/id from: ' + raw.slice(0, 120)); return null; }
  try {
    const p = await searchTextPlace(q, parsed.coords, 'places.id,places.displayName,places.rating,places.userRatingCount');
    if (!p) { console.warn('[growth] Places textSearch: no match for "' + q + '"'); return null; }
    console.log('[growth] reviews matched "' + q + '"' + (parsed.coords ? ' near ' + parsed.coords.lat.toFixed(3) + ',' + parsed.coords.lng.toFixed(3) : '') + ' -> ' + (p.displayName?.text || p.id) + ' (' + p.id + ')');
    return { rating: p.rating ?? null, count: p.userRatingCount ?? null, placeId: p.id, matched: p.displayName?.text ?? null, recent: await fetchRecentReviews(p.id), checkedAt: new Date().toISOString() };
  } catch (e) { console.error('[growth] Places textSearch failed:', e); return null; }
}

// ── Source: how many pages their site actually has ───────────────────────────
// So the portal can show "4 of 6 pages used" against their plan. Counted here rather than in the
// browser because a client's site is a different origin and CORS would block the fetch.
// Sitemap first (authoritative and cheap), falling back to the links on the homepage.
function normalizePageUrl(u: string, host: string): string | null {
  try {
    const p = new URL(u);
    if (p.hostname.replace(/^www\./, '') !== host) return null;         // same site only
    if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|xml|json|css|js|ico|mp4|webm)$/i.test(p.pathname)) return null;
    let path = p.pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
    if (path.length > 1) path = path.replace(/\/$/, '');
    return path || '/';
  } catch { return null; }
}
async function pullPages(siteUrl: string) {
  if (!siteUrl) return null;
  const full = cleanSiteUrl(siteUrl);
  if (!full) return null;
  let host = '';
  try { host = new URL(full).hostname.replace(/^www\./, ''); } catch { return null; }
  const found = new Set<string>();
  const get = async (u: string) => {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'WebEazeBot/1.0' }, signal: AbortSignal.timeout(9000) });
      return res.ok ? await res.text() : null;
    } catch { return null; }
  };
  // 1. Sitemaps, including one level of sitemap-index nesting.
  for (const name of ['/sitemap.xml', '/sitemap_index.xml']) {
    const xml = await get(new URL(name, full).toString());
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    const nested = locs.filter((l) => /\.xml($|\?)/i.test(l)).slice(0, 5);
    for (const l of locs) { const n = normalizePageUrl(l, host); if (n) found.add(n); }
    for (const child of nested) {
      const cx = await get(child);
      if (!cx) continue;
      for (const m of cx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) { const n = normalizePageUrl(m[1], host); if (n) found.add(n); }
    }
    if (found.size) break;
  }
  // 2. No usable sitemap: read the links on the homepage instead. Undercounts pages that are not
  //    linked from the nav, which is why the portal calls this a best-effort count.
  let source = 'sitemap';
  if (!found.size) {
    source = 'homepage';
    const html = await get(full);
    if (html) {
      for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
        let raw = m[1];
        if (/^(mailto:|tel:|javascript:)/i.test(raw)) continue;
        try { raw = new URL(raw, full).toString(); } catch { continue; }
        const n = normalizePageUrl(raw, host);
        if (n) found.add(n);
      }
    }
  }
  if (!found.size) return null;
  const list = [...found].sort();
  return { count: list.length, pages: list.slice(0, 40), source, checkedAt: new Date().toISOString() };
}

// ── Source: local competitor benchmark (public Places data only) ──────────────
// Resolves the client's own listing (location + category), finds nearby businesses in the
// SAME category, and compares on what is publicly available: Google rating, review count, and
// mobile site speed. Search Console visibility is private per-owner, so it is not compared.
// Best-effort: returns null (feature simply hides) if we cannot resolve the client's place.

// Mobile-only PageSpeed score for a single URL (used for competitor sites; cheaper than the
// full mobile+desktop pull). Returns a 0-100 number or null.
async function pullSpeedScore(url: string): Promise<number | null> {
  if (!url || !PSI_KEY) return null;
  const full = cleanSiteUrl(url);
  if (!full) return null;
  try {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(full)}&strategy=mobile&category=performance&key=${PSI_KEY}`;
    const res = await fetch(api);
    if (!res.ok) return null;
    const d = await res.json();
    const score = d.lighthouseResult?.categories?.performance?.score;
    return score != null ? Math.round(score * 100) : null;
  } catch { return null; }
}

// Resolve the client's own place WITH location + category (a fuller field set than pullReviews).
async function resolveSelfPlace(ref: string): Promise<{ placeId: string; name: string; rating: number | null; count: number | null; lat: number; lng: number; type: string | null; category: string | null } | null> {
  const raw = (ref || '').trim();
  if (!raw || !PLACES_KEY) return null;
  const fromPlace = (p: any): any => {
    const loc = p.location || {};
    if (loc.latitude == null || loc.longitude == null) return null;
    return { placeId: p.id, name: p.displayName?.text ?? null, rating: p.rating ?? null, count: p.userRatingCount ?? null, lat: loc.latitude, lng: loc.longitude, type: p.primaryType ?? null, category: p.primaryTypeDisplayName?.text ?? null };
  };
  const parsed = await parseMapRef(raw);
  // Raw / embedded Place ID → Place Details (the fuller field set with location + category).
  if (parsed.placeId) {
    try {
      const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(parsed.placeId)}`, {
        headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,location,primaryType,primaryTypeDisplayName' },
      });
      if (res.ok) return fromPlace(await res.json());
    } catch (e) { console.error('[growth] resolveSelfPlace details failed:', e); }
    return null;
  }
  if (!parsed.textQuery) return null;
  // Name (+ coords from a link) → restricted-then-biased Text Search, same as pullReviews.
  try {
    const p = await searchTextPlace(parsed.textQuery, parsed.coords, 'places.id,places.displayName,places.rating,places.userRatingCount,places.location,places.primaryType,places.primaryTypeDisplayName');
    return p ? fromPlace(p) : null;
  } catch (e) { console.error('[growth] resolveSelfPlace failed:', e); return null; }
}

async function pullCompetitors(ref?: string | null, selfSpeedScore?: number | null) {
  const self = await resolveSelfPlace(ref || '');
  if (!self || !self.type) { console.warn('[growth] pullCompetitors: could not resolve client place/category'); return null; }
  // Nearby businesses in the SAME category, within ~16km, most prominent first.
  let places: any[] = [];
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.location', 'Content-Type': 'application/json' },
      body: JSON.stringify({ includedTypes: [self.type], maxResultCount: 20, rankPreference: 'POPULARITY', locationRestriction: { circle: { center: { latitude: self.lat, longitude: self.lng }, radius: 16000 } } }),
    });
    if (!res.ok) { console.warn('[growth] pullCompetitors nearby ' + res.status + ': ' + (await res.text()).slice(0, 160)); return null; }
    const d = await res.json();
    places = d.places || [];
  } catch (e) { console.error('[growth] pullCompetitors nearby failed:', e); return null; }

  // Drop the client's own listing + any with no reviews, keep the 3 with the most reviews.
  const rivals = places
    .filter((p) => p.id !== self.placeId && p.userRatingCount != null && p.rating != null)
    .sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0))
    .slice(0, 3);
  if (!rivals.length) { console.warn('[growth] pullCompetitors: no rivals found for ' + self.type); return null; }

  // Best-effort mobile speed for each rival with a website (parallel, capped at 3).
  const competitors = await Promise.all(rivals.map(async (p) => ({
    name: p.displayName?.text ?? 'A nearby business',
    rating: p.rating ?? null,
    count: p.userRatingCount ?? null,
    speed: p.websiteUri ? await pullSpeedScore(p.websiteUri) : null,
  })));

  return {
    category: self.category || null,
    self: { name: self.name, rating: self.rating, count: self.count, speed: selfSpeedScore ?? null },
    competitors,
    checkedAt: new Date().toISOString(),
  };
}

// ── Source: Search Console real numbers (needs a service account added to each property) ──
// Auth is server-to-server: sign a JWT with the service account key, exchange it for an
// access token, then query searchAnalytics for the last 28 days.
function b64url(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
let _gscToken: { token: string; exp: number } | null = null;
async function getGscAccessToken(): Promise<string | null> {
  const raw = Deno.env.get('GSC_SERVICE_ACCOUNT') ?? '';
  if (!raw) { console.warn('[growth] GSC_SERVICE_ACCOUNT secret is not set'); return null; }
  const now = Math.floor(Date.now() / 1000);
  if (_gscToken && _gscToken.exp > now + 60) return _gscToken.token;
  let sa: { client_email?: string; private_key?: string };
  try { sa = JSON.parse(raw); } catch { console.error('[growth] GSC_SERVICE_ACCOUNT is not valid JSON'); return null; }
  if (!sa.client_email || !sa.private_key) { console.error('[growth] GSC_SERVICE_ACCOUNT missing client_email/private_key'); return null; }
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' +
    enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  try {
    const key = await importPkcs8(sa.private_key);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const jwt = unsigned + '.' + b64url(new Uint8Array(sig));
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
    });
    if (!res.ok) { console.error('[growth] GSC token ' + res.status + ': ' + (await res.text()).slice(0, 160)); return null; }
    const tok = await res.json();
    _gscToken = { token: tok.access_token, exp: now + (tok.expires_in || 3600) };
    return _gscToken.token;
  } catch (e) { console.error('[growth] GSC token signing failed:', e); return null; }
}
async function pullSearch(siteUrl: string) {
  if (!siteUrl) return null;
  const token = await getGscAccessToken();
  if (!token) return null;
  const clean = cleanSiteUrl(siteUrl);
  if (!clean) { console.warn('[growth] pullSearch: site_url is not a usable URL: ' + JSON.stringify(siteUrl)); return null; }
  const host = new URL(clean).hostname.replace(/^www\./, '');
  // Try each way the property might be registered in Search Console.
  const candidates = ['sc-domain:' + host, 'https://' + host + '/', 'https://www.' + host + '/', 'http://' + host + '/'];
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const endDate = fmt(new Date());
  const startDate = fmt(new Date(Date.now() - 60 * 24 * 3600 * 1000));   // ~2 months, so the trend chart looks full
  const query = (prop: string, body: unknown) => fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(prop)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // 1) Find an accessible property + its 28-day totals.
  let found: { prop: string; row: any } | null = null;
  for (const prop of candidates) {
    try {
      const res = await query(prop, { startDate, endDate, dimensions: [], rowLimit: 1 });
      if (res.status === 403 || res.status === 404) continue; // service account not on this property
      if (!res.ok) { console.warn('[growth] GSC query ' + res.status + ' (' + prop + '): ' + (await res.text()).slice(0, 120)); continue; }
      const d = await res.json();
      found = { prop, row: (d.rows && d.rows[0]) || null };
      break;
    } catch (e) { console.error('[growth] GSC query failed (' + prop + '):', e); }
  }
  if (!found) { console.warn('[growth] GSC: no accessible property matched ' + host); return null; }

  const r = found.row || {};
  const out: Record<string, unknown> = {
    clicks: Math.round(r.clicks || 0), impressions: Math.round(r.impressions || 0),
    ctr: r.ctr != null ? +(r.ctr * 100).toFixed(1) : (r.impressions != null ? 0 : null),
    position: r.position != null ? +r.position.toFixed(1) : null,
    property: found.prop, startDate, endDate, checkedAt: new Date().toISOString(),
  };

  // 2) Daily series for the trend chart (+ a first-half/second-half delta).
  try {
    const res = await query(found.prop, { startDate, endDate, dimensions: ['date'], rowLimit: 500 });
    if (res.ok) {
      const d = await res.json();
      const rows = (d.rows || []).map((x: any) => ({ date: x.keys[0], clicks: Math.round(x.clicks || 0), impressions: Math.round(x.impressions || 0) }));
      out.series = rows;
      if (rows.length >= 8) {
        const half = Math.floor(rows.length / 2);
        const sum = (a: any[]) => a.reduce((t, p) => t + p.impressions, 0);
        const first = sum(rows.slice(0, half)), second = sum(rows.slice(half));
        if (first > 0) out.deltaPct = Math.round(((second - first) / first) * 100);
      }
    } else {
      console.warn('[growth] GSC series ' + res.status + ' (' + found.prop + ')');
    }
  } catch (e) { console.error('[growth] GSC series failed:', e); }

  // 3) A month-by-month rollup of the last 12 months, for the year-in-review section.
  //
  // Deliberately SEPARATE from the 60-day series above rather than widening it. The report's trend
  // chart is built for ~60 daily points; handing it 365 would squash it into noise and bloat the
  // metrics jsonb for a chart nobody asked to change. Twelve monthly totals is the whole year in
  // twelve rows, which is what a recap needs and all it needs. Search Console keeps 16 months, so
  // this is real history rather than something we have to start collecting now and show next year.
  try {
    const yStart = fmt(new Date(Date.now() - 365 * 24 * 3600 * 1000));
    const res = await query(found.prop, { startDate: yStart, endDate, dimensions: ['date'], rowLimit: 400 });
    if (res.ok) {
      const d = await res.json();
      const by: Record<string, { impressions: number; clicks: number }> = {};
      for (const x of (d.rows || [])) {
        const month = String(x.keys[0]).slice(0, 7);   // YYYY-MM
        const m = by[month] || (by[month] = { impressions: 0, clicks: 0 });
        m.impressions += x.impressions || 0;
        m.clicks += x.clicks || 0;
      }
      out.monthly = Object.keys(by).sort().map((month) => ({
        month, impressions: Math.round(by[month].impressions), clicks: Math.round(by[month].clicks),
      }));
    } else {
      console.warn('[growth] GSC monthly ' + res.status + ' (' + found.prop + ')');
    }
  } catch (e) { console.error('[growth] GSC monthly failed:', e); }

  // 4) Top search terms people used to find them (for "what was searched").
  try {
    const res = await query(found.prop, { startDate, endDate, dimensions: ['query'], rowLimit: 8 });
    if (res.ok) {
      const d = await res.json();
      out.topQueries = (d.rows || []).map((x: any) => ({ query: x.keys[0], clicks: Math.round(x.clicks || 0), impressions: Math.round(x.impressions || 0), position: x.position != null ? +x.position.toFixed(1) : null }));
    }
  } catch (e) { console.error('[growth] GSC top queries failed:', e); }

  return out;
}

// ── AI: turn the raw metrics into a warm, plain-English report for the owner ──
async function generateSummary(c: { site_url?: string; name?: string }, metrics: any, bizType: string | null = null) {
  if (!ANTHROPIC_API_KEY) { console.warn('[growth] ANTHROPIC_API_KEY not set — skipping AI summary'); return null; }
  const s = metrics.speed, r = metrics.reviews, se = metrics.search;
  const facts = {
    // business_name is the COMPANY; c.name is the person we greet. Passing the person made the AI
    // write about "Dave Cohen" as though that were the business, and infer a trade from a human name.
    business: c.business_name || c.name || '', site: c.site_url || '', businessType: bizType || null,
    speedMobile: s?.mobile?.score ?? null, speedDesktop: s?.desktop?.score ?? null,
    googleRating: r?.rating ?? null, reviewCount: r?.count ?? null,
    searchClicks: se?.clicks ?? null, searchImpressions: se?.impressions ?? null,
    avgPosition: se?.position ?? null, clickThroughRatePct: se?.ctr ?? null,
    impressionsTrendPct: se?.deltaPct ?? null,
    topSearches: (se?.topQueries || []).map((q: any) => q.query).slice(0, 5),
  };
  const system = "You are the account team at WebEaze, a friendly web design and website-care service for small businesses. Write a short, warm, plain-English report for the business owner about how their website is doing. Talk to them directly (\"your site\"), no jargon, encouraging but honest. NEVER use em dashes. Only reference numbers that are provided (nulls mean not available) and never invent data. Return ONLY valid JSON (no markdown, no code fences) with keys: headline (a short upbeat phrase, max 8 words, written in sentence case: capitalize only the first word and any proper nouns like Google, not every word), summary (2 to 3 sentences on what has been happening), searched (one friendly sentence about what people searched to find them, or null if topSearches is empty), recommendations (array of 1 to 3 short, specific, non-technical suggestions we could do for them). Tailor the summary, and especially each recommendation, to the exact kind of business shown in businessType; if businessType is null, infer the trade from the business name, website and topSearches. Every recommendation must be specific to that trade, the kind of thing only that type of business would be told, never generic advice that could apply to anyone.";
  const userMsg = 'Latest data:\n' + JSON.stringify(facts, null, 2);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) { console.error('[growth] Anthropic ' + res.status + ': ' + (await res.text()).slice(0, 200)); return null; }
    const d = await res.json();
    let text = (Array.isArray(d.content) ? d.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '');
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const p = JSON.parse(text);
    return {
      headline: String(p.headline || '').slice(0, 80),
      summary: String(p.summary || ''),
      searched: p.searched ? String(p.searched) : null,
      recommendations: Array.isArray(p.recommendations) ? p.recommendations.map((x: unknown) => String(x)).slice(0, 3) : [],
      generatedAt: new Date().toISOString(),
    };
  } catch (e) { console.error('[growth] AI summary failed:', e); return null; }
}

// ── AI: turn Search Console "near-win" keywords into concrete growth opportunities ──
// Queries already ranking on the edge of page 1 (positions ~4 to 20) with real impressions are the
// cheapest wins. We hand those to the model and get back 2 to 4 plain-English opportunities, each
// with a ready-to-file request so the client can act in one tap. Growth/Elite only.
async function generateOpportunities(c: { site_url?: string; name?: string }, metrics: any, bizType: string | null = null) {
  if (!ANTHROPIC_API_KEY) return null;
  const se = metrics.search;
  if (!se || !Array.isArray(se.topQueries) || !se.topQueries.length) return null;
  const nearWins = se.topQueries
    .filter((q: any) => q && q.position != null && q.position >= 4 && q.position <= 20 && (q.impressions || 0) > 0)
    .sort((a: any, b: any) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, 6)
    .map((q: any) => ({ term: q.query, position: q.position, impressions: q.impressions, clicks: q.clicks }));
  if (!nearWins.length) return null;
  const system = "You are the growth team at WebEaze, a website care service for small trade businesses. You are given a client's Google Search 'near-win' keywords: searches where they already rank on the edge of page one with real search demand. Turn them into concrete growth opportunities we could do for them to win more customers. Be specific, framed as an action WE take (for example a focused service page, or beefing up an existing page). Write the 'why' in PLAIN everyday language a busy business owner gets in one read: name the actual search phrase in quotes and say something like 'people are searching for this and finding you, but not quite landing on the right page.' AVOID jargon and numbers like impressions, clicks, CTR, conversion, or position 4 to 5. Keep each 'why' to one clear sentence, enough that they understand it, not a data dump. NEVER use em dashes. HOW MANY: return 1 to 3 opportunities, and only ones that are GENUINELY DIFFERENT PIECES OF WORK. Fewer is much better than repetitive. Several keywords that are variations on one theme (the same service, the same town, the same intent) are ONE opportunity, not several: do not split 'build a page for X', 'improve local SEO for X' and 'add a service area section for X' into separate items, pick the single strongest version and fold the rest into it. If the keywords only support one real idea, return exactly one. Return ONLY valid JSON (no markdown, no code fences): an array of objects with keys: title (short action, max 8 words), why (one plain sentence naming the search phrase), impact (integer 1 to 10, how much new business this would realistically win, used to decide which single one we show first), requestType (exactly one of: Content update, New page or section, SEO or visibility, Other), requestSummary (a clear description of the change for our team to action). Tailor every opportunity to this exact type of business: use the Business type given, or if it is missing infer the trade from the business name, site and the search phrases themselves. Never suggest anything generic that could apply to any business.";
  const userMsg = 'Business: ' + (c.business_name || c.name || '') + '\nSite: ' + (c.site_url || '') + (bizType ? '\nBusiness type: ' + bizType : '') + '\nNear-win keywords:\n' + JSON.stringify(nearWins, null, 2);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 2500, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) { console.error('[growth] opportunities ' + res.status); return null; }
    const d = await res.json();
    let text = (Array.isArray(d.content) ? d.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '');
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return null;
    const TYPES = ['Content update', 'New page or section', 'SEO or visibility', 'Other'];
    const items = arr.slice(0, 3).map((o: any) => ({
      title: String(o.title || '').slice(0, 90),
      why: String(o.why || '').slice(0, 240),
      // Drives which single suggestion the portal puts in front of the client first.
      impact: Math.min(10, Math.max(1, Math.round(Number(o.impact)) || 5)),
      requestType: TYPES.includes(String(o.requestType)) ? String(o.requestType) : 'SEO or visibility',
      requestSummary: String(o.requestSummary || '').slice(0, 600),
    })).filter((o: any) => o.title && o.requestSummary);
    return items.length ? { items, generatedAt: new Date().toISOString() } : null;
  } catch (e) { console.error('[growth] opportunities failed:', e); return null; }
}

// ── AI: proactive, seasonal "timely ideas" for the client's site, as one-tap requests ──
// Not keyword-based (so it works for every plan): the current month + their trade, turned into 1-2
// timely improvements we could make right now to win more work.
async function generateNudges(c: { site_url?: string; name?: string }, refDate: Date, bizType: string | null = null, topSearches: string[] = []) {
  if (!ANTHROPIC_API_KEY) return null;
  const monthName = refDate.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const system = "You are the proactive growth team at WebEaze for a small trade business. Given the business and the current month, suggest 1 to 2 TIMELY, seasonal improvements we could make to their website right now to win more work (a seasonal promo banner, a holiday hours note, highlighting a service that is in demand this time of year, and so on). Concrete and specific to the season and their trade, not generic. NEVER use em dashes. Return ONLY valid JSON (no markdown, no code fences): an array of objects with keys: title (short, max 8 words), why (one sentence that references the season or month), impact (integer 1 to 10, how much new business this would realistically win, used to decide which single one we show first), requestType (exactly one of: Content update, New page or section, SEO or visibility, Other), requestSummary (a clear description of the change for our team). Use the Business type given; if it is missing, infer the exact trade from the business name, website and the searches people use to find them. Every idea must fit that specific trade and the current season, never generic.";
  const userMsg = 'Business: ' + (c.business_name || c.name || '') + '\nSite: ' + (c.site_url || '') + (bizType ? '\nBusiness type: ' + bizType : '') + (topSearches.length ? '\nSearches people use to find them: ' + topSearches.join(', ') : '') + '\nCurrent month: ' + monthName + '\nSuggest timely, seasonal website improvements specific to this exact trade.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) { console.error('[growth] nudges ' + res.status); return null; }
    const d = await res.json();
    let text = (Array.isArray(d.content) ? d.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '');
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return null;
    const TYPES = ['Content update', 'New page or section', 'SEO or visibility', 'Other'];
    const items = arr.slice(0, 2).map((o: any) => ({
      title: String(o.title || '').slice(0, 90),
      why: String(o.why || '').slice(0, 240),
      // Same 1-10 scale the opportunities carry, so the portal can rank one merged queue.
      impact: Math.min(10, Math.max(1, Math.round(Number(o.impact)) || 5)),
      requestType: TYPES.includes(String(o.requestType)) ? String(o.requestType) : 'Content update',
      requestSummary: String(o.requestSummary || '').slice(0, 600),
    })).filter((o: any) => o.title && o.requestSummary);
    return items.length ? { items, month: monthName, generatedAt: new Date().toISOString() } : null;
  } catch (e) { console.error('[growth] nudges failed:', e); return null; }
}

// `diag`, when passed, records which sources actually returned FRESH data on this run. Every source
// here degrades to the previous snapshot on failure, which is what keeps the portal from blanking —
// but it also means a refresh that pulled nothing looks identical to one that worked. The caller uses
// diag to tell the client which specific source is not set up, instead of a blank "Report refreshed".
async function refreshClient(
  sb: any,
  c: { user_id: string; id?: string; site_url?: string; google_place_id?: string | null; plan?: string },
  diag?: Record<string, boolean>,
) {
  const url = c.site_url || '';
  // Search joins the first wave: it talks to a different API and depends on nothing here. Running it
  // after the others was pure dead time on a function that already times out on the interactive
  // Refresh button (504 at the gateway).
  const [speed, reviews, search, pages] = await Promise.all([
    pullSpeed(url),
    pullReviews(c.google_place_id),
    pullSearch(url),
    pullPages(url),
  ]);
  // Competitors genuinely has to wait: the self row reuses the client's own mobile speed score.
  const competitors = await pullCompetitors(c.google_place_id, speed?.mobile?.score ?? null);
  if (diag) {
    diag.speed = !!(speed && (speed.mobile || speed.desktop));
    diag.reviews = !!reviews;
    diag.search = !!search;
    diag.competitors = !!competitors;
    diag.pages = !!pages;
  }
  // Merge with the last snapshot: if a source momentarily fails or isn't set up yet, keep its
  // previous value instead of overwriting good numbers with null (which would blank the portal
  // and send a text-only email).
  const { data: prev } = await sb.from('client_metrics').select('metrics').eq('user_id', c.user_id).maybeSingle();
  const old = (prev && prev.metrics) || {};
  // Lift the Lighthouse category scores out of the speed object so they live at the top level (and
  // aren't stored twice); keep each previous snapshot if this pull didn't produce a fresh one.
  const sp = speed as any;
  const accessibility = (sp && sp.accessibility) || null;
  const seo = (sp && sp.seo) || null;
  const bestPractices = (sp && sp.bestPractices) || null;
  const cwv = (sp && sp.cwv) || null;
  if (sp) { delete sp.accessibility; delete sp.seo; delete sp.bestPractices; delete sp.cwv; }
  const metrics: Record<string, unknown> = {
    // Field-level merge: if only one strategy came back this run, keep the other strategy's last good
    // score rather than replacing the whole speed object and blanking it.
    speed: sp ? {
      mobile:  (sp.mobile  && sp.mobile.score  != null) ? sp.mobile  : ((old.speed && old.speed.mobile)  || null),
      desktop: (sp.desktop && sp.desktop.score != null) ? sp.desktop : ((old.speed && old.speed.desktop) || null),
      checkedAt: sp.checkedAt,
    } : (old.speed ?? null),
    accessibility: accessibility ?? old.accessibility ?? null,
    seo: seo ?? old.seo ?? null,
    bestPractices: bestPractices ?? old.bestPractices ?? null,
    cwv: cwv ?? old.cwv ?? null,
    reviews: reviews ?? old.reviews ?? null,
    search: search ?? old.search ?? null,
    competitors: competitors ?? old.competitors ?? null,
    pages: pages ?? old.pages ?? null,
  };
  // Review Radar: how many reviews are new since the last snapshot (0 on the first-ever pull).
  const rv: any = metrics.reviews;
  if (rv && rv.count != null) {
    const prevCount = old.reviews && old.reviews.count;
    rv.newCount = (prevCount != null) ? Math.max(0, rv.count - prevCount) : 0;
    // The legacy Places fallback returns no recent-reviews array; keep the last known set so Review
    // Radar doesn't disappear on a transient miss from the primary (New) Places call.
    if ((!rv.recent || !rv.recent.length) && old.reviews && old.reviews.recent) rv.recent = old.reviews.recent;
  }
  // Keyword movement: compare each tracked query's position to the previous snapshot
  // (positive change = moved up, since a lower position number is better).
  const newKw = (metrics.search as any)?.topQueries as any[] | undefined;
  const oldKw = (old.search?.topQueries as any[]) || [];
  if (Array.isArray(newKw)) {
    const prevPos: Record<string, number> = {};
    for (const k of oldKw) { if (k && k.query != null && k.position != null) prevPos[k.query] = k.position; }
    for (const k of newKw) {
      if (k && k.query != null && k.position != null && prevPos[k.query] != null) k.change = +(prevPos[k.query] - k.position).toFixed(1);
      else if (k) k.change = null;
    }
  }
  // The client's trade (from their Google listing) + the real searches people use to find them.
  // Passed into every AI generator so recommendations, opportunities and timely ideas are specific
  // to THIS type of business, not generic advice that could apply to anyone.
  const bizType = ((metrics.competitors as any)?.category) || null;
  const topSearches = (((metrics.search as any)?.topQueries) || []).map((q: any) => q && q.query).filter(Boolean).slice(0, 6);
  // The three AI passes all read the finished `metrics` above and nothing from each other, so run
  // them together. In series with claude-sonnet-5 they were the bulk of the wall clock and pushed
  // the on-demand refresh past the gateway timeout. Each still keeps its previous value on failure.
  const adv = /growth|elite/i.test(c.plan || '');
  const [aiReport, aiOpportunities, aiNudges] = await Promise.all([
    generateSummary(c, metrics, bizType),
    adv ? generateOpportunities(c, metrics, bizType) : Promise.resolve(null),
    generateNudges(c, new Date(), bizType, topSearches),
  ]);
  metrics.report = aiReport ?? old.report ?? null;
  metrics.opportunities = adv ? (aiOpportunities ?? old.opportunities ?? null) : (old.opportunities ?? null);
  metrics.nudges = aiNudges ?? old.nudges ?? null;
  await sb.from('client_metrics').upsert({
    user_id: c.user_id, client_id: c.id ?? null, site_url: url,
    metrics, refreshed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  return metrics;
}

async function sendEmail(payload: Record<string, unknown>) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

// A plain, personal email, as if a real person on the team wrote it (no tiles/cards).
// `extra` carries the monthly-only recap (last month's completed work), folded in from the
// retired Cloudflare mailer. Omitted on on-demand sends.
function summaryHtml(name: string, url: string, m: any, plan?: string, extra?: { done?: Array<{ type?: string; resolution?: string }>; monthLabel?: string }, leads?: { count: number; label: string }) {
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  const adv = /growth|elite/i.test(plan || '');   // Growth/Elite get the deeper report
  const s = m.speed, r = m.reviews, se = m.search, rep = m.report;
  const p = (t: string) => `<p style="margin:0 0 15px;">${t}</p>`;

  // Growth gets the full AI summary; Essential gets a short one-line check-in (kept deliberately brief).
  const opening = adv
    ? (rep?.summary ? esc(rep.summary) : ('Here is a quick update on how ' + esc(url || 'your website') + ' is doing.'))
    : ('Here is your quick monthly check-in on how ' + esc(url || 'your website') + ' is doing.');

  // Leads lead: the concrete money number, highlighted in a subtle callout right up top when there is one.
  const leadHighlight = (leads && leads.count > 0)
    ? '<div style="background:#f7f6fb;border:1px solid #ece9f4;border-radius:12px;padding:15px 18px;margin:0 0 18px;">'
      + '<span style="font-size:30px;font-weight:800;color:#7851a9;letter-spacing:-.03em;vertical-align:middle;">' + leads.count + '</span>'
      + '<span style="font-size:15px;color:#1f2333;font-weight:700;vertical-align:middle;">&nbsp;new ' + (leads.count === 1 ? 'inquiry' : 'inquiries') + ' ' + esc(leads.label) + '</span>'
      + '<div style="font-size:13px;color:#6b7094;margin-top:3px;">Calls, emails, and contact-form messages from your website.</div>'
      + '</div>'
    : '';

  // Numbers as a plain sentence-y list, only what we actually have. The impressions trend %
  // is a Growth-tier detail.
  const lines: string[] = [];
  if (s?.mobile) lines.push('Site speed: ' + s.mobile.score + '/100 on mobile' + (s.desktop ? ', ' + s.desktop.score + '/100 on desktop' : ''));
  if (r?.rating != null) lines.push('Google rating: ' + r.rating + ' stars (' + (r.count ?? 0) + ' reviews)');
  if (se?.impressions != null || se?.clicks != null) {
    lines.push('Search: ' + (se.impressions != null ? Number(se.impressions).toLocaleString() + ' impressions' : '') +
      (se.clicks != null ? (se.impressions != null ? ' and ' : '') + se.clicks + ' clicks' : '') + ' in the last 2 months' +
      (adv && se.deltaPct != null ? ' (' + (se.deltaPct >= 0 ? 'up ' : 'down ') + Math.abs(se.deltaPct) + '%)' : ''));
  }
  const snap = lines.length
    ? p('Here is a quick snapshot of your site right now:') + '<ul style="margin:0 0 15px;padding-left:20px;">' + lines.map((x) => `<li style="margin-bottom:6px;">${esc(x)}</li>`).join('') + '</ul>'
    : '';

  // Growth-only: what people searched + a deeper action plan.
  const searched = adv && rep?.searched ? p(esc(rep.searched)) : '';
  const recs = (adv && rep?.recommendations && rep.recommendations.length)
    ? p('A couple of things we would suggest:') + '<ul style="margin:0 0 15px;padding-left:20px;">' + rep.recommendations.map((x: string) => `<li style="margin-bottom:6px;">${esc(x)}</li>`).join('') + '</ul>'
    : '';
  // Essential gets a soft nudge toward the deeper report instead.
  const upsell = !adv
    ? p('You are on our Essential plan. Growth adds your search trends over time, the exact terms people use to find you, and a tailored action plan each month.')
    : '';

  // Monthly-only: a recap of what we shipped for them last month (empty on on-demand sends).
  // Growth gets the detailed "what we did" list; Essential gets a short one-line count (keep it brief).
  const done = (extra?.done) || [];
  const shipped = !done.length ? ''
    : (adv
        ? p('Here is what we took care of for you' + (extra?.monthLabel ? ' in ' + esc(extra.monthLabel) : ' this month') + ':')
          + '<ul style="margin:0 0 15px;padding-left:20px;">'
          + done.map((r) => `<li style="margin-bottom:8px;"><strong>${esc(r.type || 'Update')}</strong>${r.resolution ? `<br><span style="color:#6b7094;white-space:pre-wrap;">${esc(r.resolution)}</span>` : ''}</li>`).join('')
          + '</ul>'
        : p('We also completed <strong>' + done.length + '</strong> website ' + (done.length === 1 ? 'request' : 'requests') + ' for you' + (extra?.monthLabel ? ' in ' + esc(extra.monthLabel) : ' this month') + '.'));

  // Light branded header: the WebEaze logo + wordmark + which month's report this is. The wordmark is
  // real text so it still reads if the client's email blocks the logo image.
  const reportLabel = extra?.monthLabel ? ('Your ' + esc(extra.monthLabel) + ' report') : 'Your website report';
  const header = '<div style="border-bottom:1px solid #eeeeee;padding-bottom:15px;margin-bottom:24px;">'
    + '<img src="https://webeaze.io/images/webeaze-transparent-copy.png" alt="" width="24" height="27" style="vertical-align:middle;margin-right:8px;" />'
    + '<span style="font-size:17px;font-weight:800;letter-spacing:-.02em;color:#1f2333;vertical-align:middle;">Web<span style="color:#7851a9;">Eaze</span></span>'
    + '<span style="font-size:14px;color:#9599b8;margin-left:10px;vertical-align:middle;">' + reportLabel + '</span>'
    + '</div>';
  return [
    '<!DOCTYPE html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light dark" /></head>',
    '<body style="margin:0;background:#ffffff;">',
    '<div style="max-width:560px;margin:0 auto;padding:30px 26px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1f2333;">',
    header,
    p('Hi ' + esc(first) + ','),
    p(opening),
    leadHighlight,
    snap,
    shipped,
    searched,
    recs,
    upsell,
    p('If you would like a hand with any of this, send us a request in your <a href="' + PORTAL_URL + '" style="color:#7851a9;font-weight:600;">client portal</a>.'),
    p('Talk soon,<br>The WebEaze team'),
    '<div style="margin-top:26px;padding-top:16px;border-top:1px solid #eeeeee;font-size:12px;color:#9599b8;">WebEaze Web Design, 109 Pleasant Hill Drive, Camden-Wyoming, Delaware 19934, USA</div>',
    '</div></body></html>',
  ].join('');
}

// Last month's completed work for one client, used by both the monthly cron and the admin preview.
// Returns { done: [{type, resolution}], monthLabel: 'July' }.
async function fetchMonthlyRecap(sb: any, userId: string) {
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthLabel = windowStart.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const { data: reqs } = await sb.from('update_requests')
    .select('type, status, resolution, created_at')
    .eq('user_id', userId)
    .gte('created_at', windowStart.toISOString())
    .lt('created_at', windowEnd.toISOString())
    .order('created_at', { ascending: true });
  const done = (reqs ?? []).filter((r: any) => (r.status || '') === 'Done').map((r: any) => ({ type: r.type, resolution: r.resolution }));
  return { done, monthLabel, windowStartISO: windowStart.toISOString(), windowEndISO: windowEnd.toISOString() };
}

// Count lead events (form fills, calls, emails) for a client in a window. Safe if the table
// does not exist yet (returns 0), so the feature is inert until lead_events.sql is run.
async function countLeads(sb: any, userId: string, startISO: string, endISO?: string) {
  try {
    let q = sb.from('lead_events').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', startISO);
    if (endISO) q = q.lt('created_at', endISO);
    const { count } = await q;
    return count || 0;
  } catch { return 0; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const body = await req.json().catch(() => ({}));
    const cronSecret = req.headers.get('x-cron-secret') ?? '';
 
    // ── Cron-secret entry: monthly email run, OR a no-email data refresh, OR a client list ──
    // body.action:
    //   'list'    → return the user_ids only (so a caller can fan out refreshes safely)
    //   'refresh' → refresh metrics for each client, NO email (bring data current, e.g. after
    //               setting Google Place IDs). Supports body.only for single-client fan-out.
    //   (default) → the monthly run: refresh + email each client.
    if (cronSecret && cronSecret === CRON_SECRET) {
      const only = (body && typeof body.only === 'string') ? body.only : null;
      let cq = service.from('clients')
        .select('user_id, id, email, name, business_name, site_url, google_place_id, plan, status, second_email')
        .not('site_url', 'is', null).neq('status', 'inactive');
      if (only) cq = cq.eq('user_id', only);
      const { data: clients } = await cq;

      // List mode: just hand back the user_ids so the caller can refresh them one at a time.
      if (body && body.action === 'list') {
        return json({ ok: true, users: (clients ?? []).map((c: { user_id: string }) => c.user_id) });
      }

      // 'refresh' = data only, never emails. Anything else keeps the monthly email behavior.
      const emailEach = !(body && body.action === 'refresh');

      // Subject uses the previous-calendar-month label, e.g. "July 2026" (email runs only).
      const nowD = new Date();
      const monthYear = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 1, 1))
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      // Fan-out: the cron fires ONE call per client (body.only = that user_id), so each
      // invocation handles a single client in ~30s and never hits the wall-clock limit.
      // Calling with no `only` processes everyone but can time out past a few clients.
      let sent = 0;
      let lastMetrics: any = null;
      for (const c of clients ?? []) {
        try {
          const metrics = await refreshClient(service, c);
          lastMetrics = metrics;
          if (!emailEach) continue;                                     // refresh-only run: no email
          if (!c.email) continue;
          const recap = await fetchMonthlyRecap(service, c.user_id);   // last month's completed work
          const leadCount = await countLeads(service, c.user_id, recap.windowStartISO, recap.windowEndISO);
          await sendEmail({
            from: FROM, to: [c.email, c.second_email].filter(Boolean),
            subject: 'Your ' + monthYear + ' growth report',
            html: summaryHtml(c.name || '', c.site_url || '', metrics, c.plan, recap, { count: leadCount, label: 'in ' + recap.monthLabel }),
          });
          sent++;
        } catch (e) { console.error('monthly client failed', c.user_id, e); }
      }
      // For a single-client fan-out call, hand back that client's fresh metrics so a caller can
      // verify (e.g. confirm reviews resolved) without needing service-role DB access.
      return json({ ok: true, refreshed: (clients ?? []).length, emailed: sent, metrics: only ? lastMetrics : undefined });
    }

    // ── On-demand: authenticate the caller, act on their own client only ──
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user }, error: uErr } = await authed.auth.getUser();
    if (uErr || !user) return json({ error: 'Unauthorized' }, 401);

    // Clients refresh their own record; the admin account may refresh any client (targetUserId).
    const targetUserId = (body.targetUserId && user.email === 'billy@webeaze.io') ? body.targetUserId : user.id;
    const { data: c } = await service.from('clients').select('user_id, id, email, name, business_name, site_url, google_place_id, plan, second_email').eq('user_id', targetUserId).maybeSingle();
    if (!c) return json({ error: 'No client record' }, 404);

    const diag: Record<string, boolean> = {};
    const metrics = await refreshClient(service, c, diag);
    // Name the source that came back empty. Each one fails for its own reason and needs its own fix,
    // so "could not refresh" is useless: it is almost always a per-client setup gap, not an outage.
    let note = '';
    if (!c.site_url) {
      note = 'No Site URL is set for this client, so nothing can be measured. Add one in the admin editor.';
    } else if (!PSI_KEY) {
      note = 'The GOOGLE_PSI_KEY secret is not set on the function, so site speed cannot be measured.';
    } else {
      const gaps: string[] = [];
      if (!diag.speed) gaps.push('site speed (PageSpeed could not load the site: check it is a reachable https page that does not block automated tests)');
      if (!diag.search) gaps.push('Google Search data (no Search Console property matched this domain, or our service account has not been added to it)');
      if (!diag.reviews) gaps.push(c.google_place_id ? 'Google reviews (the Place ID on file did not resolve)' : 'Google reviews (no Place ID is set for this client)');
      if (!diag.competitors) gaps.push('the local comparison (it needs a working Place ID)');
      if (gaps.length) {
        note = 'Refreshed, but we could not pull ' + gaps.join('; ') + '. Anything we could not reach is still showing its last known figures.';
      }
    }

    // Email is sent to the client's own address on file. Report exactly what happened
    // (sent + to whom, or why not) rather than assuming success.
    let emailed = false;
    let emailedTo: string | null = null;
    if (body.action === 'email') {
      // Admin previewing another client's report: send the FULL monthly version (with the
      // completed-work recap) to Billy himself, so he can see exactly what a client will get
      // without emailing the client or touching any data.
      const isAdminPreview = user.email === 'billy@webeaze.io' && !!body.targetUserId && body.targetUserId !== user.id;
      const recipient = isAdminPreview ? (user.email as string) : c.email;
      if (!recipient) {
        note = note || 'No email address is on this client record, so nothing was sent.';
      } else {
        try {
          const recap = isAdminPreview ? await fetchMonthlyRecap(service, c.user_id) : undefined;
          let leads: { count: number; label: string };
          if (isAdminPreview && recap) {
            leads = { count: await countLeads(service, c.user_id, recap.windowStartISO, recap.windowEndISO), label: 'in ' + recap.monthLabel };
          } else {
            const nowM = new Date();
            const monthStartISO = new Date(Date.UTC(nowM.getUTCFullYear(), nowM.getUTCMonth(), 1)).toISOString();
            leads = { count: await countLeads(service, c.user_id, monthStartISO), label: 'this month' };
          }
          await sendEmail({
            from: FROM, to: [recipient, isAdminPreview ? null : (c.second_email || null)].filter(Boolean),
            subject: isAdminPreview ? ('[Monthly preview] ' + (c.name || c.site_url || 'client') + "'s report") : 'Your growth report',
            html: summaryHtml(c.name || '', c.site_url || '', metrics, c.plan, recap, leads),
          });
          emailed = true; emailedTo = recipient;
        } catch (e) {
          console.error('[growth] email send failed:', e);
          note = 'The report could not be emailed right now (' + String(e).slice(0, 120) + ').';
        }
      }
    }
    return json({ ok: true, metrics, note, emailed, emailedTo });
  } catch (e) {
    console.error('growth-report error:', e);
    return json({ error: String(e) }, 500);
  }
});
