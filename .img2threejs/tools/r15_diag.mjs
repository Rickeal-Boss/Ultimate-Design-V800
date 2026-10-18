// 最小诊断：加载页面 15s，dump console / pageerror / DOM 状态
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const CDP = Number(process.env.CDP || 9457);
const URLB = process.env.URL || 'http://[::1]:4317/';
const HASH = process.env.HASH || '#vehicle=r7';
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const logs = [];
page.on('console', (m) => logs.push('CONSOLE ' + m.type() + ': ' + m.text().slice(0, 300)));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 500)));
page.on('requestfailed', (r) => logs.push('REQFAIL ' + r.url().slice(0, 120) + ' ' + (r.failure()?.errorText || '')));
console.log('GOTO ' + URLB + HASH);
try {
  await page.goto(URLB + HASH, { waitUntil: 'load', timeout: 60000 });
  console.log('LOADED');
} catch (e) { console.log('GOTO FAIL ' + e.message); }
await new Promise((r) => setTimeout(r, 15000));
const dom = await page.evaluate(() => ({
  menu: document.getElementById('menu')?.className,
  menuHTML: (document.getElementById('menu')?.innerHTML || '').slice(0, 200),
  loading: document.getElementById('loading')?.className,
  app: (document.getElementById('app')?.innerHTML || '').length,
  status: document.getElementById('status')?.textContent || ''
}));
console.log('DOM ' + JSON.stringify(dom));
console.log(logs.slice(0, 40).join('\n'));
const buf = await page.screenshot({ type: 'png' });
fs.writeFileSync('C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r15/diag_page.png', buf);
await page.close();
await browser.disconnect();
process.exit(0);
