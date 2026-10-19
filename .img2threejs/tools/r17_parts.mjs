// R17 调试：preview #assembled 装配态 parts 列表 + 菱格材质 mesh 世界坐标
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const CDP = Number(process.env.CDP || 9466);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const VEH = process.env.VEH || 'v800';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 640, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await page.goto(`${URLBASE}preview.html#assembled&vehicle=${VEH}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', { timeout: 120000, polling: 500 });
await wait(1500);
const info = await page.evaluate(() => {
  const scene = window.__v800Scene();
  const out = [];
  scene.traverse((o) => {
    const m = o;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const img = mat?.userData?.refTexture?.image;
      if (img === 'seat-quilt' || img === 'seat-cushion') {
        m.updateMatrixWorld(true);
        const e = m.matrixWorld.elements;
        const cid = m.userData?.sculptComponent?.id ?? m.userData?.component?.id ?? '(merged)';
        out.push({ cid, img, x: +e[12].toFixed(2), y: +e[13].toFixed(2), z: +e[14].toFixed(2), vis: m.visible });
      }
    }
  });
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.disconnect();
process.exit(0);
