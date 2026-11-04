/**
 * R45 线上诊断：直接打开 GitHub Pages 线上页，读 __r44Shell 装载台账 + 失败请求 + 截图。
 * 由 .qa/r45/r45_online_diag.ps1 在同一次 PS 调用里启动 Edge 后运行。
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = ROOT + '/.qa/r45_diag';
const EDGE_PORT = 9476;
const TARGET = 'https://rickeal-boss.github.io/Ultimate-Design-V800/';
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: EDGE_PORT, path, timeout: 2500 }, (res) => {
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

const ws = await waitDbg();
const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errs = [];
const bad = [];
const warns = [];
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 300));
  if (m.type() === 'warning' || m.type() === 'warn') warns.push(m.text().slice(0, 300));
});
page.on('requestfailed', (r) => bad.push('FAIL ' + String(r.failure()?.errorText) + ' ' + r.url().slice(-110)));
page.on('response', (r) => { if (r.status() >= 400) bad.push(String(r.status()) + ' ' + r.url().slice(-110)); });

try {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 180000 });
} catch (e) {
  console.log('GOTO_ERR', String(e).slice(0, 200));
}
let clicked = false;
for (const t of [10, 30, 60, 90]) {
  await wait(t * 1000);
  if (!clicked) {
    try {
      clicked = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('开始挑战'));
        if (b) { b.click(); return true; }
        return false;
      });
    } catch { /* ignore */ }
    console.log('CLICK_START', clicked);
  }
  let st = {};
  try {
    st = await page.evaluate(() => ({
      shell: window.__r44Shell ?? null,
      title: document.title,
      hash: location.hash,
      canvas: !!document.querySelector('canvas'),
      res: performance.getEntriesByType('resource')
        .filter((r) => /\.(glb|webp|png|json)(\?|$)/.test(r.name))
        .map((r) => ({ n: r.name.split('/').pop().slice(0, 46), d: Math.round(r.duration), sz: r.transferSize })),
      gl: (() => {
        const c = document.querySelector('canvas');
        return c ? { w: c.width, h: c.height } : null;
      })()
    }));
  } catch (e) { st = { evalErr: String(e).slice(0, 150) }; }
  console.log('STATE@' + t, JSON.stringify(st));
}
try {
  const shot = await page.screenshot({ encoding: 'base64' });
  fs.writeFileSync(OUT + '/online_view.png', Buffer.from(shot, 'base64'));
  console.log('SHOT', OUT + '/online_view.png');
} catch (e) { console.log('SHOT_ERR', String(e).slice(0, 150)); }
console.log('CONSOLE_ERRORS', JSON.stringify(errs.slice(0, 25)));
console.log('CONSOLE_WARNS', JSON.stringify(warns.slice(0, 25)));
console.log('BAD_REQUESTS', JSON.stringify(bad.slice(0, 40)));
fs.writeFileSync(OUT + '/online_diag.json', JSON.stringify({ errs, warns, bad }, null, 2));
await page.close();
await browser.disconnect();
console.log('DONE');
