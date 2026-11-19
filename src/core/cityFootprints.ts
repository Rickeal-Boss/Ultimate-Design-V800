/**
 * R102 · 城内「台阶/基座/柱础」2D 占位清单（地面层 y ≤ 1.85，纯数值模块）。
 *
 * 为什么单独建文件：`FreeDrive.resolveBounds` 是「1D 车心沿 x 钳位」，只用车心一个点
 * 采样 `corridorCenterHalfWidth(z)`，从未检查车长 5.495 m（半长 2.7475）×车宽 2.006 m
 * （半宽 1.003）的 bbox，heading 也不进钳位。车斜插 θ=30° 时车角 dx=2.243 m，
 * 比车半宽大 1.24 m —— 块角 14.9 m 基座内缘处车角嵌基座 1.24 m、柱位 11.12 m 处嵌柱 1.12 m
 * （probe-bounds §3）。v1 方案在**不改**既有 1D 钳位的前提下，叠加一层「车 OBB vs
 * 地面实体 AABB」的 2D 收紧，专门治「存在的建筑又穿模 / 车尾卡台阶缝隙」。
 *
 * **纯数值模块红线**：禁止 import three / DOM / 任何有副作用的渲染模块 —— FreeDrive
 * 在无 DOM 的 vitest 单测里被 import，本模块随之被加载，引 THREE 即报错。
 * 全部几何由现有真源派生（INNER / TOWER / R30_ARCADE / R97_CITY_BUTTRESS / VEHICLE +
 * FreeDrive 已有的 CITY_BLOCK_Z），禁写死 14.9 / 11.12 / 11.35 等派生值。
 *
 * 占位口径：put()（castleKit.ts:3143）把局部 box 经 `translate(side·faceHalf, 0, zc)`
 * 落到世界（side=−1 时再 rotateY(π)，x 镜像）⇒ 世界 |x| 只看局部 x 的绝对值 + faceHalf，
 * z 覆盖 = 块心 zc ± 局部 z 半宽。故每个占位盒只需 { xInner, xOuter, zMin, zMax }，
 * 双侧镜像在 clampToFootprints 里按 |x| 处理。
 */
import { VEHICLE } from '../config/physics';
import { INNER, TOWER } from '../render/scene/r28Layout';
import { R30_ARCADE, R97_CITY_BUTTRESS } from '../render/scene/castleKit';
import { CITY_BLOCK_Z } from './FreeDrive';

/** 单个地面层占位盒（世界坐标；|x| 对称，xInner = 靠路中心一侧） */
export interface CityFootprint {
  /** 内缘 |x|（> 0；车 OBB x 伸展不得越过此线） */
  xInner: number;
  /** 外缘 |x|（仅供调试 / 未来阶段二用，v1 clamp 只读 xInner） */
  xOuter: number;
  zMin: number;
  zMax: number;
  kind: 'cornerBase' | 'frontBase' | 'hallBase' | 'frontWall' | 'arcadeCol' | 'buttressBase';
}

/** 车长 / 车宽半尺寸（physics.ts 真源，勿写死 2.7475 / 1.003） */
const CAR_HALF_L = VEHICLE.lengthM / 2;
const CAR_HALF_W = VEHICLE.widthM / 2;

/* ── 真源派生（与 FreeDrive 的派生公式逐位一致，但**独立重算**以避免耦合私有常量）── */
/** 角塔进深 castleKit.ts:330 `R30_CORNER.d = 5`（私有常量，真源不可 import，按几何等价取值） */
const CORNER_D = 5;
/** 角塔大理石基座裙单侧外扩 castleKit.ts:3381 `ctw + 1.2`（ctw 与塔身相消，只剩 1.2） */
const CORNER_MARBLE_SKIRT = 1.2;
/** 角塔基座内缘 = faceHalf − 裙/2（castleKit.ts:3381，R99 同源） */
const CORNER_BASE_INNER = INNER.faceHalf - CORNER_MARBLE_SKIRT / 2; // 14.9
/** 角塔中心相对块端内偏 castleKit.ts:3461 `blockLen / 2 − 0.5` */
const CORNER_EDGE_INSET = 0.5;
/** 前排塔基 castleKit.ts:3254 `box(9.4, 1.2, 9.4, depth/2, …)`，depth = 8（:3078）⇒ 局部 x∈[0,4.7] */
const FRONT_TOWER_DEPTH = 4.7;
const FRONT_TOWER_BASE_INNER = INNER.faceHalf; // 15.5（塔基不越前脸）
/** 殿台基 castleKit.ts:3152 `box(depth+0.8, …, depth/2+0.4, …)` ⇒ 局部 x∈[−0.4, depth+0.4] */
const HALL_PLINTH_INNER = INNER.faceHalf - 0.4; // 15.1
/** 殿前大理石带 castleKit.ts:3156 `box(0.5, 1.2, …, −0.25, …)` ⇒ 世界 |x|∈[15.25, 15.75] */
const HALL_MARBLE_INNER = INNER.faceHalf - 0.25; // 15.25
/** 建筑前脸 / 连墙内缘（ castleKit.ts:4121-4131 / :3158） */
const FRONT_WALL_INNER = INNER.faceHalf; // 15.5
/** 拱廊柱内缘（FreeDrive.ARCADE_COL_INNER 同源公式；R30_ARCADE:307 + castleDetail:1397/1410） */
const ARCADE_COL_R = 0.3;
const ARCADE_COL_OFFSET = 0.12;
const ARCADE_TRANSLATE = 1.0;
const ARCADE_COL_INNER =
  INNER.faceHalf - R30_ARCADE.width - ARCADE_TRANSLATE + ARCADE_COL_OFFSET; // 11.12
