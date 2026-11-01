/**
 * R43 遮挡定罪 · 场景级探针（node，无需浏览器）
 *
 * 能力：
 *  1. `inventory`  —— 打印全部 mesh（name / tri / bbox / 材质 type+color+map+side+vertexColors）
 *  2. `pose`       —— 指定机位做 **CPU 光栅化**：逐像素首命中 mesh（z-buffer）+ 世界坐标 + 平面 ID 图
 *  3. `grid`       —— 指定机位做 raycast 网格采样（真 Raycaster，手动按 visible 过滤）
 *  4. `search`     —— 机位搜索：拿 ID 图里某 mesh 的 mask 与用户截图「暗区 mask」比 IoU
 *  5. `ab`         —— A/B：改 GORGE_HALF 等常量后重跑（由 .mjs 侧过滤 slab 复刻，不动真源）
 *
 * ※ 为什么自己写光栅器而不用 Raycaster 跑全帧：castle 20 万三角 × 23 万像素 = 不可行；
 *   光栅化是 O(三角形 + 覆盖像素)，且**逐像素首命中**与射线等价（同一套 z-buffer 判据）。
 *   Raycaster 只在 `grid` 模式做小网格交叉验证。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { encodePNG, decodePNG } from './r43_png.mjs';

/* ───────────────────────── DOM / WebGL 最小 shim ───────────────────────── */
const grad = { addColorStop() {} };
function makeCtx2d() {
  const c = {
    canvas: null,
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', shadowBlur: 0, shadowColor: '',
    lineCap: 'butt', lineJoin: 'miter', filter: 'none', imageSmoothingEnabled: true,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    putImageData() {}, fillRect() {}, strokeRect() {}, clearRect() {}, drawImage() {},
    fillText() {}, strokeText() {}, translate() {}, rotate() {}, scale() {}, transform() {},
    setTransform() {}, resetTransform() {}, save() {}, restore() {}, beginPath() {},
    closePath() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, rect() {}, ellipse() {},
    clip() {}, bezierCurveTo() {}, quadraticCurveTo() {}, setLineDash() {}, getLineDash: () => [],
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    createConicGradient: () => grad, createPattern: () => null, measureText: () => ({ width: 0 }),
    isPointInPath: () => false
  };
  return new Proxy(c, { get: (o, p) => (p in o ? o[p] : () => {}) });
}
function makeCanvas() {
  const cv = {
    width: 1, height: 1, style: {},
    getContext: () => makeCtx2d(),
    toDataURL: () => 'data:image/png;base64,',
    addEventListener() {}, removeEventListener() {}, setAttribute() {}
  };
  return cv;
}
globalThis.window = {
  devicePixelRatio: 1, location: { hash: '', href: '' }, addEventListener() {}, removeEventListener() {},
  innerWidth: 1280, innerHeight: 720, requestAnimationFrame: (f) => setTimeout(f, 16),
  devicePixelRatio: 1
};
globalThis.document = {
  createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {}, appendChild() {}, setAttribute() {} }),
  createElementNS: (ns, t) => (t === 'canvas' ? makeCanvas() : { style: {}, appendChild() {}, setAttribute() {} }),
  body: { appendChild() {}, style: {} }, documentElement: { style: {} },
  getElementById: () => null, querySelector: () => null, addEventListener() {}, removeEventListener() {}
};
globalThis.self = globalThis.window;
globalThis.requestIdleCallback = (f) => setTimeout(() => f({ timeRemaining: () => 8, didTimeout: false }), 0);
globalThis.cancelIdleCallback = (id) => clearTimeout(id);
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
globalThis.Image = class { set src(v) { this.onload?.(); } addEventListener() {} };

const K = await import('./r43_probe_bundle.mjs');
const THREE = K.THREE;

/* ───────────────────────── 场景构建（缓存） ───────────────────────── */
let ENV = null;
function env() {
  if (!ENV) {
    const t0 = Date.now();
    ENV = K.buildEnv();
    ENV.scene.updateMatrixWorld(true);
    ENV.ms = Date.now() - t0;
  }
  return ENV;
}

const matOf = (m) => (Array.isArray(m) ? m[0] : m);
const sideName = (s) => (s === THREE.FrontSide ? 'Front' : s === THREE.BackSide ? 'Back' : 'Double');

