/**
 * R44 落地审查 · 真实 GPU 出图（侧翼下潜扩大 + 谷壁分带 前后对照）
 *
 * 复用 r43_gpu_capture.mjs 全链路（Edge headless + 同进程 vite + __v800EnvShot）。
 * 机位 P2/P5 与 R43 完全同参 ⇒ 直接对照 .qa/r43_occlusion/P2_deck_left_1224_ALL.png /
 * P5_side_low_ALL.png（R43 基线）；其余为本轮应力机位。
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = ROOT + '/.qa/r44_env';
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9472;
const URL = 'http://127.0.0.1:5201/index.html#noprewarm&quality=high&gpufake=discrete';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const POSES = [
  { name: 'P5_side_low', eye: [18, 1.2, -120], tgt: [0, -6, -260], fov: 55 },
  { name: 'P2_deck_left_1224', eye: [-12.24, 1.6, 40], tgt: [-6, 1, -300], fov: 62 },
  { name: 'Q_side_high', eye: [40, 16, -140], tgt: [0, -30, -240], fov: 55 },
  { name: 'viaduct_side', eye: [180, 70, -180], tgt: [0, 20, -358.5], fov: 55 },
  { name: 'aerial', eye: [120, 160, 60], tgt: [0, 0, -500], fov: 50 },
  { name: 'deck_in_left', eye: [-10.5, 1.7, -60], tgt: [-17, -14, -150], fov: 62 }
];

const save = (name, dataUrl) => {
  const f = `${OUT}/${name}.png`;
  fs.writeFileSync(f, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
  return f;
};

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 2500 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function waitDbg() {
  for (let i = 0; i < 90; i += 1) {
    try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch { /* not up */ }
    await wait(400);
  }
  throw new Error('debugger unreachable');
}

import { createServer } from 'vite';
const vite = await createServer({
  root: ROOT, server: { port: 5201, host: '127.0.0.1', strictPort: true }, logLevel: 'error'
});
await vite.listen();
console.log('VITE_READY', vite.resolvedUrls?.local?.[0] ?? '');

let browser;
try {
  const wsUrl = await waitDbg(); await wait(600);
  browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null, protocolTimeout: 240000 });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 300)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 60; i += 1) {
    const st = await page.evaluate(() => ({
      shot: typeof window.__v800EnvShot,
      done: !!document.getElementById('loading')?.classList.contains('done'),
      canvas: !!document.querySelector('canvas')
    }));
    if (st.shot === 'function' && st.done) { console.log('SCENE READY @', i, 's'); break; }
    if (i % 5 === 0) console.log('WAIT', i, JSON.stringify(st));
    if (i === 59) { console.log(logs.slice(-40).join('\n')); throw new Error('scene never ready'); }
    await wait(1000);
  }
  await wait(1200);
  for (const p of POSES) {
    const f = await (async () => {
      const d = await page.evaluate((o) => window.__v800EnvShot(o.name, ...o.eye, ...o.tgt, o.fov), p);
      return save(p.name + '_R44', d);
    })();
    console.log('SHOT', f);
  }
  console.log('--- console tail ---');
  console.log(logs.slice(-8).join('\n'));
  console.log('DONE');
} catch (e) {
  console.error('CAPTURE_FAIL', String(e).slice(0, 800));
} finally {
  try { await browser?.disconnect(); } catch { /* ignore */ }
  try { await vite.close(); } catch { /* ignore */ }
}
