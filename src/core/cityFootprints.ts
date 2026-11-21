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
/** 前排塔基 castleKit.ts:3254 `box(9.4, 1.2, 9.4, depth/2, …)`，depth = 8（:3078）。
 *  区分两个易混量：box 半宽 = 9.4/2 = 4.7（box 在 x/z 各向的半延展）；局部 x 中心 = depth/2 = 4。
 *  ⇒ 局部 x∈[4−4.7, 4+4.7] = [−0.7, 8.7]，z 半延展 = 4.7。
 *  内缘外凸量 = boxW/2 − depth/2 = 4.7 − 4 = 0.7（塔基越过前脸线 0.7 m，R104 修正穿模）。 */
const FRONT_TOWER_BOX_W = 9.4;
const FRONT_TOWER_HALF = FRONT_TOWER_BOX_W / 2; // 4.7（box x/z 半延展）
const FRONT_TOWER_DEPTH = 8; // castleKit.ts:3078 闭包 depth（局部 x 中心 = depth/2 = 4）
const FRONT_TOWER_INSET = FRONT_TOWER_HALF - FRONT_TOWER_DEPTH / 2; // 0.7
const FRONT_TOWER_BASE_INNER = INNER.faceHalf - FRONT_TOWER_INSET; // 14.8（塔基真实可见内缘）
/** 殿台基 castleKit.ts:3152 `box(depth+0.8, …, depth/2+0.4, …)` ⇒ 局部 x∈[0, depth+0.8] ⇒ 世界内缘 = faceHalf */
const HALL_PLINTH_INNER = INNER.faceHalf; // 15.5（R103 修正：原误写 faceHalf−0.4=15.1）
/** 殿前大理石带 castleKit.ts:3156 `box(0.5, 1.2, …, −0.25, …)` ⇒ 局部 x∈[−0.5,0] ⇒ 世界 |x|∈[15.0,15.5] */
const HALL_MARBLE_INNER = INNER.faceHalf - 0.5; // 15.0（R103 修正：原误取中心 faceHalf−0.25=15.25）
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

/* ── R105 · 主殿前排飞扶壁外墩（广场域 z<plazaZ，唯一「非漂移也穿」的缺陷）────────
 * 用户主诉「细致每个建筑底部材料的边界」。主理人全量扫 + 真源核实：主殿正脸前排 3 对递减
 * 飞扶壁（castleKit.ts:2731 `[[13.5,7.0,2.6],[21.5,6.2,2.3],[29.5,5.4,2.0]]`）经
 * `pour(...rotateY(-π/2).translate(side*wx,0,zFront))`（:2742，**直接放置不走 put/faceHalf**）
 * 落到广场 z≈-1294.3，比最南块 k9（zmin=plazaZ=-1285.5）还南 ⇒ 在 2D 激活带
 * [plazaZ,gateBackZ] 之外，且 buildCityFootprints 原无此条目 ⇒ 1D 车缘（广场≈16.5）直穿内墩。
 * 坐标映射（rotateY(-π/2)：世界 x = side·wx − z_local，世界 z = zFront + x_local）：
 *   墩对 castleDetail.ts:342 `pierZs=[-pairGap/2,+pairGap/2]`（local z）⇒ 世界 x = wx ∓ pairGap/2；
 *   墩基座 castleDetail.ts:344 `box(pierW+1.1,0.5,depth+1.1,pierX,…,pz)` ⇒ 世界 x 半宽
 *   = (depth+1.1)/2（local x→世界 z，local z→世界 x）；世界 z = zFront + pierX，
 *   pierX = reach − pierW/2（:337）。仅 wx=13.5 内墩对车可达（外墩 wx≥21.5 内缘>16.5）。 */
