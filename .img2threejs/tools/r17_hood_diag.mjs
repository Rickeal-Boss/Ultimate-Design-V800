// R17 P0-4 诊断：preview 复刻 hood 机位，材质消去法定位顶带表面
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
import fs from 'node:fs';
const CDP = Number(process.env.CDP || 9471);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const OUT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await page.goto(`${URLBASE}preview.html#assembled`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', { timeout: 120000, polling: 500 });
await wait(1200);
const setHood = () => {
  const cam = window.__v800Camera;
  cam.position.set(0, 1.45, -1.45);
  cam.lookAt(0, 0.95, -16);
  cam.fov = 66; cam.near = 0.1; cam.updateProjectionMatrix();
  window.__v800Info();
};
// 基线 + 三个消去变体
const variants = [
  ['base', null],
  ['no-leather-ivory', 'leather-ivory'],
  ['no-headliner-suede', 'headliner-suede'],
  ['no-starlight', 'starlight'],
];
for (const [name, mat] of variants) {
  await page.evaluate((m) => {
    // 先全部恢复
    window.__v800HideMat('leather-ivory', false);
    window.__v800HideMat('headliner-suede', false);
    window.__v800HideMat('starlight', false);
    if (m) window.__v800HideMat(m, true);
  }, mat);
  await page.evaluate(setHood);
  await wait(250);
  const f = `${OUT}/hood_diag_${name}.png`;
  fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
  console.log('SHOT', f);
}
await browser.disconnect();
process.exit(0);
