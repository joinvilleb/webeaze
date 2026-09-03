// Supabase Edge Function: prospect-scan
// The top of the WebEaze lead-acquisition machine. Given a niche + area, finds local
// businesses via Google Places, scores each by "how much they need us" (no website,
// slow site, thin reviews...), and upserts them into `prospects` for outreach.
//
// Entry modes (POST):
//   { action:'scan', area, niche, maxPages?, checkSpeed? }
//        → discover businesses for "<niche> in <area>", score, upsert, return the ranked list.
//          maxPages 1-3 (20 results each). checkSpeed pulls mobile PageSpeed for the top
//          with-website candidates so a slow existing site counts toward the score (slower).
//   { action:'enrich-speed', limit? }
//        → fill mobile PageSpeed for stored prospects that have a website but no speed yet,
//          then re-score them. Repeatable / cron-friendly (bounded so it never times out).
//   { action:'scan-targets', batch? }
//        → scan the oldest-scanned entries in `prospect_targets` (niche x area across your
//          states), rotating through the whole list over several runs. This is what the daily
//          cron calls so the pool refills itself. batch defaults to 6.
//
// Auth: admin (billy@webeaze.io) JWT, OR the x-cron-secret header (for scheduled scans).
// Reuses growth-report's secrets — nothing new to set:
//   GOOGLE_PLACES_KEY, GOOGLE_PSI_KEY, CRON_SECRET.
//
// Deploy: supabase functions deploy prospect-scan
// Table:  supabase/prospects.sql

import { createClient } from 'jsr:@supabase/supabase-js@2';