/** 主殿正脸 z（castleKit.ts:2123 `zFront = z` = -1300） */
const PLAZA_HALL_FRONT_Z = -1300;
/** 主殿前排飞扶壁：内墩对 wx / reach / pierW / depth / pairGap（castleKit.ts:2731/2741/2738） */
const PLAZA_BUTTRESS_WX = 13.5;
const PLAZA_BUTTRESS_REACH = 7.0;
const PLAZA_BUTTRESS_PIER_W = 2.6;
const PLAZA_BUTTRESS_DEPTH = 1.4;
const PLAZA_BUTTRESS_PAIR_GAP = 3.2;
/** 内墩世界 |x| = wx − pairGap/2（内侧墩，靠路心）；外墩 = wx + pairGap/2 = 15.1（车不可达） */
const PLAZA_BUTTRESS_PIER_CENTER = PLAZA_BUTTRESS_WX - PLAZA_BUTTRESS_PAIR_GAP / 2; // 11.9
/** 基座世界 x 半宽 = (depth+1.1)/2（castleDetail.ts:344 sz=depth+1.1 → rotateY 后世界 x） */
const PLAZA_BUTTRESS_BASE_HALF_X = (PLAZA_BUTTRESS_DEPTH + 1.1) / 2; // 1.25
/** hi-detail 大脚基座额外外扩 0.3（castleDetail.ts:345 `pierW+0.6`/`depth+0.6` 之外的大脚线脚）*/
const PLAZA_BUTTRESS_HI_EXTRA = 0.3;
/** 内墩基座内缘 |x|（取 hi-detail 最外凸级，防 hi 档穿模；low 档 = 10.65 略内 0.225） */
const PLAZA_BUTTRESS_INNER =
  PLAZA_BUTTRESS_PIER_CENTER -
  PLAZA_BUTTRESS_BASE_HALF_X -
  PLAZA_BUTTRESS_HI_EXTRA; // 11.9 - 1.25 - 0.3 = 10.425
/** 内墩世界 z = zFront + pierX，pierX = reach − pierW/2（castleDetail.ts:337） */
const PLAZA_BUTTRESS_Z =
  PLAZA_HALL_FRONT_Z + (PLAZA_BUTTRESS_REACH - PLAZA_BUTTRESS_PIER_W / 2); // -1294.3
/** 基座世界 z 半宽 = (pierW+1.1)/2（castleDetail.ts:344 sx=pierW+1.1 → rotateY 后世界 z） */
const PLAZA_BUTTRESS_Z_HALF = (PLAZA_BUTTRESS_PIER_W + 1.1) / 2; // 1.85
/** 连墙段 z 区间 castleKit.ts:3289-3292（塔→殿 / 殿→塔，避开前后排塔基 z 半延展 4.7 m）：
 *  `[-blockLen/2, -blockLen/4 - 4.7]` / `[blockLen/4 + 4.7, blockLen/2]`（local z）。
 *  飞扶壁墩落在段中点 lz（castleKit.ts:3478-3487 `const lz = (za + zb) / 2`）。 */
const LINK_WALL_SEGS: ReadonlyArray<readonly [number, number]> = [
  [-BLOCK_LEN / 2, -(BLOCK_LEN / 4 + FRONT_TOWER_HALF)],
  [BLOCK_LEN / 4 + FRONT_TOWER_HALF, BLOCK_LEN / 2]
];

/**
 * 由 10 个 keep 块派生全量 2D 占位清单（每次调用新建数组，约 10 块 × 8 件 ≈ 80 条，
 * 单测可直接断言；clampToFootprints 按 z 分桶只取车附近 ~6 条，120 Hz 下 O(N) 可忽略）。
 */
