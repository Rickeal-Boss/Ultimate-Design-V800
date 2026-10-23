/**
 * R29 行车走廊侵入探针（开发线 A · 环境几何）
 *
 * ── 干什么 ──────────────────────────────────────────────────────────────
 * 遍历 castleKit 每个工厂产出的**每一条** bucket 几何，逐三角形做
 * 「三角形 × 走廊长方体」SAT 相交测试（13 轴分离轴），筛出真正侵入行车走廊的
 * 条目并打印。
 *
 * ⚠ 为什么不用 bbox：拱券类几何（archWall/archBand/archPlate）的 bbox 横跨整洞
 *   （y 从 0 到 44），但实体只在拱曲线**上方**——bbox 会把开放门洞误报成封断。
 *   逐三角形 SAT 才是几何真值。bbox 只做第一道粗筛。
 *
 * 走廊定义（主理人下发的铁律）：
 *     |x| ≤ 8（车宽 2m + 余量）  y ∈ [0, 4.5]（车高 1.85 + 余量）
 *     z ∈ [−1300, 60]（起步点 → 主殿正面）
 * 主殿正面撞击面是**设计内的撞击目标**，白名单掉 z < −1298。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node tools/r29_probe_build.mjs        # 打包（改了 castleKit 必跑）
 *   node tools/r29_corridor_probe.mjs     # 全区间扫描
 *   node tools/r29_corridor_probe.mjs --gate   # 只扫门洞带 z∈[−372,−345]
 *   node tools/r29_corridor_probe.mjs --wide   # 街面开廊 |x|≤15.5（查视觉遮挡）
 *
 * ── 口径 ────────────────────────────────────────────────────────────────
 * tri = 三角面数（已装配口径，index 优先）；DC = 非空 bucket 数（castle.ts
 * 每族 merge 成 1 mesh）+ 铺装 2 = 场景口径（脚本里单列）。
 */
import {
  makeViaduct,
  makeParapet,
  makeLamps,
  makeGate,
  makeTowerGroup,
  makeInnerCity,
  makeMainHall,
  makePaving,
  setDetailLevel,
  Terrain
} from './r29_probe_bundle.mjs';
import * as THREE from 'three';

/* ── 走廊 ── */
const CORR = { xHalf: 8, yMin: 0, yMax: 4.5, zNear: 60, zFar: -1300 };
/** 主殿正面撞击面：设计内撞击目标，不算侵入 */
const HALL_Z = -1298;

const GATE_BAND = { zNear: -345, zFar: -372 };

const FACTORIES = [
  ['makeViaduct', makeViaduct],
  ['makeParapet', makeParapet],
  ['makeLamps', makeLamps],
  ['makeGate', makeGate],
  ['makeTowerGroup', makeTowerGroup],
  ['makeInnerCity', makeInnerCity],
  ['makeMainHall', makeMainHall]
];
const BUCKETS = ['ashlar', 'wall', 'gold', 'dark', 'flame'];

/** 相交判定留 1cm 余量：贴面/共面不算侵入（桥面顶 y=0、铺装 y=0.012 等） */
const EPS = 0.01;

function triCount(geo) {
  const idx = geo.getIndex();
  const pos = geo.getAttribute('position');
  return (idx ? idx.count : pos ? pos.count : 0) / 3;
}

function bounds(geo) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox;
  return { minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z };
}

/* ═══ 三角形 × AABB（SAT，13 轴）═══ */
/* 走廊盒：中心 c=(0, (yMin+yMax)/2, (zNear+zFar)/2)，半宽 h=(xHalf, yHalf, zHalf) */
let CX, CY, CZ, HX, HY, HZ;

function initCorridorBox() {
  CX = 0;
  CY = (CORR.yMin + CORR.yMax) / 2;
  CZ = (CORR.zNear + CORR.zFar) / 2;
  HX = CORR.xHalf;
  HY = (CORR.yMax - CORR.yMin) / 2;
  HZ = (CORR.zNear - CORR.zFar) / 2;
}

/** 投影：三角 3 顶点（已减盒心）区间 vs 盒 [-r, r]（r = Σ|axis|·h） */
function axisOverlap(ax, ay, az, v) {
  const r = Math.abs(ax) * HX + Math.abs(ay) * HY + Math.abs(az) * HZ;
  let tmin = Infinity;
  let tmax = -Infinity;
  for (let i = 0; i < 3; i += 1) {
    const p = ax * v[i * 3] + ay * v[i * 3 + 1] + az * v[i * 3 + 2];
    if (p < tmin) tmin = p;
    if (p > tmax) tmax = p;
  }
  return tmin < r - EPS && tmax > -r + EPS;
}

