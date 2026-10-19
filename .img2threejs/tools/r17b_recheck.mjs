// R17b 复验：V800 cabin（烘焙眼点+透明 gauge）+ R7 双牌近距 + R7 主驾
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9477);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = ROOT + '/verify/r17b';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => { fs.appendFileSync(path.join(OUT, 'qa.log'), s + '\n'); console.log(s); };

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });

const SESSIONS = [
  { tag: 'v800cabin2', vehicle: 'v800', views: ['cabin'] },
  { tag: 'r7plateRear2', vehicle: 'r7', eye: '0,0.85,4.6,0,0.8,2.45', views: ['cabinDriver'] },
  { tag: 'r7plateFront2', vehicle: 'r7', eye: '0,0.62,-4.6,0,0.58,-2.45', views: ['cabinDriver'] },
];

for (const item of SESSIONS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const url = `${URLBASE}#vehicle=${item.vehicle}${item.eye ? `&eye=${item.eye}` : ''}`;
  log(`GOTO ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector('.btn.primary');
      return !!b && document.getElementById('menu') && !document.getElementById('menu').classList.contains('hidden');
    }, { timeout: 120000, polling: 500 });
    await wait(2000);
    await page.evaluate(() => document.querySelector('.btn.primary')?.click());
    await page.waitForFunction(() => {
      const c = document.querySelector('.countdown');
      return c !== null && c.classList.contains('hidden');
    }, { timeout: 90000, polling: 400 });
    await wait(1000);
    for (const view of item.views) {
      await page.evaluate((v) => {
        const b = document.querySelector(`.view-btn[data-view="${v}"]`);
        if (b) b.click();
      }, view);
      await wait(2200);
      const f = path.join(OUT, `${item.tag}_${view}.png`);
      fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
      log(`SHOT ${f}`);
    }
  } catch (e) {
    log(`SESSION ${item.tag} FAILED: ${String(e).slice(0, 300)}`);
  }
  await page.close();
}
await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