function materialInfo(m) {
  const mt = matOf(m.material);
  if (!mt) return { type: '?' };
  return {
    type: mt.type,
    color: mt.color ? '#' + mt.color.getHexString() : '-',
    map: mt.map ? (mt.map.image ? `${mt.map.image.width}x${mt.map.image.height}` : 'map') : '-',
    vertexColors: !!mt.vertexColors,
    side: sideName(mt.side),
    transparent: !!mt.transparent,
    opacity: mt.opacity
  };
}

/** 收集可见 mesh（尊重 visible 链 + material.visible；⚠ Raycaster 不看 visible，必须自己过） */
function visibleMeshes(scene) {
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let v = true;
    let n = o;
    while (n) { v = v && n.visible; n = n.parent; }
    if (!v) return;
    if (matOf(o.material)?.visible === false) return;
    out.push(o);
  });
  return out;
}

function triCount(geo) {
  const idx = geo.getIndex();
  const pos = geo.getAttribute('position');
  return Math.floor((idx ? idx.count : pos ? pos.count : 0) / 3);
}

function worldVerts(mesh) {
  if (mesh.__wv) return mesh.__wv;
  const pos = mesh.geometry.getAttribute('position');
  const v = new Float64Array(pos.count * 3);
  const m = mesh.matrixWorld.elements;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    v[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    v[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    v[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  mesh.__wv = v;
  return v;
}

/* ───────────────────────── 相机 ───────────────────────── */
function makeCam([x, y, z], [tx, ty, tz], fov, W, H) {
  const cam = new THREE.PerspectiveCamera(fov, W / H, 1, 20000);
  cam.position.set(x, y, z);
  cam.lookAt(tx, ty, tz);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/* ───────────────────────── CPU 光栅器（z-buffer 逐像素首命中） ───────────────────────── */
/**
 * @returns {{label:Int32Array, w:Float32Array, pos:Float32Array, names:string[], px:Int32Array}}
 */
function raster(meshes, cam, W, H) {
  const N = W * H;
  const label = new Int32Array(N).fill(-1);
  const wbuf = new Float32Array(N).fill(Infinity);
  const posBuf = new Float32Array(N * 3);
  const nrmBuf = new Float32Array(N * 3);
  const names = meshes.map((m) => m.name || '(unnamed)');
  const px = new Int32Array(meshes.length);
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
  const NEAR_W = cam.near; // 透视下 w == 视深 ⇒ 近平面判据 w >= near

  let culled = 0, clipped = 0, drawn = 0;

  /* 三角形 → 像素：v = [clipX, clipY, clipZ, w, worldX, worldY, worldZ] */
  function emit(A, B, C, mi, front) {
    const nx0 = A[0] / A[3], ny0 = A[1] / A[3];
    const nx1 = B[0] / B[3], ny1 = B[1] / B[3];
    const nx2 = C[0] / C[3], ny2 = C[1] / C[3];
    const sx0 = (nx0 * 0.5 + 0.5) * W, sy0 = (1 - (ny0 * 0.5 + 0.5)) * H;
    const sx1 = (nx1 * 0.5 + 0.5) * W, sy1 = (1 - (ny1 * 0.5 + 0.5)) * H;
    const sx2 = (nx2 * 0.5 + 0.5) * W, sy2 = (1 - (ny2 * 0.5 + 0.5)) * H;
    const minX = Math.max(0, Math.floor(Math.min(sx0, sx1, sx2)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sx0, sx1, sx2)));
    const minY = Math.max(0, Math.floor(Math.min(sy0, sy1, sy2)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sy0, sy1, sy2)));
    if (minX > maxX || minY > maxY) return;
    const d = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
    if (Math.abs(d) < 1e-12) return;
    const areaN = (nx1 - nx0) * (ny2 - ny0) - (nx2 - nx0) * (ny1 - ny0);
    const isFront = areaN > 0;
    if (front === THREE.FrontSide && !isFront) { culled += 1; return; }
    if (front === THREE.BackSide && isFront) { culled += 1; return; }
    drawn += 1;
    const iw0 = 1 / A[3], iw1 = 1 / B[3], iw2 = 1 / C[3];
    // 面法线（世界坐标叉积，未归一化先算长度）
    const e1x = B[4] - A[4], e1y = B[5] - A[5], e1z = B[6] - A[6];
    const e2x = C[4] - A[4], e2y = C[5] - A[5], e2z = C[6] - A[6];
    let fnx = e1y * e2z - e1z * e2y, fny = e1z * e2x - e1x * e2z, fnz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fnx, fny, fnz) || 1;
    fnx /= fl; fny /= fl; fnz /= fl;
    if (front === THREE.BackSide) { fnx = -fnx; fny = -fny; fnz = -fnz; }
    for (let py = minY; py <= maxY; py += 1) {
      const fy = py + 0.5;
      for (let pxx = minX; pxx <= maxX; pxx += 1) {
        const fx = pxx + 0.5;
        const b0 = ((sx1 - fx) * (sy2 - fy) - (sx2 - fx) * (sy1 - fy)) / d;
        if (b0 < -1e-6) continue;
        const b1 = ((sx2 - fx) * (sy0 - fy) - (sx0 - fx) * (sy2 - fy)) / d;
        if (b1 < -1e-6) continue;
        const b2 = 1 - b0 - b1;
        if (b2 < -1e-6) continue;
        const p0 = b0 * iw0, p1 = b1 * iw1, p2 = b2 * iw2;
        const st = p0 + p1 + p2;
        const depth = 1 / st; // 视深（米）
        const o = py * W + pxx;
        if (depth >= wbuf[o]) continue;
        wbuf[o] = depth;
        label[o] = mi;
        posBuf[o * 3] = (p0 * A[4] + p1 * B[4] + p2 * C[4]) / st;
        posBuf[o * 3 + 1] = (p0 * A[5] + p1 * B[5] + p2 * C[5]) / st;
        posBuf[o * 3 + 2] = (p0 * A[6] + p1 * B[6] + p2 * C[6]) / st;
        nrmBuf[o * 3] = fnx; nrmBuf[o * 3 + 1] = fny; nrmBuf[o * 3 + 2] = fnz;
      }
    }
  }

  const Mimg = [];
  for (let mi = 0; mi < meshes.length; mi += 1) {
    const mesh = meshes[mi];
    const geo = mesh.geometry;
    const wv = worldVerts(mesh);
    const idx = geo.getIndex();
    const n = idx ? idx.count : wv.length / 3;
    const side = matOf(mesh.material)?.side ?? THREE.FrontSide;
    for (let t = 0; t < n; t += 3) {
      const ia = (idx ? idx.getX(t) : t) * 3;
      const ib = (idx ? idx.getX(t + 1) : t + 1) * 3;
      const ic = (idx ? idx.getX(t + 2) : t + 2) * 3;
      // 顶点 → clip（x,y,z,w）+ 世界坐标（裁剪插值用）
      Mimg.length = 0;
      let behind = 0;
      for (const k of [ia, ib, ic]) {
        const x = wv[k], y = wv[k + 1], z = wv[k + 2];
        const cxv = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
        const cyv = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
        const czv = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
        const cwv = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        if (cwv < NEAR_W) behind += 1;
        Mimg.push([cxv, cyv, czv, cwv, x, y, z]);
      }
      let poly = Mimg;
      if (behind > 0) {
        if (behind === 3) continue;
        // Sutherland-Hodgman：按 w >= NEAR_W 裁一刀
        const out = [];
        for (let i = 0; i < 3; i += 1) {
          const A = poly[i], B = poly[(i + 1) % 3];
          const aw = A[3], bw = B[3];
          const ain = aw >= NEAR_W, bin = bw >= NEAR_W;
          if (ain) out.push(A);
          if (ain !== bin) {
            const tt = (NEAR_W - aw) / (bw - aw);
            out.push([
              A[0] + tt * (B[0] - A[0]), A[1] + tt * (B[1] - A[1]), A[2] + tt * (B[2] - A[2]),
              NEAR_W, A[4] + tt * (B[4] - A[4]), A[5] + tt * (B[5] - A[5]), A[6] + tt * (B[6] - A[6])
            ]);
          }
        }
        if (out.length < 3) continue;
        clipped += 1;
        poly = out;
      }
      for (let f = 1; f + 1 < poly.length; f += 1) {
        emit(poly[0], poly[f], poly[f + 1], mi, side);
      }
    }
  }
  for (let i = 0; i < N; i += 1) if (label[i] >= 0) px[label[i]] += 1;
  return { label, w: wbuf, pos: posBuf, nrm: nrmBuf, names, px, culled, clipped, drawn };
}

/* ───────────────────────── 调色板 / ID 图 ───────────────────────── */
const PALETTE = [
  0xff00ff, 0x00e5ff, 0x7cff00, 0xffa500, 0x9b5cff, 0x00ff9d, 0xff5c5c, 0x5c9bff,
  0xffff00, 0xff006e, 0x00a86b, 0xb0b0b0, 0x8a2be2, 0x20b2aa, 0xff69b4, 0xcd853f,
  0x7fff00, 0xdc143c, 0x4682b4, 0xdaa520
];
const colorOf = (i) => PALETTE[i % PALETTE.length];

function writeLabelPNG(res, W, H, file) {
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    const mi = res.label[i];
    const o = i * 4;
    if (mi < 0) { out[o] = out[o + 1] = out[o + 2] = 8; out[o + 3] = 255; continue; }
    const c = colorOf(mi);
    out[o] = (c >> 16) & 255; out[o + 1] = (c >> 8) & 255; out[o + 2] = c & 255; out[o + 3] = 255;
  }
  fs.writeFileSync(file, encodePNG(W, H, out));
}

