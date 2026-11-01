/**
 * R43 出图 · 近似着色 A/B（CPU 光栅，非 GPU 出图 —— 报告里必须如实标注）
 *
 * 口径：几何/相机/裁剪与 `r43_gorge_ab.mjs` 完全同源；着色是**近似**：
 *   albedo 用材质基色表（贴图件取该族实测中位色），光照用 ACTIVE_ENV 的
 *   sun(12°/195°, 0xffe6c8×2.6) + hemi(0.34) + fill(0.7) + rim(1.05) 的 Lambert 和，
 *   除以 π（three 的 BRDF_Lambert），再 ACESFilmic + exposure 0.85 + sRGB 编码。
 * 天空：复刻 Environment.ts:93-101 的 h 分段（h<-0.08 纯 uGround）。
 * 用途只有一件事：让「棕洞 vs 岩壁谷底」的差异肉眼可读，不做像素级对账。
 */
import fs from 'node:fs';
import { THREE, env, visibleMeshes, makeCam, raster, encodePNG } from './r43_occlusion_lib.mjs';
import { ACTIVE_ENV } from './r43_probe_bundle.mjs';

const OUT = '.qa/r43_occlusion';
/* 简化：直接 import 参数化峡谷实现（从 gorge_ab 里复制最小集） */
const V = { zNear: 60, zFar: -358.5, totalHalf: 12.6, gorgeDepth: 66.5 };

/* ── 与 r43_gorge_ab.mjs 同源复制的噪声/网格（保持两脚本独立可跑） ── */
function hash2(ix, iy) { const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}
function fbm2(x, y) { let v = 0, a = 0.5, fx = x, fy = y; for (let o = 0; o < 4; o += 1) { v += a * noise2(fx, fy); fx *= 2.07; fy *= 2.07; a *= 0.5; } return v / 0.9375; }
function rockTint(u, v, shade) {
  const joint = fbm2(u * 5.5, v * 0.35), grain = noise2(u * 3.1 + 11.3, v * 0.9 + 4.7);
  return (0.78 + 0.2 * joint + 0.08 * grain) * (1 - 0.45 * shade);
}
const ROCK_NEAR = new THREE.Color(0x8d8a85);
function addGrid(out, nu, nv, at, tint, base, flip) {
  const origin = out.pos.length / 3, tmp = new THREE.Color();
  for (let j = 0; j <= nv; j += 1) for (let i = 0; i <= nu; i += 1) {
    const p = at(i, j); out.pos.push(p[0], p[1], p[2]);
    tmp.copy(base).multiplyScalar(tint(i, j)); out.col.push(tmp.r, tmp.g, tmp.b);
  }
  const row = nu + 1;
  for (let j = 0; j < nv; j += 1) for (let i = 0; i < nu; i += 1) {
    const a = origin + j * row + i, b = a + 1, c = a + row, d = c + 1;
    if (flip) out.idx.push(a, c, b, c, d, b); else out.idx.push(a, b, c, b, d, c);
  }
}
const empty = () => ({ pos: [], col: [], idx: [] });
function toGeo(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(p.col, 3));
  g.setIndex(p.idx); g.computeVertexNormals(); return g;
}
function buildGorge({ slotHalf, wallHalf, capHalf, bedHalf, frontSide, wobByT }) {
  const out = empty(), top = -0.02, bed = -V.gorgeDepth, nx = 4;
  const nz = Math.max(2, Math.round((V.zNear - V.zFar) / 10));
  const ny = Math.max(2, Math.round((top - bed) / 5));
  for (const side of [-1, 1]) {
    addGrid(out, nz, ny,
      (i, j) => {
        const z = V.zNear + ((V.zFar - V.zNear) * i) / nz;
        const y = top + ((bed - top) * j) / ny;
        const k = wobByT ? j / ny : 1;
        const w = 2.4 * fbm2(z * 0.06 + (side > 0 ? 31.7 : 5.1), y * 0.05) * k;
        const zw = 1.6 * (noise2(z * 0.11 + 2.3, y * 0.09 + side * 7.7) - 0.5);
        return [side * (wallHalf + w), y, z + zw];
      },
      (i, j) => rockTint((V.zNear + ((V.zFar - V.zNear) * i) / nz) / 30, j / ny, 0.15 + 0.85 * (j / ny)),
      ROCK_NEAR, frontSide ? side < 0 : false);
  }
  for (const [zEnd, flip] of [[V.zNear, true], [V.zFar, false]]) {
    addGrid(out, nx, ny,
      (i, j) => {
        const x = -capHalf + ((2 * capHalf) * i) / nx;
        const y = top + ((bed - top) * j) / ny;
        const zw = 2.0 * (noise2(x * 0.13 + 8.9, y * 0.08) - 0.5);
        return [x, y, zEnd + (zEnd === V.zNear ? -Math.abs(zw) : Math.abs(zw))];
      },
      (i, j) => rockTint(i / nx, j / ny, 0.15 + 0.85 * (j / ny)),
      ROCK_NEAR, frontSide ? flip : false);
  }
  addGrid(out, nx, nz,
    (i, j) => {
      const x = -bedHalf + ((2 * bedHalf) * i) / nx;
      const z = V.zNear + ((V.zFar - V.zNear) * j) / nz;
      return [x, bed + 1.1 * (fbm2(x * 0.09 + 17.3, z * 0.05) - 0.5), z];
    },
    (i) => rockTint(i / nx, 0.5, 1), ROCK_NEAR, false);
  return out;
}
function buildGround(holeHalfX, center) {
  const holeNear = V.zNear, holeFar = V.zFar;
  const southEdge = center - 3000, northEdge = center + 3000, pieces = [];
  const TILE = 6;
  const slab = (w, d, x, z) => {
    const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); g.translate(x, -0.02, z);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * w) / TILE, (uv.getY(i) * d) / TILE);
    return g;
  };
  pieces.push(slab(3000, northEdge - holeNear, 0, (northEdge + holeNear) / 2));
  pieces.push(slab(3000, holeFar - southEdge, 0, (southEdge + holeFar) / 2));
  const sideW = 1500 - holeHalfX;
  for (const side of [-1, 1]) pieces.push(slab(sideW, holeNear - holeFar, side * (holeHalfX + sideW / 2), (holeNear + holeFar) / 2));
  let vc = 0, ic = 0;
  for (const g of pieces) { const p = g.getAttribute('position'), ix = g.getIndex(); vc += p.count; ic += ix ? ix.count : p.count; }
  const pos = new Float32Array(vc * 3), uvA = new Float32Array(vc * 2), nor = new Float32Array(vc * 3), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of pieces) {
    const p = g.getAttribute('position'), u = g.getAttribute('uv'), n = g.getAttribute('normal'), ix = g.getIndex();
    for (let i = 0; i < p.count; i += 1) {
      pos[(vo + i) * 3] = p.getX(i); pos[(vo + i) * 3 + 1] = p.getY(i); pos[(vo + i) * 3 + 2] = p.getZ(i);
      uvA[(vo + i) * 2] = u.getX(i); uvA[(vo + i) * 2 + 1] = u.getY(i);
      nor[(vo + i) * 3] = n.getX(i); nor[(vo + i) * 3 + 1] = n.getY(i); nor[(vo + i) * 3 + 2] = n.getZ(i);
    }
    if (ix) for (let i = 0; i < ix.count; i += 1) idx[io + i] = ix.getX(i) + vo;
    else for (let i = 0; i < p.count; i += 1) idx[io + i] = i + vo;
    vo += p.count; io += ix ? ix.count : p.count;
  }
  const o = new THREE.BufferGeometry();
  o.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  o.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
  o.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  o.setIndex(new THREE.BufferAttribute(idx, 1));
  return o;
}

