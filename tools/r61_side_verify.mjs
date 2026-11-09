/**
 * R61 侧面验证探针：仅拍 side 视图（V800 white / R7 purple），保存 PNG 供目检镀铬条。
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const ROOT = '<REPO_ROOT>';
const OUT = ROOT + '/.qa/r61';
const PORT = 5213, EDGE_PORT = 9485;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(path, port = EDGE_PORT) {
  return new Promise((res, rej) => { const q = http.get({ host: '127.0.0.1', port, path, timeout: 2500 }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }); q.on('error', rej); q.on('timeout', () => q.destroy(new Error('t'))); });
}
async function waitDbg() { for (let i = 0; i < 90; i++) { try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch { } await wait(400); } throw new Error('no dbg'); }
const save = (name, dataUrl) => { const f = `${OUT}/${name}.png`; fs.writeFileSync(f, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64')); return f; };
import { createServer } from 'vite';
const vite = await createServer({ root: ROOT, server: { port: PORT, host: '127.0.0.1', strictPort: true }, logLevel: 'error' });
await vite.listen();
const browser = await puppeteer.connect({ browserWSEndpoint: await waitDbg(), defaultViewport: null, timeout: 180000, protocolTimeout: 300000 });
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700 });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
for (const [car, variant] of [['v800', 'white'], ['r7', 'purple']]) {
  const hash = `#noprewarm&quality=high&gpufake=discrete&perfhud&vehicle=${car}&paint=${variant}`;
  await page.goto(`http://127.0.0.1:${PORT}/index.html${hash}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let ready = null;
  for (let i = 0; i < 90; i++) {
    ready = await page.evaluate(() => {
      const done = !!document.getElementById('loading')?.classList.contains('done');
      const shell = window.__r44Shell ?? {};
      const carId = window.__game?.car?.profile?.id ?? '';
      return { done, shellState: shell[carId]?.state, carPos: (window.__game?.car?.root?.position) ? [window.__game.car.root.position.x, window.__game.car.root.position.y, window.__game.car.root.position.z] : null };
    });
    if (ready.done && (ready.shellState === 'ready' || ready.shellState === 'failed')) break;
    await wait(1000);
  }
  await wait(4000);
  const [cx, cy, cz] = ready.carPos ?? [0, 0, 40];
  const p = (dx, dy, dz) => `${cx + dx},${cy + dy},${cz + dz}`;
  const eye = p(7.4, 1.15, 0.01), tgt = p(0, 0.8, 0), fov = 40;
  const data = await page.evaluate((et) => {
    const [eye, tgt, fov] = et;
    const nums = eye.split(',').concat(tgt.split(',')).map(Number);
    return window.__v800EnvShot('r61side', ...nums, fov);
  }, [eye, tgt, fov]);
  const f = save(`${car}-${variant}-side-r61`, data);
  console.log('SHOT', `${car}-${variant}-side-r61`, ready.shellState, f);
}
await browser.disconnect(); await vite.close();
console.log('DONE');
