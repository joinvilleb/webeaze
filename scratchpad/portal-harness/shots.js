// Batch screenshots of the real portal against the "mike" fixture set, in ONE Chrome session.
//   node build-mock.js /tmp/pmm --set=mike
//   node shots.js /tmp/pmm/mock.html <outDir> [name ...]
// Each shot reloads the page so state never leaks between shots. Writes <outDir>/<name>.png;
// copy the ones you keep into portal-screenshots/ or images/assets/.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9533 + (process.pid % 200);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const go = (view) => `navigateTo('${view}');`;
const settle = (ms) => `await new Promise(r=>setTimeout(r,${ms || 1200}));`;
// Desktop views: .body clip at 1120 (2240 wide). Mobile: 500 full page (1000 wide).
const VIEWS = { home: 'home', setup: 'setup', history: 'history', report: 'report', messages: 'notes', milestones: 'milestones', referrals: 'referrals', help: 'help', addons: 'addons', leads: 'leads', updates: 'updates' };
const SHOTS = [];
// A popup is position:fixed and scrolls inside itself; lay it flat on the page so the whole card is captured.
const flat = "(function(){var m=document.getElementById('ask-modal');m.style.cssText+=';position:absolute;inset:auto;top:0;left:0;right:0;height:auto;min-height:0;background:transparent;backdrop-filter:none;overflow:visible;display:flex;justify-content:center;padding:24px 0;';var c=m.querySelector('.info-modal-card');c.style.maxHeight='none';c.style.overflow='visible';c.style.transform='none';var b=document.querySelector('.body');if(b)b.style.visibility='hidden';})();";
for (const [name, view] of Object.entries(VIEWS)) {
  SHOTS.push({ name: 'd-' + name, vw: 1120, mobile: false, clip: '.body', js: go(view) + settle(1600) });
  SHOTS.push({ name: 'm-' + name, vw: 500, mobile: true, full: true, js: go(view) + settle(1600) });
  SHOTS.push({ name: 'a-' + name, vw: 1100, mobile: false, full: true, topbar: true, js: go(view) + settle(1600) });
}
SHOTS.push(
  { name: 'c-team', vw: 1100, mobile: false, clip: '#team-card', js: go('setup') + settle(1600) },
  { name: 'c-messages-save', vw: 760, mobile: false, clip: '#client-notes .chat-msg.me:nth-last-child(2)', js: go('notes') + settle(1200) + "document.getElementById('client-notes').style.maxHeight='none';" + settle(300) },
  { name: 'c-leads', vw: 520, mobile: false, clip: '#leads-inbox', js: go('leads') + settle(1800) },
  { name: 'c-request-popup', vw: 700, mobile: false, clip: '#ask-modal .info-modal-card', js: "openRequest('q1');" + settle(1400) + flat + settle(400) },
  { name: 'c-request-done', vw: 700, mobile: false, clip: '#ask-modal .info-modal-card', js: "openRequest('q3');" + settle(1400) + flat + settle(400) },
  { name: 'c-onboarding', vw: 640, mobile: false, clip: '#onboarding-card', js: go('home') + settle(600) + 'showOnboarding(3);' + settle(800) },
);

async function main() {
  const [mockPath, outDir, ...only] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const url = 'file://' + path.resolve(mockPath);
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--user-data-dir=/tmp/shots-' + process.pid, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) { await sleep(250); try { target = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page'); } catch (_e) {} }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  const evalv = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'eval'); return r.result.value; };

  for (const s of SHOTS.filter(s => !only.length || only.includes(s.name))) {
    try {
      await send('Emulation.setDeviceMetricsOverride', { width: s.vw, height: 900, deviceScaleFactor: 2, mobile: !!s.mobile });
      await send('Page.navigate', { url: url + '?s=' + s.name });
      await sleep(5500);
      // The harness makes the topbar static at 900ms; element shots hide it so it never covers a heading.
      await evalv(`(async()=>{ ${s.topbar ? '' : "var tb=document.querySelector('.topbar'); if(tb && !" + JSON.stringify(!!s.full) + ") tb.style.display='none';"} ${s.js} window.scrollTo(0,0); return 1; })()`);
      const errs = await evalv('JSON.stringify(window.__errs||[])');
      let clip;
      if (s.clip) {
        const b = await evalv(`(function(){var n=[...document.querySelectorAll(${JSON.stringify(s.clip)})].find(x=>x.offsetParent!==null||getComputedStyle(x).position==='fixed');if(!n)return null;var r=n.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height};})()`);
        if (!b) { console.log(s.name, 'NO ELEMENT', s.clip); continue; }
        const pad = s.name.startsWith('d-') ? 0 : 16;
        const { cssContentSize } = await send('Page.getLayoutMetrics');
        await send('Emulation.setDeviceMetricsOverride', { width: s.vw, height: Math.min(Math.ceil(Math.max(cssContentSize.height, b.y + b.h + pad)), 9000), deviceScaleFactor: 2, mobile: !!s.mobile });
        await sleep(400);
        clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.min(b.w + pad * 2, s.vw), height: b.h + pad * 2, scale: 1 };
      } else if (s.full) {
        const h = await evalv('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))');
        await send('Emulation.setDeviceMetricsOverride', { width: s.vw, height: Math.min(h, 7000), deviceScaleFactor: 2, mobile: !!s.mobile });
        await sleep(600);
      }
      const png = await send('Page.captureScreenshot', clip ? { format: 'png', clip, captureBeyondViewport: true } : { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(outDir, s.name + '.png'), Buffer.from(png.data, 'base64'));
      console.log(s.name, 'ok', errs !== '[]' ? 'ERRS ' + errs : '');
    } catch (e) { console.log(s.name, 'FAIL', e.message); }
  }
  ws.close(); chrome.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
