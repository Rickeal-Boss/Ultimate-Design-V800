// R15c 眼点标定扫描：同一 cabin 机位，沿纵深逐点取景（#eye 钩子）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9475);
const URLB = process.env.URL || 'http://[::1]:4317/';
const OUT = process.env.OUT || 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r15c';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);

// 眼点候选（世界坐标），注视点统一 (−0.40, 1.02, −9)
const TGT = '-0.40,1.02,-9';
const EYES = (process.env.EYES || '-1.00,-1.10,-1.20,-1.30').split(',').map(Number);
const XS = (process.env.EX || '-0.50').split(',').map(Number);

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });

for (const x of XS) {
  for (const z of EYES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
    page.on('console', (m) => { const t = m.text(); if (/cabin|batch|refTextures|Adapter/.test(t)) log('  ' + t.slice(0, 160)); });
    const hash = `#vehicle=v800&eye=${x},${process.env.EY || '1.26'},${z},${TGT}`;
    await page.goto(URLB + hash, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => !!document.querySelector('.btn.primary'), { timeout: 120000, polling: 400 });
    await page.evaluate(() => document.querySelector('.btn.primary')?.click());
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.countdown');
        return el !== null && el.classList.contains('hidden');
      },
      { timeout: 90000, polling: 400 }
    );
    await wait(1000);
    await page.evaluate(() => document.querySelector('.view-btn[data-view="cabin"]')?.click());
    await wait(1800);
    const f = path.join(OUT, `eye_x${x}_z${z}.png`);
    fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
    log(`SHOT ${f}`);
    await page.close();
  }
}
await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
