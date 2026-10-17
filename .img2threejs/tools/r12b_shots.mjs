// R12b 一体化截图：vite dev（API 启动）+ Edge headless + 采集 + 关闭（单命令链，防进程树回收）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.CDPPORT || 9346);
const PROFILE = ROOT + '/.img2threejs/renders/.edge-r12b-profile';
const OUT = process.env.OUT || ROOT + '/.img2threejs/renders/r12b';
const HASH = process.env.HASH || '';
const CABIN = process.env.CABIN || '';
const SHOTS = (process.env.SHOTS || '').split(',').filter(Boolean).map((s) => {
  const [name, az, pitch, dist, ty] = s.split(':');
  return { name, az: +az, pitch: +pitch, dist: +dist, ty: +(ty || 0) };
});
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({ root: ROOT, server: { port: 5174, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = 'http://127.0.0.1:5174/preview.html';

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });

async function waitDebugger() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch { }
    await wait(500);
  }
  throw new Error('Edge debugger not reachable');
}

const logs = [];
try {
  await waitDebugger();
  await wait(800);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(base + HASH, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /ready|captured|cabin:/.test(document.getElementById('status')?.textContent || ''), { timeout: 90000 });
  if (CABIN) {
    for (const row of CABIN.split(',')) {
      const dataUrl = await page.evaluate((r) => window.__v800CaptureCabin('cabin-' + r, r, {}), row);
      fs.writeFileSync(path.join(OUT, `cabin-${row}.png`), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
      console.log('SHOT cabin-' + row);
    }
  }
  const CABIN_SHOT = process.env.CABIN_SHOT || '';
  if (CABIN_SHOT) {
    for (const spec of CABIN_SHOT.split('|').filter(Boolean)) {
      const [name, eye, tgt] = spec.split(':');
      const [x, y, z] = eye.split(',').map(Number);
      const [tx, ty, tz] = tgt.split(',').map(Number);
      const dataUrl = await page.evaluate((n, a, b, c, d, e, f) => window.__v800CabinShot(n, a, b, c, d, e, f), name, x, y, z, tx, ty, tz);
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
      console.log('SHOT ' + name);
    }
  }
  for (const s of SHOTS) {
    const dataUrl = await page.evaluate((n, az, pi, d, ty) => window.__v800Capture(n, az, pi, d, ty), s.name, s.az, s.pitch, s.dist, s.ty);
    const f = path.join(OUT, `${s.name}.png`);
    fs.writeFileSync(f, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log('SHOT ' + s.name + ' bytes=' + fs.statSync(f).size);
  }
  const info = await page.evaluate(() => (window.__v800Info ? window.__v800Info() : null));
  console.log('INFO ' + JSON.stringify(info));
  browser.disconnect();
} catch (e) {
  console.error('FAIL', e && e.stack ? e.stack.slice(0, 700) : String(e));
  process.exitCode = 1;
} finally {
  try { edge.kill(); } catch { }
  await server.close();
  await wait(200);
}
const keep = logs.filter((l) => /uvassert|assert|error|Error|WARN|NaN|越界|batchmerge|lightassert/i.test(l));
if (keep.length) console.log('--- CONSOLE ---\n' + keep.slice(0, 30).join('\n'));
console.log('DONE');