export function buildCityFootprints(): CityFootprint[] {
  const list: CityFootprint[] = [];
  for (let k = 0; k < CITY_BLOCK_Z.length; k += 1) {
    const [zmin, zmax] = CITY_BLOCK_Z[k];
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

    // ④ 前排塔基（每侧 2，局部 z = ±blockLen/4；内缘 = 前脸 − 0.7 = 14.8，外缘 = 前脸 + 8.7 = 24.2）
    for (const sign of [-1, 1] as const) {
      const tz = zc + sign * (BLOCK_LEN / 4);
      list.push({
        xInner: FRONT_TOWER_BASE_INNER,
        xOuter: INNER.faceHalf + FRONT_TOWER_DEPTH / 2 + FRONT_TOWER_HALF, // 15.5 + 4 + 4.7 = 24.2
        zMin: tz - FRONT_TOWER_HALF,
        zMax: tz + FRONT_TOWER_HALF,
        kind: 'frontBase'
      });
    }

    // ⑤ 拱廊柱（每侧 2n = 4，柱位 zc ± (i+0.5)·pitch；AABB 用柱心 ± (colR + 0.1 m 微稳定余量)）
    // R106：colAabbHalf 收到精确 colR（0.3）—— 消除 R104 遗留的 0.1m ghost 触发带（车在柱 z
    //   边缘外 0.1m 仍被误钳到柱内缘 = 周期性 0.1m 空气墙）。车宽 2.006（z 半 1.003）≫ 柱 0.3，
    //   SAT 重叠裕度充足，无边界抖动风险（R104 的 +0.1 余量过保守）。
    const colAabbHalf = ARCADE_COL_R; // 0.3（真源 colR=0.3，castleDetail.ts:1397；精确贴柱无 ghost）
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
    // ⑥b 角塔飞扶壁外墩（hero 块 k<2 only；z 同角塔中心 zc±(half−0.5)，内缘 11.35）。
    //    R103 阶段二启用：块心 1D 已放宽到前脸 14.497 / 殿身 13.997，角塔基座裙 14.9 不再
    //    兜住 11.35 的外墩（车可停在 11.35~14.9 之间）⇒ 必须单列为 2D 占位，否则 hero 块
    //    角塔处穿模。非 hero 块（k≥2）渲染端不建此外墩 ⇒ 不占位（避免假空气墙）。
    if (k < 2) {
      for (const sign of [-1, 1] as const) {
        const cz = zc + sign * (half - CORNER_EDGE_INSET);
        list.push({
          xInner: BUTTRESS_CORNER_INNER,
          xOuter: INNER.faceHalf - R97_CITY_BUTTRESS.cornerReach,
          zMin: cz - BUTTRESS_Z_HALF,
          zMax: cz + BUTTRESS_Z_HALF,
          kind: 'buttressBase'
        });
      }
    }
  }

  // ⑦ 主殿前排飞扶壁内墩（广场域 z<plazaZ，块循环外 —— 主殿不在 CITY_BLOCK_Z 内）。
  //    R105：这是唯一「非漂移态也穿模」的缺陷点（全量扫证实）。内墩基座内缘 10.425，车广场
  //    1D 车缘 ≈16.5 直穿最多 ~3m（hi-detail 大脚）。外墩（wx≥21.5）内缘 >16.5 车不可达 ⇒
  //    不占位（免假空气墙）。占位以 |x| 距离存储（双侧镜像由 clampToFootprints 按车侧处理）。
  //    ⚠ 此 footprint 在 2D 激活带 [plazaZ,gateBackZ] 之外（z≈-1294.3<plazaZ）⇒ 需 FreeDrive
  //    step() 的 2D 门控下界从 plazaZ 扩到 zMin 才会真正被 consult（R105 同步改）。
  list.push({
    xInner: PLAZA_BUTTRESS_INNER,
    xOuter: PLAZA_BUTTRESS_PIER_CENTER + PLAZA_BUTTRESS_BASE_HALF_X,
    zMin: PLAZA_BUTTRESS_Z - PLAZA_BUTTRESS_Z_HALF,
    zMax: PLAZA_BUTTRESS_Z + PLAZA_BUTTRESS_Z_HALF,
    kind: 'buttressBase'
  });

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

/** clampToFootprints 返回：修正后的 x/z（可能等于入参 = 无收紧）、是否收紧、最紧占位盒 kind、外法向 nx/nz */
export interface FootprintClamp {
  x: number;
  /** R113：z 钳位目标（车心 z），无 z 收紧时 = 入参 z */
  z: number;
  hit: boolean;
  kind: CityFootprint['kind'] | null;
  /** 外法向（指向可行驶一侧）：x ≥ 0 时 −1（推向 −x）、x < 0 时 +1 */
  nx: number;
  /** R113：z 外法向（指向可行驶一侧）：车从 +z 逼近（推 +z 离带）时 +1、从 −z 逼近时 −1；无 z 收紧时 0 */
  nz: number;
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
  // R111：车头前向 f=(-sin h,-cos h)、垂直 v=(cos h,-sin h)。车 OBB 半轴：半长 halfL 沿 f、
  // 半宽 halfW 沿 v。任意单位轴 (ax,az) 上的投影半径 = halfL*|(ax,az)·f| + halfW*|(ax,az)·v|
  //   = halfL*|ax*(-s)+az*(-c)| + halfW*|ax*c+az*(-s)|
  //   = halfL*|ax*s+az*c| + halfW*|ax*c-az*s|。
  // ⚠ 旧公式 halfL*|ax*c+az*s| + halfW*|ax*s-az*c| 把半长/半宽配错了轴（cos/sin 交换）：
  //   h=0（车头朝 -Z，车宽沿 X）时 world-x 半径算出 halfL=2.7475（实为半宽 1.003）、world-z
  //   半径算出 halfW=1.003（实为半长 2.7475）⇒ 车长 5.5m 的**前缘已穿入占位盒 ~1.7m**，SAT 却
  //   判「x 轴分离 ⇒ 不相交」⇒ 2D 接触不触发 ⇒ 车持续穿模（R111 探针 6 实测直行穿柱带 1.3m/30帧）。
  //   反过来在近横穿时又**提前**判交（x 半径高估）⇒ 假阳性横推 = 空气墙。本修正让 SAT 用真实
  //   车体半径，判交时机与车体几何一致（前缘触占位盒才判交），穿模与空气墙同时消除。
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
    // 车 OBB 在该轴上的投影半径（R111 修正：半长沿车头 f、半宽沿垂直 v）
    const carR = halfL * Math.abs(ax * s + az * c) + halfW * Math.abs(ax * c - az * s);
    // 占位 AABB 在该轴上的投影半径
    const fpR = fhx * Math.abs(ax) + fhz * Math.abs(az);
    // 两中心在该轴上的距离
    const dist = Math.abs((cx - fcx) * ax + (cz - fcz) * az);
    if (dist > carR + fpR) return false; // 该轴分离 ⇒ 不相交
  }
  return true;
}