/** 顶点为世界坐标（未减盒心）。返回 true = 相交走廊盒 */
function triInCorridor(x0, y0, z0, x1, y1, z1, x2, y2, z2) {
  // 顶点相对盒心
  const v = new Float64Array(9);
  v[0] = x0 - CX; v[1] = y0 - CY; v[2] = z0 - CZ;
  v[3] = x1 - CX; v[4] = y1 - CY; v[5] = z1 - CZ;
  v[6] = x2 - CX; v[7] = y2 - CY; v[8] = z2 - CZ;
  // 盒三轴（同时是 AABB 快速剔除）
  if (!axisOverlap(1, 0, 0, v)) return false;
  if (!axisOverlap(0, 1, 0, v)) return false;
  if (!axisOverlap(0, 0, 1, v)) return false;
  // 边
  const e0x = v[3] - v[0], e0y = v[4] - v[1], e0z = v[5] - v[2];
  const e1x = v[6] - v[3], e1y = v[7] - v[4], e1z = v[8] - v[5];
  const e2x = v[0] - v[6], e2y = v[1] - v[7], e2z = v[2] - v[8];
  // 三角形法线轴
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  const nl = Math.hypot(nx, ny, nz);
  if (nl > 1e-12 && !axisOverlap(nx / nl, ny / nl, nz / nl, v)) return false;
  // 9 个 e_i × f_j 轴
  const EX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const EDGES = [[e0x, e0y, e0z], [e1x, e1y, e1z], [e2x, e2y, e2z]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const f = EDGES[j];
      const ax = EX[i][1] * f[2] - EX[i][2] * f[1];
      const ay = EX[i][2] * f[0] - EX[i][0] * f[2];
      const az = EX[i][0] * f[1] - EX[i][1] * f[0];
      const l = Math.hypot(ax, ay, az);
      if (l < 1e-9) continue; // 退化轴（共线），其它轴已覆盖
      if (!axisOverlap(ax / l, ay / l, az / l, v)) return false;
    }
  }
  return true;
}

/** 逐三角形扫一条几何：返回落入走廊的三角数 */
function scanGeometry(geo) {
  const pos = geo.getAttribute('position');
  if (!pos) return 0;
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const hits = [];
  for (let t = 0; t < n; t += 3) {
    const a = idx ? idx.getX(t) : t;
    const b2 = idx ? idx.getX(t + 1) : t + 1;
    const c = idx ? idx.getX(t + 2) : t + 2;
    if (
      triInCorridor(
        pos.getX(a), pos.getY(a), pos.getZ(a),
        pos.getX(b2), pos.getY(b2), pos.getZ(b2),
        pos.getX(c), pos.getY(c), pos.getZ(c)
      )
    ) {
      hits.push(t / 3);
      if (hits.length >= 3) break; // 记 3 个就够判定
    }
  }
  return hits.length;
}

const f3 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2);

