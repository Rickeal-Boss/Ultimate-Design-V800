/**
 * R65-G7c · 直查 batch/lamp-red 在 adapter 跑完后是否 visible（验 object.visible=false 是否生效）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9482;
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
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const mid = m?.userData?.sculptMaterial?.id ?? '';
      if (mid !== 'lamp-red') return;
      out.push({
        name: (o.name || '(noname)').slice(0, 28),
        visible: o.visible,
        parentVisible: o.parent?.visible,
        matVisible: m.visible,
        xw: (o.geometry.boundingBox ? (o.geometry.boundingBox.max.x - o.geometry.boundingBox.min.x) : 0).toFixed(2)
      });
    });
    return out;
  });
  const f = `${ROOT}/.qa/r65z_batchvis.json`;
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  for (const r of report) {
    console.log(`vis=${String(r.visible).padEnd(5)} par=${String(r.parentVisible).padEnd(5)} mat=${String(r.matVisible).padEnd(5)} xw=${r.xw} ${r.name}`);
  }
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
