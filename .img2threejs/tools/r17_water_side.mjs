// R17 水面侧视复现：开到桥（z≈-450）后切「侧跟」机位截帧
import puppeteer from 'file:///C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import fs from 'node:fs';

const OUT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17/water';
fs.mkdirSync(OUT, { recursive: true });
const URL = process.env.URL || 'http://[::1]:4317/index.html';
const CDP = Number(process.env.CDP || 9465);

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const tabs = await browser.pages();
for (const t of tabs.slice(1)) await t.close().catch(() => {});
const page = tabs[0];
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction("document.getElementById('loading')?.className.includes('done')", { timeout: 180000 });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#menu button')].find((b) => b.textContent?.includes('开始'));
  btn?.click();
});
await new Promise((r) => setTimeout(r, 3500));
await page.keyboard.down('w');

const readDist = () =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll('div,span')];
    for (const e of all) {
      const t = (e.textContent || '').trim();
      if (/^\d{2,4}m$/.test(t) && e.children.length === 0) return parseInt(t, 10);
    }
    return -1;
  });

for (let i = 0; i < 300; i++) {
  const d = await readDist();
  if (i % 15 === 0) console.log('dist', d);
  if (d <= 880 && d >= 820) {
    // 切侧跟机位看水面
    await page.evaluate(() => {
      const b = document.querySelector('.view-btn[data-view="side"]');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `${OUT}/side_${d}m.png` });
    console.log('saved side', d);
    // 再切环绕
    await page.evaluate(() => {
      const b = document.querySelector('.view-btn[data-view="orbit"]');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `${OUT}/orbit_${d}m.png` });
    console.log('saved orbit', d);
    break;
  }
  await new Promise((r) => setTimeout(r, 150));
}
await page.keyboard.up('w');
await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
