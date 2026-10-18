// R15 座舱遮挡诊断探针（只读，不改 src）
// 用法（必须经 r14-run.ps1 包装，Edge 与本脚本同处一次 PowerShell 调用）：
//   MODE=meshes|rayfan|boxes  EYE=-0.55,1.33,-0.58 TGT=-0.42,1.04,-30.58
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9444);
const URLBASE = process.env.URL || 'http://127.0.0.1:4317/preview.html';
const HASH = process.env.HASH || '#assembled';
const MODE = process.env.MODE || 'rayfan';
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = process.env.OUT || ROOT + '/verify/r15';
const EYE = (process.env.EYE || '-0.55,1.33,-0.58').split(',').map(Number);
const TGT = (process.env.TGT || '-0.42,1.04,-10').split(',').map(Number);
const FOV = Number(process.env.FOV || 68);
const ASPECT = Number(process.env.ASPECT || 1280 / 760);

fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOGF = fs.openSync(path.join(OUT, 'probe.log'), 'a');
const log = (s) => { fs.writeSync(LOGF, s + '\n'); console.log(s); };

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
log('GOTO ' + URLBASE + HASH + ' MODE=' + MODE);
await page.goto(URLBASE + HASH, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => /ready|captured/.test(document.getElementById('status')?.textContent || ''), { timeout: 120000 });
log('READY');

// 通用：收集可见 mesh 的世界空间三角形（InstancedMesh 排除 —— 幽灵 bbox 陷阱）
const collect = async () => {
  const HIDEMAT = (process.env.HIDEMAT || '').split(',').filter(Boolean);
  for (const mid of HIDEMAT) {
    const n = await page.evaluate((m) => window.__v800HideMat(m, true), mid);
    log('HIDEMAT(before) ' + mid + ' meshes=' + n);
  }
  return await page.evaluate(() => {
  const meshes = [];
  window.__v800Scene().traverse((o) => {
    const m = o;
    if (!m.isMesh || !m.visible || !m.geometry) return;
    if (m.isInstancedMesh) return; // instanceMatrix 陷阱：几何 bbox 未乘实例矩阵
    m.updateWorldMatrix(true, false);
    const g = m.geometry, pos = g.attributes.position, index = g.index;
    const e = m.matrixWorld.elements;
    const pts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      pts[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      pts[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      pts[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    // puppeteer evaluate 走 JSON 序列化 → typed array 会丢，必须物化为普通数组
    const flat = new Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { flat[i * 3] = pts[i * 3]; flat[i * 3 + 1] = pts[i * 3 + 1]; flat[i * 3 + 2] = pts[i * 3 + 2]; }
    meshes.push({
      id: (m.userData?.sculptComponent?.id || m.name) + '|' + (mat?.userData?.sculptMaterial?.id || mat?.name || ''),
      pts: flat, idx: index ? Array.from(index.array) : null, n: index ? index.count : pos.count
    });
  });
  return meshes;
});
};

if (MODE === 'meshes') {
  const rows = await page.evaluate(() => {
    const V = (x, y, z, e) => [
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14]];
    const out = [];
    window.__v800Scene().traverse((o) => {
      const m = o;
      if (!m.isMesh || !m.geometry) return;
      m.updateWorldMatrix(true, false);
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox, e = m.matrixWorld.elements;
      const cs = [];
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) cs.push(V(x, y, z, e));
      const wmin = [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.min(...cs.map(c => c[2]))];
      const wmax = [Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1])), Math.max(...cs.map(c => c[2]))];
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      out.push({
        name: m.name, inst: !!m.isInstancedMesh,
        comp: m.userData?.sculptComponent?.id || '',
        mat: mat?.userData?.sculptMaterial?.id || (mat?.name || mat?.type),
        vis: m.visible,
        tris: (g.index ? g.index.count : g.attributes.position.count) / 3,
        wmin: wmin.map(v => +v.toFixed(3)), wmax: wmax.map(v => +v.toFixed(3))
      });
    });
    return out;
  });
  const RE = process.env.FILTER || '.';
  const re = new RegExp(RE);
  for (const r of rows) {
    if (!re.test(r.comp) && !re.test(r.mat) && !re.test(r.name)) continue;
    log(`MESH ${r.name} comp=${r.comp} mat=${r.mat} vis=${r.vis} inst=${r.inst} tris=${r.tris} wmin=[${r.wmin}] wmax=[${r.wmax}]`);
  }
}

if (MODE === 'boxes') {
  const res = await page.evaluate((ids) => {
    const V = (x, y, z, e) => [
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14]];
    const acc = {};
    window.__v800Scene().traverse((o) => {
      const m = o;
      if (!m.isMesh || !m.visible || !m.geometry || m.isInstancedMesh) return;
      m.updateWorldMatrix(true, false);
      const cid = m.userData?.sculptComponent?.id || m.name;
      if (!ids.some((k) => cid.startsWith(k) || cid === k)) return;
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox, e = m.matrixWorld.elements;
      const cs = [];
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) cs.push(V(x, y, z, e));
      const wmin = [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.min(...cs.map(c => c[2]))];
      const wmax = [Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1])), Math.max(...cs.map(c => c[2]))];
      if (!acc[cid]) acc[cid] = { wmin, wmax };
      else for (let i = 0; i < 3; i++) {
        acc[cid].wmin[i] = Math.min(acc[cid].wmin[i], wmin[i]);
        acc[cid].wmax[i] = Math.max(acc[cid].wmax[i], wmax[i]);
      }
    });
    return acc;
  }, (process.env.BOXIDS || 'tri-screen,gauge-screen,dash-upper,dash-lower,tunnel-front,steering-rim,seat-driver,cabin-floor').split(','));
  for (const [id, b] of Object.entries(res)) {
    log(`BOX ${id} min=[${b.wmin.map(v => +v.toFixed(4))}] max=[${b.wmax.map(v => +v.toFixed(4))}]`);
  }
}

