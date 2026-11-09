/** R44 材质 A/B 出图：4 个 #r44mat= 档位 + noshell 对照，一页一载（与 capture 同骨架） */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const ROOT = '<REPO_ROOT>';
const OUT = ROOT + '/.qa/r44_car';
const PORT = 5200, EDGE_PORT = 9472;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(path, port = EDGE_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2500 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function waitDbg() {
  for (let i = 0; i < 90; i++) {
    try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch {}
    await wait(400);
  }
  throw new Error('debugger unreachable');
}
const save = (name, dataUrl) => {
  const f = `${OUT}/${name}.png`;
  fs.writeFileSync(f, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
  return f;
};
import { createServer } from 'vite';
const vite = await createServer({ root: ROOT, server: { port: PORT, host: '127.0.0.1', strictPort: true }, logLevel: 'error' });
await vite.listen();
console.log('VITE_READY');
const browser = await puppeteer.connect({ browserWSEndpoint: await waitDbg(), defaultViewport: null, protocolTimeout: 300000 });

async function shot(tag, extraHash) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html#noprewarm&quality=high&gpufake=discrete&perfhud&vehicle=v800&paint=white${extraHash}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    for (let i = 0; i < 90; i++) {
      const st = await page.evaluate(() => ({
        done: !!document.getElementById('loading')?.classList.contains('done'),
        shell: window.__r44Shell?.v800?.state
      })).catch(() => ({}));
      if (st.done && (st.shell === 'ready' || st.shell === 'failed')) break;
      await wait(1000);
    }
    await wait(2500);
    const d = await page.evaluate(() => {
      const p = window.__game.car.root.position;
      return window.__v800EnvShot('ab', p.x + 3.6, p.y + 1.5, p.z - 6.4, p.x, p.y + 0.75, p.z, 42);
    });
    console.log('SHOT', tag, await page.evaluate(() => document.title));
    save(tag, d);
  } catch (e) {
    console.log('ERR', tag, String(e).slice(0, 150));
  }
  await page.close();
}

await shot('_ab_plain', '&r44mat=plain');
await shot('_ab_maponly', '&r44mat=maponly');
await shot('_ab_mapnormal', '&r44mat=mapnormal');
await shot('_ab_full', '');
await shot('_ab_noshell', '&r44ext=off');
await browser.disconnect();
await vite.close();
