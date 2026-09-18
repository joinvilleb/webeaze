/*
 * One-off: give every help article page a "Related articles" block.
 *
 * 107 of the 172 article pages ended dead because RELATED_MAP only covers 65 of them.
 * scripts/build-help.js will not rewrite an existing page, and --force is not an option:
 * a simulated --force run rewrites 54 pages, and 8 of them lose hand-added <img> tags.
 * So this edits the existing files surgically instead, inserting one block immediately
 * before <div class="article-footer">, and touching nothing else on the page.
 *
 *   node scripts/backfill-related.js --dry     report what would change
 *   node scripts/backfill-related.js           write it
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { relatedFor, buildIdf } = require('./related-algo.js');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const src = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');

function literalAfter(marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('not found: ' + marker);
  const open = src.indexOf('{', i);
  let d = 0, q = null, esc = false, j = open;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) { j++; break; } }
  }
  return vm.runInNewContext('(' + src.slice(open, j) + ')');
}
function arrayAfter(marker) {
  const i = src.indexOf(marker), open = src.indexOf('[', i);
  let d = 0, q = null, esc = false, j = open;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '[') d++; else if (c === ']') { d--; if (!d) { j++; break; } }
  }
  return vm.runInNewContext('(' + src.slice(open, j) + ')');
}

const HELP_DATA = literalAfter('const HELP_DATA');
const RELATED_MAP = literalAfter('const RELATED_MAP');

// corpus from the source of truth
const corpus = {};
HELP_DATA.topics.forEach(t => t.articles.forEach(a => {
  corpus[a.slug] = { title: a.title, meta: a.meta || '', topicId: t.id };
}));

// pages that exist on disk but are not in HELP_DATA still need suggestions
const dirs = fs.readdirSync(path.join(ROOT, 'help')).filter(d =>
  fs.existsSync(path.join(ROOT, 'help', d, 'index.html')));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let strays = 0;
for (const d of dirs) {
  if (corpus[d]) continue;
  const html = fs.readFileSync(path.join(ROOT, 'help', d, 'index.html'), 'utf8');
  if (!html.includes('<div class="article-footer"')) continue;        // redirect stub
  const t = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const m = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!t) continue;
  corpus[d] = { title: t.replace(/<[^>]*>/g, '').trim(), meta: m || '', topicId: null };
  strays++;
}
if (strays) console.log(`included ${strays} page(s) present on disk but missing from HELP_DATA`);

const IDF = buildIdf(corpus);   // built once over the whole corpus
const ANCHOR = '<div class="article-footer"';
const usedCount = {};
// seed usage from the curated lists so the fallback does not pile onto already-popular pages
Object.values(RELATED_MAP).forEach(list => (list || []).forEach(s => { usedCount[s] = (usedCount[s] || 0) + 1; }));

let wrote = 0, already = 0, stubs = 0, noAnchor = 0, empty = 0;
for (const d of dirs) {
  const file = path.join(ROOT, 'help', d, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  if (!html.includes(ANCHOR)) { stubs++; continue; }                  // meta-refresh redirect stub
  if (html.includes('article-related')) { already++; continue; }      // curated block already there
  const picks = relatedFor(d, corpus, RELATED_MAP, usedCount, 3, IDF);
  if (!picks.length) { empty++; continue; }
  const block = '<div class="article-related">\n      <h3>Related articles</h3>\n' +
    picks.map(s => `      <a href="../${s}/">${esc(corpus[s].title)}</a>`).join('\n') +
    '\n    </div>\n    ';
  const at = html.indexOf(ANCHOR);
  if (at < 0) { noAnchor++; continue; }
  html = html.slice(0, at) + block + html.slice(at);
  if (!DRY) fs.writeFileSync(file, html);
  wrote++;
}
console.log(`${DRY ? '[dry run] ' : ''}related blocks added: ${wrote}`);
console.log(`  already had one: ${already}   redirect stubs skipped: ${stubs}   no suggestions found: ${empty}   anchor missing: ${noAnchor}`);

// distribution check: is any one article hogging the suggestions?
const top = Object.entries(usedCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
const never = Object.keys(corpus).filter(s => !usedCount[s]).length;
console.log(`  most-suggested: ${top.map(([s, n]) => s + '×' + n).join(', ')}`);
console.log(`  never suggested: ${never} of ${Object.keys(corpus).length}`);