const PLACES_KEY = Deno.env.get('GOOGLE_PLACES_KEY') ?? '';
const PSI_KEY = Deno.env.get('GOOGLE_PSI_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const ADMIN_EMAIL = 'billy@webeaze.io';
const SPEED_CAP = 10;   // most PageSpeed calls per invocation (keeps us under the wall-clock limit)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Google Places Text Search: businesses for "<niche> in <area>" ──
// Paginates up to maxPages (20 results each). A pageToken is only valid a moment after
// it's issued, so we pause briefly before requesting the next page.
async function searchProspects(niche: string, area: string, maxPages = 1): Promise<any[]> {
  if (!PLACES_KEY) { console.warn('[prospect] GOOGLE_PLACES_KEY not set'); return []; }
  const fieldMask = [
    'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
    'places.rating', 'places.userRatingCount', 'places.websiteUri', 'places.nationalPhoneNumber',
    'places.primaryType', 'places.primaryTypeDisplayName', 'nextPageToken',
  ].join(',');
  const out: any[] = [];
  let pageToken: string | undefined;
  const pages = Math.min(Math.max(1, maxPages | 0), 3);
  for (let i = 0; i < pages; i++) {
    const body: Record<string, unknown> = { textQuery: `${niche} in ${area}`, pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': fieldMask, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { console.warn('[prospect] textSearch ' + res.status + ': ' + (await res.text()).slice(0, 180)); break; }
      const d = await res.json();
      for (const p of (d.places || [])) out.push(p);
      if (!d.nextPageToken) break;
      pageToken = d.nextPageToken;
      await sleep(1600);
    } catch (e) { console.error('[prospect] textSearch failed:', e); break; }
  }
  return out;
}

// Mobile-only PageSpeed score for one URL (0-100 or null). Cheap single call.
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

// National-brand names we never want to email (a local franchisee can't change their corporate
// site, so the pitch can't land). Not exhaustive; the review-count check below catches the rest.
const FRANCHISE_RE = /\b(one hour|mr\.?\s?rooter|roto[-\s]?rooter|mr\.?\s?handyman|molly maid|merry maids|servpro|stanley steemer|chem[-\s]?dry|aire serv|benjamin franklin|mister sparky|jiffy lube|midas|meineke|great clips|supercuts|sport clips|planet fitness|anytime fitness|orange\s?theory|crunch fitness|f45|snap fitness|european wax|the joint|jan[-\s]?pro|two men and a truck|starbucks|dunkin|crumbl|nothing bundt|jersey mike|subway|petco|petsmart|scenthound|woof gang)\b/i;

// Same idea for the South Florida niches (pools, AC, cleaning, movers, boutique fitness, med spas):
// these are all franchised or corporate-owned, so the local manager can't buy a site from us.
const FRANCHISE_RE_2 = /\b(la fitness|eos fitness|youfit|blink fitness|esporta|gold['’]?s gym|world gym|24 hour fitness|life ?time athletic|ufc gym|title boxing|9\s?round|club pilates|pure barre|stretchlab|cyclebar|row house|burn boot camp|massage envy|hand ?& ?stone|drybar|amazing lash|sola salon|palm beach tan|elements massage|woodhouse|trugreen|weed man|lawn doctor|mosquito joe|the grounds guys|u\.?s\.? lawns|ars\b|rescue rooter|air pros|poolwerx|pool troopers|america['’]?s swimming pool|leslie['’]?s pool|the cleaning authority|maid brigade|maid right|you['’]?ve got maids|paul davis|restoration 1|rainbow international|911 restoration|college hunks|all my sons|u-?haul|pods\b|bekins|atlas van|mayflower|united van lines|valvoline|take 5 oil|ziebart|tint world|christian brothers|aamco|maaco|mavis|monro|precision tune|caliber collision|window genie|fish window|men in kilts|shack shine|camp bow wow|dogtopia|pet supplies plus|splash and dash|panera|paris baguette|insomnia cookies|cinnabon|pollo tropical|chipotle|dutch bros|tim hortons|7 brew)\b/i;

// The core heuristic: how much does this business need what we sell, AND can they actually buy it?
// We want an INDEPENDENT small local business (landscaper, gym, bakery, salon...) with a bad or no
// site. Chains and franchises are disqualified outright. Returns a 0-100 score + plain reasons.
function scoreProspect(f: { name?: string | null; website: string | null; review_count: number | null; rating: number | null; phone: string | null; speed_mobile: number | null }) {
  const reasons: string[] = [];

  // Fit gate: a national-brand name, or a huge review count (a big multi-location operation with a
  // marketing dept), means they can't or won't buy from us. Disqualify so they sink below everyone.
  const isFranchise = f.name ? (FRANCHISE_RE.test(f.name) || FRANCHISE_RE_2.test(f.name)) : false;
  const tooBig = f.review_count != null && f.review_count >= 600;
  if (isFranchise || tooBig) {
    return { score: 0, reasons: [isFranchise ? 'National franchise (skip)' : 'Too big, likely a chain (skip)'] };
  }

  let score = 0;
  if (!f.website) {
    score += 50; reasons.push('No website');
  } else if (f.speed_mobile != null) {
    if (f.speed_mobile < 50) { score += 30; reasons.push('Very slow site (' + f.speed_mobile + '/100)'); }
    else if (f.speed_mobile < 70) { score += 18; reasons.push('Slow site (' + f.speed_mobile + '/100)'); }
  }
  // Sweet spot: established enough to pay and care, small enough to still be independent and decide.
  const rc = f.review_count;
  if (rc != null && rc >= 15 && rc <= 400 && f.rating != null && f.rating >= 4.0) {
    score += 25; reasons.push('Established local business');
  } else if (rc != null && rc >= 5) {
    score += 12; reasons.push('Growing business');
  } else if (rc != null && rc < 5) {
    score += 4; reasons.push('Thin online presence');
  }
  if (f.phone) { score += 5; reasons.push('Reachable by phone'); }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// Turn a raw Places result into a prospects row (discovery columns only — never status/notes/
// user_id/proposal_url, so a re-scan refreshes the data without stomping pipeline state).
function toRow(p: any, area: string, niche: string, speed: number | null) {
  const website = p.websiteUri || null;
  const rating = p.rating ?? null;
  const review_count = p.userRatingCount ?? null;
  const phone = p.nationalPhoneNumber || null;
  const { score, reasons } = scoreProspect({ name: p.displayName?.text ?? null, website, review_count, rating, phone, speed_mobile: speed });
  const row: Record<string, unknown> = {
    place_id: p.id,
    name: p.displayName?.text ?? '(unnamed)',
    category: p.primaryTypeDisplayName?.text ?? null,
    primary_type: p.primaryType ?? null,
    address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    phone, website, rating, review_count,
    score, score_reasons: reasons,
    area, niche,
    updated_at: new Date().toISOString(),
  };
  if (speed != null) row.speed_mobile = speed;   // only set when we actually measured it
  return row;
}

// Run tasks in small concurrent batches (keeps PageSpeed within the wall-clock budget).
async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

async function doScan(sb: any, area: string, niche: string, maxPages: number, checkSpeed: boolean) {
  const places = await searchProspects(niche, area, maxPages);
  if (!places.length) return { found: 0, upserted: 0, prospects: [] };

  // Optionally measure speed for the top with-website candidates (most reviews first — the ones
  // worth pursuing), capped so we never blow the time budget. Others score without a speed bonus.
  const speedByPlace: Record<string, number | null> = {};
  if (checkSpeed) {
    const withSite = places
      .filter((p) => p.websiteUri)
      .sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0))
      .slice(0, SPEED_CAP);
    const scores = await inBatches(withSite, 5, async (p) => ({ id: p.id, s: await pullSpeedScore(p.websiteUri) }));
    for (const r of scores) speedByPlace[r.id] = r.s;
  }

  const rows = places.map((p) => toRow(p, area, niche, checkSpeed ? (speedByPlace[p.id] ?? null) : null));
  const { data, error } = await sb.from('prospects').upsert(rows, { onConflict: 'place_id' }).select('name, category, website, phone, rating, review_count, speed_mobile, score, score_reasons, status');
  if (error) throw new Error('upsert: ' + error.message);
  const ranked = (data ?? []).sort((a: any, b: any) => (b.score - a.score) || ((b.review_count || 0) - (a.review_count || 0)));
  return { found: places.length, upserted: ranked.length, checkedSpeed: checkSpeed, prospects: ranked };
}

