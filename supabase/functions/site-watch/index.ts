// Supabase Edge Function: site-watch
// Proactive site monitoring. For each active client it checks that the site is reachable,
// the domain is not about to expire, and homepage links are not broken. New problems are
// logged in `site_issues` and emailed to Billy as a digest. Problems that clear on their own
// (site back up, link works again) auto-resolve with a client-facing note, which is what the
// portal shows as "recently handled".
//
// Deploy:   supabase functions deploy site-watch
// Schedule: see supabase/site_issues.sql (pg_cron, every 6 hours, x-cron-secret header)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = 'WebEaze <support@webeaze.io>';
const TEAM = 'billy@webeaze.io';
const DOMAIN_WARN_DAYS = 30;   // warn when the domain expires within this many days
const MAX_LINKS = 15;          // cap homepage links we test, to stay fast and polite

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function fullUrl(u: string) { return /^https?:\/\//i.test(u) ? u : 'https://' + u; }
function hostOf(u: string) { return (u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase(); }
function registrableDomain(host: string) {
  host = (host || '').replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const two = ['co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'co.in'];
  return two.includes(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

async function fetchTimed(url: string, opts: RequestInit = {}, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

// Homepage reachability + HTML (for the link scan). ok=false means the site looks down.
async function checkHomepage(siteUrl: string): Promise<{ ok: boolean; status: number; html: string; error?: string }> {
  try {
    const res = await fetchTimed(fullUrl(siteUrl), { headers: { 'User-Agent': 'WebEaze-Monitor/1.0' } }, 12000);
    const html = res.status < 400 ? await res.text().catch(() => '') : '';
    return { ok: res.status < 400, status: res.status, html };
  } catch (e) { return { ok: false, status: 0, html: '', error: String(e).slice(0, 120) }; }
}

// Same-site links from the homepage, absolute-ised, de-duped, capped.
function internalLinks(html: string, siteUrl: string): string[] {
  const base = fullUrl(siteUrl);
  const host = hostOf(siteUrl);
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.size < 80) {
    let href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try {
      const abs = new URL(href, base);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
      if (hostOf(abs.host) !== host) continue;   // internal only
      abs.hash = '';
      out.add(abs.toString());
    } catch { /* skip bad href */ }
  }
  return [...out].slice(0, MAX_LINKS);
}

async function linkBroken(url: string): Promise<boolean> {
  try {
    let res = await fetchTimed(url, { method: 'HEAD', headers: { 'User-Agent': 'WebEaze-Monitor/1.0' } }, 8000);
    if (res.status === 405 || res.status === 501) res = await fetchTimed(url, { method: 'GET', headers: { 'User-Agent': 'WebEaze-Monitor/1.0' } }, 8000);
    return res.status >= 400;   // hard error only
  } catch { return false; }     // network hiccup: don't cry wolf
}

// Domain expiry via RDAP (best-effort; many TLDs unsupported → returns null and we skip).
async function domainDaysLeft(domain: string): Promise<number | null> {
  try {
    const res = await fetchTimed('https://rdap.org/domain/' + encodeURIComponent(domain), { headers: { Accept: 'application/rdap+json' } }, 9000);
    if (!res.ok) return null;
    const d = await res.json();
    const ev = (d.events || []).find((e: any) => e.eventAction === 'expiration');
    if (!ev?.eventDate) return null;
    const days = Math.round((new Date(ev.eventDate).getTime() - Date.now()) / 86400000);
    return Number.isFinite(days) ? days : null;
  } catch { return null; }
}

async function sendEmail(payload: Record<string, unknown>) {
  if (!RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Unauthorized' }, 401);

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: clients } = await service.from('clients')
    .select('user_id, id, name, site_url, status')
    .not('site_url', 'is', null).neq('status', 'inactive');

  // What we tell Billy about, at the end.
  const newIssues: Array<{ client: string; kind: string; detail: string }> = [];
  let checked = 0, resolved = 0;

  for (const c of clients ?? []) {
    try {
      // Currently-open issues for this client, so we can dedupe and auto-resolve.
      const { data: openRows } = await service.from('site_issues').select('id, kind, url').eq('user_id', c.user_id).eq('status', 'open');
      const open = openRows ?? [];
      const openKey = new Set(open.map((o: any) => o.kind + '|' + (o.url || '')));
      const fixIssue = async (id: string, note: string) => {
        await service.from('site_issues').update({ status: 'fixed', fixed_at: new Date().toISOString(), client_note: note }).eq('id', id);
        resolved++;
      };
      const raiseIssue = async (kind: string, detail: string, url?: string) => {
        if (openKey.has(kind + '|' + (url || ''))) return;   // already tracking this one
        await service.from('site_issues').insert({ user_id: c.user_id, client_id: c.id ?? null, kind, detail, url: url || null, notified: true });
        newIssues.push({ client: c.name || c.site_url || c.user_id, kind, detail });
      };

      const home = await checkHomepage(c.site_url);
      checked++;

      // 1) Reachability.
      if (!home.ok) {
        await raiseIssue('down', 'Homepage returned ' + (home.status || 'no response') + (home.error ? ' (' + home.error + ')' : ''));
      } else {
        // Site is up: auto-resolve any open 'down' issue.
        for (const o of open) if (o.kind === 'down') await fixIssue(o.id, 'Your website is back online and loading normally.');
      }

      // 2) Broken homepage links (only when the site is up).
      if (home.ok && home.html) {
        const links = internalLinks(home.html, c.site_url);
        const broken = new Set<string>();
        for (const link of links) if (await linkBroken(link)) broken.add(link);
        for (const link of broken) await raiseIssue('broken_link', 'A link on the homepage is broken (404).', link);
        // Auto-resolve open broken_link issues whose URL now works.
        for (const o of open) {
          if (o.kind === 'broken_link' && o.url && !broken.has(o.url)) {
            if (!(await linkBroken(o.url))) await fixIssue(o.id, 'The broken link on your site has been fixed.');
          }
        }
      }

      // 3) Domain expiry.
      const days = await domainDaysLeft(registrableDomain(hostOf(c.site_url)));
      if (days != null && days <= DOMAIN_WARN_DAYS && days >= 0) {
        await raiseIssue('domain_expiring', 'Domain renews in ' + days + ' day' + (days === 1 ? '' : 's') + '.');
      } else if (days != null && days > 45) {
        for (const o of open) if (o.kind === 'domain_expiring') await fixIssue(o.id, 'Your domain renewal is sorted, you are all set.');
      }
    } catch (e) { console.error('[site-watch] client failed', c.user_id, e); }
  }

  // One digest email to Billy for everything new this run.
  if (newIssues.length) {
    const rows = newIssues.map((i) => '<li style="margin-bottom:6px;"><strong>' + i.client + '</strong> (' + i.kind.replace('_', ' ') + '): ' + i.detail + '</li>').join('');
    await sendEmail({
      from: FROM, to: [TEAM],
      subject: 'Site watch: ' + newIssues.length + ' new issue' + (newIssues.length === 1 ? '' : 's') + ' to look at',
      html: '<p>The site watcher found ' + newIssues.length + ' new issue' + (newIssues.length === 1 ? '' : 's') + ':</p><ul>' + rows + '</ul><p>Mark each fixed in the admin once handled, and the client will see it as "recently handled".</p>',
    });
  }

  return json({ ok: true, checked, newIssues: newIssues.length, resolved });
});
