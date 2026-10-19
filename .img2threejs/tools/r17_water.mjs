// R17 水温复现：按住 W 开到跨河桥（z≈-450，距障 700~930m 区间）截帧
// 前置：vite dev server（IPv6 [::1] 监听）+ Edge headless CDP
import puppeteer from 'file:///C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const OUT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17/water';
const URL = process.env.URL || 'http://[::1]:4317/index.html#perfhud';
const fs = await import('node:fs');
fs.mkdirSync(OUT, { recursive: true });

const CDP = Number(process.env.CDP || 9462);
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
  return !!btn;
});
await new Promise((r) => setTimeout(r, 3000));
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

let shot = 0;
const t0 = Date.now();
for (let i = 0; i < 400; i++) {
  const d = await readDist();
  if (i % 20 === 0) console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', 'dist', d);
  // 桥在 450m 处 → 距路障 850m；930..700 区间密集截帧
  if (d <= 930 && d >= 700) {
    const file = `w_${String(shot).padStart(2, '0')}_${d}m.png`;
    await page.screenshot({ path: `${OUT}/${file}` });
    console.log('saved', file);
    shot++;
    if (shot >= 10) break;
    await new Promise((r) => setTimeout(r, 250));
  } else {
    await new Promise((r) => setTimeout(r, 120));
  }
  if (d < 400) break;
}
// 停车前再截一张车头正前（桥上）
await page.keyboard.up('w');
await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
