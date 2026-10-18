// R14 CDP 探针（连接已启动的 Edge，不自己 spawn —— 本机从 Git Bash spawn Edge 会 EACCES）
// 用法：CDP=9444 URL=http://127.0.0.1:5194/preview.html HASH=#assembled MODE=vscan|shots|hide|meshes node r14_cdp.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const CDP = Number(process.env.CDP || 9444);
const URLBASE = process.env.URL || 'http://127.0.0.1:5194/preview.html';
const HASH = process.env.HASH || '#assembled';
const MODE = process.env.MODE || 'shots';
const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const OUT = process.env.OUT || ROOT + '/verify/r14/probe-rear';
const HIDEMAT = (process.env.HIDEMAT || '').split(',').filter(Boolean);
const HIDECOMP = (process.env.HIDECOMP || '').split(',').filter(Boolean);
const PROBE_IDS = (process.env.PROBE_IDS || '').split(',').filter(Boolean);
const SHOTS = (process.env.SHOTS || 'rear:0:6:9.6:0,tail34:30:6:9.6:0,side:90:4:9.6:0,front:180:6:9.6:0')
  .split(',').filter(Boolean).map((s) => {
    const [name, az, pitch, dist, ty] = s.split(':');
    return { name, az: +az, pitch: +pitch, dist: +dist, ty: +(ty || 0) };
  });
const CLOSEUPS = (process.env.CLOSEUPS || '').split('|').filter(Boolean).map((s) => {
  const [name, eye, tgt] = s.split(':');
  return { name, eye: eye.split(',').map(Number), tgt: tgt.split(',').map(Number) };
});

fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOGF = fs.openSync(OUT + '/probe.log', 'a');
const log = (s) => { fs.writeSync(LOGF, s + '\n'); console.log(s); };
const savePng = (name, dataUrl) => {
  const f = path.join(OUT, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  log('SHOT ' + name + ' bytes=' + fs.statSync(f).size);
};

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
log('GOTO ' + HASH);
await page.goto(URLBASE + HASH, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => /ready|captured/.test(document.getElementById('status')?.textContent || ''), { timeout: 120000 });
log('READY');

if (MODE === 'meshes') {
  const rows = await page.evaluate(() => {
    const out = [];
    const V = (x, y, z, e) => [
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14]];
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
        name: m.name,
        comp: m.userData?.sculptComponent?.id || '',
        mat: mat?.userData?.sculptMaterial?.id || (mat?.name || mat?.type),
        vis: m.visible,
        tris: (g.index ? g.index.count : g.attributes.position.count) / 3,
        wmin: wmin.map(v => +v.toFixed(3)),
        wmax: wmax.map(v => +v.toFixed(3))
      });
    });
    return out;
  });
  for (const r of rows) {
    if (PROBE_IDS.length && !PROBE_IDS.some((k) => r.comp.includes(k) || r.mat.includes(k) || r.name.includes(k))) continue;
    log(`MESH ${r.name} comp=${r.comp} mat=${r.mat} vis=${r.vis} tris=${r.tris} wmin=[${r.wmin}] wmax=[${r.wmax}]`);
  }
}

if (MODE === 'vscan') {
  const xs = (process.env.XS || '0').split(',').map(Number);
  const ys = (process.env.YS || '1.3:1.85:0.025').split(':').map(Number);
  const res = await page.evaluate((xs, y0, y1, dy, FROMREAR) => {
    const scene = window.__v800Scene();
    const meshes = [];
    scene.traverse((o) => {
      const m = o;
      if (!m.isMesh || !m.visible || !m.geometry) return;
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
      const n = index ? index.count : pos.count;
      meshes.push({ id: m.userData?.sculptComponent?.id || m.name, pts, idx: index, n });
    });
    const out = [];
    for (const X of xs) {
      let prev = '';
      for (let Y = y0; Y <= y1 + 1e-9; Y += dy) {
        let best = null;
        for (const mesh of meshes) {
          const { pts, idx, n } = mesh;
          for (let t = 0; t < n; t += 3) {
            const a = (idx ? idx.getX(t) : t) * 3;
            const b = (idx ? idx.getX(t + 1) : t + 1) * 3;
            const c = (idx ? idx.getX(t + 2) : t + 2) * 3;
            const ax = pts[a], ay = pts[a + 1], az = pts[a + 2];
            const e1x = pts[b] - ax, e1y = pts[b + 1] - ay, e1z = pts[b + 2] - az;
            const e2x = pts[c] - ax, e2y = pts[c + 1] - ay, e2z = pts[c + 2] - az;
            const dz = FROMREAR ? 1 : -1;
            const pvx = -dz * e2y, pvy = dz * e2x, pvz = 0;
            const det = e1x * pvx + e1y * pvy + e1z * pvz;
            if (Math.abs(det) < 1e-12) continue;
            const inv = 1 / det;
            const oz = FROMREAR ? -8 : 8;
            const sx = X - ax, sy = Y - ay, sz = oz - az;
            const u = (sx * pvx + sy * pvy + sz * pvz) * inv;
            if (u < -1e-6 || u > 1 + 1e-6) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const v = qz * dz * inv;
            if (v < -1e-6 || u + v > 1 + 1e-6) continue;
            const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (dist > 0.01 && (!best || dist < best.dist)) best = { dist, id: mesh.id, z: oz + dz * dist };
          }
        }
        const key = best ? best.id + '@' + best.z.toFixed(3) : 'MISS';
        if (key !== prev) { out.push(`X=${X} Y=${Y.toFixed(3)} ${key}`); prev = key; }
      }
    }
    return out;
  }, xs, ys[0], ys[1], ys[2], process.env.FROMREAR !== '0');
  for (const r of res) log('VSCAN ' + r);
}

