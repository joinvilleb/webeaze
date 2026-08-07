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

// ── Source: PageSpeed Insights (real speed + Core Web Vitals + accessibility) ──
async function pullSpeed(url: string) {
  if (!url) { console.warn('[growth] pullSpeed: no site_url'); return null; }
  if (!PSI_KEY) { console.warn('[growth] pullSpeed: GOOGLE_PSI_KEY secret is not set'); return null; }
  const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;   // PageSpeed needs a full URL
  const run = async (strategy: 'mobile' | 'desktop') => {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(full)}&strategy=${strategy}&category=performance&category=accessibility&category=seo&category=best-practices&key=${PSI_KEY}`;
    const res = await fetch(api);
    if (!res.ok) throw new Error(`PSI ${strategy} ${res.status}: ${(await res.text()).slice(0, 180)}`);
    const d = await res.json();
    const lh = d.lighthouseResult ?? {};
    const score = Math.round((lh.categories?.performance?.score ?? 0) * 100);
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
  try {
    const [mobile, desktop] = await Promise.all([run('mobile'), run('desktop')]);
    const now = new Date().toISOString();
    // Accessibility / SEO / best-practices are DOM-based (same either strategy); take from mobile.
    const accessibility = mobile.a11yScore != null ? { score: mobile.a11yScore, issues: mobile.a11yIssues || [], checkedAt: now } : null;
    const seo = mobile.seoScore != null ? { score: mobile.seoScore, issues: mobile.seoIssues || [], checkedAt: now } : null;
    const bestPractices = mobile.bpScore != null ? { score: mobile.bpScore, checkedAt: now } : null;
    const cwv = mobile.cwv || null;   // real-visitor field data, when Google has enough of it
    return {
      mobile: { score: mobile.score, lcpSeconds: mobile.lcpSeconds, cls: mobile.cls },
      desktop: { score: desktop.score, lcpSeconds: desktop.lcpSeconds, cls: desktop.cls },
      accessibility, seo, bestPractices, cwv, checkedAt: now,
    };
  } catch (e) {
    console.error('pullSpeed failed', e);
    return null;
  }
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
async function pullReviews(ref?: string | null) {
  const raw = (ref || '').trim();
  if (!raw) { console.warn('[growth] pullReviews: no Place ID / name set'); return null; }
  if (!PLACES_KEY) { console.warn('[growth] pullReviews: GOOGLE_PLACES_KEY secret is not set'); return null; }

  // Decide what we were given.
  let textQuery = '';
  let bias: { lat: number; lng: number } | null = null;
  if (/^https?:\/\//i.test(raw)) {
    // Google Maps link → read the business name and (if present) the map coordinates.
    let mapsUrl = raw;
    // Shortened links (maps.app.goo.gl / goo.gl/maps) carry no name; follow the redirect first.
    if (/goo\.gl\//i.test(raw)) {
      try {
        const r = await fetch(raw, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebEazeBot/1.0)' } });
        if (r.url) mapsUrl = r.url;
      } catch (e) { console.warn('[growth] could not expand short Maps link:', e); }
    }
    const nameMatch = mapsUrl.match(/\/place\/([^/@]+)/);
    if (nameMatch) textQuery = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
    const at = mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) bias = { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
    if (!textQuery) { const q = mapsUrl.match(/[?&]q=([^&]+)/); if (q) textQuery = decodeURIComponent(q[1].replace(/\+/g, ' ')); }   // some links use ?q=Name
    if (!textQuery) { console.warn('[growth] pullReviews: could not read a name from the Maps link: ' + mapsUrl.slice(0, 120)); return null; }
  } else if (/^(ChIJ|GhIJ)[A-Za-z0-9_-]{8,}$/.test(raw)) {
    return await fetchReviewsByPlaceId(raw);   // looks like a raw Place ID
  } else {
    textQuery = raw;   // a plain business name
  }

  // Resolve a name/URL to the listing via Text Search (New) — returns rating + count in one call.
  try {
    const body: Record<string, unknown> = { textQuery };
    if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 50000 } };
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn('[growth] Places textSearch ' + res.status + ': ' + (await res.text()).slice(0, 160)); return null; }
    const d = await res.json();
    const p = d.places && d.places[0];
    if (!p) { console.warn('[growth] Places textSearch: no match for "' + textQuery + '"'); return null; }
    console.log('[growth] reviews matched "' + textQuery + '" -> ' + (p.displayName?.text || p.id) + ' (' + p.id + ')');
    return { rating: p.rating ?? null, count: p.userRatingCount ?? null, placeId: p.id, matched: p.displayName?.text ?? null, recent: await fetchRecentReviews(p.id), checkedAt: new Date().toISOString() };
  } catch (e) { console.error('[growth] Places textSearch failed:', e); return null; }
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
  const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;
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
  // Raw Place ID → Place Details.
  if (/^(ChIJ|GhIJ)[A-Za-z0-9_-]{8,}$/.test(raw)) {
    try {
      const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(raw)}`, {
        headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,location,primaryType,primaryTypeDisplayName' },
      });
      if (res.ok) return fromPlace(await res.json());
    } catch (e) { console.error('[growth] resolveSelfPlace details failed:', e); }
    return null;
  }
  // URL or name → Text Search (parse a name + optional coords like pullReviews does).
  let textQuery = raw;
  let bias: { lat: number; lng: number } | null = null;
  if (/^https?:\/\//i.test(raw)) {
    let mapsUrl = raw;
    if (/goo\.gl\//i.test(raw)) {
      try { const r = await fetch(raw, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebEazeBot/1.0)' } }); if (r.url) mapsUrl = r.url; } catch { /* ignore */ }
    }
    const nameMatch = mapsUrl.match(/\/place\/([^/@]+)/);
    textQuery = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')) : '';
    const at = mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) bias = { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
    if (!textQuery) { const q = mapsUrl.match(/[?&]q=([^&]+)/); if (q) textQuery = decodeURIComponent(q[1].replace(/\+/g, ' ')); }
    if (!textQuery) return null;
  }
  try {
    const body: Record<string, unknown> = { textQuery };
    if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 50000 } };
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.location,places.primaryType,places.primaryTypeDisplayName', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn('[growth] resolveSelfPlace textSearch ' + res.status); return null; }
    const d = await res.json();
    const p = d.places && d.places[0];
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
  const host = siteUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
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

  // 3) Top search terms people used to find them (for "what was searched").
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
async function generateSummary(c: { site_url?: string; name?: string }, metrics: any) {
  if (!ANTHROPIC_API_KEY) { console.warn('[growth] ANTHROPIC_API_KEY not set — skipping AI summary'); return null; }
  const s = metrics.speed, r = metrics.reviews, se = metrics.search;
  const facts = {
    business: c.name || '', site: c.site_url || '',
    speedMobile: s?.mobile?.score ?? null, speedDesktop: s?.desktop?.score ?? null,
    googleRating: r?.rating ?? null, reviewCount: r?.count ?? null,
    searchClicks: se?.clicks ?? null, searchImpressions: se?.impressions ?? null,
    avgPosition: se?.position ?? null, clickThroughRatePct: se?.ctr ?? null,
    impressionsTrendPct: se?.deltaPct ?? null,
    topSearches: (se?.topQueries || []).map((q: any) => q.query).slice(0, 5),
  };
  const system = "You are the account team at WebEaze, a friendly web design and website-care service for small businesses. Write a short, warm, plain-English report for the business owner about how their website is doing. Talk to them directly (\"your site\"), no jargon, encouraging but honest. NEVER use em dashes. Only reference numbers that are provided (nulls mean not available) and never invent data. Return ONLY valid JSON (no markdown, no code fences) with keys: headline (a short upbeat phrase, max 8 words, written in sentence case: capitalize only the first word and any proper nouns like Google, not every word), summary (2 to 3 sentences on what has been happening), searched (one friendly sentence about what people searched to find them, or null if topSearches is empty), recommendations (array of 1 to 3 short, specific, non-technical suggestions we could do for them).";
  const userMsg = 'Latest data:\n' + JSON.stringify(facts, null, 2);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: userMsg }] }),
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
async function generateOpportunities(c: { site_url?: string; name?: string }, metrics: any) {
  if (!ANTHROPIC_API_KEY) return null;
  const se = metrics.search;
  if (!se || !Array.isArray(se.topQueries) || !se.topQueries.length) return null;
  const nearWins = se.topQueries
    .filter((q: any) => q && q.position != null && q.position >= 4 && q.position <= 20 && (q.impressions || 0) > 0)
    .sort((a: any, b: any) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, 6)
    .map((q: any) => ({ term: q.query, position: q.position, impressions: q.impressions, clicks: q.clicks }));
  if (!nearWins.length) return null;
  const system = "You are the growth team at WebEaze, a website care service for small trade businesses. You are given a client's Google Search 'near-win' keywords: searches where they already rank on the edge of page one with real search demand. Turn them into 2 to 4 concrete growth opportunities we could do for them to win more customers. Be specific, framed as an action WE take (for example a focused service page, or beefing up an existing page). Write the 'why' in PLAIN everyday language a busy business owner gets in one read: name the actual search phrase in quotes and say something like 'people are searching for this and finding you, but not quite landing on the right page.' AVOID jargon and numbers like impressions, clicks, CTR, conversion, or position 4 to 5. Keep each 'why' to one clear sentence, enough that they understand it, not a data dump. NEVER use em dashes. Return ONLY valid JSON (no markdown, no code fences): an array of objects with keys: title (short action, max 8 words), why (one plain sentence naming the search phrase), requestType (exactly one of: Content update, New page or section, SEO or visibility, Other), requestSummary (a clear description of the change for our team to action).";
  const userMsg = 'Business: ' + (c.name || '') + '\nSite: ' + (c.site_url || '') + '\nNear-win keywords:\n' + JSON.stringify(nearWins, null, 2);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 800, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!res.ok) { console.error('[growth] opportunities ' + res.status); return null; }
    const d = await res.json();
    let text = (Array.isArray(d.content) ? d.content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '');
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return null;
    const TYPES = ['Content update', 'New page or section', 'SEO or visibility', 'Other'];
    const items = arr.slice(0, 4).map((o: any) => ({
      title: String(o.title || '').slice(0, 90),
      why: String(o.why || '').slice(0, 240),
      requestType: TYPES.includes(String(o.requestType)) ? String(o.requestType) : 'SEO or visibility',
      requestSummary: String(o.requestSummary || '').slice(0, 600),
    })).filter((o: any) => o.title && o.requestSummary);
    return items.length ? { items, generatedAt: new Date().toISOString() } : null;
  } catch (e) { console.error('[growth] opportunities failed:', e); return null; }
}