/** 单侧柱数 n = floor(len/2/pitch)，len = blockLen−2（castleKit.ts:3468） */
const BLOCK_LEN = INNER.blockLen;
const ARCADE_COL_COUNT = Math.floor((BLOCK_LEN - 2) / 2 / R30_ARCADE.pitch);
/** 飞扶壁外墩两级基座 castleDetail.ts:344 `box(pierW+1.1, 0.5, depth+1.1, pierX, …)`
 *  内缘 = faceHalf − (reach − pierW/2) − (pierW+1.1)/2 = faceHalf − reach − 0.55（pierW 抵消） */
const BUTTRESS_LINK_INNER = INNER.faceHalf - R97_CITY_BUTTRESS.linkReach - 0.55; // 11.35
const BUTTRESS_CORNER_INNER = INNER.faceHalf - R97_CITY_BUTTRESS.cornerReach - 0.55; // 11.35
/** 飞扶壁基座 z 半宽 = (depth+1.1)/2，castleDetail `depth:1.0`（castleKit.ts:3453/3487） */
const BUTTRESS_DEPTH = 1.0;
const BUTTRESS_Z_HALF = (BUTTRESS_DEPTH + 1.1) / 2; // 1.05
/** 殿身半宽（r28Layout.TOWER.hallW / 2 = 6.25，殿台基 / 大理石带 z 覆盖用） */
const HALL_HALF = TOWER.hallW / 2;
/** 连墙段 z 区间 castleKit.ts:3289-3292（塔→殿 / 殿→塔，避开前后排塔基 4.7 m 深度）：
 *  `[-blockLen/2, -blockLen/4 - 4.7]` / `[blockLen/4 + 4.7, blockLen/2]`（local z）。
 *  飞扶壁墩落在段中点 lz（castleKit.ts:3478-3487 `const lz = (za + zb) / 2`）。 */
const LINK_WALL_SEGS: ReadonlyArray<readonly [number, number]> = [
  [-BLOCK_LEN / 2, -(BLOCK_LEN / 4 + FRONT_TOWER_DEPTH)],
  [BLOCK_LEN / 4 + FRONT_TOWER_DEPTH, BLOCK_LEN / 2]
];

/**
 * 由 10 个 keep 块派生全量 2D 占位清单（每次调用新建数组，约 10 块 × 8 件 ≈ 80 条，
 * 单测可直接断言；clampToFootprints 按 z 分桶只取车附近 ~6 条，120 Hz 下 O(N) 可忽略）。
 */
