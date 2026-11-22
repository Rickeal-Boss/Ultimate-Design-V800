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
import { GATE, HALL_BRAZIER, INNER, MAIN_HALL, ROAD_HALF, TOWER } from '../render/scene/r28Layout';
import { R30_ARCADE, R97_CITY_BUTTRESS, R89_CITY_TRIM_ON, R30_CROSSINGS, R32_CORRIDOR } from '../render/scene/castleKit';
// R119 改 a：导入 corridorCenterHalfWidth（1D 车心面线走廊）供近侧界防护①比较。
//   ⚠ 反向 import 即成环（FreeDrive.ts:37 已 import 本模块）；与 CITY_BLOCK_Z 同风格：
//   corridorCenterHalfWidth 是函数声明（提升），仅在 clampToFootprints 函数体内惰性访问 ⇒ 安全。
// R120：加 WALL_2D_MAX_LATERAL_STEP（arcadeCol 柱带 xPen 特判，见 L753）——同样惰性访问，
//   CITY_BLOCK_Z / WALL_2D_MAX_LATERAL_STEP 均只在函数体内引用（const 不提升，不可顶层用）。
import { CITY_BLOCK_Z, corridorCenterHalfWidth, WALL_2D_MAX_LATERAL_STEP } from './FreeDrive';

