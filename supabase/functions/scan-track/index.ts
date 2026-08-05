// Supabase Edge Function: scan-track
// The tracking-redirect behind a QR code printed on a postcard / flyer. A prospect scans the QR, which
// points here (e.g. .../scan-track?c=postcard-oct&to=https://webeaze.io/offer). We log the scan
// (campaign, time, rough country + device from request headers) and then 302-redirect them to the
// destination, so Billy gets attribution on which mailings drive scans plus a warm landing for them.
//
// Deploy:  supabase functions deploy scan-track --no-verify-jwt
// (--no-verify-jwt: the scanner is an anonymous prospect on their phone, not a logged-in user.)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const DEFAULT_DEST = 'https://webeaze.io/consultation';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const campaign = (url.searchParams.get('c') || 'postcard').slice(0, 60);
  // Redirect target: whatever Billy encoded in the QR, as long as it's a real https URL; else our site.
  const to = url.searchParams.get('to') || '';
  const dest = /^https:\/\/[^\s]+$/i.test(to) ? to.slice(0, 600) : DEFAULT_DEST;

  try {
    const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
    await service.from('scan_events').insert({
      campaign,
      country: req.headers.get('cf-ipcountry') || req.headers.get('x-vercel-ip-country') || null,
      ip,
      user_agent: (req.headers.get('user-agent') || '').slice(0, 300) || null,
      referer: (req.headers.get('referer') || '').slice(0, 300) || null,
      dest,
    });
  } catch (_e) { /* never block the redirect if logging fails */ }

  return new Response(null, { status: 302, headers: { Location: dest, 'Cache-Control': 'no-store' } });
});
