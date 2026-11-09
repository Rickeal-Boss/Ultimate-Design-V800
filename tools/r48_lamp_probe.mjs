/**
 * R48 灯组链路运行时探针：直读 lamp_front / lamp_rear 材质在三态下的真实数值。
 * 只读运行时，不改 src/、不碰 git。
 * 用法：tools/r46_capture.ps1 -NodeScript r48_lamp_probe.mjs -EdgePort 9511 \
 *        -NodeArgs '--car=r7 --port=9511 --httpport=5216'
 */
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = '<REPO_ROOT>';
const argv = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const CAR = String(argv.car || 'r7');
const EDGE_PORT = Number(argv.port || 9503);
const HTTP_PORT = Number(argv.httpport || 5213);

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

const READ = () => {
  const g = window.__game;
  const out = { phase: g?.sm?.phase ?? null, rig: g?.rig?.mode ?? null,
    shell: window.__r44Shell?.[g?.car?.profile?.id ?? 'r7']?.state ?? null, lamps: [] };
  if (!g?.car?.root) return out;
  g.car.root.updateMatrixWorld(true);
  g.car.root.traverse((o) => {
    if (!o.isMesh) return;
    if (!/^lamp_(front|rear)$/.test(o.name)) return;
    const m = o.material;
    const e = o.matrixWorld?.elements;
    out.lamps.push({
      name: o.name, visible: o.visible, parent: o.parent?.name || o.parent?.type || '?',
      ext: o.userData?.r44External === true,
      ei: m?.emissiveIntensity ?? null,
      emissive: m?.emissive?.getHexString?.() ?? null,
      color: m?.color?.getHexString?.() ?? null,
      hasEmissiveMap: !!m?.emissiveMap, hasMap: !!m?.map,
      matVisible: m?.visible ?? null, side: m?.side ?? null,
      tri: o.geometry?.index ? o.geometry.index.count / 3 : null,
      world: e ? [e[12], e[13], e[14]] : null
    });
  });
  // R48 消去法：列出车尾灯带区域所有可见 mesh（定位纯白过曝块来源）
  out.nearTail = [];
  g.car.root.traverse((o) => {
    if (!o.isMesh || !o.visible || out.nearTail.length >= 40) return;
    const geo = o.geometry;
    if (!geo) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingBox) return;
    const b2 = geo.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const cx = (b2.min.x + b2.max.x) / 2;
    const cy = (b2.min.y + b2.max.y) / 2;
    const cz = (b2.min.z + b2.max.z) / 2;
    if (cy < 0.75 || cy > 1.5 || cz < 2.0 || cz > 3.2) return;
    const m = o.material;
    out.nearTail.push({
      name: o.name || '(unnamed)', ext: o.userData?.r44External === true,
      tri: geo.index ? geo.index.count / 3 : null,
      center: [Number(cx.toFixed(3)), Number(cy.toFixed(3)), Number(cz.toFixed(3))],
      size: [Number((b2.max.x - b2.min.x).toFixed(3)),
        Number((b2.max.y - b2.min.y).toFixed(3)), Number((b2.max.z - b2.min.z).toFixed(3))],
      ei: m?.emissiveIntensity ?? null, emissive: m?.emissive?.getHexString?.() ?? null,
      color: m?.color?.getHexString?.() ?? null, hasMap: !!m?.map, matVisible: m?.visible ?? null
    });
  });
  return out;
};

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
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (/error|warn|lamp|R48/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 200)}`); });
  page.on('pageerror', (e) => logs.push('PAGEERR ' + String(e).slice(0, 200)));
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/index.html#vehicle=${CAR}&paint=white&view=front34&r44ext=on`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate((c) => ({
      done: !!document.getElementById('loading')?.classList.contains('done'),
      shell: window.__r44Shell?.[c]?.state ?? null, hasGame: !!window.__game
    }), CAR).catch(() => ({ err: 1 }));
    if (st.done && (st.shell === 'ready' || st.shell === 'failed')) break;
    await wait(1000);
  }
  await wait(6000);

  const states = [];
  states.push({ tag: 'menu(off)', v: await page.evaluate(READ) });
  await page.evaluate(() => window.__game?.car?.setHeadlights?.(true));
  await wait(3000);
  states.push({ tag: 'headlights(true)', v: await page.evaluate(READ) });
  await page.evaluate(() => window.__game?.car?.setBrakeLights?.(1.6));
  await wait(3000);
  states.push({ tag: 'brake(1.6)', v: await page.evaluate(READ) });
  await page.evaluate(() => window.__game?.car?.flashBrakeSnap?.());
  await wait(1500);
  states.push({ tag: 'flashSnap', v: await page.evaluate(READ) });

  console.log('LAMP_STATES ' + JSON.stringify(states, null, 1));
  console.log('LOGS ' + JSON.stringify(logs.slice(0, 25), null, 1));
  await page.close();
  await browser.disconnect();
  await v.close();
}
main().catch((e) => { console.error('PROBE_FAIL', e); process.exitCode = 1; });
