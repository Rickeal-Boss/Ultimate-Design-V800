/**
 * R162 落地审查 · 车漆反光 A/B 目检（当前构建 dist，只读快照）
 *
 * 机位（与 r143_review 同源 env 约定，near=1 仅车外远距）：
 *   - front34  3/4 前：3.6,1.5,-6.4 → 0,0.75,0  fov42
 *   - side     正侧：  7.4,1.15,0.01 → 0,0.8,0  fov40
 *   - rear34   后 3/4：-3.6,1.6,6.4 → 0,0.75,0  fov42
 *   - hood     机盖高光特写：2.6,1.35,-3.4 → 0,0.92,-0.5  fov34
 *   - fender   侧围高光特写：4.6,0.9,-2.4 → 0.9,0.85,-1.2  fov34
 *
 * 每 paint 变体 × 每机位 × 参数档（new 默认 / old A/B）各一帧。
 * old 档 = `#r62clearcoat=0.7&r62clearcoatrough=0.12&r56env=0.7`（R162 前默认值）。
 *
 * 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/r46_capture.ps1 \
 *   -NodeScript r162_review_capture.mjs -Tag r162 -EdgePort 9547
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const EDGE_PORT = Number(argv.port || 9547);
const HTTP_PORT = Number(argv.httpport || 5247);
const W = 1280, H = 800;
const OUT = path.join(ROOT, '.qa', 'r162');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const distStamp = () => {
  const p = path.join(ROOT, 'dist/index.html');
  const a = path.join(ROOT, 'dist/assets');
  return { index: fs.existsSync(p) ? fs.statSync(p).mtime.toISOString() : null,
    assetsMax: fs.existsSync(a) ? Math.max(...fs.readdirSync(a).map((f) => fs.statSync(path.join(a, f)).mtimeMs)) : 0 };
};

/* 机位表：name → [ex,ey,ez,tx,ty,tz,fov] */
const VIEWS = {
  front34: [3.6, 1.5, -6.4, 0, 0.75, 0, 42],
  side:    [7.4, 1.15, 0.01, 0, 0.8, 0, 40],
  rear34:  [-3.6, 1.6, 6.4, 0, 0.75, 0, 42],
  hood:    [2.6, 1.35, -3.4, 0, 0.92, -0.5, 34],
  fender:  [4.6, 0.9, -2.4, 0.9, 0.85, -1.2, 34],
};
const PAINTS = ['white', 'black', 'gold'];
/* 参数档：new=R162 默认（不带覆盖）；old=R162 前默认 */
const MODES = [
  { tag: 'new', hash: '' },
  { tag: 'old', hash: '&r62clearcoat=0.7&r62clearcoatrough=0.12&r56env=0.7' },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
function serveDist(port) {
  const base = path.join(ROOT, 'dist');
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(String(req.url).split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const fp = path.join(base, rel);
    if (!fp.startsWith(base)) { res.writeHead(403); res.end('403'); return; }
    fs.stat(fp, (e, st) => {
      if (e || !st.isFile()) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
        'Content-Length': st.size, 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(fp).pipe(res);
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}
function httpJson(p) {
  return new Promise((resolve, reject) => {
    const rq = http.get({ host: '127.0.0.1', port: EDGE_PORT, path: p, timeout: 2500 }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('t')));
  });
}
async function waitDbg() {
  for (let i = 0; i < 60; i++) {
    try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch { }
    await wait(500);
  }
  throw new Error('CDP not ready');
}

async function shot(browser, spec, meta) {
  const hash = `#noprewarm&quality=high&gpufake=discrete&vehicle=v800&paint=${spec.paint}${spec.mode.hash}`;
  const url = `http://127.0.0.1:${HTTP_PORT}/index.html${hash}`;
  const page = await browser.newPage();
  const logs = [], failed = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 200)));
  page.on('requestfailed', (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const rec = { slot: spec.slot, paint: spec.paint, view: spec.view, mode: spec.mode.tag, url, nums: spec.nums };
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 });
    let shell = null, done = false;
    for (let i = 0; i < 150; i++) {
      const st = await page.evaluate(() => ({
        done: !!document.getElementById('loading')?.classList.contains('done'),
        shell: window.__r44Shell?.v800?.state ?? null
      })).catch(() => ({}));
      if (st.done) done = true;
      if (st.shell === 'ready' || st.shell === 'failed') shell = st.shell;
      if (done && (shell === 'ready' || shell === 'failed')) break;
      await wait(1000);
    }
    rec.loadMs = Date.now() - t0;
    rec.shell = shell;
    await wait(3000);
    await page.evaluate(() => {
      for (const id of ['menu', 'hud', 'result', 'loading', 'credits']) {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      }
    });
    await wait(600);
    const data = await page.evaluate((a) => window.__v800EnvShot?.('r162', ...a) ?? null, spec.nums);
    if (!data) throw new Error('__v800EnvShot 不可用');
    const file = path.join(OUT, `${spec.slot}.png`);
    fs.writeFileSync(file, Buffer.from(String(data).replace(/^data:image\/(png|jpeg);base64,/, ''), 'base64'));
    rec.file = file; rec.bytes = fs.statSync(file).size; rec.sha1 = sha(file);
    rec.failedRequests = failed.slice(0, 6);
  } catch (e) {
    rec.error = String(e).slice(0, 300);
    rec.console = logs.slice(-8);
    rec.failedRequests = failed.slice(0, 6);
  }
  await page.close();
  console.log('SHOT', spec.slot, JSON.stringify({ shell: rec.shell, err: rec.error ?? '', sha1: rec.sha1 ?? '' }));
  meta.push(rec);
}

async function main() {
  const srv = await serveDist(HTTP_PORT);
  const browser = await puppeteer.connect({ browserWSEndpoint: await waitDbg(), defaultViewport: null, protocolTimeout: 300000 });
  const meta = [];
  const specs = [];
  // 重点：每 paint × front34 × new/old；white/black 补 side/hood/fender 细节
  for (const paint of PAINTS) {
    for (const mode of MODES) {
      specs.push({ slot: `${paint}_front34_${mode.tag}`, paint, view: 'front34', mode, nums: VIEWS.front34 });
    }
  }
  for (const view of ['side', 'hood', 'fender']) {
    for (const mode of MODES) {
      specs.push({ slot: `white_${view}_${mode.tag}`, paint: 'white', view, mode, nums: VIEWS[view] });
      specs.push({ slot: `black_${view}_${mode.tag}`, paint: 'black', view, mode, nums: VIEWS[view] });
    }
  }
  for (const paint of PAINTS) {
    specs.push({ slot: `${paint}_rear34_new`, paint, view: 'rear34', mode: MODES[0], nums: VIEWS.rear34 });
  }
  for (const spec of specs) await shot(browser, spec, meta);
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
    runAt: new Date().toISOString(), httpPort: HTTP_PORT, edgePort: EDGE_PORT,
    distBefore: distStamp(), shots: meta, distAfter: distStamp(),
    note: 'R162 车漆反光 A/B：new=R162 默认(0.5/0.22/0.55) old=R162 前(0.7/0.12/0.7)'
  }, null, 1));
  await browser.disconnect();
  srv.close();
}
main().catch((e) => { console.error('FAIL', String(e).slice(0, 600)); process.exitCode = 1; });
