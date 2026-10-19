// R17 定向截图：单车辆 + 指定机位列表（快速迭代用）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
import fs from 'node:fs';
import path from 'node:path';

const CDP = Number(process.env.CDP || 9470);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const VEH = process.env.VEH || 'v800';
const VIEWS = (process.env.VIEWS || 'hood').split(',');
const OUT = process.env.OUT || 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logf = path.join(OUT, 'shot.log');
const log = (s) => { fs.appendFileSync(logf, s + '\n'); console.log(s); };

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 200)));
await page.goto(`${URLBASE}#vehicle=${VEH}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => {
  const b = document.querySelector('.btn.primary');
  return !!b && document.getElementById('menu') && !document.getElementById('menu').classList.contains('hidden');
}, { timeout: 120000, polling: 500 });
await wait(2500);
await page.evaluate(() => document.querySelector('.btn.primary')?.click());
await page.waitForFunction(
  () => { const c = document.querySelector('.countdown'); return c !== null && c.classList.contains('hidden'); },
  { timeout: 90000, polling: 400 }
);
await wait(1200);
for (const view of VIEWS) {
  const ok = await page.evaluate((v) => {
    const b = document.querySelector(`.view-btn[data-view="${v}"]`);
    if (b) { b.click(); return true; }
    return false;
  }, view);
  await wait(2200);
  const f = path.join(OUT, `${VEH}_${view}.png`);
  fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
  log(`SHOT ${f} btn=${ok}`);
}
for (const l of logs) {
  if (/occluder|挂载|WARN|ERROR|error/i.test(l)) log('  LOG ' + l.slice(0, 200));
}
await browser.disconnect();
process.exit(0);
