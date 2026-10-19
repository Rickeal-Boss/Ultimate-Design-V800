// R17 调试：抓 R7 组件索引键 + 遮挡诊断（一次性探针）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9463);
const URLBASE = process.env.URL || 'http://[::1]:4317/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
await page.goto(`${URLBASE}#vehicle=r7`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => {
  const b = document.querySelector('.btn.primary');
  return !!b && document.getElementById('menu') && !document.getElementById('menu').classList.contains('hidden');
}, { timeout: 120000, polling: 500 });
await wait(3000);
for (const l of logs) {
  if (/DBG|occluder|挂载|WARN|ERROR|error/i.test(l)) console.log(l.slice(0, 600));
}
await browser.disconnect();
process.exit(0);