/** 单个地面层占位盒（世界坐标；|x| 对称，xInner = 靠路中心一侧） */
export interface CityFootprint {
  /** 内缘 |x|（> 0；车 OBB x 伸展不得越过此线） */
  xInner: number;
  /** 外缘 |x|（仅供调试 / 未来阶段二用，v1 clamp 只读 xInner） */
  xOuter: number;
  zMin: number;
  zMax: number;
  kind:
    | 'cornerBase'
    | 'frontBase'
    | 'hallBase'
    | 'frontWall'
    | 'arcadeCol'
    | 'buttressBase'
    | 'gatePier'
    | 'doorLeaf';
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
/** 内墩世界 |x| = wx − pairGap/2（内侧墩，靠路心）= 11.9；外墩 = wx + pairGap/2 = 15.1（R122 起由 OUTER_EDGE 覆盖） */
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
/** 外墩基座外缘 |x|（wx + pairGap/2 + 基座半宽 + 大脚）——R122：外墩车可达（车心限 14.497、
 *  车右缘 15.5 > 外墩内缘 13.55），R105「车不可达不占位」判定对 wx=13.5 失效（probe-B：外墩纯
 *  视觉无 footprint，x=14.4 穿外墩 1.55m / x=12.0 近侧推 14.153 嵌外墩 1.31m，clamp 完全不激活）
 *  ⇒ 延展覆盖整墩对（0.7m 缝隙车 OBB 2.006m 无法嵌入，AABB 并集语义正确）。 */
const PLAZA_BUTTRESS_OUTER_EDGE =
  PLAZA_BUTTRESS_WX +
  PLAZA_BUTTRESS_PAIR_GAP / 2 + // 外墩世界 |x| 15.1
  PLAZA_BUTTRESS_BASE_HALF_X + // 基座半宽 1.25
  PLAZA_BUTTRESS_HI_EXTRA; // 大脚 0.3 ⇒ 16.65
/** 内墩世界 z = zFront + pierX，pierX = reach − pierW/2（castleDetail.ts:337） */
const PLAZA_BUTTRESS_Z =
  PLAZA_HALL_FRONT_Z + (PLAZA_BUTTRESS_REACH - PLAZA_BUTTRESS_PIER_W / 2); // -1294.3
/** 基座世界 z 半宽 = (pierW+1.1)/2（castleDetail.ts:344 sx=pierW+1.1 → rotateY 后世界 z） */
const PLAZA_BUTTRESS_Z_HALF = (PLAZA_BUTTRESS_PIER_W + 1.1) / 2; // 1.85

/* ── R123 · 跨街连廊承托柱 + 墙根/街面火盆 2D 占位（探针-B 缺口）────────────
 * 承托柱（castleKit.ts:4190-4192）：R89_CITY_TRIM_ON 时最近跨街 z 两端柱
 *   `box('ashlar',1.8,11.75,4.4, sx*9.6, ..., nearestCrossing)`，世界 |x|∈[8.7,10.5]
 *   z∈[nearestCrossing±2.2]。nearestCrossing = Math.max(R30_CROSSINGS,
 *   R32_CORRIDOR.extraCrossings)（与 castleKit:4184-4188 同派生，禁写死 −427.5）。
 * 火盆（castleKit.ts:4048-4060）：`box('ashlar',0.9/0.85,0.8,0.9,−0.7,..,bz)` 世界
 *   |x| = 前脸 15.5 − 0.7 探出 ± 半宽 = [14.35,15.25]，z = 块心 zc + bz（bz∈{−21,8}
 *   墙根 / −11 街面偶块）。y[0,0.8] 车高 1.85 ⇒ 车可撞。 */
const GALLERY_COL_CENTER_X = 9.6; // castleKit:4191 sx*9.6
const GALLERY_COL_HALF_X = 1.8 / 2; // 0.9（box 宽 1.8）
const GALLERY_COL_HALF_Z = 4.4 / 2; // 2.2（box 深 4.4）
const FIRE_BASIN_INNER = INNER.faceHalf - 0.7 - 0.45; // 前脸 15.5 − 探出 0.7 − 半宽 0.45 = 14.35
const FIRE_BASIN_OUTER = INNER.faceHalf - 0.7 + 0.45; // 15.25
const FIRE_BASIN_HALF_Z = 0.9 / 2; // 0.45（box 深 0.9）
const FIRE_BASIN_Z_OFFSETS = [
  -(INNER.blockLen / 2 - 2), // −21 墙根（castleKit:4048）
  8, // +8 墙根
  -(INNER.blockLen / 2 - 12) // −11 街面（castleKit:4056，偶块）
] as const;
const FIRE_BASIN_STREET_Z = FIRE_BASIN_Z_OFFSETS[2]; // −11

/* ── R118 · 城门带门墩 2D 占位（Fix 1）───────────────────────────────────────
 * 城门带（z ∈ [gateBackZ, gateFrontZ] = [−365.5, −351.5]）门墩实体 |x| ∈ [openHalf, halfW]。
 * 根治：1D `corridorCenterHalfWidth` 在 gateFrontZ（桥 10.997 → 隧 8.997）/ gateBackZ
 * （隧 8.997 → 块0 角塔带 13.897）硬阶跃 ⇒ 单帧横移 = 空气墙 + 瞬态穿模（探针 A/C/D）。
 * 2D 门墩 footprint 让 clampToFootprints 在门带接管：7 帧收敛替代 1 帧 2m/4.9m 瞬时。
 * 真源派生禁写死：openHalf = GATE.openW/2 = 10、门墩外缘 = GATE.halfW = 17.5；
 * z 区间 = 城门脸 GATE.z+GATE.depth/2 = −351.5（BOUNDS.gateFrontZ 同源）/ 门带后沿
 * INNER.zNear = −365.5（BOUNDS.gateBackZ 同源）。⚠ 不 import FreeDrive BOUNDS
 * （FreeDrive.ts:37 已 import 本模块 ⇒ 反向 import 即成环；与 ARCADE_COL / BUTTRESS
 * 常量同风格：真源派生而非反向 import）。 */
/** 门墩内缘 |x|（= 门洞净半宽，makeGate openHalf = openW/2 = 10） */
const GATE_PIER_INNER = GATE.openW / 2; // 10
/** 门墩外缘 |x|（= 门楼半宽，含塔墩，halfW = 17.5） */
const GATE_PIER_OUTER = GATE.halfW; // 17.5
/**
 * 门墩带 z 区间（R119 改 b：**footprint = 塔基实体 z 范围**，非扩 CAR_HALF_L）。
 * 原区间 [gateBackZ, gateFrontZ] = [−365.5, −351.5] 只覆盖门墩（塔身）实体；但门楼塔基（台基）
 * 实体 z∈[−366.1, −350.9]（castleKit makeGate `box(towerW,1.0,depth+1.2,…)` L1351，zMid=GATE.z，
 * 半深 = (depth+1.2)/2 = 7.6）比门带各超 0.6m ⇒ 原 footprint 漏掉塔基 0.6m（车头/车尾入塔基漏网）。
 * 故 footprint z 区间改为 = 塔基实体范围（南北各超门带 0.6m）：
 *   zMin = GATE.z − (depth+1.2)/2 = −358.5 − 7.6 = −366.1（塔基南界）；
 *   zMax = GATE.z + (depth+1.2)/2 = −358.5 + 7.6 = −350.9（塔基北界）。
 * ⚠ 不扩 CAR_HALF_L：clampToFootprints 的 SAT 判交（车 OBB ↔ footprint AABB）已自动覆盖「车心在
 * 带外、车头/车尾已入塔基实体」的车（车 OBB z 伸展与 footprint 重叠即触发），无需把 footprint
 * 扩到实体之外；若扩 CAR_HALF_L（zMin→−368.2475 / zMax→−348.7525）会让 footprint 大于实体，
 * 车 OBB 与 footprint 相交而**与塔基实体不相交**（如块 0 北缘 x≥10 合法位车心 z∈[−368.25,−365.5]）
 * 时被 gatePier 误钳（实测 r110 场景 clamp(12.0,−368.9) 被硬拉到 8.997，单帧 2.006m）。
 * xInner/xOuter（10/17.5）不变（门墩实体 |x| 区间）。⚠ 此 z 区间在 FreeDrive step() 2D 激活域
 * [zMin, gateFrontZ+CAR_HALF_L]（fix-1 北扩）内：车心 nz ≤ gateFrontZ+CAR_HALF_L 才 consult。
 */
const GATE_PIER_Z_MIN = GATE.z - (GATE.depth + 1.2) / 2; // −366.1（塔基南界，门带南超 0.6m）
const GATE_PIER_Z_MAX = GATE.z + (GATE.depth + 1.2) / 2; // −350.9（塔基北界，门带北超 0.6m）

/* ── R124 · 门洞门扇（castleKit.ts:1328-1333，doorLeaf({w:8,h:7}) rotateY(∓π/2)
 *   translate(side*9.2, 0, zFront−4)）───────────────────────────────────────────
 * 门扇折靠门洞侧墙，世界 AABB（castleDetail.ts:1346-1379 真源派生）：
 *   框柱厚 0.4 → x ∈ [9.2−0.2, 9.2+0.2] = [9.0, 9.4]；
 *   w=8 → 框柱外缘 w/2+0.22 = 4.22 → z ∈ [(zFront−4)−4.22, (zFront−4)+4.22]。
 * 门扇在洞内 |x| < openHalf(=GATE.openW/2=10)，gatePier xInner=10 不覆盖 ⇒ 车心 1D 隧限
 * 8.997 时车缘 10.0 穿门扇 ~1.0m（探针-A2 实证，clamp 激活域内无 footprint hit=false 残留）。
 * 补 doorLeaf footprint（xInner=9.0 贴门扇内缘，车缘 9.0 恰贴门不穿；恒远侧推 + isSolidEntryKind
 * 恒平滑防单帧瞬移）。⚠ 不扩 CAR_HALF_L：SAT 判交（车 OBB↔footprint AABB）自动覆盖「车心在
 * 带外、车头已入门扇实体」的车；z 区间在 2D 激活带 [zMin, gateFrontZ+CAR_HALF_L] 内，不改
 * FreeDrive 门控（R118 Fix 2 已把 2D 上界扩到 gateFrontZ+CAR_HALF_L）。 */
const DOOR_LEAF_X_INNER = 9.2 - 0.2; // 9.0（门扇内缘 = 框柱内面）
const DOOR_LEAF_X_OUTER = 9.2 + 0.2; // 9.4（门扇外缘）
const DOOR_LEAF_Z_MIN = GATE.z + GATE.depth / 2 - 4 - 4.22; // zFront−8.22 = −359.72（门南沿）
const DOOR_LEAF_Z_MAX = GATE.z + GATE.depth / 2 - 4 + 4.22; // zFront+0.22 = −351.28（门北沿）

/* ── R138 · 门楼飞扶壁双墩（御桥段 z>gateFrontZ，桥段 1D 限不挡墩）──────────
 * 门楼飞扶壁（castleKit.ts:1544-1558 `flyingButtress({reach:6,depth:1.1,pierW:1.7,
 * pairGap:2.4}).rotateY(-π/2).translate(±10.1,0,zFront)`）双墩立御桥段 z≈−346.35
 * （门楼前脸之前步道位）。御桥段 1D 限车心 10.997（车缘 12.0 贴桥沿）不挡墩：外墩
 * 世界 |x|∈[10.2,12.4]，车贴桥沿经过穿外墩最多 1.8m —— R125 defer「桥段 2D 红线」。
 * 坐标映射（R105 同式，rotateY(−π/2)：世界 x = ±10.1 − z_local，世界 z = zFront + x_local）：
 *   墩对 pierZs=[−pairGap/2,+pairGap/2] ⇒ 世界 |x| = 10.1 ± pairGap/2（内墩 8.9 / 外墩 11.3）；
 *   基座 box(pierW+1.1,0.5,depth+1.1) ⇒ 世界 x 半宽 (depth+1.1)/2=1.1、z 半宽 (pierW+1.1)/2=1.4；
 *   墩心 z = zFront + (reach−pierW/2) = −351.5+5.15 = −346.35。
 *   ⚠ 门楼飞扶壁调用**无 detail**（castleKit.ts:1544-1557 未传 detail）⇒ 无 R42-P1-D+
 *   hi 大脚，基座最宽 = 第一级（pierW+1.1 × depth+1.1），无需 HI_EXTRA。
 *   内墩 [7.8,10.0] / 外墩 [10.2,12.4] 间 0.2m 缝隙 < 车宽 2.006 ⇒ 车不可只占缝隙；
 *   但**不做 AABB 并集**（并集 [7.8,12.4] 会让贴桥沿车（x=10.997）单帧推回 4.2m=空气墙，
 *   R110 教训），拆两条独立 footprint ⇒ 贴桥沿车穿外墩 1.8m 单帧推回（R115/R117 收敛
 *   瞬态语义，接受）。kind=buttressBase（实体无洞类 ⇒ isSolidEntryKind 恒平滑）。
 *   ⚠ footprint z∈[−347.75,−344.95] 在 2D 激活带上界（GATE_PIER_Z_MAX+CAR_HALF_L=−348.1525）
 *   之外 ⇒ 需 FreeDrive 激活域上界扩到 GATE_FLY_Z_MAX+CAR_HALF_L=−342.2025（R138 同步改）。 */
const GATE_FRONT_Z = GATE.z + GATE.depth / 2; // −351.5（门楼前脸，castleKit zFront 同源）
const GATE_FLY_WX = 10.1; // castleKit.ts:1558 translate(side*10.1,…)
const GATE_FLY_REACH = 6; // :1548
const GATE_FLY_DEPTH = 1.1; // :1549
const GATE_FLY_PIER_W = 1.7; // :1551
const GATE_FLY_PAIR_GAP = 2.4; // :1555
const GATE_FLY_INNER_CENTER = GATE_FLY_WX - GATE_FLY_PAIR_GAP / 2; // 8.9（内墩世界 |x|）
const GATE_FLY_OUTER_CENTER = GATE_FLY_WX + GATE_FLY_PAIR_GAP / 2; // 11.3（外墩世界 |x|）
const GATE_FLY_BASE_HALF_X = (GATE_FLY_DEPTH + 1.1) / 2; // 1.1（world x 半宽，depth 轴转世界 x）
const GATE_FLY_BASE_HALF_Z = (GATE_FLY_PIER_W + 1.1) / 2; // 1.4（world z 半宽，pierW 轴转世界 z）
const GATE_FLY_Z = GATE_FRONT_Z + (GATE_FLY_REACH - GATE_FLY_PIER_W / 2); // −346.35（墩心 z）
const GATE_FLY_INNER_X_INNER = GATE_FLY_INNER_CENTER - GATE_FLY_BASE_HALF_X; // 7.8（内墩内缘）
const GATE_FLY_INNER_X_OUTER = GATE_FLY_INNER_CENTER + GATE_FLY_BASE_HALF_X; // 10.0（内墩外缘）
const GATE_FLY_OUTER_X_INNER = GATE_FLY_OUTER_CENTER - GATE_FLY_BASE_HALF_X; // 10.2（外墩内缘）
const GATE_FLY_OUTER_X_OUTER = GATE_FLY_OUTER_CENTER + GATE_FLY_BASE_HALF_X; // 12.4（外墩外缘）
const GATE_FLY_Z_MIN = GATE_FLY_Z - GATE_FLY_BASE_HALF_Z; // −347.75（墩带南界）
/** 墩带 z 上界（导出供 FreeDrive 激活域上界派生；z 半宽 = (pierW+1.1)/2） */
export const GATE_FLY_Z_MAX = GATE_FLY_Z + GATE_FLY_BASE_HALF_Z; // −344.95（墩带北界）
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

