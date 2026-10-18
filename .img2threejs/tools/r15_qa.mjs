// R15 双车目检：一次浏览器会话内跑完
//  - V800 游戏内 cabin 机位（验证三联屏下移后路面可见）
//  - R7 菜单环绕 + 主驾/副驾/后排 + 追驰（验证整车与三处内饰机位）
// 用法（必须经 r14-run.ps1 包装）：MODE=qa node r15_qa.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9455);
const URLBASE = process.env.URL || 'http://localhost:4317/';
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = process.env.OUT || ROOT + '/verify/r15';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logf = path.join(OUT, 'qa.log');
const log = (s) => { fs.appendFileSync(logf, s + '\n'); console.log(s); };

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });

const PLAN = [
  { vehicle: 'v800', views: ['cabin', 'chase'] },
  { vehicle: 'r7', views: ['cabinDriver', 'cabinPassenger', 'cabinRear', 'chase', 'orbit'] },
];

for (const item of PLAN) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 200)));
  // ⚠️ 不要挂 #rafpump：该钩子在 <head> 里把 rAF 换成 Worker 泵，headless 下文档
  // 的 load 事件永不触发（实测 Navigation timeout），这里前台标签页原生 rAF 足够。
  const url = `${URLBASE}#vehicle=${item.vehicle}`;
  log('GOTO ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // 菜单态（orbit 自动机位）
  // ⚠️ 必须 polling:'interval'：本页挂着 #rafpump（rAF 被 Worker 泵接管），
  // puppeteer 默认的 rAF 轮询会永远等不到 tick（R15 首跑 120s 超时的真因）。
  await page.waitForFunction(() => {
    const b = document.querySelector('.btn.primary');
    return !!b && document.getElementById('menu') && !document.getElementById('menu').classList.contains('hidden');
  }, { timeout: 120000, polling: 500 });
  await wait(2500);
  const menuShot = path.join(OUT, `${item.vehicle}_menu.png`);
  fs.writeFileSync(menuShot, await page.screenshot({ type: 'png' }));
  log('SHOT ' + menuShot);

  const label = await page.evaluate(() => document.querySelector('.menu-sub')?.textContent || '');
  log(`MENU_SUB[${item.vehicle}] ${label}`);

  await page.evaluate(() => document.querySelector('.btn.primary')?.click());
  await wait(1500);
  // 倒计时 3s 结束（GO 显示 700ms 后隐藏）。headless 帧率低时物理步进被 0.1s/帧 上限
  // 拖慢，仿真时间只有真实时间的 ~0.4 倍 —— 必须等 DOM 信号，不能死等墙钟。
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.countdown');
      return c !== null && c.classList.contains('hidden');
    },
    { timeout: 90000, polling: 400 }
  );
  await wait(1200);

  for (const view of item.views) {
    const ok = await page.evaluate((v) => {
      const b = document.querySelector(`.view-btn[data-view="${v}"]`);
      if (b) { b.click(); return true; }
      return false;
    }, view);
    await wait(2000);
    const active = await page.evaluate(() => document.querySelector('.view-btn.active')?.getAttribute('data-view') || '');
    const f = path.join(OUT, `${item.vehicle}_${view}.png`);
    fs.writeFileSync(f, await page.screenshot({ type: 'png' }));
    log(`SHOT ${f} btn=${ok} active=${active}`);
  }

  // HUD 按钮清单（验证 R7 是否多出三内饰机位）
  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.view-btn')).map((b) => b.getAttribute('data-view') + '|' + (b.textContent || '').trim())
  );
  log(`VIEWBTNS[${item.vehicle}] ${btns.join(' , ')}`);

  const bad = logs.filter((l) => /error|Error|PAGEERROR|NaN|undefined is not/i.test(l));
  if (bad.length) log('--- CONSOLE ---\n' + bad.slice(0, 15).join('\n'));
  const tex = logs.filter((l) => /refTextures|贴图|Adapter/.test(l));
  if (tex.length) log('--- TEX ---\n' + tex.slice(0, 10).join('\n'));
  await page.close();
}

await browser.disconnect();
console.log('ALL DONE');
process.exit(0);
