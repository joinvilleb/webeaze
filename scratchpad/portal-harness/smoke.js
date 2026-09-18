// Pre-deploy smoke test for the portal and the admin page.
//
//   node scratchpad/portal-harness/build-mock.js /tmp/pmm --set=mike
//   node scratchpad/portal-harness/smoke.js /tmp/pmm
//
// Loads both real pages against the mocked Supabase, walks every view and tab, and fails on:
//   - any uncaught error or promise rejection (window.__errs)
//   - a view that renders nothing where it should render something
//   - a known-empty section that should have rows with the fixture data
//
// WHY: a query added in the wrong position inside loadPulse's Promise.all shifted every later result
// by one and silently emptied three sections. Nothing threw, so the page "worked". This catches that
// class of bug in about a minute. Exit code 1 means do not deploy.
const { spawn } = require('child_process');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9733 + (process.pid % 200);

// [view, selector that must exist, minimum text length inside it]
const PORTAL_VIEWS = [
  ['home', '#view-home', 200],
  ['leads', '#leads-inbox', 100],
  ['report', '#view-report', 400],
  ['notes', '#client-notes', 60],
  ['setup', '#view-setup', 300],
  ['history', '#history-list', 80],
  ['milestones', '#view-milestones', 100],
  ['referrals', '#view-referrals', 100],
  ['addons', '#addons-grid', 200],
  ['updates', '#view-updates', 80],
  ['help', '#view-help', 100],
];
const ADMIN_TABS = [
  ['pulse', '#pulse-sections', 80],
  ['requests', '#view-requests', 200],
  ['clients', '#view-clients', 200],
  ['money', '#view-money', 60],
  ['insights', '#view-insights', 40],
];

async function connect(url) {
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--disable-gpu', '--no-first-run', '--user-data-dir=/tmp/smoke-' + process.pid, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find((t) => t.type === 'page'); } catch (_e) {}
  }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  const evalv = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || 'eval failed').slice(0, 200));
    return r.result.value;
  };
  return { send, evalv, close: () => { ws.close(); chrome.kill(); } };
}

// Shell invariants, measured from the live layout at both widths.
//
// WHY: every one of these was shipped broken at least once, and all for the same reason. A rule
// written ABOVE the rule it means to override loses on source order, silently: the CSS is valid, the
// page renders, and the only symptom is a button in the wrong place. Reading the stylesheet does not
// catch it. Measuring the rendered box does.
const SHELL = [
  { w: 1280, h: 900, mobile: false, name: 'desktop', checks: `[
    ['sidebar is on screen', (function(){ var d=q('.drawer'); return d && Math.abs(box(d).left) < 2 && box(d).width > 180 && box(d).width < 400; })()],
    ['content clears the sidebar', (function(){ var d=q('.drawer'), b=q('.body'); return d && b && parseFloat(css(b).paddingLeft) >= box(d).width - 1; })()],
    ['topbar clears the sidebar', (function(){ var d=q('.drawer'), t=q('.topbar-inner'); return d && t && parseFloat(css(t).paddingLeft) >= box(d).width - 1; })()],
    ['resize grip is visible', (function(){ var g=q('.sb-resize'); return g && css(g).display !== 'none' && box(g).width > 4; })()],
    ['tab bar is hidden', (function(){ var t=q('.tabbar'); return !t || css(t).display === 'none'; })()],
    ['hamburger is gone', (function(){ var h=q('.hamburger-btn'); return !h || css(h).display === 'none'; })()],
    ['sidebar header lines up with the topbar, when there is one', (function(){ var a=q('.drawer-header'), b=q('.topbar'); if (!b || css(b).display === 'none') return true; return a && Math.abs(box(a).bottom - box(b).bottom) <= 1; })()],
    ['account controls sit in the sidebar', (function(){ var r=q('.topbar-right'); return r && r.closest('.drawer-footer') !== null && box(r).width > 40; })()]
  ]`},
  { w: 390, h: 844, mobile: true, name: 'phone', checks: `[
    ['tab bar is on screen', (function(){ var t=q('.tabbar'); return t && css(t).display !== 'none' && box(t).bottom <= innerHeight + 1 && box(t).height > 40; })()],
    ['menu is put away', (function(){ var d=q('.drawer'); return d && box(d).top >= innerHeight - 2; })()],
    ['content clears the tab bar', (function(){ var t=q('.tabbar'), b=q('.body'); return t && b && parseFloat(css(b).paddingBottom) >= box(t).height; })()],
    ['chat button clears the tab bar', (function(){ var f=q('.chat-fab'), t=q('.tabbar'); if(!f||!t) return false; f.classList.add('visible'); var ok = box(f).bottom <= box(t).top + 1; return ok; })()],
    ['logo is not tiny', (function(){ var l=q('.topbar-logo'); return l && parseFloat(css(l).fontSize) >= 19; })()],
    ['sidebar grip is not in the way', (function(){ var g=q('.sb-resize'); return !g || css(g).display === 'none'; })()]
  ]`},
];

