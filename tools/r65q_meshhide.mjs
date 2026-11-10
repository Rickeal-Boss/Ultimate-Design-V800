/**
 * R65-G7 · 车尾红带「逐 mesh 隐藏」消去法（比 material-hide 更强：直接 visible=false）。
 *
 * 上一轮 material-hide（__v800HideMat）全部 byte-identical ⇒ material 路径无效。
 * 本轮直接按 mesh.visible=false 隐藏车尾每个候选 mesh，md5 比对：
 * 隐藏后红带消失（md5 变化且目检无红带）⇒ 该 mesh = 红带真身 ⇒ 对它 remapUVToRegion 归一黑区。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9478;
const URL = `http://127.0.0.1:${PORT}/preview.html#assembled`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = `${ROOT}/.qa/r65q_meshhide`;
fs.mkdirSync(OUT, { recursive: true });

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

  const shotMd5 = async (tag) => {
    const url = await page.evaluate(() => window.__v800Capture('mh', 0, 6, 7.0, 0.9));
    const buf = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
    const f = `${OUT}/mh_${tag}.png`;
    fs.writeFileSync(f, buf);
    return { tag, md5: crypto.createHash('md5').update(buf).digest('hex'), size: buf.length, file: f };
  };

  // 收集所有可见 mesh（不限 z：batch 合并后宽面 mesh 被移到原点 z=0），存 world bbox
  const tailMeshes = await page.evaluate(() => {
    const scene = window.__v800Scene ? window.__v800Scene() : null;
    const list = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      o.updateWorldMatrix(true, false);
      const p = o.getWorldPosition(new o.position.constructor());
      const g = o.geometry;
      if (g && g.boundingBox) g.computeBoundingBox();
      const bb = g?.boundingBox;
      list.push({
        name: (o.name || '(noname)').slice(0, 24),
        matId: String((Array.isArray(o.material) ? o.material[0] : o.material)?.userData?.sculptMaterial?.id ?? '').slice(0, 18),
        xw: bb ? (bb.max.x - bb.min.x).toFixed(2) : '-',
        worldZ: p.z.toFixed(2)
      });
    });
    return list;
  });

  const results = [];
  results.push(await shotMd5('base'));
  const base = results[0].md5;

  // 只测宽面 xw > 1.0（红带全宽；batch 合并 mesh 在 z=0 但横跨车尾）
  const candidates = tailMeshes.filter((m) => parseFloat(m.xw) > 1.0);
  console.log('CANDIDATES', candidates.length, 'of', tailMeshes.length, 'visible meshes');
  for (const c of candidates) {
    // 按 name+matId 精确隐藏匹配的 mesh（可能多个同名 ⇒ 全隐）
    await page.evaluate((nm, mid) => {
      const scene = window.__v800Scene();
      scene.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const n = (o.name || '').slice(0, 24);
        const m = String((Array.isArray(o.material) ? o.material[0] : o.material)?.userData?.sculptMaterial?.id ?? '').slice(0, 18);
        if (n === nm && m === mid) { o.userData.__mh = true; o.visible = false; }
      });
    }, c.name, c.matId);
    await wait(250);
    const r = await shotMd5(`i${c.idx}_${c.name.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`);
    r.candidate = c;
    results.push(r);
    // 恢复所有标记的
    await page.evaluate(() => {
      const scene = window.__v800Scene();
      scene.traverse((o) => {
        if (o.userData && o.userData.__mh) { o.visible = true; delete o.userData.__mh; }
      });
    });
    await wait(150);
  }
  console.log('BASE', base);
  for (const r of results.slice(1)) {
    console.log(`${r.md5 === base ? 'SAME' : 'DIFF'} i${r.candidate.idx} xw=${r.candidate.xw} ${r.candidate.name} / ${r.candidate.matId}`);
  }
  fs.writeFileSync(`${OUT}/meshhide.json`, JSON.stringify(results, null, 1));
  console.log('DONE');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
