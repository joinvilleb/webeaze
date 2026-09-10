// Rebuild portal/help-index.js from help-content.json (the KB the chatbot reads, generated in turn
// from the help/ article folders). The old index was generated from help.html and had drifted: 177
// articles against the KB's 186, so nine articles could never be suggested to anyone.
//
// Each entry carries slug, title, meta and `k`: the terms from the BODY that actually distinguish
// this article from the rest of the set. Title and meta alone cannot match "my hours are wrong on
// the contact page" to the article that answers it.
const fs = require('fs');
const KB = JSON.parse(fs.readFileSync('/Users/billyjoinville/GitHub/webeaze/portal/help-content.json', 'utf8'));

const STOP = new Set(('the a an and or to of for my your our is are be being been am was were do does did can could ' +
  'will would should may might must have has had it its this that these those with without on in into at as if so ' +
  'but not no yes you we i they he she them us he her his their there here when what which who whom whose why how ' +
  'from by about after before while during over under again further then once all any both each few more most other ' +
  'some such only own same than too very just now also get got make makes made take takes want need needs use uses ' +
  'using like well back even still way says say said one two three first second next last new old good best ' +
  'webeaze website site page pages help please thanks email us your you').split(/\s+/));

// A term earns its place by being rare across the set: a word in half the articles tells you nothing.
const df = new Map();
const perDoc = KB.map((a) => {
  const words = String(a.b || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  const counts = new Map();
  for (const w of words) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  for (const w of counts.keys()) df.set(w, (df.get(w) || 0) + 1);
  return counts;
});

const N = KB.length;
const out = KB.map((a, i) => {
  const inTitle = new Set((String(a.t + ' ' + a.m + ' ' + a.s.replace(/-/g, ' ')).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []));
  const scored = [...perDoc[i].entries()]
    .filter(([w]) => !inTitle.has(w))                    // the title already matches those
    .filter(([w]) => (df.get(w) || 0) <= N * 0.25)       // drop boilerplate that is in a quarter of the set
    .map(([w, c]) => [w, c * Math.log(N / (df.get(w) || 1))])
    .sort((x, y) => y[1] - x[1])
    .slice(0, 18)
    .map(([w]) => w);
  return { s: a.s, t: a.t, m: String(a.m || '').slice(0, 160), k: scored.join(' ') };
});

const header = `// Auto-generated from help-content.json by scratchpad/build-help-index.js. Do not edit by hand.
// ${out.length} articles. \`k\` holds the distinctive body terms, so a request described in the client's
// own words can still find the article that answers it.
`;
fs.writeFileSync('/Users/billyjoinville/GitHub/webeaze/portal/help-index.js',
  header + 'window.WEBEAZE_HELP = ' + JSON.stringify(out) + ';\n');
console.log('wrote ' + out.length + ' articles, ' +
  Math.round(fs.statSync('/Users/billyjoinville/GitHub/webeaze/portal/help-index.js').size / 1024) + 'KB');
console.log('sample:', JSON.stringify(out.find(a => /hours|contact/i.test(a.t)) || out[0]).slice(0, 300));
