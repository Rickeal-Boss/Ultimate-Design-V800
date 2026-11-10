/**
 * R65-G5 · V800 车轮「轮毂没填满轮框」定罪探针。
 *
 * 走 preview.html#assembled，经 __v800Scene() 找 4 个轮 spin 枢轴（含 tire-* / rim-* /
 * 手写 r22-hub-*），量各自 world 包围盒：轮胎外径/内 opening、轮毂外缘半径、轮毂 z 深度。
 * 目的：量化「高精度涡轮没填满实际轮框」——轮毂 r 0.300 vs 轮胎内 opening r ~0.38 的缝隙，
 * 以及轮毂是否只是贴外脸的薄片（z 0.13-0.16）而非有深度的轮盘。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9473;
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
    const wheels = {};
    scene.traverse((o) => {
      if (!o.isMesh) return;
      // 归到所属轮：名字含 tire-/rim-/wheel-cap-/r22-hub/arch-liner + 角标
      const nm = o.name || '';
      const id = o.userData?.sculptComponent?.id ?? '';
      const mid = o.material?.userData?.sculptMaterial?.id ?? o.material?.name ?? '';
      const m = /-(fl|fr|rl|rr)$/.exec(nm) || /-(fl|fr|rl|rr)$/.exec(id);
      const corner = m ? m[1] : null;
      const kind = /tire/i.test(nm + id) ? 'tire' : /rim/i.test(nm + id) ? 'rim(old)'
        : /r22-hub|hub/i.test(nm + id + mid) ? 'hub(new)' : /cap/i.test(nm + id) ? 'cap(old)'
        : /arch-liner/i.test(nm) ? 'archliner' : /brake|caliper|disc|steel/i.test(nm + mid) ? 'brake' : null;
      if (!corner || !kind) return;
      o.updateWorldMatrix(true, false);
      const p = o.getWorldPosition(new o.position.constructor());
      const box = new (o.geometry.boundingBox?.constructor ?? Object)();
      // 用 geometry bbox 转 world 近似（轮在原点旋转，够量半径）
      o.geometry.computeBoundingBox();
      const g = o.geometry.boundingBox;
      // world 半径：取 geometry 顶点到轮心最大/最小距离（local，轮心=spin 原点）
      const pos = o.geometry.getAttribute('position');
      let rMax = 0, rMin = Infinity;
      const v = new o.position.constructor();
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i);
        const r = Math.hypot(v.x, v.y); // 轮面平面 = local X-Y（spin 原点=轮心）
        if (r > rMax) rMax = r;
        if (r < rMin) rMin = r;
      }
      const zMin = g ? g.min.z : 0, zMax = g ? g.max.z : 0;
      const key = corner;
      wheels[key] = wheels[key] || { corner, parts: [] };
      wheels[key].parts.push({
        kind, name: nm.slice(0, 22), matId: String(mid).slice(0, 20), visible: o.visible,
        worldPos: [p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3)],
        rMin: rMin.toFixed(3), rMax: rMax.toFixed(3),
        zLocal: [zMin.toFixed(3), zMax.toFixed(3)]
      });
    });
    return wheels;
  });
  const OUT = `${ROOT}/.qa/r65k_wheel_measure.json`;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  // 摘要打印
  for (const k of Object.keys(report)) {
    console.log(`\n=== wheel ${k} ===`);
    for (const p of report[k].parts) {
      console.log(` ${p.kind.padEnd(10)} vis=${String(p.visible).padEnd(5)} r[${p.rMin},${p.rMax}] z${JSON.stringify(p.zLocal)} ${p.name}/${p.matId}`);
    }
  }
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