async function checkShell(cdp, note) {
  for (const s of SHELL) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: s.mobile });
    await sleep(900);
    const raw = await cdp.evalv(`(function(){
      var q = function(x){ return document.querySelector(x); };
      var css = function(n){ return getComputedStyle(n); };
      var box = function(n){ return n.getBoundingClientRect(); };
      return JSON.stringify(${s.checks});
    })()`);
    JSON.parse(raw).forEach(([what, ok]) => {
      if (ok) console.log('  ok   ' + s.name + ': ' + what);
      else note('shell', s.name, what);
    });
  }
}

async function run() {
  const out = path.resolve(process.argv[2] || '/tmp/pmm');
  const fails = [];
  const note = (page, what, msg) => { fails.push(page + ' > ' + what + ': ' + msg); console.log('  FAIL ' + what + ' - ' + msg); };
  const cdp = await connect();

  for (const [file, label, steps, go] of [
    ['mock.html', 'portal', PORTAL_VIEWS, (v) => `navigateTo(${JSON.stringify(v)})`],
    ['mockadmin.html', 'admin', ADMIN_TABS, (v) => `switchTab(${JSON.stringify(v)})`],
  ]) {
    console.log('\n' + label);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: 'file://' + path.join(out, file) });
    await sleep(7000);
    const boot = await cdp.evalv('JSON.stringify(window.__errs || [])');
    if (boot !== '[]') note(label, 'on load', boot.slice(0, 300));

    for (const [view, sel, minLen] of steps) {
      try {
        await cdp.evalv('(async()=>{ ' + go(view) + '; await new Promise(r=>setTimeout(r,1800)); return 1; })()');
        const res = await cdp.evalv(`(function(){
          var n = document.querySelector(${JSON.stringify(sel)});
          return JSON.stringify({ found: !!n, len: n ? (n.innerText || '').trim().length : 0, errs: (window.__errs || []).slice(-3) });
        })()`);
        const r = JSON.parse(res);
        if (!r.found) note(label, view, 'missing ' + sel);
        else if (r.len < minLen) note(label, view, sel + ' rendered only ' + r.len + ' chars (expected ' + minLen + '+)');
        else console.log('  ok   ' + view + ' (' + r.len + ' chars)');
        if (r.errs.length) note(label, view, 'errors: ' + JSON.stringify(r.errs).slice(0, 240));
        await cdp.evalv('window.__errs = []');
      } catch (e) { note(label, view, String(e.message).slice(0, 200)); }
    }
  }

  // Back to the portal for the layout checks: the loop above leaves us on the admin page.
  console.log('\nshell');
  await cdp.send('Page.navigate', { url: 'file://' + path.join(out, 'mock.html') });
  await sleep(7000);
  await checkShell(cdp, note);

  cdp.close();
  console.log('\n' + (fails.length ? fails.length + ' problem(s):\n - ' + fails.join('\n - ') : 'All good. Safe to deploy.'));
  process.exit(fails.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
