/**
 * R31 城堡几何探针（开发线 A · 环境几何）—— high/low 两档 tri / DC / 分桶读数
 *
 * ── 干什么 ──────────────────────────────────────────────────────────────
 * 复用 r29_probe_bundle.mjs 的打包产物（esbuild；**不能用 esbuild CLI**），
 * 对 castle 7 工厂跑 high / low 两档，输出：
 *   · 5 个基础桶 + 4 个可选桶（roof/wood/glass/marble，R31 点亮）的 tri；
 *   · DC = 非空桶数 + 铺装 2（castle.ts 每桶 merge 1 mesh 的整帧口径）；
 *   · 与 R30_BUDGET / R31_BUDGET 的对照（超线即 exit 1，供 tester 线接断言）。
 *
 * 用法：
 *   node tools/r31_castle_probe.mjs [--budget]
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
  setDetailLevel
} from './r29_probe_bundle.mjs';

const BASE = ['ashlar', 'wall', 'gold', 'dark', 'flame'];
const EXTRA = ['roof', 'wood', 'glass', 'marble'];
const FACTORIES = [
  ['makeViaduct', makeViaduct],
  ['makeParapet', makeParapet],
  ['makeLamps', makeLamps],
  ['makeGate', makeGate],
  ['makeTowerGroup', makeTowerGroup],
  ['makeInnerCity', makeInnerCity],
  ['makeMainHall', makeMainHall]
];

/** R30/R31 预算（与 r28Layout.ts 同源手抄 —— 探针在 node 侧，r28Layout 是 TS） */
const R30_BUDGET = { castleTriLow: 200_000, castleTriHigh: 260_000, castleDc: 20, frameTri: 360_000 };
const R31_BUDGET = { castleTriLow: 250_000, castleTriHigh: 359_000, castleDc: 20, frameTri: 465_000 };

function triCount(geo) {
  const idx = geo.getIndex();
  const pos = geo.getAttribute('position');
  return (idx ? idx.count : pos ? pos.count : 0) / 3;
}

function measure(low) {
  setDetailLevel(low);
  const perBucket = {};
  for (const k of [...BASE, ...EXTRA]) perBucket[k] = 0;
  const perFactory = {};
  let geoms = 0;
  for (const [name, fn] of FACTORIES) {
    const b = fn();
    let t = 0;
    for (const k of [...BASE, ...EXTRA]) {
      const list = b[k] || [];
      for (const g of list) {
        const n = triCount(g);
        perBucket[k] += n;
        t += n;
        geoms += 1;
      }
    }
    perFactory[name] = t;
  }
  const pave = makePaving();
  const paveTri = triCount(pave.road) + triCount(pave.walk);
  const castleTri = Object.values(perBucket).reduce((a, c) => a + c, 0);
  const dcBuckets = [...BASE, ...EXTRA].filter((k) => perBucket[k] > 0).length;
  return { low, perBucket, perFactory, paveTri, castleTri, total: castleTri + paveTri, dc: dcBuckets + 2, geoms };
}

const f1 = (v) => Math.round(v).toLocaleString('en-US');
const pad = (s, n) => String(s).padEnd(n);

for (const low of [false, true]) {
  const m = measure(low);
  const budget = low ? R31_BUDGET.castleTriLow : R31_BUDGET.castleTriHigh;
  console.log(`=== R31 castle 探针 · ${low ? 'low' : 'high'} 档 ===`);
  for (const k of [...BASE, ...EXTRA]) {
    if (m.perBucket[k] > 0 || !EXTRA.includes(k)) {
      console.log(`  ${pad(k, 8)} ${f1(m.perBucket[k])}`);
    }
  }
  console.log(`  ${pad('pave', 8)} ${f1(m.paveTri)}`);
  console.log(`  castle   ${f1(m.castleTri)}  (预算 ${f1(budget)} ${m.castleTri <= budget ? '✅' : '❌ 超线'})`);
  console.log(`  TOTAL    ${f1(m.total)}`);
  console.log(`  DC       ${m.dc}  (预算 ${R31_BUDGET.castleDc} ${m.dc <= R31_BUDGET.castleDc ? '✅' : '❌'})`);
  console.log(`  几何条数 ${m.geoms}`);
  console.log('  分工厂: ' + FACTORIES.map(([n]) => `${n} ${f1(m.perFactory[n])}`).join('  '));
  console.log('');
}

// 预算断言模式（tester 线接 CI 用）
if (process.argv.includes('--budget')) {
  const hi = measure(false);
  const lo = measure(true);
  const ok =
    hi.castleTri <= R31_BUDGET.castleTriHigh &&
    lo.castleTri <= R31_BUDGET.castleTriLow &&
    hi.dc <= R31_BUDGET.castleDc;
  console.log(`PROBE_RESULT high=${Math.round(hi.castleTri)} low=${Math.round(lo.castleTri)} dc=${hi.dc} ok=${ok}`);
  process.exit(ok ? 0 : 1);
}

// bbox 模式：分桶世界包围盒（铁律 19 —— 任何朝向/尺寸假设必须运行时实证）
if (process.argv.includes('--bbox')) {
  setDetailLevel(false);
  for (const [name, fn] of FACTORIES) {
    const b = fn();
    console.log(`--- ${name} ---`);
    for (const k of [...BASE, ...EXTRA]) {
      const list = b[k] || [];
      if (!list.length) continue;
      let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
      for (const g of list) {
        if (!g.boundingBox) g.computeBoundingBox();
        const q = g.boundingBox;
        minX = Math.min(minX, q.min.x); minY = Math.min(minY, q.min.y); minZ = Math.min(minZ, q.min.z);
        maxX = Math.max(maxX, q.max.x); maxY = Math.max(maxY, q.max.y); maxZ = Math.max(maxZ, q.max.z);
      }
      console.log(
        `  ${k.padEnd(7)} x[${minX.toFixed(1)},${maxX.toFixed(1)}] y[${minY.toFixed(1)},${maxY.toFixed(1)}] z[${minZ.toFixed(1)},${maxZ.toFixed(1)}] n=${list.length}`
      );
    }
  }
}
