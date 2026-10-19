// R17b 收官：V800 车尾近距（尾灯外凸验证）+ 双车 uvassert/batchmerge 闸口
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const CDP = Number(process.env.CDP || 9479);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const OUT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17b';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });

// 1) 车尾近距
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  await page.goto(`${URLBASE}#vehicle=v800&eye=0,1.05,5.8,0,0.92,2.8`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!document.querySelector('.btn.primary'), { timeout: 120000, polling: 500 });
  await wait(2000);
  await page.evaluate(() => document.querySelector('.btn.primary')?.click());
  await page.waitForFunction(() => { const c = document.querySelector('.countdown'); return c !== null && c.classList.contains('hidden'); }, { timeout: 90000, polling: 400 });
  await page.evaluate(() => document.querySelector('.view-btn[data-view="cabin"]')?.click());
  await wait(2200);
  fs.writeFileSync(path.join(OUT, 'v800_tail_closeup.png'), await page.screenshot({ type: 'png' }));
  console.log('SHOT tail closeup');
  await page.close();
}
// 2) 双车闸口
for (const veh of ['v800', 'r7']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 640 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(`${URLBASE}#vehicle=${veh}&uvassert&batchmerge`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!document.querySelector('.btn.primary'), { timeout: 120000, polling: 500 });
  await wait(2500);
  const rel = logs.filter((l) => /uvassert|batchmerge|各向异性|串味|Draw Call|mesh|挂载|occluder|车牌|license/i.test(l));
  console.log(`--- ${veh} ---`);
  for (const l of rel) console.log(l.slice(0, 240));
  await page.close();
}
await browser.disconnect();
process.exit(0);
