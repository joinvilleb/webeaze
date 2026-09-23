#!/usr/bin/env node
/*
 * Builds everything the client portal needs to know about the help centre, from the live
 * help/<slug>/index.html pages.
 *
 *   node scripts/build-help-kb.js           write the artifacts
 *   node scripts/build-help-kb.js --check   write nothing, exit 1 if anything would change
 *
 * WHY ONE COMMAND: this was two scripts in scratchpad/, run by hand and easy to forget. They
 * drifted twice. Once the knowledge base held 186 articles against the site's 172, including 14
 * that had been merged away months earlier, so the assistant answered from content that no longer
 * existed. The index drifted separately to 177. Building all three artifacts in one pass means
 * they cannot disagree about what exists.
 *
 * WHY NOT part of scripts/build-site.js: that builds dist/ for the public site from `git ls-files`,
 * and portal/ is gitignored, so it never sees these files. The portal also deploys separately.
 *
 * Source of truth is the generated pages, NOT help.html, because a page can legitimately be ahead
 * of the source (see scripts/sync-help-index.js).
 *
 * Outputs:
 *   portal/help-content.json   plain text bodies, what the chat assistant reads. Keys s,t,m,b.
 *   portal/help-articles.json  sanitised HTML bodies, what the in-portal reader renders.
 *   portal/help-index.js       search index with distinctive body terms. Keys s,t,m,k.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const HELP = path.join(ROOT, 'help');
const PORTAL = path.join(ROOT, 'portal');
const CHECK = process.argv.includes('--check');

// ── shared text helpers, carried over from the scripts this replaces ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', ndash: '-', mdash: ', ', middot: '·', copy: '©' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
  return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
});
const noDash = (s) => s.replace(/\s*—\s*/g, ', ');

