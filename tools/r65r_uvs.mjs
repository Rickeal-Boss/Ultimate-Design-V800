/**
 * R65-G7b · 量 batch/lamp-red 的 UV 范围（确认采样 reflector atlas 红带区 u0.004-0.496）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9479;
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
      const mid = m?.userData?.sculptMaterial?.id ?? '';
      if (mid !== 'lamp-red' && mid !== 'housing-dark') return;
      const uv = o.geometry.getAttribute('uv');
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      if (uv) for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const g = o.geometry; g.computeBoundingBox();
      const bb = g.boundingBox;
      out.push({
        name: (o.name || '(noname)').slice(0, 24), matId: mid,
        xw: (bb.max.x - bb.min.x).toFixed(3),
        uvCount: uv ? uv.count : 0,
        u: uv ? [uMin.toFixed(3), uMax.toFixed(3)] : null,
        v: uv ? [vMin.toFixed(3), vMax.toFixed(3)] : null,
        hasEmisMap: !!m?.emissiveMap
      });
    });
    return out;
  });
  const f = `${ROOT}/.qa/r65r_uvs.json`;
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  for (const r of report) {
    console.log(`${r.matId.padEnd(14)} xw=${r.xw} uv${JSON.stringify(r.u)}v${JSON.stringify(r.v)} n=${r.uvCount} eMap=${r.hasEmisMap} ${r.name}`);
  }
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
