/**
 * R43-P0B · 峡谷/大地遮挡 A/B 参数化探针
 *
 * 在 node 里**参数化重建** `Road.buildGround` 的 4 块 slab 与 `Terrain.buildGorge` 的
 * 岩壁/封口/谷底，然后对每个方案跑同一套 CPU 光栅（逐像素首命中）：
 *   · 空洞率（label<0 的像素占比）—— 空洞 = 世界缺口 = 天空球下半球 uGround 漏出来
 *   · 首命中命中表（mesh + 距离）
 *   · 平涂 ID 图 + 近似着色图
 *
 * 方案：
 *   A_now      现状（GORGE_HALF=18，岩壁 FrontSide + 绕序翻转，谷底只铺 |x|≤12.6）
 *   B_dside    仅把岩壁改 DoubleSide
 *   C_closed   B + 谷底铺满槽宽 + 岩壁顶对齐槽口（贴地棱线不再开口）
 *   D_valley   C + 槽宽 18→70（把「两条 5.4m 缝」变成真正的山谷）
 *   E_pre42    现状但槽宽回到 12.6（R42 之前）—— 用来证明 R42 把洞**开大了**
 *
 * 用法：node tools/r43_gorge_ab.mjs
 */
import fs from 'node:fs';
import {
  THREE, env, visibleMeshes, makeCam, raster, writeLabelPNG, hitTable, encodePNG, matOf
} from './r43_occlusion_lib.mjs';

const OUT = '.qa/r43_occlusion';
fs.mkdirSync(OUT, { recursive: true });

const V = { zNear: 60, zFar: -358.5, totalHalf: 12.6, gorgeDepth: 66.5 };
const G0 = 18;   // 现状 GORGE_HALF
const G_PRE = 12.6;
const G_VALLEY = 70;

/* ── 值噪声（与 Terrain.ts 完全同式，保证 A/B 只差在被测项） ── */
function hash2(ix, iy) { const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}
function fbm2(x, y) {
  let v = 0, a = 0.5, fx = x, fy = y;
  for (let o = 0; o < 4; o += 1) { v += a * noise2(fx, fy); fx *= 2.07; fy *= 2.07; a *= 0.5; }
  return v / 0.9375;
}
function rockTint(u, v, shade) {
  const joint = fbm2(u * 5.5, v * 0.35);
  const grain = noise2(u * 3.1 + 11.3, v * 0.9 + 4.7);
  return (0.78 + 0.2 * joint + 0.08 * grain) * (1 - 0.45 * shade);
}
const ROCK_NEAR = new THREE.Color(0x8d8a85);

