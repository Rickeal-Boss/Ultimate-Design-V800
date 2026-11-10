/**
 * R65-G6b · V800 车尾「全宽红带」广谱消去法——逐材质隐藏，md5 比对找真身。
 *
 * 上一轮 hide housing-dark / lamp-red 均 byte-identical ⇒ 红带非此二者。
 * 本轮枚举所有「可能出现在车尾」的材质逐个隐藏，对每张截图算 md5；
 * 隐藏后 md5 变化 ⇒ 该材质在车尾可见；再对比哪些隐藏让「红带」消失（目检）。
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
const DPORT = 9475;
const URL = `http://127.0.0.1:${PORT}/preview.html#assembled`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = `${ROOT}/.qa/r65m_sweep`;
fs.mkdirSync(OUT, { recursive: true });

// 车尾可能相关的材质 id（覆盖红/暗场/反光/尾门/车身漆/玻璃）
const CANDIDATES = [
  'lamp-red', 'housing-dark', 'lamp-mark', 'lamp-gold', 'lamp-amber', 'lamp-white',
  'paint-upper', 'paint-lower', 'glass-dark', 'chrome', 'matte-black',
  'r21-tail-lamp-red', 'r21-tail-lamp-housing', 'r21-tail-lamp-chrome', 'r21-tail-lamp-gold'
];

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
    const url = await page.evaluate(() => window.__v800Capture('sweep', 0, 6, 7.0, 0.9));
    const buf = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
    const f = `${OUT}/sweep_${tag}.png`;
    fs.writeFileSync(f, buf);
    return { tag, md5: crypto.createHash('md5').update(buf).digest('hex'), size: buf.length, file: f };
  };

  const results = [];
  // 基线
  results.push(await shotMd5('base'));
  // 逐材质隐藏 → 拍 → 恢复
  for (const id of CANDIDATES) {
    const n = await page.evaluate((id) => window.__v800HideMat(id, true), id);
    await wait(250);
    const r = await shotMd5(id);
    r.hiddenCount = n;
    results.push(r);
    await page.evaluate((id) => window.__v800HideMat(id, false), id);
    await wait(150);
  }
  const base = results[0].md5;
  console.log('BASE', base, results[0].size);
  for (const r of results.slice(1)) {
    console.log(`${r.md5 === base ? 'SAME ' : 'DIFF '} ${r.tag.padEnd(22)} hidden=${r.hiddenCount} size=${r.size}`);
  }
  fs.writeFileSync(`${OUT}/sweep.json`, JSON.stringify(results, null, 1));
  console.log('DONE');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