// ── AI: proactive, seasonal "timely ideas" for the client's site, as one-tap requests ──
// Not keyword-based (so it works for every plan): the current month + their trade, turned into 1-2
// timely improvements we could make right now to win more work.
async function generateNudges(c: { site_url?: string; name?: string }, refDate: Date) {
  if (!ANTHROPIC_API_KEY) return null;
  const monthName = refDate.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const system = "You are the proactive growth team at WebEaze for a small trade business. Given the business and the current month, suggest 1 to 2 TIMELY, seasonal improvements we could make to their website right now to win more work (a seasonal promo banner, a holiday hours note, highlighting a service that is in demand this time of year, and so on). Concrete and specific to the season and their trade, not generic. NEVER use em dashes. Return ONLY valid JSON (no markdown, no code fences): an array of objects with keys: title (short, max 8 words), why (one sentence that references the season or month), requestType (exactly one of: Content update, New page or section, SEO or visibility, Other), requestSummary (a clear description of the change for our team).";
  const userMsg = 'Business: ' + (c.name || '') + '\nSite: ' + (c.site_url || '') + '\nCurrent month: ' + monthName + '\nSuggest timely, seasonal website improvements for this trade.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: userMsg }] }),
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
      requestType: TYPES.includes(String(o.requestType)) ? String(o.requestType) : 'Content update',
      requestSummary: String(o.requestSummary || '').slice(0, 600),
    })).filter((o: any) => o.title && o.requestSummary);
    return items.length ? { items, month: monthName, generatedAt: new Date().toISOString() } : null;
  } catch (e) { console.error('[growth] nudges failed:', e); return null; }
}

