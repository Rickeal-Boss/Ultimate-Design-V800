// R11 终验：#assembled#uvassert 控制台校验 + 侧/正/45° QA 截图
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const base = process.env.VURL; // http://localhost:5199/preview.html
const outDir = process.env.OUT;
const port = Number(process.env.CDPPORT || 9333);
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// ---- 1) assembled + uvassert ----
await page.goto(base + '#assembled#uvassert', { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(
    () => /#uvassert/.test(document.getElementById('status')?.textContent || '') ||
      logs.length > 0,
    { timeout: 90000 }
  );
} catch { /* 继续读 logs */ }
await new Promise((r) => setTimeout(r, 4000));
const uvLines = logs.filter((l) => /#uvassert/.test(l));
console.log('== UVASSERT ==');
for (const l of uvLines) console.log(l.slice(0, 400));

// ---- 2) 裸模型三机位 ----
logs.length = 0;
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => /ready|captured/.test(document.getElementById('status')?.textContent || ''), { timeout: 90000 });
const shots = [
  ['r11_side', 90, 8, 9.0, 0],
  ['r11_front', 0, 8, 9.0, 0],
  ['r11_hero45', 40, 12, 8.4, 0],
];
for (const [name, az, pitch, dist, ty] of shots) {
  const dataUrl = await page.evaluate((n, a, p, d, t) => window.__v800Capture(n, a, p, d, t), name, az, pitch, dist, ty);
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('SHOT ' + name + ' bytes=' + fs.statSync(file).size);
}
fs.writeFileSync(path.join(outDir, 'r11_console.log'), logs.join('\n'), 'utf8');
const errs = logs.filter((l) => /\[error\]|\[pageerror\]/.test(l));
console.log('CONSOLE_ERRORS=' + errs.length);
browser.disconnect();
console.log('DONE');