/* ── 近似着色 ── */
const ALBEDO = {
  ground: 0x8a8884, road: 0x6a6864, '(unnamed)': 0xd8d2c8,
  'terrain-skyline': 0x9d968c, 'terrain-rock': 0x8d8a85,
  'castle-pave-road': 0x7a7875, 'castle-pave-walk': 0xbdb3a4,
  ashlar: 0xd0c8bc, wall: 0xb5b1ae, gold: 0xa2771d,
  dark: 0x141110, roof: 0x6a6560, wood: 0x3a3128,
  glass: 0xa9a49a, marble: 0xada6a0, agedGold: 0xd2cec4,
  grey: 0xb7bec4, flame: 0xffffb6, pave: 0x8b9094, door: 0x2a2018
};
function albedoOf(name) {
  if (ALBEDO[name]) return ALBEDO[name];
  for (const k of Object.keys(ALBEDO)) if (name.includes(k)) return ALBEDO[k];
  return [0xb0, 0xb0, 0xb0];
}
const E = env();
const scene = E.scene;
const ms0 = visibleMeshes(scene);
const groundMesh = ms0.find((m) => m.name === 'ground');
const rockMesh = ms0.find((m) => m.name === 'terrain-rock');
const groundCenter = (260 - 2000) / 2;
const rockMats = {};
function rockMat(side) {
  if (!rockMats[side]) rockMats[side] = new THREE.MeshLambertMaterial({ color: new THREE.Color(1.8, 1.8, 1.8), vertexColors: true, side });
  return rockMats[side];
}
function applyState(st) {
  delete groundMesh.__wv; delete rockMesh.__wv;
  groundMesh.geometry = buildGround(st.slotHalf, groundCenter);
  rockMesh.geometry = toGeo(buildGorge(st));
  rockMesh.material = rockMat(st.frontSide ? THREE.FrontSide : THREE.DoubleSide);
  scene.updateMatrixWorld(true);
}

