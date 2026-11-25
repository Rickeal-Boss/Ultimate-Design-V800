/**
 * R163 落地 · 全局环境光线物理重平衡目检（当前构建 dist，只读快照）
 *
 * 机位（__v800EnvShot 世界坐标自由机位，拍游戏场景 Castle/Road/天空，非菜单车）：
 *   - chase   行车跟车视：0,3.2,30 → 0,1.5,-300 fov55（道路+城堡纵深，主光/环境对比）
 *   - castle  城堡全景：-15,6,-40 → 0,12,-1285 fov45（白石受光/背光关系）
 *   - car34   车 3/4 前：3.6,1.5,-6.4 → 0,0.75,0 fov42（车在新光照下漆感/高光）
 *
 * 判读：光照重平衡（sun 2.6→1.5 / hemi 0.34→0.55 / rim 1.05→0.6 / fill 0.7→0.5）后
 *   场景应更漫射（直射/环境比 7.6→2.7）、但**不破**：白石受光面仍可读、天空/雾不黑、
 *   车漆保留光泽（非哑光）、逆光构图/暖冷分工保留。
 *
 * 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/r46_capture.ps1 \
 *   -NodeScript r163_lighting_capture.mjs -Tag r163 -EdgePort 9548
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
const EDGE_PORT = Number(argv.port || 9548);
const HTTP_PORT = Number(argv.httpport || 5248);
const W = 1280, H = 800;
const OUT = path.join(ROOT, '.qa', 'r163');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12);

const VIEWS = {
  chase:  [0, 3.2, 30, 0, 1.5, -300, 55],
  castle: [-15, 6, -40, 0, 12, -1285, 45],
  car34:  [3.6, 1.5, -6.4, 0, 0.75, 0, 42],
};

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

async function main() {
  const srv = await serveDist(HTTP_PORT);
  const browser = await puppeteer.connect({ browserWSEndpoint: await waitDbg(), defaultViewport: null, protocolTimeout: 300000 });
  const hash = `#noprewarm&quality=high&gpufake=discrete&vehicle=v800`;
  const url = `http://127.0.0.1:${HTTP_PORT}/index.html${hash}`;
  const page = await browser.newPage();
  const logs = [], failed = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 200)));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const rec = { url, shots: [] };
  const t0 = Date.now();
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
  for (const [name, nums] of Object.entries(VIEWS)) {
    const data = await page.evaluate((a) => window.__v800EnvShot?.('r163', ...a) ?? null, nums);
    if (!data) { rec.shots.push({ name, error: '__v800EnvShot 不可用' }); continue; }
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(String(data).replace(/^data:image\/(png|jpeg);base64,/, ''), 'base64'));
    rec.shots.push({ name, file, bytes: fs.statSync(file).size, sha1: sha(file) });
    console.log('SHOT', name, JSON.stringify({ bytes: rec.shots.at(-1).bytes, sha1: rec.shots.at(-1).sha1 }));
  }
  rec.failedRequests = failed.slice(0, 6);
  rec.consoleTail = logs.slice(-8);
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
    runAt: new Date().toISOString(), httpPort: HTTP_PORT, edgePort: EDGE_PORT, rec,
    note: 'R163 全局环境光线物理重平衡（sun 1.5/hemi 0.55/rim 0.6/fill 0.5，暴风天光漫射化）'
  }, null, 1));
  await browser.disconnect();
  srv.close();
}
main().catch((e) => { console.error('FAIL', String(e).slice(0, 600)); process.exitCode = 1; });
