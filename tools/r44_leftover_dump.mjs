/** R44 程序化残留 dump：外部壳就绪后，列出 root 树里仍「会画出来」的程序化 mesh。
 * 判据：mesh.visible 链 true 且其材质 visible=true 且非外部壳(r44External)
 * 且材质不在内饰白名单 → 写 .qa/r44_car/procedural_leftover.json
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const ROOT = '<REPO_ROOT>';
const OUT = ROOT + '/.qa/r44_car';
const PORT = 5200, EDGE_PORT = 9472;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(path, port = EDGE_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2500 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function waitDbg() {
  for (let i = 0; i < 90; i++) {
    try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl; } catch {}
    await wait(400);
  }
  throw new Error('debugger unreachable');
}
import { createServer } from 'vite';
const vite = await createServer({ root: ROOT, server: { port: PORT, host: '127.0.0.1', strictPort: true }, logLevel: 'error' });
await vite.listen();
console.log('VITE_READY');
const browser = await puppeteer.connect({ browserWSEndpoint: await waitDbg(), defaultViewport: null, protocolTimeout: 300000 });

async function dump(car, variant) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const out = { car, variant, leftovers: [], note: '' };
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html#noprewarm&quality=high&gpufake=discrete&vehicle=${car}&paint=${variant}`, { waitUntil: 'domcontentloaded', timeout: 150000 }).catch((e) => console.log('nav retry after', String(e).slice(0, 80)));
    for (let i = 0; i < 90; i++) {
      const st = await page.evaluate(() => ({ done: !!document.getElementById('loading')?.classList.contains('done'), shell: window.__r44Shell?.[window.__game?.car?.profile?.id ?? '']?.state })).catch(() => ({}));
      if (st.done && (st.shell === 'ready' || st.shell === 'failed')) break;
      await wait(1000);
    }
    await wait(2000);
    out.leftovers = await page.evaluate(() => {
      const g = window.__game;
      const THREEv = window.__THREE;
      const rows = [];
      const box = new THREEv.Box3();
      g.car.root.traverse((o) => {
        const m = o;
        if (!m.isMesh) return;
        if (m.userData?.r44External) return;
        let vis = true;
        for (let p = m; p; p = p.parent) if (!p.visible) { vis = false; break; }
        if (!vis) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const live = mats.filter((mt) => mt && mt.visible);
        if (live.length === 0) return;
        box.setFromObject(m);
        const size = new THREEv.Vector3(); box.getSize(size);
        const c = new THREEv.Vector3(); box.getCenter(c);
        const tri = (m.geometry?.index ? m.geometry.index.count : m.geometry?.getAttribute('position')?.count ?? 0) / 3;
        rows.push({
          meshName: m.name || '(anon)',
          parent: m.parent?.name || '(anon)',
          matIds: live.map((mt) => mt.userData?.sculptMaterial?.id ?? `(raw:${mt.type}${mt.userData?.cabinHidable ? ':cabinHidable' : ''})`),
          tri,
          worldCenter: [c.x, c.y, c.z].map((v) => +v.toFixed(2)),
          worldSize: [size.x, size.y, size.z].map((v) => +v.toFixed(2))
        });
      });
      rows.sort((a, b) => b.tri - a.tri);
      return rows;
    });
    console.log(`[${car}] leftovers:`, out.leftovers.length);
    for (const r of out.leftovers.slice(0, 40)) {
      console.log(`  ${r.meshName} <${r.matIds}> tri=${r.tri} c=(${r.worldCenter}) s=(${r.worldSize})`);
    }
  } catch (e) {
    out.note = String(e).slice(0, 300);
  }
  fs.writeFileSync(`${OUT}/procedural_leftover_${car}.json`, JSON.stringify(out, null, 1));
  console.log('WROTE', car, out.leftovers.length);
  await page.close().catch(() => {});
}

const only = process.argv[2];
try {
  if (!only || only === 'v800') await dump('v800', 'white');
  if (!only || only === 'r7') await dump('r7', 'purple');
} catch (e) {
  console.log('FATAL', String(e).slice(0, 300));
}
await browser.disconnect().catch(() => {});
await vite.close().catch(() => {});
process.exit(0);
