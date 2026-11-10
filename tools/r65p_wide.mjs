/**
 * R65-G7 · 锁定 V800 车尾「全宽红带」真身：报车尾区所有**可见且 x 宽 > 0.4** 的 mesh，
 * 带材质 id / emissive 颜色 / 是否 emissiveMap / world bbox。红带=宽面 mesh 采样 tailBand
 * atlas 红带区（jagged=512px texel 拉伸），锁定宽面 mesh 即可 remapUVToRegion 归一到黑区。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9477;
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
    const scene = window.__v800Scene ? window.__v800Scene() : null;
    if (!scene) return { error: 'no scene' };
    const out = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      o.updateWorldMatrix(true, false);
      const g = o.geometry;
      if (!g || !g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      const xw = bb.max.x - bb.min.x;
      if (xw < 0.4) return; // 只看宽面（红带全宽）
      const p = o.getWorldPosition(new o.position.constructor());
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const mid = m?.userData?.sculptMaterial?.id ?? m?.name ?? '';
      out.push({
        name: (o.name || '(noname)').slice(0, 28),
        matId: String(mid).slice(0, 22),
        emis: m?.emissive ? `#${m.emissive.getHexString()}` : '-',
        ei: m?.emissiveIntensity ?? '-',
        hasEmisMap: !!(m?.emissiveMap),
        hasMap: !!m?.map,
        xw: xw.toFixed(3),
        bbX: [bb.min.x.toFixed(2), bb.max.x.toFixed(2)],
        bbY: [bb.min.y.toFixed(2), bb.max.y.toFixed(2)],
        bbZ: [bb.min.z.toFixed(2), bb.max.z.toFixed(2)],
        worldZ: p.z.toFixed(2)
      });
    });
    out.sort((a, b) => parseFloat(b.xw) - parseFloat(a.xw));
    return { count: out.length, meshes: out };
  });
  const f = `${ROOT}/.qa/r65p_wide.json`;
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  console.log('WROTE', f, 'count', report.count, report.error ?? '');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