/* ── 与 Terrain.addGrid 同式的网格累加 ── */
function addGrid(out, nu, nv, at, tint, base, flip) {
  const origin = out.pos.length / 3;
  const tmp = new THREE.Color();
  for (let j = 0; j <= nv; j += 1) {
    for (let i = 0; i <= nu; i += 1) {
      const p = at(i, j);
      out.pos.push(p[0], p[1], p[2]);
      tmp.copy(base).multiplyScalar(tint(i, j));
      out.col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  const row = nu + 1;
  for (let j = 0; j < nv; j += 1) {
    for (let i = 0; i < nu; i += 1) {
      const a = origin + j * row + i, b = a + 1, c = a + row, d = c + 1;
      if (flip) out.idx.push(a, c, b, c, d, b);
      else out.idx.push(a, b, c, b, d, c);
    }
  }
}
function toGeo(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(p.col, 3));
  g.setIndex(p.idx);
  g.computeVertexNormals();
  return g;
}
const empty = () => ({ pos: [], col: [], idx: [] });

/**
 * 参数化峡谷。
 *  halfTop    槽口半宽（= 大地的洞边）
 *  halfFloor  谷底半宽
 *  wallTop    岩壁顶 y（= -0.02，必须 == 大地高度）
 *  frontSide  true = 复刻 R42 现状（FrontSide + side<0 翻绕序）；false = DoubleSide
 */
function buildGorge({ slotHalf, wallHalf, capHalf, bedHalf, frontSide, wobByT, wobble }) {
  const out = empty();
  const top = -0.02, bed = -V.gorgeDepth;
  const zStep = 10, yStep = 5;
  const nz = Math.max(2, Math.round((V.zNear - V.zFar) / zStep));
  const ny = Math.max(2, Math.round((top - bed) / yStep));
  // 侧壁（复刻真源：x = side*(wallHalf + wob)，wob 在拓扑上**不随高度归零**）
  for (const side of [-1, 1]) {
    addGrid(out, nz, ny,
      (i, j) => {
        const z = V.zNear + ((V.zFar - V.zNear) * i) / nz;
        const y = top + ((bed - top) * j) / ny;
        const t = j / ny;
        const k = wobByT ? t : 1;
        const w = wobble ? 2.4 * fbm2(z * 0.06 + (side > 0 ? 31.7 : 5.1), y * 0.05) * k : 0;
        const zw = wobble ? 1.6 * (noise2(z * 0.11 + 2.3, y * 0.09 + side * 7.7) - 0.5) : 0;
        return [side * (wallHalf + w), y, z + zw];
      },
      (i, j) => {
        const z = V.zNear + ((V.zFar - V.zNear) * i) / nz;
        return rockTint(z / 30, j / ny, 0.15 + 0.85 * (j / ny));
      },
      ROCK_NEAR, frontSide ? side < 0 : false);
  }
  // 两端封口（真源 cap 用 VIADUCT.totalHalf，与槽宽无关 ⇒ 槽比 cap 宽时两端是敞口）
  const nx = 4;
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
  // 谷底（真源只铺到 VIADUCT.totalHalf = 12.6）
  addGrid(out, nx, nz,
    (i, j) => {
      const x = -bedHalf + ((2 * bedHalf) * i) / nx;
      const z = V.zNear + ((V.zFar - V.zNear) * j) / nz;
      return [x, bed + (wobble ? 1.1 * (fbm2(x * 0.09 + 17.3, z * 0.05) - 0.5) : 0), z];
    },
    (i) => rockTint(i / nx, 0.5, 1),
    ROCK_NEAR, false);
  return out;
}

/** 参数化大地（复刻 Road.buildGround 的 4 块 slab，holeHalfX 可调） */
function buildGround(holeHalfX, groundCenter) {
  const holeNear = V.zNear, holeFar = V.zFar;
  const southEdge = groundCenter - 3000, northEdge = groundCenter + 3000;
  const pieces = [];
  const TILE = 6;
  const slab = (w, d, x, z) => {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.translate(x, -0.02, z);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * w) / TILE, (uv.getY(i) * d) / TILE);
    uv.needsUpdate = true;
    return g;
  };
  pieces.push(slab(3000, northEdge - holeNear, 0, (northEdge + holeNear) / 2));
  pieces.push(slab(3000, holeFar - southEdge, 0, (southEdge + holeFar) / 2));
  const sideW = 1500 - holeHalfX;
  for (const side of [-1, 1]) {
    pieces.push(slab(sideW, holeNear - holeFar, side * (holeHalfX + sideW / 2), (holeNear + holeFar) / 2));
  }
  // mergeSafe 等价：这里手工把 4 块合成一个非索引 BufferGeometry
  let vc = 0, ic = 0;
  for (const g of pieces) { const p = g.getAttribute('position'); const ix = g.getIndex(); vc += p.count; ic += ix ? ix.count : p.count; }
  const pos = new Float32Array(vc * 3), uvArr = new Float32Array(vc * 2), nor = new Float32Array(vc * 3), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of pieces) {
    const p = g.getAttribute('position'), u = g.getAttribute('uv'), n = g.getAttribute('normal'), ix = g.getIndex();
    for (let i = 0; i < p.count; i += 1) {
      pos[(vo + i) * 3] = p.getX(i); pos[(vo + i) * 3 + 1] = p.getY(i); pos[(vo + i) * 3 + 2] = p.getZ(i);
      uvArr[(vo + i) * 2] = u.getX(i); uvArr[(vo + i) * 2 + 1] = u.getY(i);
      nor[(vo + i) * 3] = n.getX(i); nor[(vo + i) * 3 + 1] = n.getY(i); nor[(vo + i) * 3 + 2] = n.getZ(i);
    }
    if (ix) for (let i = 0; i < ix.count; i += 1) idx[io + i] = ix.getX(i) + vo;
    else for (let i = 0; i < p.count; i += 1) idx[io + i] = i + vo;
    vo += p.count; io += ix ? ix.count : p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* ── 场景 & 方案切换 ── */
const E = env();
const scene = E.scene;
const ms0 = visibleMeshes(scene);
const groundMesh = ms0.find((m) => m.name === 'ground');
const rockMesh = ms0.find((m) => m.name === 'terrain-rock');
const groundCenter = (260 + -2000) / 2;
const groundMat = matOf(groundMesh.material);
const rockGain = 1.8;
const rockMatCache = {};
function rockMat(side) {
  if (!rockMatCache[side]) {
    rockMatCache[side] = new THREE.MeshLambertMaterial({
      color: new THREE.Color(rockGain, rockGain, rockGain), vertexColors: true, side, fog: true
    });
  }
  return rockMatCache[side];
}

const STATES = {
  A_now: {
    slotHalf: G0, wallHalf: V.totalHalf, capHalf: V.totalHalf, bedHalf: V.totalHalf,
    frontSide: true, wobByT: false, wobble: true,
    label: '现状(真源复刻) 槽18 / 岩壁顶12.6~15 / 封口12.6 / 谷底12.6 / FrontSide'
  },
  B_dside: {
    slotHalf: G0, wallHalf: V.totalHalf, capHalf: V.totalHalf, bedHalf: V.totalHalf,
    frontSide: false, wobByT: false, wobble: true,
    label: 'A + 岩壁改 DoubleSide'
  },
  C_closed: {
    slotHalf: G0, wallHalf: G0, capHalf: G0, bedHalf: G0 + 2,
    frontSide: false, wobByT: true, wobble: true,
    label: 'B + 壁顶/封口/谷底全部对齐槽宽 18（几何闭合）'
  },
  D_valley: {
    slotHalf: G_VALLEY, wallHalf: G_VALLEY, capHalf: G_VALLEY, bedHalf: G_VALLEY + 3,
    frontSide: false, wobByT: true, wobble: true,
    label: 'C + 槽宽 18→70（真山谷：140m 宽 66.5m 深）'
  },
  E_pre42: {
    slotHalf: G_PRE, wallHalf: V.totalHalf, capHalf: V.totalHalf, bedHalf: V.totalHalf,
    frontSide: false, wobByT: false, wobble: true,
    label: 'R42 之前：槽 12.6 + DoubleSide（槽=壁，本来就闭合）'
  }
};

function applyState(st) {
  // ⚠ 必须清掉 worldVerts 缓存，否则换了几何仍用旧世界顶点（首跑实测 A/B 数字完全一样 = 这个坑）
  delete groundMesh.__wv;
  delete rockMesh.__wv;
  groundMesh.geometry = buildGround(st.slotHalf, groundCenter);
  const rock = buildGorge(st);
  rockMesh.geometry = toGeo(rock);
  rockMesh.material = rockMat(st.frontSide ? THREE.FrontSide : THREE.DoubleSide);
  scene.updateMatrixWorld(true);
  return triCountGeo(rockMesh.geometry);
}
function triCountGeo(g) { const i = g.getIndex(); return (i ? i.count : g.getAttribute('position').count) / 3; }

/* ── 机位：用户截图复现档 + QA 档 ── */
const CAMERAS = [
  { name: 'R41pose_right', eye: [12.24, 1.6, 40], tgt: [6, 1, -300], fov: 62 },
  { name: 'R41pose_mirror', eye: [-12.24, 1.6, 40], tgt: [-6, 1, -300], fov: 62 },
  { name: 'deck_in_left', eye: [-10.5, 1.7, -60], tgt: [-17, -14, -150], fov: 62 },
  { name: 'gap_lookdown', eye: [13.5, 2.0, -80], tgt: [16, -30, -120], fov: 62 },
  { name: 'Q_bridge_side_low', eye: [18, 1.2, -120], tgt: [0, -6, -260], fov: 55 },
  { name: 'Q_side_high', eye: [40, 16, -140], tgt: [0, -30, -240], fov: 55 }
];
const W = 360, H = 428;

/** 棕色洞 mask 图：命中几何=浅灰，抬头看天=深蓝，穿过缺口看到天空 uGround=纯红 */
function writeBrownMask(r, mask, w, h, file) {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const k = i * 4;
    if (mask[i]) { o[k] = 255; o[k + 1] = 0; o[k + 2] = 0; }
    else if (r.label[i] >= 0) { o[k] = 150; o[k + 1] = 150; o[k + 2] = 150; }
    else { o[k] = 30; o[k + 1] = 40; o[k + 2] = 70; }
    o[k + 3] = 255;
  }
  fs.writeFileSync(file, encodePNG(w, h, o));
}

