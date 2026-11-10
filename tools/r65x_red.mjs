/**
 * R65-G7c · 按颜色找车尾红带真身：报所有 visible 且 emissive 偏红（r>g、r>b）的 mesh，
 * 带 world bbox（判断是否落在车尾 y0.5-1.3 区）。避开坐标帧混淆——直接看颜色+位置。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9481;
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
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || !m.emissive) return;
      const e = m.emissive;
      const redish = e.r > 0.25 && e.r > e.g + 0.05 && e.r > e.b + 0.05;
      if (!redish) return;
      o.updateWorldMatrix(true, false);
      const g = o.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const p = o.getWorldPosition(new o.position.constructor());
      out.push({
        name: (o.name || '(noname)').slice(0, 26),
        matId: String(m.userData?.sculptMaterial?.id ?? m.name ?? '').slice(0, 20),
        emis: `#${e.getHexString()}`,
        ei: m.emissiveIntensity,
        hasEmisMap: !!m.emissiveMap,
        xw: (bb.max.x - bb.min.x).toFixed(2),
        cy: (p.y + (bb.min.y + bb.max.y) / 2).toFixed(2),
        cz: (p.z + (bb.min.z + bb.max.z) / 2).toFixed(2)
      });
    });
    out.sort((a, b) => parseFloat(b.xw) - parseFloat(a.xw));
    return { count: out.length, meshes: out };
  });
  const f = `${ROOT}/.qa/r65x_red.json`;
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  console.log('WROTE', f, 'count', report.count, report.error ?? '');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
