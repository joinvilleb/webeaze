// Builds mock.html (client portal) and mockadmin.html in OUT from the real files. Usage:
//   node build-mock.js <outDir>
// Copies the WHOLE portal directory first: a lone index.html 404s status.js and the portal's
// script dies mid-run ("Cannot access X before initialization").
const fs = require('fs'), path = require('path');
const REPO = path.resolve(__dirname, '../..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(REPO, 'portal'), OUT, { recursive: true });
const mock = fs.readFileSync(path.join(__dirname, 'mock-inject.js'), 'utf8');
const errs = '<script>window.__errs=[];addEventListener("error",e=>window.__errs.push(String(e.message)));addEventListener("unhandledrejection",e=>window.__errs.push("rej: "+String(e.reason&&e.reason.message||e.reason)));</script></head>';
const hide = `<script>setTimeout(function(){try{document.querySelectorAll('.tour-overlay,.chat-fab,.chat-teaser,.install-bar,#toast-wrap').forEach(function(n){n.style.display='none';});var tb=document.querySelector('.topbar');if(tb)tb.style.position='static';}catch(e){}},900);</script>`;
for (const [src, dst] of [['index.html', 'mock.html'], ['admin.html', 'mockadmin.html']]) {
  let s = fs.readFileSync(path.join(OUT, src), 'utf8');
  s = s.replace(/<script src="https:\/\/unpkg\.com\/@supabase[^>]*><\/script>/, '').replace('</head>', errs);
  const a = s.indexOf('const SUPABASE_URL'); if (a < 0) throw new Error('no SUPABASE_URL in ' + src);
  s = s.slice(0, a) + '\n' + mock + '\n' + s.slice(a);
  const last = s.lastIndexOf('</body>');   // the first two are inside JS strings
  s = s.slice(0, last) + hide + s.slice(last);
  fs.writeFileSync(path.join(OUT, dst), s);
}
console.log('built ' + OUT + '/mock.html and mockadmin.html');