async function refreshClient(sb: any, c: { user_id: string; id?: string; site_url?: string; google_place_id?: string | null; plan?: string }) {
  const url = c.site_url || '';
  const [speed, reviews] = await Promise.all([pullSpeed(url), pullReviews(c.google_place_id), ]);
  const search = await pullSearch(url);
  // Local competitor benchmark reuses the client's own mobile speed for the self row.
  const competitors = await pullCompetitors(c.google_place_id, speed?.mobile?.score ?? null);
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
    speed: speed ?? old.speed ?? null,
    accessibility: accessibility ?? old.accessibility ?? null,
    seo: seo ?? old.seo ?? null,
    bestPractices: bestPractices ?? old.bestPractices ?? null,
    cwv: cwv ?? old.cwv ?? null,
    reviews: reviews ?? old.reviews ?? null,
    search: search ?? old.search ?? null,
    competitors: competitors ?? old.competitors ?? null,
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
  // AI report last, so it can summarize the freshest numbers. Keep the prior one if it fails.
  metrics.report = (await generateSummary(c, metrics)) ?? old.report ?? null;
  // AI growth opportunities from near-win keywords (Growth/Elite only; keep prior on failure).
  const adv = /growth|elite/i.test(c.plan || '');
  metrics.opportunities = adv ? ((await generateOpportunities(c, metrics)) ?? old.opportunities ?? null) : (old.opportunities ?? null);
  // Seasonal nudges: proactive timely ideas for every plan.
  metrics.nudges = (await generateNudges(c, new Date())) ?? old.nudges ?? null;
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

  const opening = rep?.summary ? esc(rep.summary) : ('Here is a quick update on how ' + esc(url || 'your website') + ' is doing.');

  // Leads lead: the concrete money number, right up top when there is one.
  const leadLine = (leads && leads.count > 0)
    ? p('First, the good news: your website brought in <strong>' + leads.count + (leads.count === 1 ? ' new inquiry' : ' new inquiries') + '</strong> ' + esc(leads.label) + ' (calls, emails, and contact-form messages).')
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
  const done = (extra?.done) || [];
  const shipped = done.length
    ? p('Here is what we took care of for you' + (extra?.monthLabel ? ' in ' + esc(extra.monthLabel) : ' this month') + ':')
      + '<ul style="margin:0 0 15px;padding-left:20px;">'
      + done.map((r) => `<li style="margin-bottom:8px;"><strong>${esc(r.type || 'Update')}</strong>${r.resolution ? `<br><span style="color:#6b7094;white-space:pre-wrap;">${esc(r.resolution)}</span>` : ''}</li>`).join('')
      + '</ul>'
    : '';

  return [
    '<!DOCTYPE html><html><head><meta charset="UTF-8" /></head>',
    '<body style="margin:0;background:#ffffff;">',
    '<div style="max-width:560px;margin:0 auto;padding:32px 26px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1f2333;">',
    p('Hi ' + esc(first) + ','),
    p(opening),
    leadLine,
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
        .select('user_id, id, email, name, site_url, google_place_id, plan, status, second_email')
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
    const { data: c } = await service.from('clients').select('user_id, id, email, name, site_url, google_place_id, plan, second_email').eq('user_id', targetUserId).maybeSingle();
    if (!c) return json({ error: 'No client record' }, 404);

    const metrics = await refreshClient(service, c);
    let note = !c.site_url ? 'This client has no Site URL set — add one in the admin editor.'
      : (!PSI_KEY ? 'GOOGLE_PSI_KEY secret is not set on the function.'
      : (metrics.speed ? '' : 'PageSpeed returned no data. Check the Site URL is a reachable https page and the PageSpeed Insights API is enabled for your key.'));

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