function main() {
  const args = process.argv.slice(2);
  const gateOnly = args.includes('--gate');
  const wide = args.includes('--wide');
  const yMaxArg = args.find((a) => a.startsWith('--yMax='));
  if (yMaxArg) CORR.yMax = Number(yMaxArg.split('=')[1]) || CORR.yMax;
  if (wide) CORR.xHalf = 15.5; // 街面开廊（视觉遮挡排查档）
  initCorridorBox();
  setDetailLevel(false); // high 档口径（几何长度与 low 一致，只降装饰段数）

  const hits = [];
  const stats = { tris: 0, perBucket: {}, perFactory: {}, geoms: 0, triScan: 0 };
  for (const k of BUCKETS) stats.perBucket[k] = 0;

  for (const [name, fn] of FACTORIES) {
    const b = fn();
    let fTri = 0;
    for (const k of BUCKETS) {
      const list = b[k] || [];
      for (let i = 0; i < list.length; i += 1) {
        const geo = list[i];
        const t = triCount(geo);
        fTri += t;
        stats.perBucket[k] += t;
        stats.geoms += 1;
        const bb = bounds(geo);
        // bbox 粗筛（严格重叠，再交给 SAT 精判）
        const rough =
          bb.minX < CORR.xHalf && bb.maxX > -CORR.xHalf &&
          bb.minY < CORR.yMax && bb.maxY > CORR.yMin &&
          bb.minZ < CORR.zNear && bb.maxZ > CORR.zFar;
        if (!rough) continue;
        // 白名单：主殿正面撞击面（z < −1298）
        if (bb.minZ < HALL_Z) continue;
        if (gateOnly && !(bb.minZ < GATE_BAND.zNear && bb.maxZ > GATE_BAND.zFar)) continue;
        stats.triScan += 1;
        const nTri = scanGeometry(geo);
        if (nTri > 0) {
          hits.push({ factory: name, bucket: k, index: i, bb, tris: t, nTri });
        }
      }
    }
    stats.perFactory[name] = fTri;
    stats.tris += fTri;
  }

  // 铺装（PavingKit，不在 StoneBuckets 里，单独统计）
  const pave = makePaving();
  const paveTri = triCount(pave.road) + triCount(pave.walk);

  /* ── Terrain（castleKit 之外的地形线，只读诊断）：远景岩环是否横穿走廊 ──
   * R28 把远景环半径内收到 1600/1200（环心=原点）。r=1200 的环在 x=0 处落在
   * z=−1200 —— 正好横在城内大街上、主殿前方 100m。这里实例化 Terrain 拿真实
   * 几何做同一套 SAT 判定，给主理人硬数字（Terrain.ts 不在本线白名单内）。 */
  let terrainHits = 0;
  let terrainTri = 0;
  if (!gateOnly) {
    const dummy = new THREE.Scene();
    new Terrain(dummy);
    dummy.traverse((o) => {
      const mesh = o;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry;
      terrainTri += triCount(geo);
      const bb = bounds(geo);
      const rough =
        bb.minX < CORR.xHalf && bb.maxX > -CORR.xHalf &&
        bb.minY < CORR.yMax && bb.maxY > CORR.yMin &&
        bb.minZ < CORR.zNear && bb.maxZ > CORR.zFar;
      if (!rough) return;
      if (scanGeometry(geo) > 0) terrainHits += 1;
      console.log(
        `[terrain] ${mesh.name}  x[${f3(bb.minX)},${f3(bb.maxX)}] y[${f3(bb.minY)},${f3(bb.maxY)}] z[${f3(bb.minZ)},${f3(bb.maxZ)}]`
      );
    });
  }

  const totalTri = stats.tris + paveTri;
  const dcStones = BUCKETS.filter((k) => stats.perBucket[k] > 0).length;
  const dc = dcStones + 2; // pave-road / pave-walk

  console.log('=== R29 走廊侵入探针（逐三角形 SAT） ===');
  console.log(`走廊: |x|<=${CORR.xHalf}  y∈[${CORR.yMin},${CORR.yMax}]  z∈[${CORR.zFar},${CORR.zNear}]  白名单 z<${HALL_Z}`);
  console.log(`模式: ${gateOnly ? '门洞带 z∈[' + GATE_BAND.zFar + ',' + GATE_BAND.zNear + ']' : wide ? '街面开廊（视觉遮挡档）' : '全区间'}`);
  console.log('');
  if (hits.length === 0) {
    console.log('侵入条目 0  ✅');
  } else {
    console.log(`侵入条目 ${hits.length}  ❌`);
    console.log('factory            bucket  idx  hitTri  x[min,max]          y[min,max]          z[min,max]           tris');
    for (const h of hits) {
      const b = h.bb;
      console.log(
        `${h.factory.padEnd(18)} ${h.bucket.padEnd(7)} ${String(h.index).padStart(3)}  ${String(h.nTri).padStart(5)}  ` +
          `[${f3(b.minX)},${f3(b.maxX)}]  [${f3(b.minY)},${f3(b.maxY)}]  [${f3(b.minZ)},${f3(b.maxZ)}]  ${h.tris}`
      );
    }
  }
  console.log('');
  console.log(`（bbox 粗筛命中 ${stats.triScan} 条 → SAT 精判命中 ${hits.length} 条）`);
  console.log(`[terrain] 侵入条目 ${terrainHits}（tri ${Math.round(terrainTri)}，castleKit 之外 · 只读诊断）`);
  console.log('');
  console.log('--- tri / DC（high 档，已装配口径）---');
  for (const k of BUCKETS) console.log(`  ${k.padEnd(7)} ${Math.round(stats.perBucket[k])}`);
  console.log(`  pave    ${Math.round(paveTri)}`);
  console.log(`  TOTAL   ${Math.round(totalTri)}  (castle 7 工厂 ${Math.round(stats.tris)} + 铺装 ${Math.round(paveTri)})`);
  console.log(`  DC      ${dc}  (石材族 ${dcStones} + 铺装 2)`);
  console.log(`  几何条数 ${stats.geoms}`);
  console.log('');
  console.log('--- 分工厂 tri ---');
  for (const [name] of FACTORIES) console.log(`  ${name.padEnd(16)} ${Math.round(stats.perFactory[name])}`);
  console.log('');
  console.log(`PROBE_RESULT intrusions=${hits.length} tris=${Math.round(totalTri)} dc=${dc}`);
}

main();