/**
 * R113：OBB-vs-AABB 的 MTV（最小平移向量）最小穿透轴判定。
 *
 * 返回 4 条候选轴（世界 x、世界 z、车局部 x、车局部 z）上穿透最浅的轴。若任一轴投影不重叠
 * （overlap ≤ 0）⇒ 已分离，返回 axis='separated'。这是 clampToFootprints 决定「沿 x 还是沿 z
 * 推离」的依据：车头先入占位带（z 覆盖浅、x 覆盖深）时 min 轴 = z（x 单向钳无法解决，必须沿 z
 * 推）；车侧深嵌（x 覆盖浅）时 min 轴 = x（R112 迭代钳解决）；斜插时 min 轴 = 车局部轴。
 */
function obbMtvAxis(
  cx: number,
  cz: number,
  heading: number,
  halfL: number,
  halfW: number,
  f: CityFootprint
): { axis: 'x' | 'z' | 'lx' | 'lz' | 'separated'; depth: number } {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const side = cx < 0 ? -1 : 1;
  const fcx = (side * (f.xInner + f.xOuter)) / 2;
  const fhx = (f.xOuter - f.xInner) / 2;
  const fcz = (f.zMin + f.zMax) / 2;
  const fhz = (f.zMax - f.zMin) / 2;
  const axes: ReadonlyArray<{ axis: 'x' | 'z' | 'lx' | 'lz'; ax: number; az: number }> = [
    { axis: 'x', ax: 1, az: 0 },
    { axis: 'z', ax: 0, az: 1 },
    { axis: 'lx', ax: c, az: -s },
    { axis: 'lz', ax: s, az: c },
  ];
  let min = Infinity;
  let minAxis: 'x' | 'z' | 'lx' | 'lz' = 'x';
  for (const a of axes) {
    const carR = halfL * Math.abs(a.ax * s + a.az * c) + halfW * Math.abs(a.ax * c - a.az * s);
    const fpR = fhx * Math.abs(a.ax) + fhz * Math.abs(a.az);
    const dist = Math.abs((cx - fcx) * a.ax + (cz - fcz) * a.az);
    const overlap = carR + fpR - dist;
    if (overlap <= 0) return { axis: 'separated', depth: 0 };
    if (overlap < min) {
      min = overlap;
      minAxis = a.axis;
    }
  }
  return { axis: minAxis, depth: min };
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
  /* R112：x 钳**迭代复查**。单次 x 钳到最紧界后，车 OBB 可能**重新落入**另一占位盒——
   * 典型案例（r112 诊断 11/16 实测）：入参 x=14.30 时 buttress 恰在 x 轴分离边缘
   * （0.021m 间隙），单次 clamp 只看到 frontBase（bound=12.421），把车推到 12.421 时车 OBB
   * （x 伸展 2dx=4.76m）扫过 buttress 带 [11.35,11.90] 落入其中，车局部横向轴（lx）穿透
   * 1.787m 残留。迭代用 clamp 后位置 cx 复查 SAT：若车 OBB 仍与占位盒相交则继续钳到更紧界
   * （buttress bound=8.971 比 frontBase 12.421 更紧）。实测全量扫 81 万例 maxIters=2 ⇒
   * 上限 4（安全裕度）。FreeDrive 的 WALL_2D_MAX_LATERAL_STEP=0.30m/帧步长上限照旧
   * （车逐步收敛到最终目标，无瞬移）；只收紧不放宽（每次 iterBest < |cx| 才更新）。
   */
  const xClamp = (() => {
    let best = Infinity;
    let kind: CityFootprint['kind'] | null = null;
    let cx = x;
    for (let iter = 0; iter < 4; iter += 1) {
      let iterBest = Infinity;
      let iterKind: CityFootprint['kind'] | null = null;
      for (const f of footprintsNear(z, dz)) {
        // SAT 精确相交测试：车 OBB 真的与占位 AABB 相交才收紧（避免车 z 覆盖碰边即触发的误钳）
        if (!obbOverlapsAabb(cx, z, heading, CAR_HALF_L, CAR_HALF_W, f)) continue;
        const bound = f.xInner - dx;
        if (bound < iterBest) {
          iterBest = bound;
          iterKind = f.kind;
        }
      }
      if (iterBest === Infinity) break; // 无相交占位盒
      if (Math.abs(cx) <= iterBest) break; // 已到最紧界（不再收紧）
      cx = cx >= 0 ? iterBest : -iterBest;
      best = iterBest;
      kind = iterKind;
    }
    return { best, kind };
  })();
  /* R113：z 钳**迭代复查**（正交于 x 钳）。车头先入占位带（如 arcadeCol 柱带 z-深仅 0.6m）
   * 时，x 覆盖深而 z 覆盖浅 ⇒ MTV 最小穿透轴 = 世界 z，x 单向钳无法把车头沿 z 推离（R112
   * 实驶探针 SB 直行穿柱带 0.797m/7帧即此）。此块对「min 轴 = z」的占位盒沿 z 推：车从 +z 逼近
   * （cz ≥ 带心）⇒ 把车心 z 推到 f.zMax + dz（车头恰停在带 +z 外缘，不再穿入）；从 −z 逼近 ⇒
   * 推到 f.zMin − dz（车尾停在带 −z 外缘）。迭代复查防「推 z 后重新落入另一占位盒」（z 方向
   * 占位密集，单次推满会过头，R112 V1/V2 实测恶化 2.70m）。重叠判定用**入参 x**（车当前位置）：
   * x-钳把车推出带 x 范围后车头 z 穿透仍在（车此刻在带 x 内、z 上只推 x 无法消 z），必须用
   * 当前位置才看得到 z 重叠并沿 z 阻挡。车斜插时 x/z 钳都触发，逐帧由 FreeDrive 双轴步长收敛。
   */
  const zClamp = (() => {
    let zLimit = Infinity;
    let zKind: CityFootprint['kind'] | null = null;
    let zDir = 0;
    let cz = z;
    for (let iter = 0; iter < 4; iter += 1) {
      let iterZPos = -Infinity; // +z 最紧界（车头停在带 +z 外缘）
      let iterZNeg = Infinity; // −z 最紧界（车尾停在带 −z 外缘）
      let iterKind: CityFootprint['kind'] | null = null;
      for (const f of footprintsNear(cz, dz)) {
        // ⚠ 用**入参 x**（车当前位置）判定重叠：x-钳已把车推出带 x 范围时，车头 z 穿透仍在
        //   （车此刻在带 x 内、z 上被 x-钳只推 x 无法消 z），必须用当前位置才能看到 z 重叠并沿 z 阻挡。
        if (!obbOverlapsAabb(x, cz, heading, CAR_HALF_L, CAR_HALF_W, f)) continue;
        const m = obbMtvAxis(x, cz, heading, CAR_HALF_L, CAR_HALF_W, f);
        if (m.axis !== 'z') continue; // 只有 z 为最小穿透轴才沿 z 推（x 钳/迭代已处理 x/lx）
        const fcz = (f.zMin + f.zMax) / 2;
        if (cz >= fcz) {
          const zb = f.zMax + dz;
          if (zb > iterZPos) {
            iterZPos = zb;
            iterKind = f.kind;
          }
        } else {
          const zb = f.zMin - dz;
          if (zb < iterZNeg) {
            iterZNeg = zb;
            iterKind = f.kind;
          }
        }
      }
      let moved = false;
      if (iterZPos > -Infinity && cz < iterZPos) {
        cz = iterZPos;
        zLimit = iterZPos;
        zKind = iterKind;
        zDir = 1;
        moved = true;
      }
      if (iterZNeg < Infinity && cz > iterZNeg) {
        cz = iterZNeg;
        zLimit = iterZNeg;
        zKind = iterKind;
        zDir = -1;
        moved = true;
      }
      if (!moved) break;
    }
    return { zLimit, zKind, zDir };
  })();
  const ax = Math.abs(x);
  const xClamped = xClamp.best < Infinity && ax > xClamp.best;
  const zClamped = zClamp.zLimit < Infinity;
  if (!xClamped && !zClamped) {
    return { x, z, hit: false, kind: null, nx: 0, nz: 0 };
  }
  const nx = x >= 0 ? -1 : 1; // x 外法向：指向路内（把车推离占位盒）
  return {
    x: xClamped ? (x >= 0 ? xClamp.best : -xClamp.best) : x,
    z: zClamped ? zClamp.zLimit : z,
    hit: true,
    kind: zClamped ? zClamp.zKind : xClamp.kind,
    nx,
    nz: zClamp.zDir, // z 外法向：+1 = 推向 +z（可行驶侧）、−1 = 推向 −z
  };
}