    // ⑤ 拱廊柱（每侧 2n = 4，柱位 zc ± (i+0.5)·pitch；AABB 用柱心 ± colR = 柱圆柱的包围盒）
    // R106：colAabbHalf 收到精确 colR（0.3）—— 消除 R104 遗留的 0.1m ghost 触发带（车在柱 z
    //   边缘外 0.1m 仍被误钳到柱内缘 = 周期性 0.1m 空气墙）。车宽 2.006（z 半 1.003）≫ 柱 0.3，
    //   SAT 重叠裕度充足，无边界抖动风险（R104 的 +0.1 余量过保守）。
    // R114：colAabbXOuter 从「柱带结构外缘 14.62」收到「柱圆柱包围盒 11.72」（柱心 11.42 + colR）。
    //   原 AABB x 深 3.5m 把柱子后方空廊（x∈[11.72,14.62]）也包进来 —— 车斜插车角进空廊
    //   （SAT 判交但车缘距柱心 > colR，真没碰柱）被误挡 = 空气墙（违反 R100「看不见空隙不挡」，
    //   R114 探针实测 maxAir 2~3m）。收窄后柱带占位 = 柱圆柱包围盒，车进空廊不再挡（空气墙消），
    //   真碰柱（车缘进 [11.12,11.72]）仍挡（防穿柱）。
    const colAabbHalf = ARCADE_COL_R; // 0.3（真源 colR=0.3，castleDetail.ts:1397；精确贴柱无 ghost）
    const colAabbXOuter = ARCADE_COL_INNER + 2 * ARCADE_COL_R; // 11.72 = 柱心 11.42 + colR
    for (let i = 0; i < ARCADE_COL_COUNT; i += 1) {
      const offset = (i + 0.5) * R30_ARCADE.pitch;
      for (const sign of [-1, 1] as const) {
        const pz = zc + sign * offset;
        list.push({
          xInner: ARCADE_COL_INNER,
          xOuter: colAabbXOuter,
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

  // ⑥c R121：10 个缺块（R99 补街殿身/连墙，前脸严格 |x| = INNER.faceHalf）—— R102 建表只认
  //   采样块 CITY_BLOCK_Z，从未同步 R99 补的缺块实体（castleKit.ts:4086-4137 只 b.ashlar/wall.push
  //   视觉几何，不注册 footprint）⇒ 空档中段斜插 θ=30° 车角穿补墙 1.24m / θ=60° 穿 1.88m，
  //   clamp 完全不激活（probe-A/D 交叉证实真穿模）。补 frontWall footprint（kind 复用 ①，
  //   xInner/xOuter 同 ①）。缺块判定 = 块区间 [zNear−(k+1)·blockLen, zNear−k·blockLen] 不在
  //   CITY_BLOCK_Z 中（INNER 真源派生，禁写死 −549.5/−1239.5 等 z 值）。
  //   ⚠ 不改 FreeDrive 门控：缺块 z∈[−1239.5,−549.5] 已在 2D 激活带
  //   [BOUNDS.zMin, GATE_PIER_Z_MAX+CAR_HALF_L] 内（SAT 判交自动覆盖车角入补墙，无需扩带）。
  // R122（probe-C 维护性）：cityBlockTotal 由 INNER.zFar 真源派生（r28Layout.ts:434，与
  //   CITY_BLOCK_Z 末项 zmin 同值 −1285.5，无功能变化）——原式依赖 CITY_BLOCK_Z 末项 = 块
  //   k=total−1 的隐含假设，若 keep 集合变化导致末块≠k19 会算错 frontWall 数（漏补/多补 =
  //   新穿模/新空气墙）。920/46=20 整除精确，舍入无风险。
  const cityBlockTotal = Math.round(
    (INNER.zNear - INNER.zFar) / INNER.blockLen
  );
  for (let k = 0; k < cityBlockTotal; k += 1) {
    const gapZmin = INNER.zNear - (k + 1) * INNER.blockLen;
    const kept = CITY_BLOCK_Z.some(([zm]) => Math.abs(zm - gapZmin) < 1e-6);
    if (kept) continue;
    list.push({
      xInner: FRONT_WALL_INNER,
      xOuter: FRONT_WALL_INNER + 8,
      zMin: gapZmin,
      zMax: gapZmin + INNER.blockLen,
      kind: 'frontWall'
    });
  }

  // ⑥d R123：跨街连廊承托柱（castleKit.ts:4190-4192，R89_CITY_TRIM_ON 时最近跨街 z 两端
  //   柱 `box('ashlar',1.8,11.75,4.4, sx*9.6, ..., nearestCrossing)`）。探针-B 实证：柱实体
  //   |x|∈[8.7,10.5] z∈[−429.7,−425.3]（nearestCrossing=Math.max(R30_CROSSINGS,
  //   extraCrossings)=−427.5，块 k=1 内）纯视觉无 footprint，1D 车心限 14.497 放行车心 9.6 ⇒
  //   车穿柱 1.8m 且 clamp 完全不激活（hit=false）。补 buttressBase（结构性墩，近/远侧推 +
  //   R123 fix-1 全 sinH 平滑）。⚠ 仅 R89_CITY_TRIM_ON（默认 true，`#r89city=off` 关闭）时
  //   柱才建 ⇒ footprint 需同门控，否则 `#r89city=off` 出空气墙。nearestCrossing 用与
  //   castleKit:4184-4188 相同的「最近跨街」派生（R30_CROSSINGS 与 extraCrossings 合并取 max，
  //   禁写死 −427.5）。z 带 −429.7..−425.3 已在 2D 激活带内，不改 FreeDrive 门控。 */
  if (R89_CITY_TRIM_ON) {
    const nearestCrossing = Math.max(
      ...R30_CROSSINGS,
      ...R32_CORRIDOR.extraCrossings
    );
    list.push({
      xInner: GALLERY_COL_CENTER_X - GALLERY_COL_HALF_X,
      xOuter: GALLERY_COL_CENTER_X + GALLERY_COL_HALF_X,
      zMin: nearestCrossing - GALLERY_COL_HALF_Z,
      zMax: nearestCrossing + GALLERY_COL_HALF_Z,
      kind: 'buttressBase'
    });
  }

  // ⑥e R123：墙根/街面火盆（castleKit.ts:4048-4060，`box('ashlar',0.9/0.85,..,−0.7,..,bz)`）。
  //   探针-B 实证：盆实体 |x|∈[14.35,15.25]（= 前脸 15.5 − 0.7 探出 ± 半宽），z = 块心 zc +
  //   bz（bz∈{−blockLen/2+2, 8} 墙根 / −blockLen/2+12 街面 k%2==0），y[0,0.8] 车高 1.85 ⇒ 车可撞，
  //   纯视觉无 footprint ⇒ 车贴墙缘（1D 车缘 14.9~15.5）穿盆 0.45~0.55m 且 clamp 不激活。
  //   补 frontWall（贴墙突出物，车心恒 < 盆心 14.8 ⇒ 恒远侧推 14.35−dx，近侧不需）。逐采样块
  //   （缺块 R99 补街不生成火盆）按 bz 推。kind 复用 frontWall ⇒ 近/远侧 + isEntryKind 行为同墙。
  //   ⚠ 盆 xInner=14.35 < 相邻墙/基座 footprint（15.0/15.5）⇒ 盆为最紧界，车贴墙时先被盆钳
  //   （车缘 14.35 = 盆内缘，不穿盆），正确（盆是真实突出实体）。 */
  for (const [k, [bzMin, bzMax]] of CITY_BLOCK_Z.entries()) {
    const zc = (bzMin + bzMax) / 2;
    for (const bz of FIRE_BASIN_Z_OFFSETS) {
      if (bz === FIRE_BASIN_STREET_Z && k % 2 !== 0) continue; // 街面盆仅偶块（castleKit:4055）
      list.push({
        xInner: FIRE_BASIN_INNER,
        xOuter: FIRE_BASIN_OUTER,
        zMin: zc + bz - FIRE_BASIN_HALF_Z,
        zMax: zc + bz + FIRE_BASIN_HALF_Z,
        kind: 'frontWall'
      });
    }
  }

  // ⑦ 主殿前排飞扶壁墩对（广场域 z<plazaZ，块循环外 —— 主殿不在 CITY_BLOCK_Z 内）。
  //    R105：内墩基座内缘 10.425，车广场 1D 车缘 ≈16.5 直穿最多 ~3m（hi-detail 大脚）⇒ 占位。
  //    R122：probe-B 证实外墩（wx+pairGap/2=15.1，实体 x[13.85,16.35]）车可达 —— 车心限 14.497、
  //    车右缘 15.5 > 外墩内缘 13.55，R105「车不可达不占位」判定对 wx=13.5 失效（外墩纯视觉
  //    无 footprint，x=14.4 穿外墩 1.55m / x=12.0 近侧推 14.153 嵌外墩 1.31m，clamp 完全不激活）。
  //    ⇒ xOuter 延展到 OUTER_EDGE（16.65）覆盖整墩对：z-钳在墩对北脸统一接管（0.7m 缝隙车
  //    OBB 2.006m 无法嵌入，AABB 并集语义正确）；wx≥21.5 外墩 x>18.65 仍车不可达 ⇒ 不占位（免
  //    假空气墙）。占位以 |x| 距离存储（双侧镜像由 clampToFootprints 按车侧处理）。
  //    ⚠ 此 footprint 在 2D 激活带 [plazaZ,gateBackZ] 之外（z≈-1294.3<plazaZ）⇒ 需 FreeDrive
  //    step() 的 2D 门控下界从 plazaZ 扩到 zMin 才会真正被 consult（R105 同步改）。
  list.push({
    xInner: PLAZA_BUTTRESS_INNER,
    xOuter: PLAZA_BUTTRESS_OUTER_EDGE,
    zMin: PLAZA_BUTTRESS_Z - PLAZA_BUTTRESS_Z_HALF,
    zMax: PLAZA_BUTTRESS_Z + PLAZA_BUTTRESS_Z_HALF,
    kind: 'buttressBase'
  });

  // ⑦b 主殿前广场列阵火盆（makeMainHall ⑪ 列阵，块循环外 —— 主殿不在 CITY_BLOCK_Z 内）。
  //    R125 探针（全域残余缺口扫描 + clamp 决定性复核）实证：内列 |x|=ROAD_HALF+arrayInset=8.9、
  //    外列 |x|=ROAD_HALF+arrayInset+1.6=10.5（z 自 plazaNear+3.5 起节拍 arrayPitch=5）共 4 座/侧
  //    （2 内 + 2 外，交错 z），底座 box 0.9×0.8×0.9 在车高（y∈[0,0.95]），纯视觉无 footprint ⇒
  //    车心 1D 14.497/13.997（车缘 15.5/15.0）直穿火盆最多 ~0.99m（probe @(x=8.40,z=-1278.5)）。
  //    ⇒ 补 4 条占位（正 |x|，双侧镜像由 clampToFootprints 按车侧处理）。kind=buttressBase（实体
  //    无洞类 ⇒ isSolidEntryKind 恒平滑，无单帧瞬移）。2D 激活带 [zMin,gateFrontZ+CAR_HALF_L] 内
  //    （z∈[-1278.95,-1263.05] ⊂ 带），FreeDrive 门控已覆盖，无需改。近侧外推（xOuter+dx=10.353）
  //    与外列（10.05-10.95）相撞 ⇒ nearSideBlocked 自动回退远侧（xInner−dx=7.447，绕行中心）。
  //    ⚠ 几何派生逐位对齐 castleKit makeMainHall ⑪（L3021-3033），禁写死错配。
  {
    const brazierBaseHalf = 0.9 / 2; // 列阵火盆底座 box('ashlar',0.9,0.8,0.9) → 半宽 0.45
    const brazierZStart = 3.5; // 首座自 plazaNear+3.5（makeMainHall 列阵）
    const brazierOuterOffset = 1.6; // 外列相对内列 +1.6（makeMainHall ⑪）
    const brazierExtraCount = 2; // ⑪ 外列追加 2 座/侧
    const plazaNear = MAIN_HALL.z + MAIN_HALL.plazaDepth; // -1300 + 18 = -1282（主殿前方可见侧）
    const innerCx = ROAD_HALF + HALL_BRAZIER.arrayInset; // 8.9
    const outerCx = innerCx + brazierOuterOffset; // 10.5
    for (let i = 0; i < HALL_BRAZIER.arrayCount; i += 1) {
      const cz = plazaNear + brazierZStart + i * HALL_BRAZIER.arrayPitch;
      list.push({
        xInner: innerCx - brazierBaseHalf,
        xOuter: innerCx + brazierBaseHalf,
        zMin: cz - brazierBaseHalf,
        zMax: cz + brazierBaseHalf,
        kind: 'buttressBase'
      });
    }
    for (let i = 0; i < brazierExtraCount; i += 1) {
      const cz = plazaNear + brazierZStart + (HALL_BRAZIER.arrayCount + i) * HALL_BRAZIER.arrayPitch;
      list.push({
        xInner: outerCx - brazierBaseHalf,
        xOuter: outerCx + brazierBaseHalf,
        zMin: cz - brazierBaseHalf,
        zMax: cz + brazierBaseHalf,
        kind: 'buttressBase'
      });
    }
  }

  // ⑧ 城门带门墩（R118 Fix 1 / R119 改 b）：城门带两侧门墩 |x|∈[10,17.5]。
  //    Root cause：1D corridorCenterHalfWidth 在 gateFrontZ（桥 10.997→隧 8.997）/ gateBackZ
  //    （隧 8.997→块0 角塔带 13.897）硬阶跃，单帧横移 2m/4.9m = 空气墙 + 瞬态穿模（探针 A/C/D）。
  //    2D 门墩 footprint 让 clampToFootprints 在门带接管（7 帧收敛替代 1 帧瞬时，斜向有碰撞反馈）。
  //    R119 改 b：z 区间 = 塔基实体范围（GATE_PIER_Z_MIN/MAX 已含）——原 [gateBackZ,gateFrontZ] 只
  //    覆盖门墩塔身实体，漏掉「门楼塔基 z 超 0.6m」（塔基 z∈[−366.1,−350.9]，castleKit 台基
  //    box(depth+1.2)）。SAT 判交（车 OBB↔footprint）自然覆盖车头/车尾入塔基实体，无需扩 CAR_HALF_L；
  //    扩 CAR_HALF_L 反使 footprint>实体，块 0 北缘合法位车被 gatePier 误钳（r110 实测 2.006m）。
  //    ⚠ 此 footprint 在 2D 激活带 [plazaZ,gateBackZ] 之外（z>gateBackZ）⇒ 需 FreeDrive step()
  //    的 2D 门控上界从 gateBackZ 扩到 gateFrontZ+CAR_HALF_L（R118 Fix 2 / R119 fix-1 同步改，本文件禁碰）。
  list.push({
    xInner: GATE_PIER_INNER,
    xOuter: GATE_PIER_OUTER,
    zMin: GATE_PIER_Z_MIN,
    zMax: GATE_PIER_Z_MAX,
    kind: 'gatePier'
  });

  // ⑨ R124 · 门洞门扇（双侧镜像，|x| 距离存储由 clampToFootprints 按车侧处理）：
  //    门扇折靠侧墙 x∈[9.0,9.4]（探针-A：gatePier 限 8.997 车缘 10.0 穿门 1.0m，hit=false 残留）。
  //    补 doorLeaf 占位让 clamp 在门扇 z 带接管：车缘 9.0 恰贴门内缘不穿。恒远侧推（车心恒 <
  //    门心 9.2 ⇒ 不近侧），isSolidEntryKind 恒平滑（R123 fix-1 语义，防单帧瞬移）。
  list.push({
    xInner: DOOR_LEAF_X_INNER,
    xOuter: DOOR_LEAF_X_OUTER,
    zMin: DOOR_LEAF_Z_MIN,
    zMax: DOOR_LEAF_Z_MAX,
    kind: 'doorLeaf'
  });

  // ⑩ R138 · 门楼飞扶壁双墩（御桥段 z>gateFrontZ）：拆内/外墩两条独立 footprint
  //    （不做 AABB 并集 [7.8,12.4]，并集令贴桥沿车（x=10.997）单帧推 4.2m=空气墙）。
  //    内墩 [7.8,10.0] / 外墩 [10.2,12.4]，z∈[−347.75,−344.95]，双侧镜像（|x| 距离存储）。
  //    ⚠ z 带在 2D 激活域（上界 GATE_PIER_Z_MAX+CAR_HALF_L=−348.1525）之外 ⇒ FreeDrive
  //    激活域上界须扩到 GATE_FLY_Z_MAX+CAR_HALF_L=−342.2025（R138 同步改，本文件禁碰门控）。
  list.push({
    xInner: GATE_FLY_INNER_X_INNER,
    xOuter: GATE_FLY_INNER_X_OUTER,
    zMin: GATE_FLY_Z_MIN,
    zMax: GATE_FLY_Z_MAX,
    kind: 'buttressBase'
  });
  list.push({
    xInner: GATE_FLY_OUTER_X_INNER,
    xOuter: GATE_FLY_OUTER_X_OUTER,
    zMin: GATE_FLY_Z_MIN,
    zMax: GATE_FLY_Z_MAX,
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
  /** R118 Fix 3：对**最紧钳位盒**的真实 x 轴 SAT 穿透（车 OBB x 投影与占位盒 x 区间的公共长度；
   *  m；0 = 无 x 收紧或无 x 轴重叠）。R117 旧式 = |x|−best（车心到最终钳位目标的距离），在车 OBB
   *  完全处于占位盒内缘外侧时高估真实穿透（N2/N4 广场墩单帧 4~5m，探针 D 7.4 倍）。FreeDrive 用
   *  max(0.30, xPen) 作 x 步长上限：车已穿模时单帧推回真实穿透（消除穿模），未穿模时保持 0.30 平滑 */
  xPen: number;
  /** R116：车心 z 到 z 钳位目标（带外缘钳位线）的距离（m；0 = 无 z 收紧）。FreeDrive 用 max(0.30, zPen) 作 z 步长上限，车已穿模时单帧推回消除，未穿模时保持 0.30 平滑 */
  zPen: number;
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
): { axis: 'x' | 'z' | 'lx' | 'lz' | 'separated'; depth: number; az: number } {
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
  let minAz = 0;
  for (const a of axes) {
    const carR = halfL * Math.abs(a.ax * s + a.az * c) + halfW * Math.abs(a.ax * c - a.az * s);
    const fpR = fhx * Math.abs(a.ax) + fhz * Math.abs(a.az);
    const dist = Math.abs((cx - fcx) * a.ax + (cz - fcz) * a.az);
    const overlap = carR + fpR - dist;
    if (overlap <= 0) return { axis: 'separated', depth: 0, az: 0 };
    if (overlap < min) {
      min = overlap;
      minAxis = a.axis;
      minAz = a.az;
    }
  }
  return { axis: minAxis, depth: min, az: minAz };
}

/**
 * R119 改 a 防护②：近侧目标（f.xOuter+dx 外推）处车 OBB 是否与**其它**占位盒相交。
 *
 * 近侧界是外推（放宽 R112「只收紧不放宽」）：若把车外推到 nearBound 会让车 OBB 落入另一占位盒
 * （如外推后车角嵌进前排塔基 / 连墙墩），则近侧界不可用（回退远侧 f.xInner−dx）。用与主钳位
 * 同一 SAT 精确判交（obbOverlapsAabb），排除自身 f（近侧界恰贴 f 外缘，边界判交不算「其它」）。
 */
function nearSideBlocked(
  nearBound: number,
  z: number,
  heading: number,
  dz: number,
  exclude: CityFootprint
): boolean {
  for (const g of footprintsNear(z, dz)) {
    if (g === exclude) continue;
    if (obbOverlapsAabb(nearBound, z, heading, CAR_HALF_L, CAR_HALF_W, g)) return true;
  }
  return false;
}

/**
 * 纯函数：把车 OBB 的 x 伸展钳到「不与城内 2D 占位相交」的最紧界（默认只收紧，不放宽）。
 *
 * dx(θ) = 半长·|sinθ| + 半宽·|cosθ| 是车 OBB 4 角点相对车心的 x 最大伸展
 * （heading=0 时车头朝 −Z，前向 (−sin h, −cos h)，车长沿 z、车宽沿 x ⇒ dx(0)=半宽）。
 * 对所有与车 OBB 做 SAT 相交的占位盒取 |x| ≤ xInner − dx(θ) 的最紧界。
 *
 * ⚠ 只收紧不放宽（默认）：调用方在 resolveBounds 之后 step() 里调用本函数，入参 x 已经是
 * 1D 车心钳位结果，本函数只会把它进一步往路中心拉，绝不外推 ⇒ CameraRig 与 r97/r98/r99/r100
 * 全部 1D 护栏在几何上不会破（新钳位只会更紧，不会更松）。
 *
 * R119 改 a 近侧界例外（唯一外推情形）：对凸出宽走廊的**局部突出物**（buttressBase / arcadeCol
 * —— 飞扶壁墩、拱廊柱带，车可合法停在其与前脸之间的空隙），当车心位于其外缘侧（|x| ≥ mid）时，
 * 改按近侧界 |x| ≥ xOuter + dx 外推（车被推离突出物外缘，非硬拉回路内 ⇒ 消除 R119 恒推远侧的
 * 穿墩/柱带 yank）。必须同时通过两道防护才外推，否则回退远侧 f.xInner−dx：
 *   ① 近侧目标 ≤ 1D 车心面线走廊 corridorCenterHalfWidth(z)（不越 1D 护栏，车缘不破可见面线）；
 *   ② 近侧目标处车 OBB 不与**其它**占位盒相交（nearSideBlocked，外推不落入另一实体）。
 * gatePier 漏斗恒远侧（车不可能在门墩 xOuter(17.5) 外侧 —— x∈[0,±8] 洞内走线，近侧界会把
 * 进洞车弹出 +7.5m ⇒ 明确排除）。
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
    let bestF: CityFootprint | null = null;
    let kind: CityFootprint['kind'] | null = null;
    let expanded = false; // R119 改 a：本次是否走近侧界（外推/放宽）而非远侧收紧
    let cx = x;
    for (let iter = 0; iter < 4; iter += 1) {
      // R119 改 a：近/远侧选择。本迭代分两组收集相交占位盒的目标界：
      //   - 远侧（收紧/内推）：bound = f.xInner − dx，R112 只收紧不放宽（默认）。取**最小**界
      //     （farBest = min，最紧内推）。
      //   - 近侧（外推/放宽）：bound = f.xOuter + dx，仅局部突出物（buttressBase/arcadeCol）且车心
      //     在外缘侧（cxAbs ≥ mid）时候选，且必须通过两道防护（① 近侧目标 ≤ 1D 车心面线走廊
      //     corridorCenterHalfWidth(z)；② 近侧目标处车 OBB 不与**其它**占位盒相交 nearSideBlocked），
      //     否则回退远侧。取**最大**界（nearBest = max，最远外推才清所有近侧占位）。gatePier 恒远侧
      //     （车不可能在门墩外缘外侧）。
      //   选择规则：优先远侧（硬边界/墙——车必须内推清墙，近侧外推会让车落入墙区）；无远侧时才用
      //   近侧（局部突出物外推，位移最小，消除 R119 恒推远侧 yank）。
      let farBest = Infinity;
      let farF: CityFootprint | null = null;
      let nearBest = -Infinity;
      let nearF: CityFootprint | null = null;
      const cxAbs = Math.abs(cx);
      for (const f of footprintsNear(z, dz)) {
        // SAT 精确相交测试：车 OBB 真的与占位 AABB 相交才收紧（避免车 z 覆盖碰边即触发的误钳）
        if (!obbOverlapsAabb(cx, z, heading, CAR_HALF_L, CAR_HALF_W, f)) continue;
        const mid = (f.xInner + f.xOuter) / 2;
        const useNear =
          (f.kind === 'buttressBase' || f.kind === 'arcadeCol') && cxAbs >= mid;
        if (useNear) {
          const nearBound = f.xOuter + dx;
          if (
            nearBound <= corridorCenterHalfWidth(z) &&
            !nearSideBlocked(nearBound, z, heading, dz, f)
          ) {
            if (nearBound > nearBest) {
              nearBest = nearBound;
              nearF = f;
            }
          } else {
            const farBound = f.xInner - dx;
            if (farBound < farBest) {
              farBest = farBound;
              farF = f;
            }
          }
        } else {
          const farBound = f.xInner - dx;
          if (farBound < farBest) {
            farBest = farBound;
            farF = f;
          }
        }
      }
      // 选择：优先远侧（硬边界），无远侧才用近侧
      const useNearSel = farBest === Infinity && nearBest > -Infinity;
      const iterBest = useNearSel ? nearBest : farBest;
      const iterF = useNearSel ? nearF : farF;
      const iterKind = iterF ? iterF.kind : null;
      if (iterBest === Infinity || iterBest === -Infinity) break; // 无相交占位盒
      if (Math.abs(cxAbs - iterBest) < 1e-9) break; // 已到目标界（收敛，无需再动）
      cx = cx >= 0 ? iterBest : -iterBest;
      best = iterBest;
      bestF = iterF;
      kind = iterKind;
      expanded = useNearSel;
    }
    // R118 Fix 3：xPen = 对「决定最终 best 的占位盒 bestF」的**真实 x 轴 SAT 穿透** —— 车 OBB x 投影
    //   [|x|−dx, |x|+dx] 与占位盒 x 区间 [xInner, xOuter] 的公共长度（SAT 世界 x 轴重叠），非 R117
    //   旧式 `|x| − best`（车心到目标距离）。旧式在车 OBB 完全处于占位盒内缘**外侧**（|x|−dx ≥
    //   xInner）时把「车心到目标」误读为「x 轴穿透」⇒ N2/N4 广场飞扶壁墩单帧推回 4~5m（探针 D：
    //   cx=13.897 高估 4.475 vs 真实 0.606，7.4 倍）= 空气墙/瞬移。真实穿透语义核对：
    //   ① 车在路侧（|x|−dx < xInner）⇒ 上式 = |x|+dx−xInner = |x|−best（R117 多盒收敛修复保留）；
    //   ② 车越内缘（|x|−dx ≥ xInner）⇒ 给真实（较小）重叠 ⇒ N2/N4 单帧推回受限（FreeDrive 的
    //      max(0.30, xPen) 回 0.30 平滑）；
    //   ③ x 轴分离（min(|x|+dx, xOuter) ≤ max(|x|−dx, xInner)）⇒ 0。
    const xPen =
      best < Infinity && bestF
        ? Math.max(
            0,
            Math.min(Math.abs(x) + dx, bestF.xOuter) - Math.max(Math.abs(x) - dx, bestF.xInner)
          )
        : 0;
    return { best, kind, xPen, expanded, bestF };
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
        // R114：放宽到「min 轴的 z 分量显著」才沿 z 推。R113 只推 min 轴=z，但斜插（如 45°）
        //   时 min 轴常为车局部轴（lx/lz，z 分量 = |sin h|/|cos h|，45° 时 0.707）——车头斜入
        //   占位带（墩/柱/塔基）z 覆盖浅，MTV 最小分离沿局部轴，x 钳收敛 0.3m/帧太慢 ⇒ 车角深
        //   嵌 0.5m 级（R113 判定接受的斜插收敛瞬态，R114 实测 0.547m）。把 z 钳扩展到「min 轴的
        //   z 分量 ≥ 0.45」（覆盖 30°/45° 斜插；x 轴 az=0 仍交给 x 钳）⇒ 车头斜入时沿 z 推回带
        //   外缘（同 R113 对柱带的机制），消除斜插穿墩瞬态。阈值 0.45：45°(0.707)/30°(0.5) 触发，
        //   15°(0.259) 不触发（x-钳处理，15° 穿模本已微小）。只放宽 z-钳触发条件，目标/步长不变。
        if (Math.abs(m.az) < 0.45) continue;
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
    // R116：车心 z 到 z 钳位目标（带外缘钳位线）的距离 = 单帧推回量（车已穿模时让 z 轴相切）。
    //   与 xPen 对称；zLimit<Infinity（有 z 收紧）时 = |入参 z − zLimit|，否则 0。
    return { zLimit, zKind, zDir, zPen: zLimit < Infinity ? Math.abs(z - zLimit) : 0 };
  })();
  /* R119 fix-5 · 单帧推回平滑上限（m）。
   * xPen / zPen 是「车已穿模时的单帧推回量」（FreeDrive 动态步长 maxStep=max(0.30, pen)，
   * R115/R116：车穿模时单帧推回 pen 恰贴内缘/带外缘消除穿模）。当车**斜切入/骑上**占位盒且
   * 持续深入（门墩斜切 h=−0.2 车头入塔基、广场墩骑墩车角深嵌）时，2D 激活时车 OBB 已深嵌
   * 占位盒（xPen 实测 1.5~2.3m）⇒ 单帧推回大深度 = 2.3m/1.8m 瞬移 yank（fix-4 报告 1/2 号）。
   *
   * ⚠ 不能一刀切限幅：车**穿洞/急转**（门墩 h=90° 车前进沿 x，x 钳与前进同向）和**漂移贴墙**
   * （车深入 z 带，z 钳大）必须保留「单帧消除穿模」（车快速过洞/贴墙收敛，R119 ② 门墩接触
   * ≤2 帧、r105 漂移收敛尾部零穿模）。条件限幅（**只平滑「车横向深嵌 > 车头纵向深入」且
   * 车前进沿 z 为主（x 钳横向拉回路内）」）：
   *   xPen 平滑：xPen>0.35（已穿模）且 |sin heading|≤0.5（车前进 z 为主；r119 ② 门墩急转
   *     |sin h|≈0.99>0.5 保留单帧消除）且 zOv<xPen（车**横向**深嵌，z 轴重叠浅；r105 漂移
   *     车纵向深嵌 z 带 zOv≈2.1>xPen≈0.53 反向 ⇒ 保留单帧消除，不重演收敛尾部穿模）；
   *   zPen 平滑：zPen>0.35 且 xPen>zPen（车横向深嵌 > 车头纵向深入，问题 1 号 2.3>0.73；
   *     r105 漂移 zPen≈3.79 > xPen≈0.53 反向 ⇒ 保留单帧消除 z）。
   * 语义：clamp 的目标 x/z 不变（best / zLimit 逐位保留），只限「FreeDrive 单帧推回上限」⇒
   * R112/R117 静态收敛（clamp 后喂回 hit=false）不受影响，R110 连续收敛（≤max(0.30,pen)）仍满足。
   * 值 0.35 = 报告「yank ≤0.35/帧平滑」上限（>WALL_2D_MAX_LATERAL_STEP=0.30，未穿模仍 0.30）。
   * 注：问题 3 号（块边界连墙墩 h=±0.5 v=55）yank 来自 FreeDrive 内部（车斜插高速 1D 撞击
   * 链路，2D clamp 全程零触发，新旧 bundle 2D-hit 帧=0）——非 2D 占位收敛，本限幅不适用。 */
  const X_Z_PEN_SMOOTH_CAP = 0.35;
  const xPenRaw = xClamp.xPen; // 未限幅真实 x 轴穿透（供限幅判据 / zPen 比较）
  const zPenRaw = zClamp.zPen; // 未限幅车心 z 到 z 钳目标距离
  const sinHAbs = Math.abs(Math.sin(heading));
  // 车 OBB z 投影与「x 钳最紧盒」的 z 轴重叠（车头/车尾纵向深入占位盒的深度；问题 1 号门墩
  //   斜切 = 0.73m（车头入塔基）、广场墩骑墩 = 0（车 z 贴边）、r105 漂移贴墙 = 2.1m（纵向深嵌）。
  //   zOv < xPen ⇒ 车横向深嵌 > 纵向深入（斜切/骑墩特征，需要横向平滑拉回路内）。
  const zOv =
    xClamp.bestF && xClamp.best < Infinity
      ? Math.max(0, Math.min(z + dz, xClamp.bestF.zMax) - Math.max(z - dz, xClamp.bestF.zMin))
      : 0;
  /* R119 fix-5b · 入激活域横向推回类占位盒特判（门墩/墩/柱/殿台基斜切第一帧）。
   * fix-5 的 zOv<xPenRaw 判据把「门墩斜切入激活域第一帧」误判为「纵向深嵌」：
   *   门墩斜切第一帧车 OBB 刚与 gatePier z 带重叠（zOv≈xPenRaw，实测 zOv/xPen=1.09）而非
   *   r105 漂移深嵌（zOv≈2.1 >> xPen≈0.53，比值≈4）⇒ zOv<xPenRaw=false ⇒ 不限幅 ⇒ 单帧
   *   横向推回 0.41-0.64m（fix-6 任务① 21/48 残留）。本特判：**入激活域类**占位盒
   *   （gatePier 门墩 / buttressBase 墩 / arcadeCol 柱 / hallBase 殿台基 —— 车斜切入其 z 带
   *   第一帧需横向平滑拉回路内，非纵向深嵌漂移）且车前进 z 为主（sinH≤0.5）且已穿模
   *   （xPenRaw>0.35）时限幅，**不再依赖 zOv<xPenRaw**。
   *   R119 ② 门墩急转 sinH≈0.99>0.5 ⇒ sinH 判据排除，单帧消除保留（穿洞收敛不破）。
   *   ⚠ R138+ Fix-2 泛化：本条「入激活域类 sinH≤0.5 限幅」现被下方 `sinHAbs<=0.5` 低角项
   *   全覆盖（含 cornerBase/frontBase/frontWall），isEntryKind 变量已并入低角项移除（行为
   *   对 gatePier/buttressBase/arcadeCol/hallBase 不变）。r105 漂移曾实测命中 cornerBase/
   *   frontBase（zOv≈2.1>>xPen≈0.53 需保留单帧消除）——经 R110-R123 连续收敛后 R105 ① 场景
   *   实测仅命中 arcadeCol（sinH≥0.9>0.5，sinH 判据排除，单帧消除保留），cornerBase/
   *   frontBase 不再命中 ⇒ 泛化低角平滑不破坏 r105 漂移收敛。 */
  /* R123 fix-1 · 实体无洞类占位盒全 sinH 平滑（R122 展宽副作用修复）。
   *   R122 把主殿飞扶壁 footprint xOuter 13.15→16.65 覆盖整墩对后，墩盒展宽（6.3m）。车斜插
   *   深嵌（sinH>0.5，如 θ=60° sinH=0.866）时车 OBB x 投影几乎整体落入盒 ⇒ xPen 从旧 2.03m
   *   放大到 5.53m；此时 sinHAbs>0.5 ⇒ 原 xPenSmooth 不生效 ⇒ xPen=5.53 ⇒ maxStepX=5.53 ⇒
   *   单帧横移 5.53m 瞬移（probe-C 2b：R118 Fix3「xPen 较小」假设因盒展宽失效，无测试覆盖）。
   *   R123 fix-1b（cornerBase/frontBase 斜插同病，探针验证）：θ=60° 车 OBB 深嵌块 0 角塔基座
   *   （cornerBase x[14.9,24.7]）xPen=1.98 ⇒ 单帧 14.0→12.019 瞬移 —— cornerBase 不在
   *   isSolidEntryKind 且 sinH>0.5 ⇒ 原式不平滑。扩展：**非门墩实体横向深嵌**（zOv<xPenRaw，
   *   车 OBB 横向深入 > 纵向深入）恒平滑（覆盖 cornerBase/frontBase 斜插）。门墩（gatePier，
   *   有门洞）保留 sinH 门控（R119 ② 急转 sinH≈0.99 需单帧消除过洞收敛）；r105 漂移纵向
   *   深嵌（zOv≈2.1>>xPen≈0.53，**仅 sinH>0.5 斜插**）zOv<xPenRaw=false ⇒ 不触发平滑，
   *   单帧消除穿模保留（不重演收敛尾部穿模/卡死；sinH≤0.5 直行已被下方 R138+ Fix-2 平滑）；
   *   arcadeCol 柱窄（0.60m）自然 xPen≤0.6，zOv 判别亦安全。 */
  const isSolidEntryKind =
    xClamp.bestF != null &&
    (xClamp.bestF.kind === 'buttressBase' ||
      xClamp.bestF.kind === 'hallBase' ||
      xClamp.bestF.kind === 'doorLeaf');
  const isGatePierKind = xClamp.bestF != null && xClamp.bestF.kind === 'gatePier';
  /* R138+ Fix-2 · 直行/近直行贴墙恒平滑（补 R123 fix-1b 未覆盖的「直行空档」）。
   *   根因（探针实证）：cornerBase/frontBase/frontWall（角塔基座/前排塔基/火盆，均**非**
   *   isSolidEntryKind 亦**非** isEntryKind）在车直行贴墙（heading=0，sinH=0，车头沿 z 为主）
   *   时车 OBB 纵向深嵌（zOv≫xPenRaw：cornerBase zOv/xPen=6~7、frontBase=9），原式
   *   `(!isGatePierKind && zOv < xPenRaw)` 判据为 false（纵向深嵌反向）且 `(sinHAbs<=0.5 &&
   *   isEntryKind)` 不命中（kind 不在入域类）⇒ xPenSmooth=false ⇒ 单帧推回 = 真实穿透
   *   0.5~1.05m（>X_Z_PEN_SMOOTH_CAP=0.35）= 贴墙横向 yank（真空气墙）。R123 fix-1b 只覆盖
   *   sinH>0.5 斜插（zOv<xPenRaw 项），直行贴墙是空档。
   *   本项：对「sinH≤0.5（车头沿 z 为主）」一律平滑（min(xPenRaw, 0.35)），不再依赖
   *   zOv<xPenRaw 判别 —— 小突出物火盆（0.9×0.9 方体，车 OBB 在 z 向全罩）zOv≈xPenRaw≈0.9
   *   精确等值，`zOv>xPenRaw` 严格判据会漏掉（zOv/xPen=1.000），故去 zOv 判别。
   *   ⚠ 本项仅实际影响 cornerBase/frontBase/frontWall：其余 kind 已被 isSolidEntryKind
   *   （buttressBase/hallBase/doorLeaf 恒平滑）或 `sinHAbs<=0.5 && isEntryKind`（低角项，
   *   现被子项覆盖）处理，行为不变。frontWall 主体 xInner=15.5 对合法 1D 车缘
   *   （≤14.497+1.003=15.5）零穿透 ⇒ 对主墙面为 no-op，只处理探出 0.7m 的火盆（xInner=14.35）。
   *   最终 clamp 目标（best）不变，仅限单帧推回到 X_Z_PEN_SMOOTH_CAP=0.35（收敛速率，
   *   车 2~3 帧内收敛到贴界，无残留、无卡死）。 */
  const xPenSmooth =
    xPenRaw > 0.35 &&
    (isSolidEntryKind ||
      (!isGatePierKind && zOv < xPenRaw) ||
      sinHAbs <= 0.5); // 车横深嵌（实体无洞 / 非门墩横向深嵌 / 低角含直行贴墙恒平滑）
  const zPenSmooth = zPenRaw > 0.35 && xPenRaw > zPenRaw; // 车横向深嵌 > 车头纵向深入
  const ax = Math.abs(x);
  // R119 改 a：xClamped 方向感知。远侧（收紧，best < ax）与近侧（外推，best > ax）都需要
  //   车移到 best；仅当车已恰在目标界（边界接触，best == ax）才不钳（保留 R112 收敛语义）。
  const xClamped =
    xClamp.best < Infinity && Math.abs(ax - xClamp.best) > 1e-9;
  const zClamped = zClamp.zLimit < Infinity;
  if (!xClamped && !zClamped) {
    return { x, z, hit: false, kind: null, nx: 0, nz: 0, xPen: 0, zPen: 0 };
  }
  // R119 改 a：nx 外法向指向车被推离占位盒的方向（可行驶侧）。远侧（收紧/内推）→ 指向路内
  //   （x≥0 时 −1）；近侧（外推/放宽）→ 指向路外/突出物外侧（x≥0 时 +1）。FreeDrive 的
  //   nxSide=−fp.nx 与 resolveBounds 同约定（指向墙外），近侧时 fnSide 才能对「从外侧撞入」的车
  //   给正法向入射（否则 2D 接触从不扣速 = 滑开）。
  const nx = x >= 0 ? (xClamp.expanded ? 1 : -1) : xClamp.expanded ? -1 : 1;
  return {
    x: xClamped ? (x >= 0 ? xClamp.best : -xClamp.best) : x,
    z: zClamped ? zClamp.zLimit : z,
    hit: true,
    // R114：kind 反映**最紧 x 钳盒**（x 钳是主判据：bound=xInner−dx 取最紧界），z 钳盒仅当 x
    //   未收紧时兜底。R113 原式 `zClamped ? zClamp.zKind : xClamp.kind` 在 z 钳触发（R114 扩展
    //   到 min 轴 z 分量显著后斜插常见）时用 z 钳盒盖过 x 钳最紧盒（如墩位斜插 z 钳先扫到柱带
    //   arcadeCol 而 x 钳最紧是墩 buttressBase）⇒ kind 语义错（r102/r103 断言钉「最紧盒」失败）。
    //   改为 x 钳优先 ⇒ kind 恒为「最紧界」占位盒（测试钉的语义），z 钳只贡献 z/nz。
    kind: xClamped ? xClamp.kind : zClamp.zKind,
    nx,
    nz: zClamp.zDir, // z 外法向：+1 = 推向 +z（可行驶侧）、−1 = 推向 −z
    // R115：车 OBB x 越界深度（FreeDrive 动态步长用）。R119 fix-5 条件限幅（见上方注释）：
    //   车深嵌且前进 z 为主（x 钳横向）时限幅到平滑上限，否则保留单帧消除穿模。
    // R120：arcadeCol 柱带 xPen 特判 —— 柱带宽仅 0.60m（x∈[11.12,11.72]），fix-5 用 0.35 上限
    //   仍使块边界连墙墩 1D 残余 0.34m（>0.30 平滑带）；柱带是「周期窄突出物」，车斜切深嵌时
    //   单帧推回可收紧到 WALL_2D_MAX_LATERAL_STEP（0.30，与未穿模同额）⇒ 残余 →0.29 且无 yank。
    //   其余 kind 保持 X_Z_PEN_SMOOTH_CAP=0.35（⑧门墩斜切末态车缘 10.0055 断言依赖 0.35，
    //   全局降 0.30 会恶化到 10.2785 破坏 edge≤10.01 ⇒ 必须按 kind 特判，不可全局降）。
    xPen: xPenSmooth
      ? Math.min(xPenRaw, xClamp.kind === 'arcadeCol' ? WALL_2D_MAX_LATERAL_STEP : X_Z_PEN_SMOOTH_CAP)
      : xPenRaw,
    // R116：车心 z 到 z 钳目标距离（FreeDrive 动态步长用）。R119 fix-5 条件限幅：
    //   车横向深嵌 > 车头纵向深入时限幅，否则保留单帧消除（r105 漂移 z 深嵌不限）。
    zPen: zPenSmooth ? Math.min(zPenRaw, X_Z_PEN_SMOOTH_CAP) : zPenRaw,
  };
}
