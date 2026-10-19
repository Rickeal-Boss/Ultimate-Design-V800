// R17b R7 车牌探针：读 [R17b-probe] 控制台输出
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const CDP = Number(process.env.CDP || 9475);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 640 });
page.on('console', (m) => {
  if (m.text().includes('R17b-probe')) console.log(m.text());
});
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await page.goto(`${URLBASE}#vehicle=r7`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !!document.querySelector('.btn.primary'), { timeout: 120000, polling: 500 });
await new Promise((r) => setTimeout(r, 3000));
await browser.disconnect();
process.exit(0);
