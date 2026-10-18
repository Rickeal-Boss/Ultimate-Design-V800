// 游戏内截图（连接已启动的 Edge）：按 V 循环机位，截 canvas
// 用法：CDP=9452 OUT=... KEYS=vv WAIT=1200 node r14_game.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9444);
const URL = process.env.URL || 'http://127.0.0.1:5194/';
const HASH = process.env.HASH || '';
const OUT = process.env.OUT || 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r14/game';
const NAME = process.env.NAME || 'shot';
const KEYS = process.env.KEYS || '';
const WAIT = Number(process.env.WAIT || 1500);
const HOLD = Number(process.env.HOLD || 0);

fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
log('GOTO ' + URL + HASH);
await page.goto(URL + HASH, { waitUntil: 'domcontentloaded', timeout: 90000 });
await wait(4000);
// 菜单里的「开始挑战」按钮（.btn.primary）
try {
  await page.evaluate(() => {
    const b = document.querySelector('.btn.primary');
    if (b) b.click();
  });
  log('START clicked');
} catch { log('START click failed'); }
await wait(1200);
// 倒计时 3s 结束后才进入 accel 阶段；机位按钮在 countdown 阶段会被忽略 → 先等再点
if (HOLD) await wait(HOLD);
await wait(WAIT);
for (const k of KEYS) {
  await page.keyboard.press(k);
  await wait(350);
}
// CLICKTEXT：点 HUD 机位按钮（data-view=chase|hood|cabin|side）
const CLICKTEXT = process.env.CLICKTEXT || '';
if (CLICKTEXT) {
  const ok = await page.evaluate((tt) => {
    const sel = document.querySelector(`.view-btn[data-view="${tt}"]`);
    if (sel) { sel.click(); return 'view-btn'; }
    const all = Array.from(document.querySelectorAll('button, [role=button]'));
    const el = all.find((e) => (e.textContent || '').trim() === tt && e.offsetParent !== null);
    if (el) { el.click(); return 'text'; }
    return 'none';
  }, CLICKTEXT);
  log('CLICK ' + CLICKTEXT + ' -> ' + ok);
  await wait(900);
}
await wait(Number(process.env.SETTLE || 500));
const buf = await page.screenshot({ type: 'png' });
const f = path.join(OUT, NAME + '.png');
fs.writeFileSync(f, buf);
log('SHOT ' + f + ' bytes=' + buf.length);
const bad = logs.filter((l) => /error|Error|PAGEERROR|NaN/i.test(l));
if (bad.length) log('--- CONSOLE ---\n' + bad.slice(0, 20).join('\n'));
await page.close();
browser.disconnect();
process.exit(0);
