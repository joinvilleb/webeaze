// Rebuild portal/help-content.json (the chatbot KB) from the LIVE help article folders.
//   node scratchpad/rebuild-help-kb.js [--check]
// --check writes nothing and reports how many articles would change, so an extractor change
// cannot silently rewrite all 186 entries.
// Per article: s = folder, t = <h1>, m = data-topic-label + ". " + meta description,
// b = text of <section class="article-body">. Redirect stubs (no article-body) are skipped.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HELP = path.join(ROOT, 'help');
const OUT = path.join(ROOT, 'portal', 'help-content.json');
const CHECK = process.argv.includes('--check');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', ndash: '-', mdash: ', ', middot: '·', copy: '©' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
  return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
});
const noDash = (s) => s.replace(/\s*—\s*/g, ', ');
function text(html) {
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div|ul|ol|tr|details|summary|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  s = decode(s).replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return noDash(s);
}

const out = [];
for (const slug of fs.readdirSync(HELP).sort()) {
  const f = path.join(HELP, slug, 'index.html');
  if (!fs.existsSync(f)) continue;
  const html = fs.readFileSync(f, 'utf8');
  const bi = html.indexOf('<section class="article-body">');
  if (bi < 0) continue;
  let body = html.slice(bi + '<section class="article-body">'.length);
  const cut = body.search(/<div class="article-related"|<\/section>/);
  if (cut >= 0) body = body.slice(0, cut);
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || slug;
  const topic = (html.match(/data-topic-label="([^"]*)"/) || [])[1] || '';
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  out.push({ s: slug, t: noDash(decode(h1.replace(/<[^>]+>/g, '')).trim()), m: noDash(decode((topic ? topic + '. ' : '') + desc).trim()), b: text(body) });
}

const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const oldBy = new Map(old.map(a => [a.s, JSON.stringify(a)]));
const changed = out.filter(a => oldBy.get(a.s) !== JSON.stringify(a)).map(a => a.s);
const gone = old.filter(a => !out.some(b => b.s === a.s)).map(a => a.s);
console.log(out.length + ' articles; ' + changed.length + ' changed' + (changed.length <= 20 ? ': ' + changed.join(', ') : '') + (gone.length ? '; removed: ' + gone.join(', ') : ''));
if (!CHECK) fs.writeFileSync(OUT, JSON.stringify(out));
