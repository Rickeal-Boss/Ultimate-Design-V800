// R17 P0-3：座椅菱格特写（preview #assembled，相机贴近菱格批次 bbox 前上角）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
import fs from 'node:fs';
const CDP = Number(process.env.CDP || 9468);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const VEH = process.env.VEH || 'v800';
const OUT = process.env.OUT || 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await page.goto(`${URLBASE}preview.html#assembled&vehicle=${VEH}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', { timeout: 120000, polling: 500 });
await wait(1500);
const r = await page.evaluate(() => {
  const scene = window.__v800Scene();
  const cam = window.__v800Camera;
  let target = null;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m?.userData?.refTexture?.image === 'seat-quilt') && !target) target = o;
  });
  if (!target) return null;
  target.geometry.computeBoundingBox();
  const bb = target.geometry.boundingBox;
  // 世界系 bbox（合并 mesh 在 mergeTarget 下，直接读局部 bbox + matrixWorld）
  const min = bb.min.clone().applyMatrix4(target.matrixWorld);
  const max = bb.max.clone().applyMatrix4(target.matrixWorld);
  const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
  // 瞄准「最前排座椅靠背」：世界 z 最小（车头 -Z 方向）那一片的顶部
  const aim = { x: cx * 0.5, y: max.y - 0.12, z: min.z + 0.18 };
  // 相机：从瞄准点斜上方 0.55m、外侧 0.5m 贴近拍摄
  cam.position.set(aim.x + 0.55, aim.y + 0.42, aim.z + 0.62);
  cam.lookAt(aim.x, aim.y, aim.z);
  cam.fov = 45; cam.near = 0.05; cam.updateProjectionMatrix();
  return { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z], aim, cam: [cam.position.x, cam.position.y, cam.position.z] };
});
console.log('BBOX', JSON.stringify(r));
// preview 无 rAF 循环：__v800Info() 内部 renderer.render(scene, camera) 且不摆机位
await page.evaluate(() => { window.__v800Info(); });
await wait(300);
const file = `${OUT}/${VEH}_quilt_closeup.png`;
fs.writeFileSync(file, await page.screenshot({ type: 'png' }));
console.log('SHOT', file);
await browser.disconnect();
process.exit(0);
