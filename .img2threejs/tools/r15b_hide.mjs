// R15b 消去法：同一 cabin 机位，逐材质隐藏对照（hidemat 钩子）
// 用法（经 r14-run.ps1 包装）：MODE=hide node r15b_hide.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9472);
const URLB = process.env.URL || 'http://[::1]:4317/';
const OUT = process.env.OUT || 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r15b';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);

const VEH = process.env.VEH || 'v800';
const VIEW = process.env.VIEW || (VEH === 'r7' ? 'cabinDriver' : 'cabin');
const CASES = (process.env.CASES || 'base,leather-warm,leather-dark,leather-ivory')
  .split(',')
  .map((s) => (s === 'base'
    ? { name: `${VEH}_base`, hash: `#vehicle=${VEH}` }
    : { name: `${VEH}_no_${s}`, hash: `#vehicle=${VEH}&hidemat=${s}` }));

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });

for (const c of CASES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 200)));
  await page.goto(URLB + c.hash, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!document.querySelector('.btn.primary'), { timeout: 120000, polling: 400 });
  await page.evaluate(() => document.querySelector('.btn.primary')?.click());
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.countdown');
      return el !== null && el.classList.contains('hidden');
    },
    { timeout: 90000, polling: 400 }
  );
  await wait(1200);
  const ok = await page.evaluate((viewSel) => {
    const b = document.querySelector(`.view-btn[data-view="${viewSel}"]`);
    if (b) { b.click(); return true; }
    return false;
  }, (process.env.VIEW || 'cabin'));
  await wait(2000);
  const f = path.join(OUT, c.name + '.png');
  fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
  const qa = logs.find((l) => l.includes('[QA] hidemat')) || '';
  log(`SHOT ${f} cabinBtn=${ok} ${qa}`);
  await page.close();
}
await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
