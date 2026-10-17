// 舱内机位截图：CABIN=front|rear OUT=dir VURL=...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const EDGE_OK = true;
const url = process.env.VURL;
const outDir = process.env.OUT;
const port = Number(process.env.CDPPORT || 9333);
const cabin = process.env.CABIN || 'front';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url + '#cabin=' + cabin, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => /ready|captured|cabin:/.test(document.getElementById('status')?.textContent || ''), { timeout: 90000 });
} catch (e) {
  const st = await page.evaluate(() => document.getElementById('status')?.textContent || '(no status)');
  console.log('TIMEOUT status=' + st);
  console.log('LOGS:\n' + logs.join('\n').slice(0, 3000));
  await browser.disconnect();
  process.exit(1);
}

const rows = cabin === 'front' ? ['front', 'rear'] : [cabin];
for (const row of rows) {
  const shots = [
    [`${row}-center`, { zoom: 1 }],
    [`${row}-wide`, { zoom: 0.55 }],
  ];
  for (const [name, opts] of shots) {
    const dataUrl = await page.evaluate((r, o) => window.__v800CaptureCabin('cabin', r, o), row, opts);
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const file = path.join(outDir, `cabin-${name}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('SHOT cabin-' + name + ' bytes=' + fs.statSync(file).size);
  }
}
fs.writeFileSync(path.join(outDir, 'console.log'), logs.join('\n'), 'utf8');
console.log('CONSOLE_ERRORS=' + logs.filter((l) => /\[error\]|\[pageerror\]/.test(l)).length);
browser.disconnect();
console.log('DONE');