if (MODE === 'rayfan') {
  const meshes = await collect();
  const castAll = (eye, d, maxDist) => {
    const hits = [];
    for (const mesh of meshes) {
      const { pts, idx, n } = mesh;
      for (let tt = 0; tt < n; tt += 3) {
        const a = (idx ? idx[tt] : tt) * 3;
        const b = (idx ? idx[tt + 1] : tt + 1) * 3;
        const c = (idx ? idx[tt + 2] : tt + 2) * 3;
        const ax = pts[a], ay = pts[a + 1], az = pts[a + 2];
        const e1x = pts[b] - ax, e1y = pts[b + 1] - ay, e1z = pts[b + 2] - az;
        const e2x = pts[c] - ax, e2y = pts[c + 1] - ay, e2z = pts[c + 2] - az;
        const pvx = d[1] * e2z - d[2] * e2y, pvy = d[2] * e2x - d[0] * e2z, pvz = d[0] * e2y - d[1] * e2x;
        const det = e1x * pvx + e1y * pvy + e1z * pvz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = eye[0] - ax, sy = eye[1] - ay, sz = eye[2] - az;
        const u = (sx * pvx + sy * pvy + sz * pvz) * inv;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 0.01 && dist <= maxDist) {
          hits.push({ dist, id: mesh.id, p: [eye[0] + d[0] * dist, eye[1] + d[1] * dist, eye[2] + d[2] * dist] });
        }
      }
    }
    hits.sort((p, q) => p.dist - q.dist);
    return hits;
  };
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  // —— 全部在 node 侧做（meshes 已取回）——
  const eye = EYE, tgt = TGT;
  // 1) 眼点 → 正前方路面点（y≈0.03, 30m 外）的射线：列出全部命中
  const road = [tgt[0], 0.03, eye[2] - 30];
  const dRoad = norm(sub(road, eye));
  log(`RAY eye=[${eye}] -> road=[${road.map(v => +v.toFixed(2))}] dir=[${dRoad.map(v => +v.toFixed(4))}]`);
  const all = castAll(eye, dRoad, 35);
  for (const h of all.slice(0, 12)) {
    log(`  HIT d=${h.dist.toFixed(3)} id=${h.id} p=[${h.p.map(v => +v.toFixed(3))}]`);
  }
  if (!all.length) log('  HIT none (ray reaches 35m)');

  // 2) 垂直扇扫描：注视方位角不变，pitch 从 +12°（抬头）到 -45°（看地板），1° 步进
  const fwdH = norm([sub(tgt, eye)[0], 0, sub(tgt, eye)[2]]);
  log('PITCHFAN (0°=水平, 负=向下): pitch | nearest hit | dist | hitY');
  const rows = [];
  for (let pd = 12; pd >= -45; pd -= 1) {
    const r = (pd * Math.PI) / 180;
    const d = norm([fwdH[0], Math.sin(r), fwdH[2] * Math.cos(r)]);
    const hs = castAll(eye, d, 40);
    const h = hs[0];
    const row = { pd, id: h ? h.id : 'MISS(路面/远景)', dist: h ? +h.dist.toFixed(2) : null, hy: h ? +h.p[1].toFixed(3) : null };
    rows.push(row);
  }
  // 压缩输出：仅打印命中段变化处
  let prev = '';
  for (const row of rows) {
    const key = row.id.split('|')[0].split('@')[0];
    if (key !== prev) { log(`  pitch=${row.pd}° ${row.id}${row.dist != null ? '@' + row.dist + 'm hitY=' + row.hy : ''}`); prev = key; }
  }
  // 3) 关键角度：眼点到 tri-screen 顶沿/底沿、dash-upper 顶面前缘的俯角
  log('ANGLES: (相对水平线, 正=向下俯角)');
  const aim = (p) => { const dd = sub(p, eye); return +(Math.atan2(-dd[1], Math.hypot(dd[0], dd[2])) * 180 / Math.PI).toFixed(2); };
  log(`  注视点 tgt俯角=${aim(tgt)}°`);
  log(`  tri-screen顶沿(1.2875,z-1.42)俯角=${aim([eye[0], 1.2875, -1.42])}°  底沿(0.9725)俯角=${aim([eye[0], 0.9725, -1.42])}°`);
  log(`  dash-upper顶面(0.985,前缘z-1.32)俯角=${aim([eye[0], 0.985, -1.32])}°  后缘(z-1.78)俯角=${aim([eye[0], 0.985, -1.78])}°`);
  log(`  dash-lower底(0.67,z-1.45)俯角=${aim([eye[0], 0.67, -1.45])}°`);
  log(`  FOV=${FOV} 半垂直FOV=${(FOV / 2).toFixed(1)}° 注视俯角含在内`);
}

log('ALL DONE');
await page.close();
browser.disconnect();
process.exit(0);
