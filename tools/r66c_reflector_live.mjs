/**
 * r66c_reflector_live.mjs — 活体探针：确认改 reflectorMat.emissive 是否触达渲染。
 * 背景：G7 三层消去（material-hide/mesh-hide/UV remap）全 byte-identical ⇒ 怀疑 live 改动
 * 根本没到渲染。本探针走 __v800Scene() 直接改 reflector 材质 emissiveIntensity=0，capture
 * 前后 md5 比对。若 DIFFERENT ⇒ live 改材质有效，根治可行；若 IDENTICAL ⇒ capture 路径坏。
 * 同时 dump reflectorMat 状态 + 各红自发光体宽度。
 * dev-only（.qa/ gitignore）。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9483;
const URL = `http://127.0.0.1:${PORT}/preview.html#assembled`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DPORT}`, defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/error|R66|reflector/i.test(t)) console.log('[pg]', t.slice(0, 160)); });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__v800Capture === 'function', { timeout: 90000 });
await wait(2500);

// tail 机位
const TAIL = { name: 'tail', az: 0, pitch: 6, dist: 7.0 };
async function shotMd5(name, az, pitch, dist) {
  const b64 = await page.evaluate((n, a, p, d) => window.__v800Capture(n, a, p, d), name, az, pitch, dist);
  return crypto.createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 10);
}

// 1) baseline
const base = await shotMd5('base', TAIL.az, TAIL.pitch, TAIL.dist);
console.log('BASE', base);

// 2) dump reflector + red-emissive state
const dump = await page.evaluate(() => {
  const scene = window.__v800Scene();
  const reds = [];
  const refl = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const id = m?.userData?.sculptMaterial?.id ?? '';
      const isRefl = /rear-reflector/i.test(o.name);
      if (id === 'lamp-red' || isRefl) {
        o.updateWorldMatrix(true, false);
        const bb = o.geometry.boundingBox ?? (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
        const xw = bb ? (bb.max.x - bb.min.x).toFixed(3) : '-';
        const rec = { name: (o.name || '(noname)').slice(0, 24), matId: id, xw, isReflClone: !!(m.emissiveMap && m.userData?.sculptMaterial?.id === 'lamp-red'), ei: +m.emissiveIntensity?.toFixed(3), emis: '#' + m.emissive?.getHexString(), vis: o.visible, matVis: m.visible };
        (isRefl ? refl : reds).push(rec);
      }
    }
  });
  return { reds, refl };
});
console.log('RED-EMISSIVE (lamp-red, non-reflector):');
for (const r of dump.reds) console.log(' ', JSON.stringify(r));
console.log('REFLECTOR (cloned lamp-red + rear-reflector):');
for (const r of dump.refl) console.log(' ', JSON.stringify(r));

// 3) live change: zero reflector clone emissive + hide rear-reflector meshes
const liveResult = await page.evaluate(() => {
  const scene = window.__v800Scene();
  let nMat = 0, nMesh = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (/rear-reflector/i.test(o.name)) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.emissiveIntensity !== undefined) { m.emissiveIntensity = 0; m.needsUpdate = true; nMat++; } }
      o.visible = false; nMesh++;
    }
  });
  return { nMat, nMesh };
});
console.log('LIVE-CHANGE', JSON.stringify(liveResult));
await wait(400);
const after = await shotMd5('after', TAIL.az, TAIL.pitch, TAIL.dist);
console.log('AFTER', after);
console.log('RESULT', base === after ? 'IDENTICAL (live 改动未触达渲染 ⇒ capture 路径坏)' : 'DIFFERENT (live 改材质有效 ⇒ 根治可行)');

browser.disconnect();
process.exit(0);
