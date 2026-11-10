/**
 * R65-G6 · V800 车尾「全宽红带 + 鹰屏红边」消去法（hide-material）定罪探针。
 *
 * 用户标注截图：竖灯上方一条 jagged 红带（不该有）+ 竖灯中部鹰屏上缘 jagged 红边。
 * jagged/撕裂边 = 贴图/UV 伪影（低分辨率 atlas 拉伸），非几何。
 * 候选：housing-dark（EX-28 尾灯红带 atlas emissiveMap，红 0xe03040，左半红带区）
 *       vs lamp-red（刹车灯红，batch 合并）。
 * 方法：基线 → 隐 housing-dark 拍 → 隐 lamp-red 拍（各步恢复），红带消失者即真身。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9474;
const URL = `http://127.0.0.1:${PORT}/preview.html#assembled`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = `${ROOT}/.qa/r65l_elim`;
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

  const shot = async (tag) => {
    const url = await page.evaluate(() => window.__v800Capture('elim', 0, 6, 7.0, 0.9));
    const f = `${OUT}/tail_${tag}.png`;
    fs.writeFileSync(f, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log('SHOT', f, fs.statSync(f).size);
  };
  const hide = (id, h) => page.evaluate((id, h) => window.__v800HideMat(id, h), id, h);

  await shot('base');
  await hide('housing-dark', true); await wait(300);
  await shot('no_housingdark');
  await hide('housing-dark', false); await wait(300);
  await hide('lamp-red', true); await wait(300);
  await shot('no_lampred');
  await hide('lamp-red', false); await wait(300);
  console.log('DONE');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
}
