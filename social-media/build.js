#!/usr/bin/env node
/* Build one month of social posts.
     node build.js aug-sep-2026
   Writes <month>/posts.html (contact sheet for review) and <month>/single/<id>.html
   (one 1080x1080 page per post, which render.sh screenshots). */
const fs = require('fs');
const path = require('path');
const { CSS, FONTS, card } = require('./lib');

const month = process.argv[2];
if (!month) { console.error('usage: node build.js <month-slug>   e.g. aug-sep-2026'); process.exit(1); }

const mod = require(path.join(__dirname, 'months', month + '.js'));
const outDir = path.join(__dirname, month);
fs.mkdirSync(path.join(outDir, 'single'), { recursive: true });

// One page per post. Depth is ../../ because single/<id>.html sits two levels under the repo root.
mod.posts.forEach(p => {
  const page = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${p.id}</title>${FONTS}<style>${CSS}
html,body{margin:0;padding:0;width:1080px;height:1080px;overflow:hidden}</style></head>
<body>${card(p, '../../../')}</body></html>`;
  fs.writeFileSync(path.join(outDir, 'single', p.id + '.html'), page);
});

// Contact sheet
const sheet = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>WebEaze social, ${mod.label}</title>${FONTS}<style>${CSS}
body{background:#dedde3;padding:36px;display:flex;flex-wrap:wrap;gap:36px}
.post{flex:0 0 auto}</style></head>
<body>${mod.posts.map(p => card(p, '../')).join('\n')}</body></html>`;
fs.writeFileSync(path.join(outDir, 'posts.html'), sheet);
fs.writeFileSync(path.join(outDir, 'posts.json'),
  JSON.stringify({ label: mod.label, ids: mod.posts.map(p => p.id) }, null, 1));

console.log(`${month}: ${mod.posts.length} posts  (${mod.label})`);
console.log(`  ${month}/posts.html          contact sheet`);
console.log(`  ${month}/single/*.html       one page per post`);
console.log(`  next: ./render.sh ${month}`);