const report = { states: {}, cams: CAMERAS.map((c) => c.name) };
for (const [key, st] of Object.entries(STATES)) {
  const tris = applyState(st);
  const ms = visibleMeshes(scene);
  report.states[key] = { label: st.label, slotHalf: st.slotHalf, rockTri: Math.round(tris), runs: {} };
  for (const c of CAMERAS) {
    const cam = makeCam(c.eye, c.tgt, c.fov, W, H);
    const r = raster(ms, cam, W, H);
    // 逐像素视线方向（未命中像素要区分「抬头看天（合法）」与「穿过世界缺口（=棕色墙）」）
    const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const tanY = Math.tan((c.fov * Math.PI) / 360), tanX = tanY * (W / H);
    const dir = new THREE.Vector3();
    let skyUp = 0, holeBrown = 0, leftTot = 0, leftBrown = 0;
    const brownMask = new Uint8Array(W * H);
    for (let py = 0; py < H; py += 1) {
      for (let px = 0; px < W; px += 1) {
        const i = py * W + px;
        const nx = ((px + 0.5) / W) * 2 - 1;
        const ny = 1 - ((py + 0.5) / H) * 2;
        dir.copy(fwd).addScaledVector(right, nx * tanX).addScaledVector(up, ny * tanY).normalize();
        const elev = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        const inLeft = px < W * 0.55;
        if (inLeft) leftTot += 1;
        if (r.label[i] >= 0) continue;
        if (elev > 0) skyUp += 1;
        else if (elev < -0.08) { // 天空 shader h<-0.08 = 纯 uGround 棕
          holeBrown += 1; brownMask[i] = 1;
          if (inLeft) leftBrown += 1;
        }
      }
    }
    const tbl = hitTable(r, W, H, 14, 16, [0, 0, 1, 1]);
    report.states[key].runs[c.name] = {
      brownPct: +(100 * holeBrown / (W * H)).toFixed(1),
      leftBrownPct: +(100 * leftBrown / leftTot).toFixed(1),
      skyUpPct: +(100 * skyUp / (W * H)).toFixed(1),
      top: tbl.lines.slice(0, 5)
    };
    writeLabelPNG(r, W, H, `${OUT}/ab_${key}_${c.name}.png`);
    writeBrownMask(r, brownMask, W, H, `${OUT}/brown_${key}_${c.name}.png`);
  }
  console.log(`\n===== ${key} :: ${st.label} =====`);
  console.log(`  岩壁 tri ${Math.round(tris)}（现状基准 2728）`);
  for (const c of CAMERAS) {
    const x = report.states[key].runs[c.name];
    console.log(`  ${c.name.padEnd(20)} 棕洞 ${String(x.brownPct).padStart(5)}%   左半区棕洞 ${String(x.leftBrownPct).padStart(5)}%   抬头天 ${String(x.skyUpPct).padStart(5)}%`);
    for (const l of x.top) console.log('      ' + l);
  }
}
fs.writeFileSync(`${OUT}/gorge_ab.json`, JSON.stringify(report, null, 1));

/* 恢复现状（避免污染后续脚本） */
applyState(STATES.A_now);
console.log('\nJSON →', `${OUT}/gorge_ab.json`);
