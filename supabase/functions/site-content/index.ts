// Supabase Edge Function: site-content
// Public read endpoint for a client's Live Blocks (business hours, announcement bar, etc.). The
// blocks.js snippet on a client's website calls this with ?key=<user_id> and gets back the block
// content JSON, which it renders live. Reads with the service role so anonymous website visitors
// never need auth and never touch the table directly. Content here is meant to be public (it shows
// on their site), so exposing it read-only is by design.
//
// Deploy:  supabase functions deploy site-content --no-verify-jwt
// (--no-verify-jwt: the caller is an anonymous visitor on the client's website, not a logged-in user.)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const key = (new URL(req.url).searchParams.get('key') || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return json({ blocks: {} });
  }

  try {
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Blocks hold the client's own edits (hours, announcement, review settings). The review CONTENT is
    // the Google reviews we already fetch for the portal (client_metrics), so the reviews widget stays
    // fresh with zero client effort. Both are public content meant for their website.
    const [sb, cm, ss, cl] = await Promise.all([
      service.from('site_blocks').select('blocks').eq('user_id', key).maybeSingle(),
      service.from('client_metrics').select('metrics').eq('user_id', key).maybeSingle(),
      // Business details for the structured-data block. Everything here is already printed on the
      // client's own website, so publishing it on a public endpoint reveals nothing new. Nothing
      // from the account side (email, plan, billing, notes) is selected, deliberately.
      service.from('site_submissions').select('contact, content').eq('user_id', key).maybeSingle(),
      service.from('clients').select('business_name, name, site_url').eq('user_id', key).maybeSingle(),
    ]);
    const blocks = (sb.data && sb.data.blocks) || {};
    const rv = cm.data && cm.data.metrics && cm.data.metrics.reviews;
    const reviews = rv ? { rating: rv.rating, count: rv.count, recent: (rv.recent || []).slice(0, 12) } : null;

    // What blocks.js needs to write a LocalBusiness block onto the client's site. Only the things a
    // visitor can already read there: the name over the door, the phone number, what they do, the
    // areas they cover. The rating and review count come from `reviews` above.
    const contact = (ss.data && ss.data.contact) || {};
    const content = (ss.data && ss.data.content) || {};
    const clientRow = cl.data || {};
    const business = {
      name: clientRow.business_name || contact.business || clientRow.name || null,
      phone: contact.phone || null,
      industry: contact.industry || null,
      services: Array.isArray(content.services) ? content.services.slice(0, 12)
              : (typeof content.services === 'string' ? content.services : null),
      areas: Array.isArray(content.areas) ? content.areas.slice(0, 12)
           : (typeof content.areas === 'string' ? content.areas : null),
      hours: blocks.hours || content.hours || null,
      url: clientRow.site_url || null,
    };
    const hasBusiness = !!(business.name && (business.phone || business.services || business.areas));
    return json({ blocks, reviews, business: hasBusiness ? business : null });
  } catch (_e) {
    return json({ blocks: {}, reviews: null, business: null });   // never error the visitor's page; just render nothing
  }
});
