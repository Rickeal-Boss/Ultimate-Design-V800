/**
 * R65-G4 · V800 车尾「全宽红带」定罪探针。
 *
 * 走 preview.html#assembled（跑 V800Adapter，含尾灯替换），用 __v800Camera.parent
 * 拿到 scene，traverse 找出所有「红色 emissive / lamp-red / taillamp / reflector」相关
 * mesh，报告 name / 材质 id / world 位置 / world bbox 尺寸。
 * 目的：定位全宽红带究竟是哪个 mesh（工厂 taillamp-bar-*？反光条？tailField？还是
 * 误染到 body？），jagged 边=贴图渗色 vs 干净几何=实心 bar。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5273;
const DPORT = 9472;
const URL = `http://127.0.0.1:${PORT}/preview.html#assembled`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = `${ROOT}/.img2threejs/renders/.edge-r65j`;
// ATTACH=1 ⇒ 连接已由外部 PS 会话 Start-Process 起的 Edge（node 直接 spawn msedge → EACCES）
const edge = (process.env.R43_ATTACH === '1') ? null : spawn(EDGE, ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${DPORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore' });

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
    if (!scene || !scene.traverse) return { error: 'no __v800Scene()' };
    const out = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        const id = m.userData?.sculptMaterial?.id ?? m.name ?? '(anon)';
        const emis = m.emissive ? `#${m.emissive.getHexString()}` : '-';
        const ei = m.emissiveIntensity !== undefined ? m.emissiveIntensity : '-';
        // 只报：红 emissive / taillamp / reflector / lamp 相关
        const redish = /red|tail|reflector|lamp|brake/i.test(id) || (m.emissive && m.emissive.r > 0.4 && m.emissive.g < 0.35);
        if (!redish) continue;
        const p = o.getWorldPosition(new o.position.constructor());
        const gbb = o.geometry.boundingBox;
        o.geometry.computeBoundingBox();
        out.push({
          name: o.name || '(noname)',
          matId: id,
          emis, ei,
          transparent: !!m.transparent,
          hasMap: !!(m.map || m.emissiveMap),
          pos: [p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3)],
          geomBB: o.geometry.boundingBox ? {
            min: [o.geometry.boundingBox.min.x.toFixed(3), o.geometry.boundingBox.min.y.toFixed(3), o.geometry.boundingBox.min.z.toFixed(3)],
            max: [o.geometry.boundingBox.max.x.toFixed(3), o.geometry.boundingBox.max.y.toFixed(3), o.geometry.boundingBox.max.z.toFixed(3)]
          } : null,
          visible: o.visible
        });
      }
    });
    return { count: out.length, meshes: out };
  });
  const OUT = `${ROOT}/.qa/r65j_tailband.json`;
  fs.mkdirSync(`${ROOT}/.qa`, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log('WROTE', OUT, 'count=', report.count, 'err=', report.error ?? 'none');
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
  try { edge.kill(); } catch {}
}
