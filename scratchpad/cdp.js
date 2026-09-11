// Real phone emulation. --window-size cannot go below ~500px on macOS, so a 390px iPhone layout is
// unreachable from the CLI flags alone; Emulation.setDeviceMetricsOverride over the DevTools protocol
// is the only way to see what Billy actually sees. No puppeteer: Node 24 has WebSocket built in.
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + (process.pid % 200);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const url = process.argv[2];
  const expr = process.argv[3] || '1';
  const shot = process.argv[4] || '';
  const width = +(process.env.VW || 390), height = +(process.env.VH || 844);
  const wait = +(process.env.WAIT || 3500);

  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--hide-scrollbars',
    '--disable-gpu', '--no-first-run', '--user-data-dir=/tmp/cdp-' + process.pid, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore'] });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find(t => t.type === 'page');
    } catch (_e) {}
  }
  if (!target) { chrome.kill(); throw new Error('chrome did not come up'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  });
  await new Promise(r => ws.addEventListener('open', r));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url });
  await sleep(wait);

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log('EVAL ERROR: ' + (r.exceptionDetails.exception || {}).description);
  else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value));

  if (shot) {
    const full = process.env.FULL === '1';
    if (full) {
      const { cssContentSize } = await send('Page.getLayoutMetrics');
      await send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(Math.ceil(cssContentSize.height), 6000), deviceScaleFactor: 2, mobile: true });
      await sleep(400);
    }
    const png = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
  }
  ws.close(); chrome.kill();
  try { fs.rmSync('/tmp/cdp-' + process.pid, { recursive: true, force: true }); } catch (_e) {}
}
main().catch(e => { console.error(String(e.message)); process.exit(1); });
