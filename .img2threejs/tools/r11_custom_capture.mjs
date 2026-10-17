// 自定义机位截图：SHOTS="name:az:pitch:dist:targetY,..." OUT=dir
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const url = process.env.VURL;
const outDir = process.env.OUT;
const port = Number(process.env.CDPPORT || 9333);
const shots = (process.env.SHOTS || '').split(',').filter(Boolean).map((s) => {
  const [name, az, pitch, dist, ty] = s.split(':');
  return { name, az: +az, pitch: +pitch, dist: +dist, ty: +(ty || 0) };
});
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => /ready|captured|cabin:/.test(document.getElementById('status')?.textContent || ''), { timeout: 90000 });
for (const s of shots) {
  const dataUrl = await page.evaluate((n, az, pi, d, ty) => window.__v800Capture(n, az, pi, d, ty), s.name, s.az, s.pitch, s.dist, s.ty);
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const file = path.join(outDir, `${s.name}.png`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('SHOT ' + s.name + ' bytes=' + fs.statSync(file).size);
}
browser.disconnect();
console.log('DONE');