async function doEnrichSpeed(sb: any, limit: number) {
  // Prospects with a website but no speed yet, worth-pursuing first.
  const { data: rows, error } = await sb.from('prospects')
    .select('id, name, website, rating, review_count, phone')
    .not('website', 'is', null).is('speed_mobile', null)
    .order('score', { ascending: false }).limit(Math.min(Math.max(1, limit | 0), SPEED_CAP));
  if (error) throw new Error('select: ' + error.message);
  if (!rows?.length) return { enriched: 0 };
  let enriched = 0;
  await inBatches(rows, 5, async (r: any) => {
    const speed = await pullSpeedScore(r.website);
    if (speed == null) return;
    const { score, reasons } = scoreProspect({ name: r.name, website: r.website, review_count: r.review_count, rating: r.rating, phone: r.phone, speed_mobile: speed });
    const { error: upErr } = await sb.from('prospects').update({ speed_mobile: speed, score, score_reasons: reasons, updated_at: new Date().toISOString() }).eq('id', r.id);
    if (!upErr) enriched++;
  });
  return { enriched };
}

// Scan the oldest-scanned active targets (niche x area) and rotate through the list. checkSpeed is
// off here so many areas stay fast; enrich-speed backfills PageSpeed separately.
async function doScanTargets(sb: any, batch: number) {
  const { data: targets, error } = await sb.from('prospect_targets')
    .select('id, niche, area, max_pages')
    .eq('active', true)
    .order('last_scanned_at', { ascending: true, nullsFirst: true })
    .limit(Math.min(Math.max(1, batch | 0), 12));
  if (error) throw new Error('targets: ' + error.message);
  if (!targets?.length) return { scannedTargets: 0, results: [] };
  const results: any[] = [];
  for (const t of targets) {
    try {
      const r = await doScan(sb, t.area, t.niche, t.max_pages || 1, false);
      await sb.from('prospect_targets').update({ last_scanned_at: new Date().toISOString() }).eq('id', t.id);
      results.push({ niche: t.niche, area: t.area, found: r.found, upserted: r.upserted });
    } catch (e) {
      results.push({ niche: t.niche, area: t.area, error: String(e).slice(0, 140) });
    }
  }
  return { scannedTargets: results.length, results };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Authorize: cron secret (scheduled scans) OR an authenticated admin session.
  const cronSecret = req.headers.get('x-cron-secret') ?? '';
  let authorized = !!CRON_SECRET && cronSecret === CRON_SECRET;
  if (!authorized) {
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    authorized = user?.email === ADMIN_EMAIL;
  }
  if (!authorized) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'scan';

    if (action === 'enrich-speed') {
      const out = await doEnrichSpeed(service, Number(body.limit) || SPEED_CAP);
      return json({ ok: true, ...out });
    }

    if (action === 'scan-targets') {
      const out = await doScanTargets(service, Number(body.batch) || 6);
      return json({ ok: true, ...out });
    }

    // Default: scan.
    const area = String(body.area || '').trim();
    const niche = String(body.niche || '').trim();
    if (!area || !niche) return json({ error: 'area and niche are required' }, 400);
    const out = await doScan(service, area, niche, Number(body.maxPages) || 1, body.checkSpeed !== false);
    return json({ ok: true, area, niche, ...out });
  } catch (e) {
    console.error('prospect-scan error:', e);
    return json({ error: String(e) }, 500);
  }
});
