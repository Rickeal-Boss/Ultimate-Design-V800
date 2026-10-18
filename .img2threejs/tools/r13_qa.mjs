// R13 QA：#assembled 基线三机位 + 数值探针 + 消去法逐材质隐藏
// 用法: OUT=dir MODE=baseline|hide|probe bash 调用；见文件尾环境变量说明
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.CDPPORT || 9380);
const PROFILE = '/tmp/r13edge_' + process.pid;
const OUT = process.env.OUT || ROOT + '/.img2threejs/renders/r13';
const MODE = process.env.MODE || 'baseline';
// 逗号分隔材质 id（hide 模式逐个隐藏拍前脸）
const HIDEMAT = (process.env.HIDEMAT || '').split(',').filter(Boolean);
// 逗号分隔组件 id（hidecomp 模式）
const HIDECOMP = (process.env.HIDECOMP || '').split(',').filter(Boolean);
const SHOTS = (process.env.SHOTS || '').split(',').filter(Boolean).map((s) => {
  const [name, az, pitch, dist, ty] = s.split(':');
  return { name, az: +az, pitch: +pitch, dist: +dist, ty: +(ty || 0) };
});
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGF = fs.openSync(OUT + '/qa.log', 'a');
const log = (s) => { fs.writeSync(LOGF, s + '\n'); console.log(s); };
process.on('unhandledRejection', (e) => { log('UNHANDLED ' + String(e).slice(0, 500)); process.exit(2); });
setTimeout(() => { log('WATCHDOG timeout'); process.exit(3); }, 330000).unref();

