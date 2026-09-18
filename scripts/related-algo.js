/*
 * Chooses "Related articles" for a help article.
 *
 * WHY: RELATED_MAP was hand-curated and covers 65 of 171 articles, so 107 article pages
 * ended with nothing to click. This fills the gap without anyone hand-writing 107 more
 * entries, and is shared by scripts/build-help.js (new pages) and
 * scripts/backfill-related.js (the pages that already exist) so the two cannot drift.
 *
 * Curated entries always win. The fallback only fires when curation runs short.
 */
const STOP = new Set(('a an the and or but if of to in on for with your you we our is are it this ' +
  'that can be as at from will not do does have has they them their my me i what how why when ' +
  'does no yes get got any all some more most just like about into out up down over under').split(' '));

const words = s => String(s || '').toLowerCase().replace(/<[^>]*>/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));

/**
 * Inverse document frequency. Without it the common words swamp everything: "website" and
 * "business" appear in most articles, so "Can you design a logo for my business?" matched
 * Google Business Profile on the word "business" alone. A word shared by two articles only
 * means something if few other articles use it.
 */
function buildIdf(corpus) {
  const df = new Map(), n = Object.keys(corpus).length;
  for (const d of Object.values(corpus)) {
    for (const w of new Set([...words(d.title), ...words(d.meta)])) df.set(w, (df.get(w) || 0) + 1);
  }
  const idf = new Map();
  for (const [w, c] of df) idf.set(w, Math.log(n / (1 + c)));
  return idf;
}

/**
 * corpus: { slug: { title, meta, topicId } }
 * Returns up to `want` slugs, curated first, then scored.
 *
 * Scoring notes, both learned from simulating this over the whole corpus:
 *  - divide by sqrt(candidate length) or articles with long meta descriptions win everything
 *    (unnormalised, one article was picked 21 times and 25 were never picked at all)
 *  - penalise articles already used a lot, so the long tail surfaces
 */
function relatedFor(slug, corpus, curated, usedCount, want = 3, idf = null) {
  idf = idf || buildIdf(corpus);
  const W = w => Math.max(0.05, idf.get(w) || 0);
  const out = [];
  for (const s of (curated[slug] || [])) {
    if (s !== slug && corpus[s] && !out.includes(s)) out.push(s);
    if (out.length >= want) return out;
  }

  const self = corpus[slug];
  if (!self) return out;
  // A word shared with the TITLE says far more than one shared with the meta blurb.
  // Weighting them equally is what made "Can you design a logo" suggest the AI chatbot.
  const myTitle = new Set(words(self.title));
  const myMeta = new Set(words(self.meta));
  if (!myTitle.size && !myMeta.size) return out;

  const scored = [];
  for (const [cand, d] of Object.entries(corpus)) {
    if (cand === slug || out.includes(cand)) continue;
    const theirTitle = new Set(words(d.title));
    const theirAll = new Set([...theirTitle, ...words(d.meta)]);
    if (!theirAll.size) continue;
    let score = 0;
    for (const w of theirTitle) {
      if (myTitle.has(w)) score += 3 * W(w);        // title to title, the strongest signal
      else if (myMeta.has(w)) score += 1.2 * W(w);
    }
    for (const w of theirAll) {
      if (theirTitle.has(w)) continue;
      if (myTitle.has(w)) score += 1.2 * W(w);
      else if (myMeta.has(w)) score += 0.5 * W(w);
    }
    if (!score) continue;
    score = score / Math.sqrt(theirAll.size);
    // Same topic is a hint, not a trump card. At 1.6 it buried better cross-topic matches.
    if (d.topicId && d.topicId === self.topicId) score *= 1.22;
    const used = usedCount[cand] || 0;
    if (used >= 6) score *= 0.45;                                 // stop the same few dominating
    else if (used >= 3) score *= 0.8;
    scored.push([cand, score]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [cand] of scored) {
    if (out.length >= want) break;
    out.push(cand);
  }
  out.forEach(s => { usedCount[s] = (usedCount[s] || 0) + 1; });
  return out;
}

module.exports = { relatedFor, words, buildIdf };
