// Supabase Edge Function: outreach-sync
// Stage 3 of the lead-acquisition machine. Pushes drafted email prospects into an Instantly
// campaign as leads, with the AI-written copy carried as per-lead custom variables. Instantly
// then handles the actual sending, warmup, follow-ups, and reply detection.
//
// Each lead carries these custom variables (reference them in your Instantly campaign steps):
//   {{ai_subject}} {{ai_body}}   ·   {{ai_fu1_subject}} {{ai_fu1_body}}   ·   {{ai_fu2_subject}} {{ai_fu2_body}}
//
// Entry (POST): { action:'sync', limit?, campaign? }   limit defaults to 10; campaign overrides the env id.
// Auth: admin (billy@webeaze.io) JWT, OR x-cron-secret (for the daily cron).
// Secrets: INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID, CRON_SECRET.
//
// Deploy: supabase functions deploy outreach-sync   (Verify JWT OFF — self-auths)
// Docs:   https://developer.instantly.ai/api/v2/lead/createlead

import { createClient } from 'jsr:@supabase/supabase-js@2';

const INSTANTLY_API_KEY = Deno.env.get('INSTANTLY_API_KEY') ?? '';
const INSTANTLY_CAMPAIGN_ID = Deno.env.get('INSTANTLY_CAMPAIGN_ID') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const ADMIN_EMAIL = 'billy@webeaze.io';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Add one lead (with its AI copy as custom variables) to the Instantly campaign.
// Returns the Instantly lead id, or throws.
async function addLead(campaign: string, p: any): Promise<string> {
  const seq = p.outreach || {};
  const fu = Array.isArray(seq.followups) ? seq.followups : [];
  const payload = {
    campaign,
    email: p.email,
    company_name: p.name || undefined,
    website: p.website || undefined,
    phone: p.phone || undefined,
    skip_if_in_campaign: true,
    skip_if_in_workspace: true,
    // Custom variables must be flat (string/number/boolean/null). Our copy is strings.
    custom_variables: {
      ai_subject: String(seq.subject || ''),
      ai_body: String(seq.body || ''),
      ai_fu1_subject: String(fu[0]?.subject || ''),
      ai_fu1_body: String(fu[0]?.body || ''),
      ai_fu2_subject: String(fu[1]?.subject || ''),
      ai_fu2_body: String(fu[1]?.body || ''),
    },
  };
  const res = await fetch('https://api.instantly.ai/api/v2/leads', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + INSTANTLY_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Instantly ' + res.status + ': ' + JSON.stringify(data).slice(0, 200));
  return data.id || data.lead_id || '';
}

async function doSync(sb: any, limit: number, campaign: string) {
  if (!INSTANTLY_API_KEY) throw new Error('INSTANTLY_API_KEY not set');
  if (!campaign) throw new Error('No Instantly campaign id (set INSTANTLY_CAMPAIGN_ID or pass campaign)');

  // Drafted email leads not yet handed to Instantly.
  const { data: rows, error } = await sb.from('prospects')
    .select('id, name, email, website, phone, outreach')
    .eq('status', 'drafted').eq('channel', 'email').not('email', 'is', null).not('outreach', 'is', null)
    .order('score', { ascending: false }).limit(Math.min(Math.max(1, limit | 0), 25));
  if (error) throw new Error('select: ' + error.message);
  if (!rows?.length) return { synced: 0, failed: 0, prospects: [] };

  let synced = 0, failed = 0;
  const out: any[] = [];
  for (const p of rows) {
    try {
      const leadId = await addLead(campaign, p);
      const merged = { ...(p.outreach || {}), instantlyLeadId: leadId || null, sentAt: new Date().toISOString() };
      await sb.from('prospects').update({ status: 'sent', outreach: merged, updated_at: new Date().toISOString() }).eq('id', p.id);
      synced++; out.push({ name: p.name, email: p.email, ok: true });
    } catch (e) {
      failed++; out.push({ name: p.name, email: p.email, ok: false, error: String(e).slice(0, 160) });
      console.error('[sync] lead failed', p.email, e);
    }
  }
  return { synced, failed, prospects: out };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

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
    const campaign = String(body.campaign || INSTANTLY_CAMPAIGN_ID || '').trim();
    const out = await doSync(service, Number(body.limit) || 10, campaign);
    return json({ ok: true, ...out });
  } catch (e) {
    console.error('outreach-sync error:', e);
    return json({ error: String(e) }, 500);
  }
});
