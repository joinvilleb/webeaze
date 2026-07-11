#!/usr/bin/env node
/*
 * sync-help-index.js — reverse-sync: pull edited standalone help pages BACK into
 * help.html's HELP_DATA so the help hub's search/browse index matches what you
 * actually edited. Standalone pages (help/<slug>/index.html) are the source of
 * truth; this updates the HELP_DATA body for any article whose page text differs.
 *
 * Body-only sync (title/meta are left alone). Run after editing help pages:
 *   node scripts/sync-help-index.js            # apply
 *   node scripts/sync-help-index.js --dry-run  # just report what would change
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HELP = path.join(ROOT, 'help.html');
const DRY = process.argv.includes('--dry-run');
let help = fs.readFileSync(HELP, 'utf8');

function between(a, b) { const s = help.indexOf(a), e = help.indexOf(b, s); return help.slice(s, e); }
function objLit(mark) { const s = help.indexOf(mark); let i = help.indexOf('{', s), d = 0; for (; i < help.length; i++) { if (help[i] === '{') d++; else if (help[i] === '}') { d--; if (!d) { i++; break; } } } while (i < help.length && help[i] !== ';') i++; return help.slice(s, i + 1); }
const dataScript = between('const HELP_DATA = {', 'const INDEX = indexArticles(HELP_DATA);') + 'const INDEX = indexArticles(HELP_DATA);';
const { HELP_DATA } = new Function(dataScript + '\n' + objLit('const RELATED_MAP = {') + '\n return {HELP_DATA};')();

const revBody = b => b
  .replace(/\s*id="toc-[0-9a-z]+"/g, '')
  .replace(/(href|src)="\.\.\/([a-z0-9-]+)\/"/g, '$1="#/$2"')
  .replace(/(href|src)="\.\.\/\.\.\/([^"]*)"/g, '$1="$2"');
const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

let synced = 0, skipped = [], changes = [];
HELP_DATA.topics.forEach(t => t.articles.forEach(a => {
  const f = path.join(ROOT, 'help', a.slug, 'index.html');
  if (!fs.existsSync(f)) return;
  const m = fs.readFileSync(f, 'utf8').match(/<section class="article-body">([\s\S]*?)<\/section>/);
  if (!m) return;
  const pageBody = revBody(m[1]).trim();
  if (strip(pageBody) === strip(a.body)) return;
  changes.push(a.slug);
  if (DRY) return;
  if (pageBody.includes('`') || pageBody.includes('${')) { skipped.push(a.slug + '(backtick)'); return; }
  const slugIdx = help.indexOf(`slug: '${a.slug}'`);
  if (slugIdx < 0) { skipped.push(a.slug + '(no-slug)'); return; }
  const key = help.indexOf('body: `', slugIdx), s2 = key + 7, e2 = help.indexOf('`', s2);
  if (key < 0 || e2 < 0) { skipped.push(a.slug + '(delim)'); return; }
  help = help.slice(0, s2) + '\n\n        ' + pageBody + '\n        ' + help.slice(e2);
  synced++;
}));
if (DRY) { console.log(`Would sync ${changes.length} article(s): ${changes.join(', ') || 'none'}`); process.exit(0); }
if (synced) fs.writeFileSync(HELP, help);
console.log(`Synced ${synced} article bodies into HELP_DATA; skipped: ${skipped.join(', ') || 'none'}`);
