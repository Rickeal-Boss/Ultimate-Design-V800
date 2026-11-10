/**
 * R65-G6c · 定罪 V800 车尾全宽红带：找出携带 housing-dark + 尾灯红带 atlas emissiveMap
 * 的 mesh，报告 name / world bbox 宽度 / 是否 visible。jagged 边 = 512px atlas 拉伸伪影。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9476;
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
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        const mid = m.userData?.sculptMaterial?.id ?? m.name ?? '';
        const hasRedAtlas = !!(m.emissiveMap && m.emissive && m.emissive.r > 0.5 && m.emissive.g < 0.3);
        // 只报：车尾区（世界 z < -1.5，车头 -Z）或 带 emissiveMap 的暗场
        o.updateWorldMatrix(true, false);
        const p = o.getWorldPosition(new o.position.constructor());
        const g = o.geometry.boundingBox;
        if (g) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const xw = bb ? bb.max.x - bb.min.x : 0;
        const isTail = p.z < -1.2 || p.z > 1.2; // 车尾( assembled -Z ) 或 spec +Z 尾
        if (!hasRedAtlas && !/tail|lantern|taillamp|尾|housing/i.test(String(mid) + o.name)) continue;
        out.push({
          name: (o.name || '(noname)').slice(0, 26),
          matId: String(mid).slice(0, 22),
          hasRedAtlas,
          emis: m.emissive ? `#${m.emissive.getHexString()}` : '-',
          visible: o.visible,
          worldZ: p.z.toFixed(3),
          xw: xw.toFixed(3),
          bbX: bb ? [bb.min.x.toFixed(2), bb.max.x.toFixed(2)] : null
        });
      }
    });
    return { count: out.length, meshes: out };
  });
  const f = `${ROOT}/.qa/r65n_tailband2.json`;
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  console.log('WROTE', f, 'count', report.count, report.error ?? '');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
