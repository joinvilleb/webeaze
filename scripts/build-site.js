#!/usr/bin/env node
/*
 * Assembles the public website into dist/.
 *
 * WHY THIS EXISTS: GitHub Pages serves the whole repository, so webeaze.io currently
 * publishes supabase/*.sql (schema and RLS policies), _worker/worker.js and our build
 * tooling. Pointing a host at the repo root would carry that across. This copies only
 * what belongs on the public site, so the deploy is explicit about what ships.
 *
 * Source of truth is `git ls-files`, so anything untracked (portal/, node_modules/)
 * can never leak in by accident.
 *
 *   node scripts/build-site.js            build dist/
 *   node scripts/build-site.js --verify   build, then check every internal link resolves
 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');

const OUT = 'dist';

// Kept out of the public site. Everything else in the repo ships.
const DENY = [
  /^supabase\//,            // database schema, triggers, RLS policies
  /^scripts\//,             // build tooling, including this file
  /^_worker\//,             // request-bot source and its wrangler account cache
  /^\.wrangler\//,
  /^scratchpad\//,
  /^archive\//,
  /^social-media\//,        // internal post generator, not linked from the site
  /^client-assets\//,       // deliverables made for clients, hosted on their own sites
  /\.sql$/,
  /^netlify\.toml$/,        // inert leftover from a host we never used
  /^CNAME$/, /^\.nojekyll$/, // GitHub Pages specific
  /^\.DS_Store$/, /(^|\/)\.DS_Store$/,
  /^\.gitignore$/, /^\.gitattributes$/,
  /^README\.md$/, /^SITE-REPORT-.*\.md$/,
];

const tracked = execSync('git ls-files -z', { maxBuffer: 1 << 28 })
  .toString().split('\0').filter(Boolean);
const keep = tracked.filter(f => !DENY.some(re => re.test(f)));

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of keep) {
  const dest = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f, dest);
}
console.log(`built ${OUT}/  ${keep.length} files kept, ${tracked.length - keep.length} withheld`);

if (!process.argv.includes('--verify')) return;

// ---- verify: every internal reference must resolve inside dist ----
const htmls = keep.filter(f => f.endsWith('.html'));
const exists = p => fs.existsSync(path.join(OUT, p));
const broken = new Map();
for (const f of htmls) {
  const html = fs.readFileSync(path.join(OUT, f), 'utf8');
  const dir = path.dirname(f);
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  for (const r of refs) {
    if (/^(https?:|mailto:|tel:|data:|#|\/\/|javascript:)/i.test(r)) continue;
    const clean = r.split('#')[0].split('?')[0];
    if (!clean) continue;
    let target = clean.startsWith('/') ? clean.slice(1) : path.normalize(path.join(dir, clean));
    if (exists(target) || exists(target + '.html') ||
        exists(path.join(target, 'index.html')) || exists(target.replace(/\/$/, '/index.html'))) continue;
    if (!broken.has(clean)) broken.set(clean, []);
    broken.get(clean).push(f);
  }
}
if (!broken.size) { console.log('verify: every internal link and asset resolves inside dist/'); return; }
console.log(`verify: ${broken.size} unresolved references`);
[...broken.entries()].slice(0, 40).forEach(([r, from]) =>
  console.log(`   ${r}\n      from ${from.slice(0, 3).join(', ')}${from.length > 3 ? ` +${from.length - 3} more` : ''}`));
