/**
 * R47 一次性运行时探针：确认 cabin 态下高精度方向盘是否真的进了场景树。
 * 只读源码 / 只读运行时，不改 src/、不碰 git。
 * 用法（必须与 Edge 起停同处一次 PowerShell 调用）：
 *   tools/r46_capture.ps1 -NodeScript r47_interior_probe.mjs -EdgePort 9503 -Tag r47ip
 */
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const HTTP_PORT = 5213;
const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const CAR = String(argv.car || 'v800');
const EDGE_PORT = Number(argv.port || 9503);

function httpJson(pathname, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2500 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { createServer } = await import('vite');
  const v = await createServer({ root: ROOT,
    server: { port: HTTP_PORT, host: '127.0.0.1', strictPort: true,
      watch: { ignored: ['**/dist/**', '**/.qa/**', '**/verify/**', '**/node_modules/**',
        '**/.img2threejs/**', '**/tools/**', '**/src/assets/**'] } },
    logLevel: 'error' });
  await v.listen();
  console.log('SERVER vite dev on', HTTP_PORT);

  const ver = await httpJson('/json/version', EDGE_PORT);
  const browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
  const page = await browser.newPage();
  const logs = [], failed = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 240)}`));
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 240)));
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    if (/steering/i.test(r.url())) logs.push(`[resp] ${r.status()} ${r.headers()['content-type'] ?? '?'} ${r.url()}`);
  });
  page.on('requestfailed', (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText ?? ''}`));
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  const hash = `#vehicle=${CAR}&paint=white&view=cabin&r44ext=on`;
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/index.html${hash}`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate((c) => ({
      done: !!document.getElementById('loading')?.classList.contains('done'),
      shell: window.__r44Shell?.[c]?.state ?? null,
      hasGame: !!window.__game
    }), CAR).catch((e) => ({ err: String(e) }));
    if (st.done && (st.shell === 'ready' || st.shell === 'failed')) break;
    await wait(1000);
  }
  await wait(20000);
  await page.evaluate(() => window.__game?.car?.root?.updateMatrixWorld?.(true));

  const fetchProbe = await page.evaluate(async () => {
    const urls = [
      '/src/assets/cars/v800/steering.glb',
      '/assets/cars/v800/steering.glb',
      '/src/assets/cars/v800/steering_basecolor.webp'
    ];
    const out = [];
    for (const u of urls) {
      try {
        const r = await fetch(u);
        const t = await r.arrayBuffer();
        const head = Array.from(new Uint8Array(t.slice(0, 8))).join(',');
        out.push([u, r.status, r.headers.get('content-type'), t.byteLength, head]);
      } catch (e) { out.push([u, 'ERR', String(e)]); }
    }
    return out;
  });
  console.log('FETCHPROBE ' + JSON.stringify(fetchProbe));

  const probe = await page.evaluate(() => {
    const g = window.__game;
    const out = {
      hasGame: !!g,
      rigMode: g?.rig?.mode ?? null,
      phase: g?.sm?.phase ?? null,
      shell: window.__r44Shell ?? null,
      steering: [], ext: [], programmaticRing: []
    };
    if (!g?.car?.root) return out;
    g.car.root.traverse((o) => {
      if (!o.isMesh) return;
      const e = o.matrixWorld?.elements;
      const rec = {
        name: o.name || '(unnamed)',
        visible: o.visible,
        parent: o.parent?.name || o.parent?.type || '?',
        pos: o.position?.toArray?.() ?? null,
        scale: o.scale?.toArray?.() ?? null,
        world: e ? [e[12], e[13], e[14]] : null,
        ext: o.userData?.r44External === true,
        side: o.material?.side ?? null,
        tri: o.geometry?.index ? o.geometry.index.count / 3 : null
      };
      if (/steer/i.test(o.name)) out.steering.push(rec);
      if (rec.ext) out.ext.push(rec);
      if (/wheel|ring|steer|方向/i.test(o.name) && !rec.ext) out.programmaticRing.push(rec);
    });
    return out;
  });
  console.log('PROBE ' + JSON.stringify(probe, null, 1).slice(0, 12000));
  // 目检证据：隐藏菜单面板后截整帧（方向盘已确认在树里，等 20s 后必然完成装配）
  await page.evaluate(() => {
    const m = document.getElementById('menu');
    if (m) m.style.display = 'none';
  });
  await page.screenshot({ path: path.join(ROOT, 'verify/r46/after/r47_cabin_steering_' + CAR + '.png') });
  console.log('SHOT verify/r46/after/r47_cabin_steering_' + CAR + '.png');
  console.log('LOGS ' + JSON.stringify(logs.filter((x) => /steer|Interior|QA|error|warn|404|failed|resp/i.test(x)).slice(0, 40), null, 1));
  console.log('FAILED ' + JSON.stringify(failed.slice(0, 20), null, 1));
  await page.close();
  await browser.disconnect();
  await v.close();
}
main().catch((e) => { console.error('PROBE_FAIL', e); process.exitCode = 1; });