export function buildCityFootprints(): CityFootprint[] {
  const list: CityFootprint[] = [];
  for (const [zmin, zmax] of CITY_BLOCK_Z) {
    const zc = (zmin + zmax) / 2;
    const half = (zmax - zmin) / 2; // 23

    // ① 建筑前脸连墙（整块 46 m 连续；殿身 hallW 也落在 |x| = faceHalf 线内）
    list.push({
      xInner: FRONT_WALL_INNER,
      xOuter: FRONT_WALL_INNER + 8,
      zMin: zmin,
      zMax: zmax,
      kind: 'frontWall'
    });

    // ② 殿台基 / 殿前大理石带（殿身 zc ± hallW/2 范围，地面层 y ≤ 1.5）
    list.push({
      xInner: HALL_PLINTH_INNER,
      xOuter: INNER.faceHalf + 8.4,
      zMin: zc - HALL_HALF - 0.7,
      zMax: zc + HALL_HALF + 0.7,
      kind: 'hallBase'
    });
    list.push({
      xInner: HALL_MARBLE_INNER,
      xOuter: HALL_MARBLE_INNER + 0.5,
      zMin: zc - HALL_HALF - 0.6,
      zMax: zc + HALL_HALF + 0.6,
      kind: 'hallBase'
    });

    // ③ 街区角塔大理石基座裙（每块 2 座，块端内偏 0.5，伸出块端 reach − 0.5 = 2.6 m）
    const cornerZHalf = (CORNER_D + CORNER_MARBLE_SKIRT) / 2; // 3.1
    for (const sign of [-1, 1] as const) {
      const cz = zc + sign * (half - CORNER_EDGE_INSET);
      list.push({
        xInner: CORNER_BASE_INNER,
        xOuter: INNER.faceHalf + 8 + CORNER_MARBLE_SKIRT,
        zMin: cz - cornerZHalf,
        zMax: cz + cornerZHalf,
        kind: 'cornerBase'
      });
    }

    // ④ 前排塔基（每侧 2，局部 z = ±blockLen/4，内缘 = 前脸 15.5）
    for (const sign of [-1, 1] as const) {
      const tz = zc + sign * (BLOCK_LEN / 4);
      list.push({
        xInner: FRONT_TOWER_BASE_INNER,
        xOuter: FRONT_TOWER_BASE_INNER + FRONT_TOWER_DEPTH,
        zMin: tz - FRONT_TOWER_DEPTH,
        zMax: tz + FRONT_TOWER_DEPTH,
        kind: 'frontBase'
      });
    }

    // ⑤ 拱廊柱（每侧 2n = 4，柱位 zc ± (i+0.5)·pitch；AABB 用柱心 ± (colR + 0.6 m 缓冲))
    const colAabbHalf = ARCADE_COL_R + 0.6;
    for (let i = 0; i < ARCADE_COL_COUNT; i += 1) {
      const offset = (i + 0.5) * R30_ARCADE.pitch;
      for (const sign of [-1, 1] as const) {
        const pz = zc + sign * offset;
        list.push({
          xInner: ARCADE_COL_INNER,
          xOuter: ARCADE_COL_INNER + R30_ARCADE.width,
          zMin: pz - colAabbHalf,
          zMax: pz + colAabbHalf,
          kind: 'arcadeCol'
        });
      }
    }

    // ⑥ 连墙飞扶壁外墩（每连墙段 1 座，落在段中点 lz；两级基座 z 半宽 1.05）
    for (const [za, zb] of LINK_WALL_SEGS) {
      if (zb - za <= 1) continue;
      const lz = zc + (za + zb) / 2;
      list.push({
        xInner: BUTTRESS_LINK_INNER,
        xOuter: INNER.faceHalf - R97_CITY_BUTTRESS.linkReach,
        zMin: lz - BUTTRESS_Z_HALF,
        zMax: lz + BUTTRESS_Z_HALF,
        kind: 'buttressBase'
      });
    }
    // ⑥b 角塔飞扶壁外墩（hero 块 only；z 同角塔中心，内缘 11.35 比基座 14.9 靠内得多
    //     ⇒ 基座裙 14.9 已挡车，v1 不单列避免双计；若未来放宽 1D 钳位再启用）
    void BUTTRESS_CORNER_INNER;
  }
  return list;
}

/** 城内 2D 占位清单（模块级缓存，与 CITY_BLOCK_Z 同为只读派生） */
let CACHED: CityFootprint[] | null = null;
/** 取缓存清单（首访构建，供 clampToFootprints / 单测共用） */
export function getCityFootprints(): readonly CityFootprint[] {
  if (!CACHED) CACHED = buildCityFootprints();
  return CACHED;
}

/** 车长 bbox 与 z 覆盖重叠的占位盒收集（车 z 半伸展 dz 由 heading 决定） */
export function footprintsNear(
  z: number,
  dz: number
): CityFootprint[] {
  const out: CityFootprint[] = [];
  const zlo = z - dz;
  const zhi = z + dz;
  for (const f of getCityFootprints()) {
    if (f.zMax < zlo || f.zMin > zhi) continue;
    out.push(f);
  }
  return out;
}

/** clampToFootprints 返回：修正后的 x（可能等于入参 = 无收紧）、是否收紧、最紧占位盒 kind、外法向 nx */
export interface FootprintClamp {
  x: number;
  hit: boolean;
  kind: CityFootprint['kind'] | null;
  /** 外法向（指向可行驶一侧）：x ≥ 0 时 −1（推向 −x）、x < 0 时 +1 */
  nx: number;
}

