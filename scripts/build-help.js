#!/usr/bin/env node
/*
 * build-help.js — generate individual, crawlable help-article pages from help.html.
 *
 * WHY: help.html is a hash-router SPA, so all ~180 articles live behind #/slug on ONE URL
 * and are invisible to search engines. This generates a real static page per article at
 * help/<slug>.html (served at /help/<slug>), each indexable, with proper <head>, schema,
 * TOC, related links, and the same design. Re-run whenever help.html content changes.
 *
 * Usage: node scripts/build-help.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const help = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');

// Content-based extraction (resilient to help.html line shifts) ──────────────
function between(startMark, endMark) { // returns [start .. endMark) — endMark excluded
  const s = help.indexOf(startMark); const e = help.indexOf(endMark, s);
  if (s < 0 || e < 0) throw new Error('marker not found: ' + startMark);
  return help.slice(s, e);
}
function sliceMarks(startMark, endMark) { // includes endMark
  const s = help.indexOf(startMark); const e = help.indexOf(endMark, s);
  if (s < 0 || e < 0) throw new Error('marker not found: ' + startMark);
  return help.slice(s, e + endMark.length);
}
function objectLiteral(startMark) { // balanced { .. }; (no nested braces inside strings expected)
  const s = help.indexOf(startMark); let i = help.indexOf('{', s), depth = 0;
  for (; i < help.length; i++) { if (help[i] === '{') depth++; else if (help[i] === '}') { depth--; if (!depth) { i++; break; } } }
  while (i < help.length && help[i] !== ';') i++;
  return help.slice(s, i + 1);
}

// ── 1. Extract data (HELP_DATA + index machinery + RELATED_MAP) and eval it ──
const dataScript = between('const HELP_DATA = {', 'const INDEX = indexArticles(HELP_DATA);') + 'const INDEX = indexArticles(HELP_DATA);';
const relatedScript = objectLiteral('const RELATED_MAP = {');
let HELP_DATA, INDEX, RELATED_MAP;
try {
  const out = new Function(dataScript + '\n' + relatedScript + '\n return { HELP_DATA, INDEX, RELATED_MAP };')();
  ({ HELP_DATA, INDEX, RELATED_MAP } = out);
} catch (e) {
  console.error('Failed to eval help data. Line boundaries may have shifted.', e.message);
  process.exit(1);
}
const bySlug = {};
HELP_DATA.topics.forEach(t => t.articles.forEach(a => { bySlug[a.slug] = { article: a, topic: t }; }));
const readTimeOf = slug => (INDEX.find(x => x.slug === slug) || {}).readTime || 1;

// ── 2. Extract + rewrite nav and footer for the /help/ subdirectory (../ paths) ──
// Pages live at help/<slug>/index.html, so the site root is two levels up (../../).
function rewriteUrl(v) {
  let m = v.match(/^(?:help\.html)?#\/([a-z0-9-]+)$/);
  if (m) return '../' + m[1] + '/';             // article cross-link -> sibling folder
  if (v === '#/' || v === 'help.html' || v === 'help.html#/') return '../../help.html';
  if (/^(https?:|\/\/|mailto:|tel:|#)/.test(v)) return v; // external / in-page anchor
  if (v.startsWith('../') || v.startsWith('/')) return v;
  return '../../' + v;                           // relative site asset/page
}
const prefixAssets = html => html.replace(/\b(href|src)="([^"]*)"/g, (_, attr, val) => `${attr}="${rewriteUrl(val)}"`);
const NAV = prefixAssets(sliceMarks('<header class="wb-header"', '<div class="wb-header-spacer"></div>'));
const FOOTER = prefixAssets(sliceMarks('<footer>', '</footer>'));

// ── 3. Extract help.html's stylesheet into a shared file ──
// Grab ALL <style> blocks from the head (base theme + the wb-light override that makes it
// light dark-text-on-white). Using only the first block leaves white-on-white text.
const headHtml = help.slice(0, help.indexOf('</head>'));
const styleInner = [...headHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n\n');
const extraCss = `

/* ── Static help-article page wrappers (added by build-help.js) ── */
.help-article-main { max-width: 820px; margin: 0 auto; padding: 34px 20px 80px; }
.article-back { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--brand, #7851a9); text-decoration: none; padding: 7px 13px; border: 1px solid var(--border, #e4e7f1); border-radius: 9px; margin-bottom: 14px; transition: border-color .15s, background .15s; }
.article-back:hover { border-color: var(--brand, #7851a9); background: rgba(120,81,169,.06); }
.article-back i { font-size: 11px; }
.article-related { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--border, #e4e7f1); }
.article-related h3 { font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--muted, #6b7094); margin: 0 0 14px; }
.article-related ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.article-related a { display: block; padding: 12px 15px; border: 1px solid var(--border, #e4e7f1); border-radius: 10px; font-weight: 600; color: var(--text, #0f1228); text-decoration: none; transition: border-color .15s, color .15s; }
.article-related a:hover { border-color: var(--brand, #7851a9); color: var(--brand, #7851a9); }

/* ── Dynamic breadcrumb (overrides the extracted SPA styles) ── */
.article-breadcrumb { display: flex !important; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 22px; padding: 0; background: none !important; border: none !important; font-size: 13.5px; }
.article-breadcrumb a { display: inline-flex; align-items: center; gap: 6px; color: var(--muted, #6b7094); font-weight: 600; text-decoration: none; transition: color .15s; }
.article-breadcrumb a:hover { color: var(--brand, #7851a9); }
.article-breadcrumb .sep { color: #c4c8d4; font-size: 10px; width: auto; }
.article-breadcrumb .crumb-current { color: var(--text, #0f1228); font-weight: 700; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 1 !important; }
.article-breadcrumb .crumb-mid span { display: inline-block; max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
@media (max-width: 560px) {
  .article-breadcrumb { gap: 6px; font-size: 12.5px; }
  .article-breadcrumb .crumb-mid span { max-width: 150px; }
}
`;
fs.writeFileSync(path.join(ROOT, 'css', 'help-article.css'), styleInner + extraCss);

// ── 4. Helpers ──
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function isoDate(mmddyyyy) {
  const p = String(mmddyyyy || '').split('-');
  if (p.length === 3) return `${p[2]}-${p[0]}-${p[1]}`;
  return new Date().toISOString().slice(0, 10);
}

// Rewrite article body: cross-links, asset paths, and add ids to <h2> for the TOC.
function processBody(body) {
  let html = body.replace(/\b(href|src)="([^"]*)"/g, (_, attr, val) => `${attr}="${rewriteUrl(val)}"`);
  const headings = [];
  let i = 0;
  html = html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/g, (m, attrs, inner) => {
    const id = 'toc-' + i++;
    headings.push({ id, text: inner.replace(/<[^>]+>/g, '').trim() });
    // preserve existing attrs but ensure an id
    if (attrs && /\bid=/.test(attrs)) return m;
    return `<h2${attrs || ''} id="${id}">${inner}</h2>`;
  });
  return { html, headings };
}

function buildToc(headings) {
  if (headings.length < 3) return '';
  const items = headings.map(h => `<li><a href="#${h.id}">${escText(h.text)}</a></li>`).join('');
  return `<nav class="article-toc"><p class="toc-label">On this page</p><ul>${items}</ul></nav>`;
}

function buildRelated(slug) {
  const rel = (RELATED_MAP[slug] || []).map(s => bySlug[s]).filter(Boolean).slice(0, 3);
  if (!rel.length) return '';
  const items = rel.map(r => `<li><a href="../${r.article.slug}/">${escText(r.article.title)}</a></li>`).join('');
  return `<div class="article-related"><h3>Related articles</h3><ul>${items}</ul></div>`;
}

// ── 5. Generate a page per article ──
function page({ article, topic }) {
  const slug = article.slug;
  const url = `https://webeaze.io/help/${slug}/`;
  const { html: bodyHtml, headings } = processBody(article.body);
  const titleTag = `${escAttr(article.title)} | WebEaze Help`;
  const desc = escAttr(article.meta || '');
  const articleSchema = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: article.title, description: article.meta || '',
    datePublished: isoDate(article.updated), dateModified: isoDate(article.updated),
    author: { '@type': 'Organization', name: 'WebEaze' },
    publisher: { '@type': 'Organization', name: 'WebEaze', logo: { '@type': 'ImageObject', url: 'https://webeaze.io/images/webeaze-transparent.png' } },
    mainEntityOfPage: url, inLanguage: 'en-US'
  };
  const catUrl = `https://webeaze.io/help?topic=${topic.id}`;
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://webeaze.io/' },
      { '@type': 'ListItem', position: 2, name: 'Help Center', item: 'https://webeaze.io/help' },
      { '@type': 'ListItem', position: 3, name: topic.title, item: catUrl },
      { '@type': 'ListItem', position: 4, name: article.title, item: url }
    ]
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${titleTag}</title>
<meta name="description" content="${desc}" />
<link rel="canonical" href="${url}" />
<meta name="robots" content="index, follow" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="WebEaze" />
<meta property="og:title" content="${titleTag}" />
<meta property="og:description" content="${desc}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="https://webeaze.io/images/webeaze-transparent.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${titleTag}" />
<meta name="twitter:description" content="${desc}" />
<meta name="twitter:image" content="https://webeaze.io/images/webeaze-transparent.png" />
<link rel="shortcut icon" href="../../images/webeaze-transparent-copy.png" type="image/png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
<link rel="stylesheet" href="../../css/nav.css" />
<link rel="stylesheet" href="../../css/help-article.css" />
<script type="application/ld+json">${JSON.stringify(articleSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
</head>
<body>
${NAV}
<main class="help-article-main">
  <div class="article-view">
    <nav class="article-breadcrumb" id="articleCrumb" data-topic-id="${escAttr(topic.id)}" data-topic-label="${escAttr(topic.title)}">
      <a href="../../help.html"><i class="fas fa-home"></i> Help Center</a>
      <i class="fas fa-chevron-right sep"></i>
      <a class="crumb-mid" href="../../help.html?topic=${encodeURIComponent(topic.id)}"><span>${escText(topic.title)}</span></a>
      <i class="fas fa-chevron-right sep"></i>
      <span class="crumb-current">${escText(article.title)}</span>
    </nav>
    <header class="article-header">
      <h1>${escText(article.title)}</h1>
      <div class="meta">
        <i class="fas fa-clock"></i> Last updated: ${escText(article.updated)}
        &nbsp;&nbsp;<span class="read-time"><i class="fas fa-book-open"></i> ${readTimeOf(slug)} min read</span>
      </div>
    </header>
    ${buildToc(headings)}
    <section class="article-body">${bodyHtml}</section>
    ${buildRelated(slug)}
    <div class="article-footer">
      <a href="../../help.html" class="btn-ghost"><i class="fas fa-arrow-left"></i> Back to Help Center</a>
    </div>
  </div>
</main>
${FOOTER}
<script src="../../js/nav.js" defer></script>
<script>
/* Dynamic breadcrumb: reflects how the reader reached this page (search vs. category browse). */
(function () {
  var nav = document.getElementById('articleCrumb');
  if (!nav) return;
  var mid = nav.querySelector('.crumb-mid');
  var trail = null;
  try { trail = JSON.parse(sessionStorage.getItem('wb_help_trail') || 'null'); } catch (e) {}
  if (trail && trail.kind === 'search' && trail.q && mid) {
    mid.querySelector('span').textContent = 'Search results';
    mid.setAttribute('href', '../../help.html?q=' + encodeURIComponent(trail.q));
    mid.setAttribute('title', 'Back to search: ' + trail.q);
  }
  // Leaving to another help article (related/inline link) resets the trail so the next
  // page shows its own category instead of a stale search crumb.
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (a && /(^|\/)\.\.\/[a-z0-9-]+\/$/.test(a.getAttribute('href') || '')) {
      try { sessionStorage.removeItem('wb_help_trail'); } catch (er) {}
    }
  });
})();
</script>
</body>
</html>`;
}

const outDir = path.join(ROOT, 'help');
fs.mkdirSync(outDir, { recursive: true });
let n = 0;
const slugs = [];
HELP_DATA.topics.forEach(t => t.articles.forEach(a => {
  const dir = path.join(outDir, a.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page({ article: a, topic: t }));
  slugs.push(a.slug); n++;
}));

// ── 6. Update sitemap.xml with /help/<slug> URLs ──
const smPath = path.join(ROOT, 'sitemap.xml');
if (fs.existsSync(smPath)) {
  let sm = fs.readFileSync(smPath, 'utf8');
  sm = sm.replace(/\s*<url>\s*<loc>https:\/\/webeaze\.io\/help\/[a-z0-9-]+\/?<\/loc>[\s\S]*?<\/url>/g, ''); // drop old help entries
  const block = slugs.map(s => `  <url>\n    <loc>https://webeaze.io/help/${s}/</loc>\n    <changefreq>monthly</changefreq>\n  </url>`).join('\n');
  sm = sm.replace(/<\/urlset>/, block + '\n</urlset>');
  fs.writeFileSync(smPath, sm);
  console.log('sitemap.xml updated with ' + slugs.length + ' help URLs');
}

console.log(`Generated ${n} help article pages in help/ + css/help-article.css`);
