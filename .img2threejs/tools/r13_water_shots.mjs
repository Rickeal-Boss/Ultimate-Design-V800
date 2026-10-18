// Waterway 独立渲染探针：water-qa.html 三机位截图
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = ROOT + '/verify/r13f';
const PORT = 9396;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await createServer({ root: ROOT, server: { port: 5181, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/r13edge_wq_${process.pid}`,
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
  await page.goto('http://127.0.0.1:5181/water-qa.html', { waitUntil: 'networkidle0', timeout: 60000 });
  await wait(1500);
  for (let k = 0; k < 3; k++) {
    const name = await page.evaluate(() => window.__nextShot());
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log('SHOT ' + name);
  }
  console.log('ERRORS=' + (errors.length ? '\n' + errors.join('\n') : 'none'));
  browser.disconnect();
  process.exit(0);
} catch (e) {
  console.error('FAIL', String(e).slice(0, 500));
  process.exit(1);
} finally {
  try { edge.kill(); } catch {}
  await server.close();
}
