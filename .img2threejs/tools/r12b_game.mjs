// R12b 游戏实机冒烟：vite dev + Edge headless 打开 /#autodrive，等 HUD/渲染，整页截图
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9366;
const OUT = process.env.OUT || ROOT + '/.img2threejs/renders/r12c';
const HASH = process.env.GAMEHASH || '#autodrive';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ root: ROOT, server: { port: 5176, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ROOT}/.img2threejs/renders/.edge-game`, '--no-first-run', '--no-proxy-server', '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { } await wait(400); }
const logs = [];
try {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 400)));
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:5176/' + HASH, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(6000);
  await page.screenshot({ path: path.join(OUT, 'game_autodrive.png') });
  const fps = await page.evaluate(() => (window.__v800Perf ? window.__v800Perf() : null));
  console.log('GAME shot ms=' + (Date.now() - t0), 'perf=' + JSON.stringify(fps));
  browser.disconnect();
} catch (e) { console.error('FAIL', String(e).slice(0, 500)); process.exitCode = 1; }
finally { try { edge.kill(); } catch { } await server.close(); }
console.log('--- LOGS ---');
for (const l of logs.filter((x) => /error|Error|assert|WARN|uvassert|batchmerge|NaN/i.test(x)).slice(0, 20)) console.log(l.slice(0, 240));
console.log('DONE');