const server = await createServer({ root: ROOT, server: { port: 5174, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
log('VITE up');
const base = 'http://127.0.0.1:5174/preview.html';

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
  '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });

log('EDGE spawned');
async function waitDebugger() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch { }
    await wait(500);
  }
  throw new Error('Edge debugger not reachable');
}

const logs = [];
const savePng = (name, dataUrl) => {
  const f = path.join(OUT, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  log('SHOT ' + name + ' bytes=' + fs.statSync(f).size);
};
try {
  await waitDebugger();
  log('CDP up');
  await wait(600);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
  log('GOTO...');
  await page.goto(base + (process.env.HASH || '#assembled'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /ready|captured/.test(document.getElementById('status')?.textContent || ''), { timeout: 90000 });

  if (MODE === 'probe') {
    const info = await page.evaluate(() => window.__v800Info());
    log('INFO ' + JSON.stringify(info));
    const parts = await page.evaluate(() => window.__v800Parts());
    const want = (process.env.PROBE_IDS || '').split(',').filter(Boolean);
    for (const p of parts) {
      if (!want.length || want.includes(p.id)) {
        console.log(`PART ${p.id} size=[${p.size}] worldMin=[${p.worldMin}] worldPos=[${p.worldPos}]`);
      }
    }
  }

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
      log(`MESH ${r.name} comp=${r.comp} mat=${r.mat} vis=${r.vis} tris=${r.tris} wmin=[${r.wmin}] wmax=[${r.wmax}]`);
    }
  }

  const azv = Number(process.env.PICK_AZ || 180);
  if (MODE === 'ray') {
    // 纯 JS 射线拾取：相机位姿取自 __v800Camera，Möller–Trumbore 遍历可见 mesh
    const res = await page.evaluate((azv) => {
      const cam = window.__v800Camera;
      const scene = window.__v800Scene();
      // 相机对准前脸（az=180 → 世界 -Z）
      const az = azv * Math.PI / 180, pit = 8 * Math.PI / 180;
      const target = [0, 1.0, 0];
      const eye = [target[0] + 9 * Math.cos(pit) * Math.sin(az), target[1] + 9 * Math.sin(pit), target[2] + 9 * Math.cos(pit) * Math.cos(az)];
      // lookAt 构造视图基
      const fwd = norm3(sub3(target, eye));
      const right = norm3(cross3(fwd, [0, 1, 0]));
      const up = cross3(right, fwd);
      const fov = cam.fov, aspect = cam.aspect;
      const tanY = Math.tan(fov * Math.PI / 360), tanX = tanY * aspect;
      function sub3(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
      function cross3(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
      function norm3(a){const l=Math.hypot(a[0],a[1],a[2]);return [a[0]/l,a[1]/l,a[2]/l];}
      function dot3(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
      const meshes = [];
      scene.traverse((o) => {
        const m = o;
        if (!m.isMesh || !m.visible || !m.geometry) return;
        m.updateWorldMatrix(true, false);
        const g = m.geometry;
        const pos = g.attributes.position;
        const index = g.index;
        const e = m.matrixWorld.elements;
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        const tris = [];
        const n = index ? index.count : pos.count;
        const tri = [0,0,0];
        for (let t = 0; t < n; t += 3) {
          for (let k = 0; k < 3; k++) {
            const vi = index ? index.getX(t + k) : t + k;
            const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
            tri[k] = [e[0]*x+e[4]*y+e[8]*z+e[12], e[1]*x+e[5]*y+e[9]*z+e[13], e[2]*x+e[6]*y+e[10]*z+e[14]];
          }
          tris.push(tri.map(v => v.slice()));
        }
        meshes.push({
          id: (m.userData?.sculptComponent?.id || m.name || m.type),
          mat: mat?.userData?.sculptMaterial?.id || mat?.type,
          tris
        });
      });
      function castDir(dx, dy, dz) {
        let best = null;
        for (const mesh of meshes) {
          for (const t of mesh.tris) {
            const e1 = sub3(t[1], t[0]), e2 = sub3(t[2], t[0]);
            const p = cross3([dx,dy,dz], e2);
            const det = dot3(e1, p);
            if (Math.abs(det) < 1e-9) continue;
            const inv = 1 / det;
            const s = sub3(eye, t[0]);
            const u = dot3(s, p) * inv;
            if (u < -1e-6 || u > 1 + 1e-6) continue;
            const q = cross3(s, e1);
            const v = dot3([dx,dy,dz], q) * inv;
            if (v < -1e-6 || u + v > 1 + 1e-6) continue;
            const dist = dot3(e2, q) * inv;
            if (dist > 0.01 && (!best || dist < best.dist)) best = { dist, id: mesh.id, mat: mesh.mat, at: [eye[0]+dx*dist, eye[1]+dy*dist, eye[2]+dz*dist].map(v=>+v.toFixed(2)) };
          }
        }
        return best;
      }
      const pts = [];
      for (const ny of [-0.1,0,0.05,0.1,0.15]) for (const nx of [-0.45,-0.35,-0.25,0,0.25,0.35,0.45]) pts.push([nx,ny]);
      const out = [];
      for (const [nx, ny] of pts) {
        const dx = norm3([...fwd].map((f,i)=>f + right[i]*nx*tanX + up[i]*ny*tanY));
        const hit = castDir(dx[0], dx[1], dx[2]);
        out.push({ ndc: [nx, ny], hit: hit ? hit.id + '|' + hit.mat + '@' + hit.dist.toFixed(2) + '@' + hit.at : 'MISS' });
      }
      return out;
    }, azv);
    for (const r of res) log('RAY ' + JSON.stringify(r));
  }

  if (MODE === 'closeup') {
    // 近距特写：走 __v800CabinShot（恢复 near 0.05/60），env CLOSEUPS="name:ex,ey,ez:tx,ty,tz|..."
    for (const spec of (process.env.CLOSEUPS || '').split('|').filter(Boolean)) {
      const [name, eye, tgt] = spec.split(':');
      const [ex, ey, ez] = eye.split(',').map(Number);
      const [tx, ty, tz] = tgt.split(',').map(Number);
      const d = await page.evaluate((n, a, b, c, x, y, z) => window.__v800CabinShot(n, a, b, c, x, y, z), name, ex, ey, ez, tx, ty, tz);
      savePng(name, d);
    }
  }

  if (MODE === 'matprobe') {
    const res = await page.evaluate(() => {
      const out = [];
      window.__v800Scene().traverse((o) => {
        const m = o;
        if (!m.isMesh) return;
        const cid = m.userData?.sculptComponent?.id;
        if (cid === 'maextro-mark' || cid === 'shield-logo' || cid === 'chrome-brow' || cid === 'windshield' || cid === 'greenhouse-glass') {
          const mat = Array.isArray(m.material) ? m.material[0] : m.material;
          out.push({
            id: cid,
            matId: mat?.userData?.sculptMaterial?.id,
            emissive: mat?.emissive ? [mat.emissive.r, mat.emissive.g, mat.emissive.b].map(v => +v.toFixed(3)) : null,
            emissiveIntensity: mat?.emissiveIntensity,
            opacity: mat?.opacity,
            transmission: mat?.transmission,
            color: mat?.color ? [mat.color.r, mat.color.g, mat.color.b].map(v => +v.toFixed(3)) : null,
            hasEmissiveMap: !!mat?.emissiveMap,
            hasMap: !!mat?.map,
            visible: m.visible,
            worldMin: null
          });
          m.updateWorldMatrix(true, false);
          const g = m.geometry;
          if (!g.boundingBox) g.computeBoundingBox();
          out[out.length - 1].worldMin = [g.boundingBox.min.x, g.boundingBox.min.y, g.boundingBox.min.z].map(v => +v.toFixed(3));
        }
      });
      return out;
    });
    for (const r of res) log('MAT ' + JSON.stringify(r));
  }

  if (MODE === 'baseline' || MODE === 'shots') {
    for (const s of SHOTS) {
      const dataUrl = await page.evaluate((n, az, pi, d, ty) => window.__v800Capture(n, az, pi, d, ty), s.name, s.az, s.pitch, s.dist, s.ty);
      savePng(s.name, dataUrl);
    }
    const info = await page.evaluate(() => window.__v800Info());
    log('INFO ' + JSON.stringify(info));
  }

  if (MODE === 'hide') {
    // 先拍一张未隐藏基线
    const az = Number(process.env.HIDE_AZ || 180);
    const dataUrl0 = await page.evaluate((a) => window.__v800Capture('hide0-none', a, 8, 9.0, 0), az);
    savePng('hide0-none', dataUrl0);
    for (const matId of HIDEMAT) {
      const n = await page.evaluate((m) => window.__v800HideMat(m, true), matId);
      const d = await page.evaluate((a, m) => window.__v800Capture('hide-' + m, a, 8, 9.0, 0), az, matId);
      savePng('hide-' + matId, d);
      await page.evaluate((m) => window.__v800HideMat(m, false), matId);
      log('HIDEMAT ' + matId + ' meshes=' + n);
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
      const d = await page.evaluate((a, c) => window.__v800Capture('hidec-' + c, a, 8, 9.0, 0), az, cid);
      savePng('hidec-' + cid, d);
      await page.evaluate((id) => {
        window.__v800Scene().traverse((o) => {
          const m = o;
          if (m.isMesh && m.userData?.sculptComponent?.id === id) m.visible = true;
        });
      }, cid);
      log('HIDECOMP ' + cid + ' meshes=' + n);
    }
  }

  log('ALL DONE');
  const keepEarly = logs.filter((l) => /uvassert|assert|error|Error|WARN|NaN|越界|batchmerge|lightassert/i.test(l));
  if (keepEarly.length) log('--- CONSOLE ---\n' + keepEarly.slice(0, 40).join('\n'));
  browser.disconnect();
  process.exit(process.exitCode || 0);
} catch (e) {
  console.error('FAIL', e && e.stack ? e.stack.slice(0, 700) : String(e));
  log('FAIL-EXIT');
  process.exit(1);
} finally {
  try { edge.kill(); } catch { }
  await server.close();
  await wait(200);
}
const keep = logs.filter((l) => /uvassert|assert|error|Error|WARN|NaN|越界|batchmerge|lightassert/i.test(l));
if (keep.length) log('--- CONSOLE ---\n' + keep.slice(0, 30).join('\n'));
log('DONE');
