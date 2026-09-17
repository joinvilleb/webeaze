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

  cdp.close();
  console.log('\n' + (fails.length ? fails.length + ' problem(s):\n - ' + fails.join('\n - ') : 'All good. Safe to deploy.'));
  process.exit(fails.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
