// Supabase Edge Function: business-lookup
// Finds a client's business on Google and hands back the facts Site setup would otherwise ask them
// to type: business name, trade, phone, address, service area and opening hours.
//
// Why: Site setup asks for business name, industry, services, areas and hours. Google already knows
// most of that for any business with a Google listing, which is nearly all of them. Turning four
// screens of typing into "is this you?" is the difference between a client finishing onboarding on
// their phone and abandoning it.
//
// Called with the client's JWT.
//   Body: { query: 'Bear Carpet Care Harrisburg' }   search by name (what setup does)
//      or { placeId: 'ChIJ...' }                     when we already have their listing
//   Returns: { ok, found, business: { name, category, phone, address, area, hours, website,
//              rating, reviewCount, placeId } }
//
// Deploy:  supabase functions deploy business-lookup   (Verify JWT ON; the portal sends a JWT)
// Secret:  GOOGLE_PLACES_KEY (the same key growth-report uses)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const PLACES_KEY = Deno.env.get('GOOGLE_PLACES_KEY') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Everything setup would otherwise ask them to type out by hand.
const FIELDS = 'id,displayName,primaryTypeDisplayName,formattedAddress,shortFormattedAddress,nationalPhoneNumber,regularOpeningHours,websiteUri,rating,userRatingCount';

// Google returns opening hours as one line per day already phrased for humans
// ("Monday: 9:00 AM – 5:00 PM"), which is exactly the shape the setup textarea wants.
function readHours(p: any): string {
  const d = p && p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions;
  return Array.isArray(d) && d.length ? d.join('\n') : '';
}
// The town, pulled off the formatted address, as a sensible first guess at their service area.
function readArea(p: any): string {
  const a = String((p && (p.shortFormattedAddress || p.formattedAddress)) || '');
  const parts = a.split(',').map((x) => x.trim()).filter(Boolean);
  // "123 Main St, Harrisburg, PA 17101, USA" -> "Harrisburg, PA"
  if (parts.length >= 3) return parts[1] + (parts[2] ? ', ' + parts[2].replace(/\s*\d{5}(-\d{4})?$/, '').trim() : '');
  return parts.length === 2 ? parts.join(', ') : a;
}
function shape(p: any) {
  if (!p) return null;
  return {
    placeId: p.id || null,
    name: (p.displayName && p.displayName.text) || null,
    category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || null,
    phone: p.nationalPhoneNumber || null,
    address: p.formattedAddress || null,
    area: readArea(p),
    hours: readHours(p),
    website: p.websiteUri || null,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const authed = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    if (!PLACES_KEY) return json({ ok: false, reason: 'not-configured' });

    const body = await req.json().catch(() => ({} as any));
    const placeId = String(body.placeId || '').trim();
    const query = String(body.query || '').replace(/\s+/g, ' ').trim();

    if (placeId) {
      const res = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId), {
        headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': FIELDS },
      });
      if (!res.ok) return json({ ok: true, found: false });
      return json({ ok: true, found: true, business: shape(await res.json()) });
    }

    if (query.length < 3) return json({ ok: true, found: false, reason: 'too short' });
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'Content-Type': 'application/json', 'X-Goog-FieldMask': FIELDS.split(',').map((f) => 'places.' + f).join(',') },
      body: JSON.stringify({ textQuery: query, maxResultCount: 3 }),
    });
    if (!res.ok) { console.error('[business-lookup] searchText ' + res.status + ': ' + (await res.text()).slice(0, 160)); return json({ ok: true, found: false }); }
    const d = await res.json();
    const list = (d.places || []).map(shape).filter(Boolean);
    // Up to three, so a client whose name matches a chain can pick the right one rather than
    // silently getting somebody else's hours.
    return json({ ok: true, found: !!list.length, business: list[0] || null, alternatives: list.slice(1) });
  } catch (e) {
    console.error('[business-lookup] error:', e);
    return json({ ok: false, reason: 'error' });
  }
});