const sunDir = new THREE.Vector3(-0.2531, 0.2079, -0.9448).normalize();
const fillDir = new THREE.Vector3(0.2531, 0.64, 0.9448).normalize();
const rimDir = new THREE.Vector3(0.56, 0.109, 0.81).normalize();
const cSun = new THREE.Color(ACTIVE_ENV.sun.color), cHemiS = new THREE.Color(ACTIVE_ENV.hemi.sky);
const cHemiG = new THREE.Color(ACTIVE_ENV.hemi.ground), cFill = new THREE.Color(ACTIVE_ENV.fill.color);
const cRim = new THREE.Color(ACTIVE_ENV.rim.color);
const cZen = new THREE.Color(ACTIVE_ENV.sky.zenith), cMid = new THREE.Color(ACTIVE_ENV.sky.mid);
const cHor = new THREE.Color(ACTIVE_ENV.sky.horizon), cGnd = new THREE.Color(ACTIVE_ENV.sky.ground);
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function aces(x) { const v = Math.max(0, x) * (0.85 / 0.6); return Math.min(1, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)); }
function srgb(x) { return Math.round(255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); }
const tmpC = new THREE.Color();
function skyColor(dy) {
  const h = dy;
  if (h < -0.08) return cGnd.clone();
  if (h < 0) return cHor.clone().lerp(cGnd, ss(0, 0.08, -h));
  const c = cHor.clone().lerp(cMid, ss(0, 0.18, h));
  return c.lerp(cZen, ss(0.12, 0.65, h));
}
function shade(r, W, H, cam, file) {
  const out = new Uint8Array(W * H * 4);
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const tanY = Math.tan((cam.fov * Math.PI) / 360), tanX = tanY * (W / H);
  const d = new THREE.Vector3();
  for (let py = 0; py < H; py += 1) for (let px = 0; px < W; px += 1) {
    const i = py * W + px, o = i * 4;
    const nx = ((px + 0.5) / W) * 2 - 1, ny = 1 - ((py + 0.5) / H) * 2;
    d.copy(fwd).addScaledVector(right, nx * tanX).addScaledVector(up, ny * tanY).normalize();
    let col;
    if (r.label[i] < 0) col = skyColor(d.y);
    else {
      tmpC.setHex(albedoOf(r.names[r.label[i]])); // setHex 自动 sRGB→线性

      const Nx = r.nrm[i * 3], Ny = r.nrm[i * 3 + 1], Nz = r.nrm[i * 3 + 2];
      const dl = Math.max(0, Nx * sunDir.x + Ny * sunDir.y + Nz * sunDir.z);
      const fl = Math.max(0, Nx * fillDir.x + Ny * fillDir.y + Nz * fillDir.z);
      const rl = Math.max(0, Nx * rimDir.x + Ny * rimDir.y + Nz * rimDir.z);
      const hemiK = 0.5 + 0.5 * Ny;
      const ir = dl * cSun.r * ACTIVE_ENV.sun.intensity + fl * cFill.r * ACTIVE_ENV.fill.intensity
        + rl * cRim.r * ACTIVE_ENV.rim.intensity + hemiK * cHemiS.r * ACTIVE_ENV.hemi.intensity + (1 - hemiK) * cHemiG.r * ACTIVE_ENV.hemi.intensity;
      const ig = dl * cSun.g * ACTIVE_ENV.sun.intensity + fl * cFill.g * ACTIVE_ENV.fill.intensity
        + rl * cRim.g * ACTIVE_ENV.rim.intensity + hemiK * cHemiS.g * ACTIVE_ENV.hemi.intensity + (1 - hemiK) * cHemiG.g * ACTIVE_ENV.hemi.intensity;
      const ib = dl * cSun.b * ACTIVE_ENV.sun.intensity + fl * cFill.b * ACTIVE_ENV.fill.intensity
        + rl * cRim.b * ACTIVE_ENV.rim.intensity + hemiK * cHemiS.b * ACTIVE_ENV.hemi.intensity + (1 - hemiK) * cHemiG.b * ACTIVE_ENV.hemi.intensity;
      col = new THREE.Color(tmpC.r * ir / Math.PI, tmpC.g * ig / Math.PI, tmpC.b * ib / Math.PI);
    }
    out[o] = srgb(aces(col.r)); out[o + 1] = srgb(aces(col.g)); out[o + 2] = srgb(aces(col.b)); out[o + 3] = 255;
  }
  fs.writeFileSync(file, encodePNG(W, H, out));
}

/* ── 跑 A / D 两态，各 2 机位 ── */
const STATES = {
  A_now: { slotHalf: 18, wallHalf: 12.6, capHalf: 12.6, bedHalf: 12.6, frontSide: true, wobByT: false },
  D_fix: { slotHalf: 70, wallHalf: 70, capHalf: 70, bedHalf: 73, frontSide: false, wobByT: true }
};
const CAMS = [
  { name: 'r41pose', eye: [12.24, 1.6, 40], tgt: [6, 1, -300], fov: 62 },
  { name: 'deck_left', eye: [-10.5, 1.7, -60], tgt: [-17, -14, -150], fov: 62 }
];
const W = 480, H = 570;
for (const [k, st] of Object.entries(STATES)) {
  applyState(st);
  const ms = visibleMeshes(scene);
  for (const c of CAMS) {
    const cam = makeCam(c.eye, c.tgt, c.fov, W, H);
    const r = raster(ms, cam, W, H);
    shade(r, W, H, cam, `${OUT}/shaded_${k}_${c.name}.png`);
    console.log('wrote', `${OUT}/shaded_${k}_${c.name}.png`);
  }
}
console.log('DONE');
