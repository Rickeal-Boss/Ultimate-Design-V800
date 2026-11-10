/**
 * r66f_undertier.mjs — 低精度车底/车轮现状数值诊断。
 * 走 preview#assembled（跑 V800Adapter，含 R22-B 轮毂接线），经 __v800Scene() 统计：
 *   · tire-* / rim-* / r22-hub-* / wheel-cap-* 各 mesh 的 visible + world bbox；
 *   · 车底是否有封底板（body-lower 底边 y、有无 y<0.2 的封闭面）；
 *   · 轮拱区（轮心 ±0.855,0.382,±1.715 半径 0.452 内）有没有实体填满。
 * 数值定罪（铁律1）：轮子在不在、可不可见、有没有被合批吞掉，不靠 capture 目检。
 * dev-only（.qa/ gitignore）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9484; // Edge 远程调试端口（puppeteer 连这里，非 vite 5273）
const URL = `http://127.0.0.1:${PORT}/preview.html#assembled`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(ROOT, '.qa', 'r66f_undertier.json');

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DPORT}`, defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/error|R22-B|找不到轮系|轮胎|wheel/i.test(t)) console.log('[pg]', t.slice(0, 140)); });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__v800Capture === 'function', { timeout: 90000 });
await wait(2500);

const report = await page.evaluate(() => {
  const scene = window.__v800Scene();
  const tires = [];
  const rims = [];
  const hubs = [];
  const underbody = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.updateWorldMatrix(true, false);
    const g = o.geometry;
    if (!g) return;
    g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return;
    const comp = o.userData?.sculptComponent?.id ?? '';
    const nm = o.name || '';
    const id = comp || nm;
    // 世界 bbox（取 geometry bbox 8 角变换到世界）
    const corners = [];
    for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) corners.push({ x, y, z });
    const V3 = o.position.constructor;
    const v = corners.map((c) => o.localToWorld(new V3(c.x, c.y, c.z)));
    const wmin = { x: Math.min(...v.map((p) => p.x)), y: Math.min(...v.map((p) => p.y)), z: Math.min(...v.map((p) => p.z)) };
    const wmax = { x: Math.max(...v.map((p) => p.x)), y: Math.max(...v.map((p) => p.y)), z: Math.max(...v.map((p) => p.z)) };
    const rec = { name: nm.slice(0, 28), comp: comp.slice(0, 28), vis: o.visible, matVis: (Array.isArray(o.material) ? o.material[0] : o.material)?.visible, wmin: [wmin.x.toFixed(3), wmin.y.toFixed(3), wmin.z.toFixed(3)], wmax: [wmax.x.toFixed(3), wmax.y.toFixed(3), wmax.z.toFixed(3)] };
    if (/^tire-/.test(id)) tires.push(rec);
    else if (/^rim-/i.test(id) || /rim-spokes/i.test(nm)) rims.push(rec);
    else if (/r22-hub|wheel-hub/i.test(nm)) hubs.push(rec);
    else if (/body-lower|underbody|底板|floor/i.test(id)) underbody.push(rec);
  });
  return { tireCount: tires.length, rimCount: rims.length, hubCount: hubs.length, underbodyCount: underbody.length, tires, rims, hubs, underbody };
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`tireCount=${report.tireCount} rimCount=${report.rimCount} hubCount=${report.hubCount} underbodyCount=${report.underbodyCount}`);
for (const t of report.tires) console.log('TIRE', JSON.stringify(t));
for (const h of report.hubs) console.log('HUB', JSON.stringify(h));
for (const u of report.underbody) console.log('UNDER', JSON.stringify(u));
browser.disconnect();
process.exit(0);