// ── collect the articles ──
const slugs = fs.readdirSync(HELP).sort().filter(s => fs.existsSync(path.join(HELP, s, 'index.html')));
const raw = [];
for (const slug of slugs) {
  const html = fs.readFileSync(path.join(HELP, slug, 'index.html'), 'utf8');
  const bi = html.indexOf('<section class="article-body">');
  if (bi < 0) continue;                                   // meta-refresh redirect stub
  let body = html.slice(bi + '<section class="article-body">'.length);
  const cut = body.search(/<div class="article-related"|<\/section>/);
  if (cut >= 0) body = body.slice(0, cut);
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || slug;
  raw.push({
    s: slug,
    t: noDash(decode(h1.replace(/<[^>]+>/g, '')).trim()),
    m: noDash(decode(((html.match(/data-topic-label="([^"]*)"/) || [])[1] ? (html.match(/data-topic-label="([^"]*)"/) || [])[1] + '. ' : '') + ((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '')).trim()),
    html: body,
  });
}
const SLUGS = new Set(raw.map(a => a.s));

/*
 * One classifier, used by both emitters, so the plain-text file and the HTML file can never
 * disagree about what a link points at. Order matters: webeaze.io and portal.webeaze.io must be
 * tested before the generic https branch or absolute site links get filed as external.
 */
function classifyHref(href) {
  const h = String(href || '').trim();
  if (/^mailto:/i.test(h)) return { kind: 'mailto' };
  if (/^tel:/i.test(h)) return { kind: 'tel' };
  if (/^#(?!\/)/.test(h)) return { kind: 'anchor' };
  if (/^https?:\/\/portal\.webeaze\.io/i.test(h)) {
    const frag = (h.match(/#([a-zA-Z0-9-]+)/) || [])[1] || null;
    return { kind: 'portal', value: frag };
  }
  let p = h.replace(/^https?:\/\/(www\.)?webeaze\.io/i, '');
  const sib = p.match(/(?:^|\/)help\/([a-z0-9-]+)\/?(?:index\.html)?(?:[#?].*)?$/)
           || p.match(/^\.\.\/([a-z0-9-]+)\/(?:index\.html)?(?:[#?].*)?$/)
           || p.match(/^#\/([a-z0-9-]+)$/);
  if (sib) return SLUGS.has(sib[1]) ? { kind: 'help', value: sib[1] } : { kind: 'dead', value: sib[1] };
  // p !== h means the webeaze.io prefix was stripped above, so this is our own site even though
  // it is written as an absolute URL. Testing /^https?:/ first filed 19 of them as external.
  const ourSite = p !== h || !/^https?:/i.test(h);
  if (ourSite && p) return { kind: 'site', value: 'https://webeaze.io/' + p.replace(/^(\.\.\/)+/, '').replace(/^\//, '') };
  if (/^https?:/i.test(h)) return { kind: 'external', value: h.replace(/[#?].*$/, '') };
  return { kind: 'other' };
}

// ── emitter 1: plain text for the assistant, with links named inline so it can cite them ──
function toText(html, annotate) {
  const annotated = !annotate ? html : html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, label) => {
    const href = (attrs.match(/href="([^"]*)"/i) || [])[1] || '';
    const c = classifyHref(href);
    if (c.kind === 'help') return label + ' [help article: ' + c.value + ']';
    if (c.kind === 'portal' && c.value) return label + ' [portal: #' + c.value + ']';
    if (c.kind === 'site' || c.kind === 'external') return label + ' (' + c.value + ')';
    return label;
  });
  let s = annotated.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    // An icon that stands in for words ("select [person icon] in the top right corner") has to read
    // as words here, or the assistant quotes a step with a hole in it.
    .replace(/<span[^>]*aria-label="([^"]*)"[^>]*>[\s\S]*?<\/span>/gi, (m, label) => label)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div|ul|ol|tr|details|summary|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  s = decode(s).replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return noDash(s);
}

// ── emitter 2: sanitised HTML for the in-portal reader ──
const KEEP = new Set(['p','h2','h3','h4','ul','ol','li','strong','em','b','i','u','a','img','table','thead','tbody','tr','td','th','blockquote','code','pre','div','span','dl','dt','dd','details','summary','figure','figcaption','br','hr']);
function toHtml(html) {
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?([a-z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (m, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!KEEP.has(tag)) return '';                       // drop the tag, keep its text
    if (m[1] === '/') return '</' + tag + '>';
    const keptAttrs = [];
    for (const a of attrs.matchAll(/([a-z-]+)\s*=\s*"([^"]*)"/gi)) {
      const name = a[1].toLowerCase(), val = a[2];
      if (/^on/i.test(name)) continue;                   // no inline handlers reach the portal
      // role/aria-label ride along because an icon can now stand in for words ("select [person
      // icon] in the top right corner"), and dropping its label leaves a screen reader with a hole
      // in the sentence. They carry no behaviour.
      if (name === 'href' || name === 'src' || name === 'alt' || name === 'class'
          || name === 'width' || name === 'height' || name === 'loading' || name === 'title'
          || name === 'role' || name === 'aria-label' || name === 'aria-hidden') {
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) continue;
        keptAttrs.push(name + '="' + val.replace(/"/g, '&quot;') + '"');
      }
    }
    return '<' + tag + (keptAttrs.length ? ' ' + keptAttrs.join(' ') : '') + '>';
  });
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

const content = raw.map(a => ({ s: a.s, t: a.t, m: a.m, b: toText(a.html, true) }));
// The index is built from UNannotated text. Feeding it the annotated bodies pushed slug words and
// URL fragments ("https", "webeaze", "pricing", "html") into the distinctive-term lists and changed
// the search corpus for 117 of 172 articles.
const plain = raw.map(a => ({ s: a.s, t: a.t, m: a.m, b: toText(a.html, false) }));
const articles = raw.map(a => ({ s: a.s, t: a.t, m: a.m, b: toHtml(a.html) }));

// ── emitter 3: the search index, ported verbatim from build-help-index.js ──
const STOP = new Set(('the a an and or to of for my your our is are be being been am was were do does did can could ' +
  'will would should may might must have has had it its this that these those with without on in into at as if so ' +
  'but not no yes you we i they he she them us he her his their there here when what which who whom whose why how ' +
  'from by about after before while during over under again further then once all any both each few more most other ' +
  'some such only own same than too very just now also get got make makes made take takes want need needs use uses ' +
  'using like well back even still way says say said one two three first second next last new old good best ' +
  'webeaze website site page pages help please thanks email us your you').split(/\s+/));
const df = new Map();
const perDoc = plain.map((a) => {
  const words = String(a.b || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  const counts = new Map();
  for (const w of words) { if (STOP.has(w)) continue; counts.set(w, (counts.get(w) || 0) + 1); }
  for (const w of counts.keys()) df.set(w, (df.get(w) || 0) + 1);
  return counts;
});
const N = plain.length;
const index = plain.map((a, i) => {
  const inTitle = new Set((String(a.t + ' ' + a.m + ' ' + a.s.replace(/-/g, ' ')).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []));
  const scored = [...perDoc[i].entries()]
    .filter(([w]) => !inTitle.has(w))
    .filter(([w]) => (df.get(w) || 0) <= N * 0.25)
    .map(([w, c]) => [w, c * Math.log(N / (df.get(w) || 1))])
    .sort((x, y) => y[1] - x[1]).slice(0, 18).map(([w]) => w);
  return { s: a.s, t: a.t, m: String(a.m || '').slice(0, 160), k: scored.join(' ') };
});

// ── integrity: every link must be accounted for, and nothing may point at a missing article ──
let linkTotal = 0; const byKind = {}; const dead = [];
for (const a of raw) {
  for (const m of a.html.matchAll(/<a\b[^>]*href="([^"]*)"/gi)) {
    linkTotal++;
    const c = classifyHref(m[1]);
    byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    if (c.kind === 'dead') dead.push(a.s + ' -> ' + c.value);
  }
}
const accounted = Object.values(byKind).reduce((x, y) => x + y, 0);

// ── write, or report ──
const files = [
  ['help-content.json', JSON.stringify(content)],
  ['help-articles.json', JSON.stringify(articles)],
  ['help-index.js',
    '// Auto-generated from the help/ pages by scripts/build-help-kb.js. Do not edit by hand.\n' +
    '// ' + index.length + ' articles. `k` holds the distinctive body terms, so a request described in the client\'s\n' +
    '// own words can still find the article that answers it.\n' +
    'window.WEBEAZE_HELP = ' + JSON.stringify(index) + ';\n'],
];
const changed = [];
for (const [name, body] of files) {
  const p = path.join(PORTAL, name);
  const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (prev !== body) changed.push(name);
  if (!CHECK) fs.writeFileSync(p, body);
}

const gz = zlib.gzipSync(Buffer.from(files[1][1])).length;
console.log(`${content.length} articles from ${slugs.length} folders (${slugs.length - content.length} redirect stubs skipped)`);
console.log(`  help-content.json   ${(files[0][1].length / 1024).toFixed(0)}KB`);
console.log(`  help-articles.json  ${(files[1][1].length / 1024).toFixed(0)}KB raw, ${(gz / 1024).toFixed(0)}KB gzipped`);
console.log(`  help-index.js       ${(files[2][1].length / 1024).toFixed(0)}KB`);
console.log(`  links: ${linkTotal} classified as ${Object.entries(byKind).map(([k, v]) => k + ' ' + v).join(', ')}`);
if (accounted !== linkTotal) { console.error(`  ERROR: ${linkTotal - accounted} link(s) unclassified`); process.exit(1); }
if (dead.length) { console.error('  ERROR: links to articles that do not exist:\n    ' + dead.join('\n    ')); process.exit(1); }

if (CHECK) {
  if (changed.length) { console.error('\nSTALE: would rewrite ' + changed.join(', ') + '. Run: node scripts/build-help-kb.js'); process.exit(1); }
  console.log('\nup to date');
} else {
  console.log(changed.length ? '\nwrote ' + changed.join(', ') : '\nno change');
}
