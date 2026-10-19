// R17 闸口数字：#uvassert + #batchmerge 控制台输出采集（双车）
import puppeteer from 'file:///C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import fs from 'node:fs';

const OUT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17/gates.log';
const URLB = process.env.URL || 'http://[::1]:4317/';
const CDP = Number(process.env.CDP || 9471);
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const veh of ['v800', 'r7']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 640 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(`${URLB}#vehicle=${veh}&uvassert&batchmerge`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!document.querySelector('.btn.primary'), { timeout: 120000, polling: 500 });
  await wait(2000);
  const rel = logs.filter((l) => /uvassert|batchmerge|各向异性|串味|Draw Call|mesh|挂载|occluder|license|车牌/i.test(l));
  fs.appendFileSync(OUT, `\n===== ${veh} =====\n` + rel.join('\n') + '\n');
  console.log(`--- ${veh} ---`);
  for (const l of rel) console.log(l.slice(0, 240));
  await page.close();
}
await browser.disconnect();
console.log('GATES DONE');
process.exit(0);
