// R17b 收尾 QA：绿牌下调 / 尾灯外凸 / 方向盘+眼点 / R7 B柱 / R7 双牌近距
// 会话表：每条一个独立 page（#eye 是 URL hash，必须重载）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9473);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = process.env.OUT || ROOT + '/verify/r17b';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logf = path.join(OUT, 'qa.log');
const log = (s) => { fs.appendFileSync(logf, s + '\n'); console.log(s); };

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });

// hash 追加 &eye=... 的会话给 { eye: '...' }
const SESSIONS = [
  { tag: 'v800a', vehicle: 'v800', views: ['chase', 'hood', 'side'] },
  { tag: 'v800eyeA', vehicle: 'v800', eye: '-0.40,1.20,-0.72,-0.30,0.98,-9', views: ['cabin'] },
  { tag: 'v800eyeB', vehicle: 'v800', eye: '-0.42,1.15,-0.70,-0.30,0.95,-9', views: ['cabin'] },
  { tag: 'r7a', vehicle: 'r7', views: ['side', 'cabinDriver', 'chase'] },
  { tag: 'r7plateRear', vehicle: 'r7', eye: '0,0.85,4.6,0,0.8,2.45', views: ['cabinDriver'] },
  { tag: 'r7plateFront', vehicle: 'r7', eye: '0,0.62,-4.6,0,0.58,-2.45', views: ['cabinDriver'] },
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
      const ok = await page.evaluate((v) => {
        const b = document.querySelector(`.view-btn[data-view="${v}"]`);
        if (b) { b.click(); return true; }
        return false;
      }, view);
      await wait(2200);
      const f = path.join(OUT, `${item.tag}_${view}.png`);
      fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
      log(`SHOT ${f} btn=${ok}`);
    }
  } catch (e) {
    log(`SESSION ${item.tag} FAILED: ${String(e).slice(0, 300)}`);
  }
  await page.close();
}
await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