if (MODE === 'camsweep') {
  // 机位候选扫描：EYES="x,y,z;x,y,z;..." 每个眼点只打 5×5 网格，报中心命中 + 命中构件种类
  const eyes = (process.env.EYES || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
  const tgt = (process.env.TGT || '-0.42,1.05,-10').split(',').map(Number);
  const fov = Number(process.env.FOV || 58);
  const aspect = Number(process.env.ASPECT || 1.684);
  const res = await page.evaluate((eyes, tgt, fov, aspect) => {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const meshes = [];
    window.__v800Scene().traverse((o) => {
      const m = o;
      if (!m.isMesh || !m.visible || !m.geometry) return;
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
      meshes.push({ id: (m.userData?.sculptComponent?.id || m.name) + '|' + (mat?.userData?.sculptMaterial?.id || mat?.name || ''), pts, idx: index, n: index ? index.count : pos.count });
    });
    const cast = (eye, d) => {
      let best = null;
      for (const mesh of meshes) {
        const { pts, idx, n } = mesh;
        for (let tt = 0; tt < n; tt += 3) {
          const a = (idx ? idx.getX(tt) : tt) * 3;
          const b = (idx ? idx.getX(tt + 1) : tt + 1) * 3;
          const c = (idx ? idx.getX(tt + 2) : tt + 2) * 3;
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
          if (dist > 0.01 && (!best || dist < best.dist)) best = { dist, id: mesh.id };
        }
      }
      return best;
    };
    const t = Math.tan((fov * Math.PI) / 360);
    const out = [];
    for (const eye of eyes) {
      const fwd = norm(sub(tgt, eye));
      const right = norm(cross(fwd, [0, 1, 0]));
      const up = cross(right, fwd);
      const ids = new Set();
      let minD = Infinity;
      for (let iy = -2; iy <= 2; iy++) for (let ix = -2; ix <= 2; ix++) {
        const sx = (ix / 2) * t * aspect * 0.9, sy = (iy / 2) * t * 0.9;
        const d = norm([fwd[0] + right[0] * sx + up[0] * sy, fwd[1] + right[1] * sx + up[1] * sy, fwd[2] + right[2] * sx + up[2] * sy]);
        const h = cast(eye, d);
        if (h) { ids.add(h.id); minD = Math.min(minD, h.dist); } else ids.add('MISS');
      }
      const center = cast(eye, fwd);
      out.push(`eye=[${eye.map((v) => v.toFixed(2))}] center=${center ? center.id + '@' + center.dist.toFixed(2) : 'MISS'} minDist=${minD === Infinity ? '-' : minD.toFixed(2)} kinds=${ids.size} {${[...ids].join(', ')}}`);
    }
    return out;
  }, eyes, tgt, fov, aspect);
  for (const r of res) log('CAM ' + r);
}

if (MODE === 'pick') {
  // 机位射线拾取：给眼点/注视点，在 NDC 网格上打射线，报最近命中的构件 id
  const eye = (process.env.EYE || '-0.55,1.16,-0.45').split(',').map(Number);
  const tgt = (process.env.TGT || '-0.42,1.12,-10').split(',').map(Number);
  const fov = Number(process.env.FOV || 58);
  const aspect = Number(process.env.ASPECT || 1.684);
  const nx = Number(process.env.NX || 5);
  const ny = Number(process.env.NY || 7);
  const res = await page.evaluate((eye, tgt, fov, aspect, nx, ny) => {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const fwd = norm(sub(tgt, eye));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const meshes = [];
    window.__v800Scene().traverse((o) => {
      const m = o;
      if (!m.isMesh || !m.visible || !m.geometry) return;
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
      meshes.push({
        id: (m.userData?.sculptComponent?.id || m.name) + '|' + (mat?.userData?.sculptMaterial?.id || mat?.name || ''),
        pts, idx: index, n: index ? index.count : pos.count
      });
    });
    const t = Math.tan((fov * Math.PI) / 360);
    const rows = [];
    for (let iy = ny; iy >= -ny; iy--) {
      const line = [];
      for (let ix = -nx; ix <= nx; ix++) {
        const sx = (ix / nx) * t * aspect, sy = (iy / ny) * t;
        const d = norm([fwd[0] + right[0] * sx + up[0] * sy, fwd[1] + right[1] * sx + up[1] * sy, fwd[2] + right[2] * sx + up[2] * sy]);
        let best = null;
        for (const mesh of meshes) {
          const { pts, idx, n } = mesh;
          for (let tt = 0; tt < n; tt += 3) {
            const a = (idx ? idx.getX(tt) : tt) * 3;
            const b = (idx ? idx.getX(tt + 1) : tt + 1) * 3;
            const c = (idx ? idx.getX(tt + 2) : tt + 2) * 3;
            const ax = pts[a], ay = pts[a + 1], az = pts[a + 2];
            const e1x = pts[b] - ax, e1y = pts[b + 1] - ay, e1z = pts[b + 2] - az;
            const e2x = pts[c] - ax, e2y = pts[c + 1] - ay, e2z = pts[c + 2] - az;
            const pvx = d[1] * e2z - d[2] * e2y, pvy = d[2] * e2x - d[0] * e2z, pvz = d[0] * e2y - d[1] * e2x;
            const det = e1x * pvx + e1y * pvy + e1z * pvz;
            if (Math.abs(det) < 1e-12) continue;
            const inv = 1 / det;
            const sx2 = eye[0] - ax, sy2 = eye[1] - ay, sz2 = eye[2] - az;
            const u = (sx2 * pvx + sy2 * pvy + sz2 * pvz) * inv;
            if (u < -1e-6 || u > 1 + 1e-6) continue;
            const qx = sy2 * e1z - sz2 * e1y, qy = sz2 * e1x - sx2 * e1z, qz = sx2 * e1y - sy2 * e1x;
            const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
            if (v < -1e-6 || u + v > 1 + 1e-6) continue;
            const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (dist > 0.01 && (!best || dist < best.dist)) best = { dist, id: mesh.id };
          }
        }
        line.push(best ? `${best.id}@${best.dist.toFixed(2)}` : 'MISS');
      }
      rows.push(`ndcY=${(iy / ny).toFixed(2)} ` + line.join(' | '));
    }
    return rows;
  }, eye, tgt, fov, aspect, nx, ny);
  for (const r of res) log('PICK ' + r);
}

if (MODE === 'shots') {
  for (const s of SHOTS) {
    const d = await page.evaluate((n, a, p, dd, t) => window.__v800Capture(n, a, p, dd, t), s.name, s.az, s.pitch, s.dist, s.ty);
    savePng(s.name, d);
  }
  const info = await page.evaluate(() => window.__v800Info());
  log('INFO ' + JSON.stringify(info));
}

if (MODE === 'closeup') {
  for (const mid of HIDEMAT) {
    const n = await page.evaluate((m) => window.__v800HideMat(m, true), mid);
    log('HIDEMAT(before) ' + mid + ' meshes=' + n);
  }
  for (const cid of HIDECOMP) {
    const n = await page.evaluate((id) => {
      let c = 0;
      window.__v800Scene().traverse((o) => {
        const m = o;
        if (m.isMesh && m.userData?.sculptComponent?.id === id) { m.visible = false; c++; }
      });
      return c;
    }, cid);
    log('HIDECOMP(before) ' + cid + ' meshes=' + n);
  }
  for (const c of CLOSEUPS) {
    const d = await page.evaluate((n, a, b, cc, x, y, z) => window.__v800CabinShot(n, a, b, cc, x, y, z),
      c.name, c.eye[0], c.eye[1], c.eye[2], c.tgt[0], c.tgt[1], c.tgt[2]);
    savePng(c.name, d);
  }
}

if (MODE === 'hide') {
  for (const cid of HIDECOMP) {
    const n = await page.evaluate((id) => {
      let c = 0;
      window.__v800Scene().traverse((o) => {
        const m = o;
        if (m.isMesh && m.userData?.sculptComponent?.id === id) { m.visible = false; c++; }
      });
      return c;
    }, cid);
    for (const s of SHOTS) {
      const d = await page.evaluate((n2, a, p, dd, t) => window.__v800Capture(n2, a, p, dd, t), 'hide-' + cid + '-' + s.name, s.az, s.pitch, s.dist, s.ty);
      savePng('hide-' + cid + '-' + s.name, d);
    }
    await page.evaluate((id) => {
      window.__v800Scene().traverse((o) => {
        const m = o;
        if (m.isMesh && m.userData?.sculptComponent?.id === id) m.visible = true;
      });
    }, cid);
    log('HIDECOMP ' + cid + ' meshes=' + n);
  }
  for (const mid of HIDEMAT) {
    const n = await page.evaluate((m) => window.__v800HideMat(m, true), mid);
    for (const s of SHOTS) {
      const d = await page.evaluate((a, p, dd, t) => window.__v800Capture('hidem-' + a, 0, p, dd, t), s.name, s.pitch, s.dist, s.ty);
      savePng('hidem-' + mid + '-' + s.name, d);
    }
    await page.evaluate((m) => window.__v800HideMat(m, false), mid);
    log('HIDEMAT ' + mid + ' meshes=' + n);
  }
}

log('ALL DONE');
const keep = logs.filter((l) => /uvassert|assert|error|Error|WARN|NaN|越界|batchmerge|lightassert|串味/i.test(l));
if (keep.length) log('--- CONSOLE ---\n' + keep.slice(0, 40).join('\n'));
await page.close();
browser.disconnect();
process.exit(0);
