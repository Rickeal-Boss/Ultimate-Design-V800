// R17 双车目检：一次浏览器会话内跑完（V800 5 机位 + R7 7 机位 + 消去法变体）
// 用法：先起 vite（IPv6 监听），经 r14-run.ps1 包装起 Edge：
//   powershell -File .img2threejs/tools/r14-run.ps1 -Mode qa -Script r17_qa.mjs -CDP 9461
// 或手动：Edge headless 起 CDP 后 CDP=9461 node .img2threejs/tools/r17_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9461);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = process.env.OUT || ROOT + '/verify/r17';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logf = path.join(OUT, 'qa.log');
const log = (s) => { fs.appendFileSync(logf, s + '\n'); console.log(s); };

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });

const PLAN = [
  { vehicle: 'v800', views: ['cabin', 'chase', 'hood', 'orbit', 'side'] },
  { vehicle: 'r7', views: ['cabinDriver', 'cabinPassenger', 'cabinRear', 'chase', 'orbit', 'side'] },
];

for (const item of PLAN) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 200)));
  const url = `${URLBASE}#vehicle=${item.vehicle}`;
  log('GOTO ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => {
    const b = document.querySelector('.btn.primary');
    return !!b && document.getElementById('menu') && !document.getElementById('menu').classList.contains('hidden');
  }, { timeout: 120000, polling: 500 });
  await wait(2500);
  const menuShot = path.join(OUT, `${item.vehicle}_menu.png`);
  fs.writeFileSync(menuShot, await page.screenshot({ type: 'png' }));
  log('SHOT ' + menuShot);

  await page.evaluate(() => document.querySelector('.btn.primary')?.click());
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.countdown');
      return c !== null && c.classList.contains('hidden');
    },
    { timeout: 90000, polling: 400 }
  );
  await wait(1200);

  for (const view of item.views) {
    const ok = await page.evaluate((v) => {
      const b = document.querySelector(`.view-btn[data-view="${v}"]`);
      if (b) { b.click(); return true; }
      return false;
    }, view);
    await wait(2000);
    const active = await page.evaluate(() => document.querySelector('.view-btn.active')?.getAttribute('data-view') || '');
    const f = path.join(OUT, `${item.vehicle}_${view}.png`);
    fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
    log(`SHOT ${f} btn=${ok} active=${active}`);
  }
  // 控制台关键行（遮挡材质克隆数 / 挂载清单 / 合批数字）
  for (const l of logs) {
    if (/cabin occluder|参考图贴图挂载|batchmerge|refTextures|抽稀|QA/.test(l)) log('  LOG ' + l.slice(0, 220));
  }
  await page.close();
}
await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
