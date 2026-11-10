/**
 * R65-G7b · 定位车尾「全宽红带」的**可见宿主 mesh**——红带在尾门面（车尾 z、y0.6-1.2、
 * 全 x 宽）。报所有 visible mesh 中：世界 bbox 与「尾门面红带采样盒」相交且足够宽者，
 * 带材质 id / emissive / emissiveMap / world bbox。宿主 = 要 remapUVToRegion 的目标。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9480;
const URL = `http://127.0.0.1:${PORT}/preview.html#assembled`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${DPORT}/json/version`); if (r.ok) break; } catch {}
    await wait(400);
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DPORT}`, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => {
    const s = document.getElementById('status');
    return s && /ready/i.test(s.textContent || '');
  }, { timeout: 180000 });
  await wait(1500);

  const report = await page.evaluate(() => {
    const scene = window.__v800Scene();
    const out = [];
    // 红带采样盒（世界系，车尾 -Z 朝后）：x 全宽、y 0.55-1.25、z -3.0..-2.3
    const BX = [-1.05, 1.05], BY = [0.55, 1.25], BZ = [-3.0, -2.3];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      o.updateWorldMatrix(true, false);
      const g = o.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      // world bbox ≈ local bbox + world pos（车尾件无缩放旋转误差可接受）
      const p = o.getWorldPosition(new o.position.constructor());
      const x0 = bb.min.x + p.x, x1 = bb.max.x + p.x;
      const y0 = bb.min.y + p.y, y1 = bb.max.y + p.y;
      const z0 = bb.min.z + p.z, z1 = bb.max.z + p.z;
      // 与红带盒相交？
      const inter = x0 < BX[1] && x1 > BX[0] && y0 < BY[1] && y1 > BY[0] && z0 < BZ[1] && z1 > BZ[0];
      if (!inter) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      out.push({
        name: (o.name || '(noname)').slice(0, 26),
        matId: String(m?.userData?.sculptMaterial?.id ?? m?.name ?? '').slice(0, 20),
        emis: m?.emissive ? `#${m.emissive.getHexString()}` : '-',
        hasEmisMap: !!m?.emissiveMap,
        xw: (x1 - x0).toFixed(2),
        yb: [y0.toFixed(2), y1.toFixed(2)],
        zb: [z0.toFixed(2), z1.toFixed(2)]
      });
    });
    out.sort((a, b) => parseFloat(b.xw) - parseFloat(a.xw));
    return { count: out.length, meshes: out };
  });
  const f = `${ROOT}/.qa/r65w_host.json`;
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  console.log('WROTE', f, 'count', report.count, report.error ?? '');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
