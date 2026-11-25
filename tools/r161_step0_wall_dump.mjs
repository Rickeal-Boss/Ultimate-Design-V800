/**
 * R161 Step0 · P0 段可见墙 mesh world bbox dump（定擦墙划痕痕迹表面）
 *
 * 只读探针：复用 r29_probe_bundle.mjs（esbuild 打包，城堡工厂几何为**世界坐标**，
 * 见 r29_corridor_probe.mjs:101「顶点为世界坐标」）。遍历每条 bucket 几何
 * computeBoundingBox，筛出「可行驶侧 |x|∈[8,16] 且 y∈[0,2.2]」的车高连续墙体，
 * 按 P0 段分组输出 minX/maxX/minY/maxY/minZ/maxZ，供定「可行驶侧可见面」。
 *
 * 用法：node tools/r161_step0_wall_dump.mjs
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

// R161 P0 段 z 区间（FreeDrive.ts BOUNDS 同源）
const SEGMENTS = [
  ['御桥段', -351.5, 70],
  ['城门带', -365.5, -351.5],
  ['主殿广场', -1297, -1285.5]
];
// 城内块区（CITY_BLOCK_Z FreeDrive.ts:433-444）
const BLOCKS = [
  [-411.5, -365.5], [-457.5, -411.5], [-503.5, -457.5], [-549.5, -503.5],
  [-687.5, -641.5], [-779.5, -733.5], [-917.5, -871.5], [-1055.5, -1009.5],
  [-1147.5, -1101.5], [-1285.5, -1239.5]
];

const FACTORIES = [
  ['makeViaduct', makeViaduct],
  ['makeParapet', makeParapet],
  ['makeLamps', makeLamps],
  ['makeGate', makeGate],
  ['makeTowerGroup', makeTowerGroup],
  ['makeInnerCity', makeInnerCity],
  ['makeMainHall', makeMainHall],
  ['makePaving', makePaving]
];
const BUCKETS = ['ashlar', 'wall', 'gold', 'dark', 'flame', 'roof', 'wood', 'glass', 'marble'];

function bounds(geo) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = geo.boundingBox;
  return { minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z };
}

function triCount(geo) {
  const idx = geo.getIndex();
  const pos = geo.getAttribute('position');
  return (idx ? idx.count : pos ? pos.count : 0) / 3;
}

// 收集全部几何（world bbox）
setDetailLevel(false); // high 档
const items = [];
for (const [fname, fn] of FACTORIES) {
  const b = fn();
  for (const k of BUCKETS) {
    const list = b[k] || [];
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const bb = bounds(g);
      items.push({ f: fname, k, i, ...bb, tri: triCount(g) });
    }
  }
}
console.log(`total geometries: ${items.length}`);

// 可行驶侧可见墙：|x| 与 [8,16] 相交、y∈[0,2.2]（车高 1.85+余量）
const wallFilter = (bb) =>
  bb.maxX > 8 && bb.minX < 16 && bb.minY < 2.2 && bb.maxY > 0.2;

function reportSegment(name, zMin, zMax) {
  console.log(`\n===== ${name}  z∈[${zMin},${zMax}] =====`);
  const hits = items
    .filter((it) => it.minZ < zMax && it.maxZ > zMin && wallFilter(it))
    .sort((a, b2) => a.minX - b2.minX); // 可行驶侧内表面 = 最小 minX（正侧）先出
  const seen = new Set();
  for (const it of hits) {
    // 归一化：只报正侧（x 对称）
    if (it.maxX <= 0 && it.minX >= 0) continue;
    const key = `${it.f}.${it.k}.${it.minX.toFixed(1)}.${it.maxX.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(
      `  ${it.f}.${it.k}#${it.i}  x[${it.minX.toFixed(2)},${it.maxX.toFixed(2)}]` +
      `  y[${it.minY.toFixed(2)},${it.maxY.toFixed(2)}]  z[${it.minZ.toFixed(2)},${it.maxZ.toFixed(2)}]  tri=${it.tri}`
    );
  }
}

for (const [name, zMin, zMax] of SEGMENTS) reportSegment(name, zMin, zMax);
for (let bi = 0; bi < BLOCKS.length; bi++) {
  const [zMin, zMax] = BLOCKS[bi];
  reportSegment(`城内块区${bi}`, zMin, zMax);
}
