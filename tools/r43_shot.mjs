/** R43 车模外观 QA 截图：Edge headless + puppeteer-core，走 preview.ts#assembled
 *  用法: node tools/r43_shot.mjs <outDir> [tag] [--vehicle=r7] [--hash=...] [--shots=...]
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = '<REPO_ROOT>';
const args = process.argv.slice(2);
const OUT = args[0] || `${ROOT}/.qa/r43_car/shots`;
const TAG = args[1] || 'now';
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const VEHICLE = opt('vehicle', 'v800');
const HASH = opt('hash', 'assembled');
const PORT = Number(opt('port', '5273'));
const SHOTS = opt('shots', 'f45:225:6:9.2,side:270:4:9.4,r45:135:8:9.2,front:180:6:9.2,top:180:58:9.6');

fs.mkdirSync(OUT, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const DPORT = 9471;
const PROFILE = `${ROOT}/.img2threejs/renders/.edge-r43`;
const URL = `http://127.0.0.1:${PORT}/preview.html#${HASH}${VEHICLE === 'r7' ? '&vehicle=r7' : ''}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = (process.env.R43_ATTACH === '1') ? null : spawn(EDGE, ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${DPORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--window-size=1400,900', 'about:blank'],
{ stdio: 'ignore' });

let browser;
try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DPORT}/json/version`);
      if (r.ok) break;
    } catch { /* retry */ }
    await wait(400);
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DPORT}`, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 400)));
  console.log('GOTO', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => {
    const s = document.getElementById('status');
    return s && /ready/i.test(s.textContent || '');
  }, { timeout: 180000 });
  await wait(1800);
  const info = await page.evaluate(() => (typeof window.__v800Info === 'function' ? window.__v800Info() : null));
  console.log('INFO', JSON.stringify(info));
  for (const spec of SHOTS.split(',').filter(Boolean)) {
    const [name, az, pitch, dist] = spec.split(':');
    const url = await page.evaluate((n, a, p, d) => window.__v800Capture(n, +a, +p, +d), name, az, pitch, dist);
    const f = `${OUT}/${TAG}_${name}.png`;
    fs.writeFileSync(f, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log('SHOT', f, fs.statSync(f).size);
  }
  const bad = logs.filter((l) => /PAGEERROR|error/i.test(l));
  if (bad.length) console.log('LOGS(error):\n' + bad.slice(0, 20).join('\n'));
} finally {
  try { if (browser) await browser.disconnect(); } catch { /* ignore */ }
  try { edge.kill(); } catch { /* ignore */ }
}
