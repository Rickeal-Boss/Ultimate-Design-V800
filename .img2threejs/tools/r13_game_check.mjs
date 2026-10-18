// R13 桥+水 游戏内目检：#autodrive 自动跑加速段，定时抓 canvas 帧
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = ROOT + '/verify/r13f';
const PORT = 9393;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await createServer({ root: ROOT, server: { port: 5179, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/r13edge_game_${process.pid}`,
  '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
    await wait(500);
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1280, height: 720 } });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
  await page.goto('http://127.0.0.1:5179/#autodrive', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等待加载屏消失
  await wait(6000);
  // autodrive: 菜单需点击开始？检查游戏是否自动开始——若菜单在，点开始按钮
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => /开始|start/i.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  console.log('startClicked=' + clicked);
  // CDP 真实鼠标按住油门滑条到底（不松手）
  const pt = await page.evaluate(() => {
    const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent?.trim() === '油门');
    const wrap = label?.parentElement;
    if (!wrap) return null;
    const r = wrap.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 4 };
  });
  if (!pt) throw new Error('throttle slider not found');
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  console.log('throttleHeld at', JSON.stringify(pt));
  const t0 = Date.now();
  const marks = [22000, 30000, 38000];
  for (const m of marks) {
    const dt = m - (Date.now() - t0);
    if (dt > 0) await wait(dt);
    await page.screenshot({ path: `${OUT}/game_${m}.png` });
    console.log('SHOT game_' + m);
  }
  console.log('ERRORS=' + (errors.length ? '\n' + errors.slice(0, 10).join('\n') : 'none'));
  browser.disconnect();
  process.exit(0);
} catch (e) {
  console.error('FAIL', String(e).slice(0, 500));
  process.exit(1);
} finally {
  try { edge.kill(); } catch {}
  await server.close();
}