/**
 * 纯函数：车 OBB（4 角点）与城内占位 AABB 做 SAT（分离轴定理）相交测试。
 *
 * 4 条候选分离轴：世界 x、世界 z、车 OBB 局部 x 轴 (cos h, −sin h)、局部 z 轴 (sin h, cos h)
 * （OBB vs AABB 的 SAT 只需这两组轴；任一轴上投影不重叠 ⇒ 不相交）。世界 x 轴上的
 * 分离判据直接给出 x 方向的最紧钳位 |x| ≤ xInner − dx(θ)。
 */
function obbOverlapsAabb(
  cx: number,
  cz: number,
  heading: number,
  halfL: number,
  halfW: number,
  f: CityFootprint
): boolean {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const axes: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [0, 1],
    [c, -s],
    [s, c]
  ];
  // 占位清单以 |x| 存储（正值 = 距路中心距离，双侧镜像）。按车所在侧把占位盒**镜像**到
  // 车那一侧再判交：cx<0 ⇒ 占位盒中心 x 取负。否则 −X 半城的车永远对不上 +X 占位盒，
  // SAT 判「不相交」⇒ −X 侧 2D 收紧整段失效（车从左侧穿模）。
  const side = cx < 0 ? -1 : 1;
  const fcx = side * (f.xInner + f.xOuter) / 2;
  const fhx = (f.xOuter - f.xInner) / 2;
  const fcz = (f.zMin + f.zMax) / 2;
  const fhz = (f.zMax - f.zMin) / 2;
  for (const [ax, az] of axes) {
    // 车 OBB 在该轴上的投影半径
    const carR = halfL * Math.abs(ax * c + az * s) + halfW * Math.abs(ax * s - az * c);
    // 占位 AABB 在该轴上的投影半径
    const fpR = fhx * Math.abs(ax) + fhz * Math.abs(az);
    // 两中心在该轴上的距离
    const dist = Math.abs((cx - fcx) * ax + (cz - fcz) * az);
    if (dist > carR + fpR) return false; // 该轴分离 ⇒ 不相交
  }
  return true;
}

/**
 * 纯函数：把车 OBB 的 x 伸展钳到「不与城内 2D 占位相交」的最紧界（只收紧，不放宽）。
 *
 * dx(θ) = 半长·|sinθ| + 半宽·|cosθ| 是车 OBB 4 角点相对车心的 x 最大伸展
 * （heading=0 时车头朝 −Z，前向 (−sin h, −cos h)，车长沿 z、车宽沿 x ⇒ dx(0)=半宽）。
 * 对所有与车 OBB 做 SAT 相交的占位盒取 |x| ≤ xInner − dx(θ) 的最紧界。
 *
 * ⚠ 只收紧不放宽：调用方在 resolveBounds 之后 step() 里调用本函数，入参 x 已经是
 * 1D 车心钳位结果，本函数只会把它进一步往路中心拉，绝不外推 ⇒ CameraRig 与 r97/r98/r99/r100
 * 全部 1D 护栏在几何上不会破（新钳位只会更紧，不会更松）。
 */
export function clampToFootprints(
  x: number,
  z: number,
  heading: number
): FootprintClamp {
  const dx = CAR_HALF_L * Math.abs(Math.sin(heading)) + CAR_HALF_W * Math.abs(Math.cos(heading));
  const dz = CAR_HALF_L * Math.abs(Math.cos(heading)) + CAR_HALF_W * Math.abs(Math.sin(heading));
  const limit = /* 最紧界，Infinity 表示无占位盒 */ (() => {
    let best = Infinity;
    let kind: CityFootprint['kind'] | null = null;
    for (const f of footprintsNear(z, dz)) {
      // SAT 精确相交测试：车 OBB 真的与占位 AABB 相交才收紧（避免车 z 覆盖碰边即触发的误钳）
      if (!obbOverlapsAabb(x, z, heading, CAR_HALF_L, CAR_HALF_W, f)) continue;
      const bound = f.xInner - dx;
      if (bound < best) {
        best = bound;
        kind = f.kind;
      }
    }
    return { best, kind };
  })();
  const ax = Math.abs(x);
  if (ax <= limit.best) {
    return { x, hit: false, kind: null, nx: 0 };
  }
  const nx = x >= 0 ? -1 : 1; // 外法向：指向路内（把车推离占位盒）
  return { x: -nx * limit.best, hit: true, kind: limit.kind, nx };
}