/* ───────────────────────── 用户截图暗区 mask ───────────────────────── */
const SHOT = 'C:/Users/16896/.workbuddy/clipboard-images/clipboard-2026-11-01T04-16-43-742Z-d236ed26.png';
function shotDarkMask(TH = 90) {
  if (shotDarkMask.cache) return shotDarkMask.cache;
  const { width, height, rgba } = decodePNG(fs.readFileSync(SHOT));
  const m = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    const l = 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
    m[i] = l < TH ? 1 : 0;
  }
  shotDarkMask.cache = { w: width, h: height, m, rgba };
  return shotDarkMask.cache;
}

/** 把 mask 双线性缩到 W×H（最近邻足够） */
function resampleMask(m, sw, sh, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y / H) * sh));
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x / W) * sw));
      out[y * W + x] = m[sy * sw + sx];
    }
  }
  return out;
}

function iou(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] > 0.5 ? 1 : 0, bv = b[i] > 0.5 ? 1 : 0;
    if (av & bv) inter += 1;
    if (av | bv) uni += 1;
  }
  return uni ? inter / uni : 0;
}

/* ───────────────────────── 命中表 ───────────────────────── */
function hitTable(res, W, H, cols, rows, region) {
  const tally = {};
  const per = {};
  const [rx0, ry0, rx1, ry1] = region;
  let total = 0;
  for (let iy = 0; iy < rows; iy += 1) {
    for (let ix = 0; ix < cols; ix += 1) {
      const nx = rx0 + ((rx1 - rx0) * (ix + 0.5)) / cols;
      const ny = ry0 + ((ry1 - ry0) * (iy + 0.5)) / rows;
      const px = Math.min(W - 1, Math.floor(nx * W));
      const py = Math.min(H - 1, Math.floor(ny * H));
      const o = py * W + px;
      const mi = res.label[o];
      total += 1;
      const key = mi < 0 ? '(空)' : res.names[mi];
      tally[key] = (tally[key] || 0) + 1;
      per[key] = per[key] || { w: [] };
      if (mi >= 0) per[key].w.push(res.w[o]);
    }
  }
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  return {
    total, sorted,
    lines: sorted.map(([k, n]) => {
      const ws = (per[k]?.w ?? []).slice().sort((a, b) => a - b);
      const p50 = ws.length ? ws[Math.floor(ws.length / 2)] : NaN;
      return `${k.padEnd(26)} ${String(n).padStart(4)}  ${((100 * n) / total).toFixed(1).padStart(5)}%  首命中距离 p50=${Number.isFinite(p50) ? p50.toFixed(1) + 'm' : '-'}`;
    })
  };
}

export {
  THREE, K, env, visibleMeshes, matOf, materialInfo, triCount, worldVerts,
  makeCam, raster, writeLabelPNG, colorOf, PALETTE, shotDarkMask, resampleMask, iou,
  hitTable, SHOT, sideName, encodePNG, decodePNG
};
