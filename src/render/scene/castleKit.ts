/**
 * 白城堡（哥特式白石大教堂）+ **可行驶御桥** 的程序化构件库 —— 全部 BufferGeometry，
 * 零外部资产 / 零 Math.random（随机一律走确定性公式）。
 *
 * ── 与 R26 的关系（为什么整篇重写）────────────────────────────────────────
 * R26 版是「尖拱拱廊长廊 + 双侧大教堂 + 远景塔尖」的旧设想，注释自述「改动没有跑
 * 截图验证」。R27 按 FBX 实测（`.qa/r27_measure.md`）与三张官方渲染图
 * （7cd7329c 车视正桥 / 2497fab5 桥侧全景 / 2a302891 近景）重写为：
 *   ① 御桥：24 跨双心尖拱 —— 中央主券（矢高 7.85，拱脚在桥面下）+ 双侧两层券廊
 *      （一层 spring −5.0 / 二层 spring −12.9）+ 4 束柱墩（束柱根数 pierColumns）+
 *      2.2m 金顶栏板（圆柱瓶柱 + 金压顶 + 每跨金徽章）+ 火盆灯柱 + 三带铺装；
 *   ② 城门楼：20×30 尖拱门洞（14m 隧道）+ 双塔墩 + 三层金券 + 金饰圆盘 + 火盆；
 *   ③ 城内大街：殿 / 塔 / 连墙 / 尖拱窗 / 垛口 / 金线 / 火盆，夹道至路障。
 *
 * ── 尺度口径 ───────────────────────────────────────────────────────────────
 * 一切常量 import 自 `r27Layout.ts`（布局真源，本项目唯一）。FBX 构件库的 1:1
 * 人体尺度值（栏板节拍 1.017、窗 1.068×7.039）是 52m 宽桥上的尺度，**不直接用**；
 * 按「比例层」以 ROAD_W = 14.8 为锚换算（r27Layout 各常量注释已注明比例来源）。
 *
 * ── 坐标系 ───────────────────────────────────────────────────────────────
 * 世界系：车沿 **−z** 行驶，路面 y=0（半宽 7.4），车头 = −Z。
 *   桥体 / 栏板 / 铺装 / 灯柱：直接产世界坐标几何（沿 −z 铺）。
 *   城门：原点 = 路中心地面，进深沿 z（前脸朝 +z = 来车方向）。
 *   城内建筑：前脸在 |x| = faceHalf（左 +15.5 / 右 −15.5），法线朝路心，
 *             进深 8 向后扎进崖体（makeInnerCity 走「局部坐标 + 单次镜像」配方）。
 *
 * ── UV 口径 ───────────────────────────────────────────────────────────────
 * 米制平面 UV（planarUV）：按法线主轴选投影平面，u,v = 局部米数 / 贴图米数。
 * 尖拱件（ExtrudeGeometry）默认**无法线**，先 computeVertexNormals 再 planarUV。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { STONE_TILE_METERS } from './stoneTexture';
import type { StoneKind } from './stoneTexture';
import {
  apseDrum,
  archHeadPlate,
  bellTower,
  blindArcadeRow,
  capitalCollar,
  cloisterArcade,
  corniceBand,
  corridorCrossing,
  corridorGallery,
  corridorRun,
  crocketRun,
  crookedSpire,
  dentilBand,
  diamondFit,
  doorLeaf,
  draperyRelief,
  finialOrnament,
  flyingButtress,
  gildedScreen,
  mapParts,
  pinnacleCluster,
  pour,
  quatrefoilMedal,
  roseWindow,
  setDeepFar,
  statueNicheX,
  statueNicheZ,
  traceryWindowX,
  traceryWindowZ
} from './castleDetail';
import type { ExtraBucketKey } from './castleDetail';
import {
  GATE,
  GATE_DECOR,
  HALL_BRAZIER,
  INNER,
  LAMP,
  MAIN_HALL,
  PARAPET,
  ROAD_HALF,
  ROAD_W,
  TOWER,
  TOWER_GROUP,
  VIADUCT
} from './r27Layout';

/* ═══════════════════ 桶与低配档 ═══════════════════ */

/** 按材质族分桶的几何集合（castle.ts 逐桶 mergeSafe → 1 mesh → 1 DC） */
export interface StoneBuckets {
  /** 主体白石（ashlar 贴图） */
  ashlar: THREE.BufferGeometry[];
  /** 次级灰白墙（wall 贴图，比主体暗一档） */
  wall: THREE.BufferGeometry[];
  /** 鎏金饰（metalness 0.85，形体全靠环境反射） */
  gold: THREE.BufferGeometry[];
  /** 近黑洞穴内壁（门洞隧道 / 尖拱窗背板）—— 不进石材族，否则读成"亮洞" */
  dark: THREE.BufferGeometry[];
  /** 火焰发光体（MeshBasic，靠 bloom 出光晕） */
  flame: THREE.BufferGeometry[];
}

function emptyBuckets(): StoneBuckets {
  return { ashlar: [], wall: [], gold: [], dark: [], flame: [] };
}

/**
 * R31 可选桶直推（roof/wood/glass/marble）：castle.ts 的 `absorb()` 对这四个键
 * 做防御式读取，castleKit 只要往桶对象上挂同名数组即自动生效（每桶 +1 DC）。
 * 注：B 线 z-zone 合批后 castle 静态 DC 实测 ≤ 18，R31_BUDGET.castleDc = 32 留余量。
 */
function extra(b: StoneBuckets, key: ExtraBucketKey, g: THREE.BufferGeometry): void {
  const dst = b as unknown as Record<string, THREE.BufferGeometry[] | undefined>;
  if (!dst[key]) dst[key] = [];
  dst[key].push(g);
}

/**
 * R37-A 变体桶直推（grey / pave / …）：与 `extra()` 同形，但显式列出允许键，
 * 免得手滑把几何推进一个 castle.ts 没有注册的桶（那样会被 `absorb()` 静默丢弃 ——
 * 静默丢几何是本项目出过的事，故这里用类型收口而不是裸 Record）。
 * castle.ts 的 `VARIANT_BUCKETS` 是这些键的唯一真源，改桶名要两边一起改。
 */
export type VariantBucketKey = 'grey' | 'pave' | 'agedGold' | 'door';

function pushVariant(b: StoneBuckets, key: VariantBucketKey, g: THREE.BufferGeometry): void {
  const dst = b as unknown as Record<string, THREE.BufferGeometry[] | undefined>;
  if (!dst[key]) dst[key] = [];
  dst[key].push(g);
}

/**
 * 低配细节档（质量档**只降装饰密度，绝不改几何长度** —— 铁律 33）。
 * 影响：8 面尖塔 → 4 面、卷叶 crocket 跳过、火焰段数降。
 * **不影响**：拱跨数、栏板长度、城门/建筑尺寸、铺装范围。
 */
let LOW_DETAIL = false;

export function setDetailLevel(low: boolean): void {
  LOW_DETAIL = low;
}

export function isLowDetail(): boolean {
  return LOW_DETAIL;
}

const TILE: Record<StoneKind, number> = { ...STONE_TILE_METERS };

/** castleKit 形体族的贴图口径（ashlar / wall / gold 均属 StoneKind） */
type CastleKind = StoneKind;

/* ═══════════════════ R29 加大建筑群（开发线 A 自有常量；r28Layout 只读不动） ═══════════════════
 * 用户令：城堡群目前是「外包交付版」，需**加大建筑群**贴近参考图。四条增量
 * （预算红线（R29 当时口径）：high ≤ 240k tri / DC ≤ 20；R29 改前实测 129,414 tri / 7 DC。
 *   ⚠ R32 C-1 已**删除** `R27_BUDGET` / `R30_BUDGET`（零代码消费），预算键唯一真源
 *   是 `r31Budget.ts` 的 `R31_BUDGET`（castleTriHigh 400k / castleTriLow 285k /
 *   castleDc 32 / visibleTri 200k）；上面这行 240k/20 是**历史留档**，不是现值）：
 *   ① 城内大街：连墙抬高（9→14）、每街区补第二座塔、殿身上加层 + 角塔、
 *     沿街立面**后两排体量**（高过前排 → 天际线成簇）
 *   ② 门楼塔群：翼墙向两侧延伸（xEnd 55 → ±95）+ 角塔 + 门楼后排塔
 *   ③ 主殿：两翼向后延伸纵深 + 后排塔楼 + 后殿第二进体量
 *   ④ 远景剪影带：|x| ≥ 120 两侧 + 主殿后方，纯盒体、进 wall 桶（吃雾、不参与碰撞）
 * 造价纪律：新增形体一律 box(12 tri) / spire(16 tri) / 深色窗缝 dark box(12 tri)，
 * **不复用 lancetWindow**（≈182 tri/扇，铺满必爆预算）。低配档不裁这些体量
 * （铁律 33：低配只降装饰密度，不改几何长度）。
 */
/** 城内大街后排体量 → R31 移至 R30_CROSSINGS 之后的 R31 常量块（墙 24 / 塔 +8） */
/** 门楼翼墙延伸外缘（r28Layout.TOWER_GROUP.wing.xEnd = 55 之外再加） */
const R29_WING_EXT = { xEnd: 95, h: 29 };
/** 远景剪影带（|x| 内缘 / 外缘、z 范围）—— 纯盒体，wall 桶 */
const R29_SKYLINE = { xIn: 120, xOut: 175, zNear: -430, zFar: -1430 };

/* ═══════════════════ R30 构件库复刻 + 内部加密连廊（A 线自有常量） ═══════════════════
 * FBX 构件库（`.qa/r30_fbx/*.json`）复刻 + 用户令「检查城堡内部：建筑少且矮、
 * 无连廊」。预算口径 r30_plan §4：castle high ≤260k / frame ≤360k（R29 基线实测
 * 181,342 tri / 7 DC，探针 tools/r29_corridor_probe.mjs）。增量纪律：
 *   ① 花格窗**换装** lancetWindow（182 → ≤120 tri/扇，城内 360 扇净省 ≈66/扇）；
 *   ② 新件一律 box/spire/extrude 廉价件，单件 tri 上限见 castleDetail 文件头；
 *   ③ 全部进既有 5 桶（ashlar/wall/gold/dark/flame）——**不新增桶类型**
 *      （castle.ts 不在本轮白名单，新桶不会被合并 ⇒ DC 必爆）；
 *   ④ 低配档不裁这些体量（铁律 33：只降装饰密度——卷叶跳过、瓶柱减半）。
 * 行车走廊铁律：|x|≤8 / y≤4.5 / z∈[−1300,60] 严禁新件侵入（连廊楼面一律 ≥6.5m，
 * 街面拱廊柱列落在 |x|≥11 区内；判据 r29_corridor_probe.mjs）。
 */
/** 城内街面低拱廊（连廊主体）：楼面 8.2m（>走廊 4.5 且低于街窗基座 8.5） */
const R30_ARCADE = { floorY: 8.2, width: 3.5, pitch: 8.8, rise: 3.6 } as const;
/** 街区角塔（每街区每侧 2 座，落在块两端 ∓22.5；深 5 只咬连墙外端 3m，窗已避让） */
const R30_CORNER = { h: 31, w: 8, d: 5 } as const;
/** 跨街封闭拱顶连廊 z（块心 k=3/8/13，确定性；避开门洞带与广场带） */
const R30_CROSSINGS = [-526.5, -756.5, -986.5] as const;

/* ═══════════════════ R31 内部建筑群加密（A 线自有常量；数字出处 .qa/r31_a_report.md） ═══════════════════
 * 用户令：①「加大内部建筑群并检查内部建筑高度与材料丰富度」②「构建时长无限制、
 * 运行时必须流畅（fill rate 才是瓶颈）」。增量四件（全部结构件，低配不裁，铁律 33）：
 *   ① 第二进院落带（x 28..44，R29 第三排外移让位）：后殿半圆室 apse（隔块，56m 级
 *      天际线第三层）+ 钟楼（隔三块，64m 级）+ 中景体量（30m 级）；
 *   ② 墙顶敞廊（R29 后排墙顶加列柱 + 拱 = 可见回廊 cloister，marble 柱身）；
 *   ③ 材料丰富度：roof（殿坡顶/后殿锥顶/钟楼四坡顶）、wood（连廊楼面/梁）、
 *     glass（花格窗玻璃底板，castleDetail 内置）、marble（回廊柱列/钟楼塔身带）
 *     四可选桶真正点亮 —— castle.ts EXTRA_BUCKETS 防御式读取自动生效，4 DC。
 *   ④ 主殿两翼飞扶壁（参考图最显著语汇：前排门楼段 ↔ 翼墙的空中连接）。
 * 走廊纪律：全部新件世界 |x| ≥ 24.5（> 走廊 8），跨街连廊楼面 ≥12 不变。
 */
/** R29 后排体量（A 线自有；R31：墙 20→24 加墙顶敞廊、四塔 +8 加高 —— 天际线第二层） */
const R29_REAR_ROW = {
  xIn: 9,
  xOut: 26,
  /** 后排连墙高（R31 20→24；仍 < 塔 44.3 ⇒ 只在殿上方露出） */
  wallH: 24,
  /** 后排塔：[局部 z, 总高]（R31 全体 +8：60/74/66/56） */
  towers: [
    [-17, 60],
    [-6, 74],
    [7, 66],
    [17, 56]
  ] as readonly (readonly [number, number])[]
};
/** 第三排（R31 外移 27..42 → 46..61，让位第二进院落带；塔 78 → 82） */
const R29_REAR2 = { xIn: 46, xOut: 61, wallH: 26, towerH: 82 };
/** 第三排中央高塔（块心；R31 随第三排外移，84 → 88） */
const R30_REAR_CORE = { h: 88, w: 15 };
/** 第二进院落带（R31 新增）：x 范围 / 后殿 / 钟楼 */
const R31_COURTYARD = {
  xIn: 28,
  xOut: 44,
  /** 后殿（隔块 k%2===0）：半径 / 高（天际线第三层 56m 级；x 收在 37.5 防锥顶咬第三排塔） */
  apse: { x: 37.5, r: 8, h: 56 },
  /** 钟楼（隔三块 k%3===0）：宽 / 总高 */
  bell: { x: 33.5, w: 9, h: 64 },
  /** 中景体量（无 apse/钟楼的块）：墙高 */
  midH: 30
} as const;
/** 墙顶敞廊（R29 后排墙顶；marble 柱列 + 尖拱） */
const R31_CLOISTER = { colH: 7.5, depth: 3.0, pitch: 5.2, archRise: 2.9 } as const;
/** 第四排远景体量（R31 随第三排外移：43..58 → 63..78） */
const R31_ROW4 = { xIn: 63, xOut: 78, wallH: 40, towerH: 88 };

/* ═══════════════════ R32 参考图级精化 + 内部扩建（A 线自有常量） ═══════════════════
 * 用户令：① 构件与环境与参考图近乎一致（FBX 级雕刻）② 加大内部建筑群
 * ③ 材料丰富度。依据：r32_brief §1 参考图像素级判读 + §2 SM_Det.fbx 实测常量。
 * 增量纪律（同 R30/R31）：新件一律 box/spire/archBand 廉价件；全进既有 9 桶
 * （ashlar/wall/gold/dark/flame + roof/wood/glass/marble，**不新增桶**）；
 * 远区（DEEP_FAR / k≥ 远界）只降装饰密度不改几何长度（铁律 33）。
 * 预算：R31_BUDGET castle high ≤400k（R32 前实测 356,746）⇒ 增量 ≈+35k 内；
 *       low ≤285k（R32 前 245,470）。走廊纪律：|x|≤8 / y≤4.5 / z∈[−1300,60] 不侵。
 */
/** 桥栏火盆（WCArchBraizer 3.18×3.88×2.77 比例层；参考图 B：桥两侧栏杆柱顶 6–8 盏/侧） */
const R32_BRAZIER = {
  /** 每侧盏数（参考图 6–8 取 7） */
  perSide: 7,
  /** 桥段 z 范围（城门脸内 12m 起，不伸进门洞带） */
  zIn: VIADUCT.zNear - 30,
  zOut: GATE.z + GATE.depth / 2 + 12,
  /** 栏板中心线 x（= makeParapet 的 x） */
  x: VIADUCT.totalHalf - 0.36,
  /** 盆高（FBX 3.88 的比例层；栏板 2.6 高 ⇒ 盆 ≈1.35 读作栏板上陈设） */
  bowlH: 0.95,
  flameH: 0.5
} as const;

/**
 * R37-A 引桥**烛台式壁灯**（挂在栏板外壁的暖光节奏；与 R32_BRAZIER 落地火盆
 * 是两种灯具，详见 makeParapet 内注释）。
 *   perSide 6 ⇒ 双侧共 **12 座**（硬上限 12，不铺满全桥 423m）；
 *   spacing 10.5m（参考图「8–12m 低频节奏」中值），6 站 z = **−349.5 / −339 /
 *   −328.5 / −318 / −307.5 / −297**（实测）；
 *   out 0.18 ⇒ 壁座外脸比栏板中心线（**x = 12.24**，非旧注释的 16.36）外挪 0.18m。
 *
 * ── y 为什么是 1.30（**R37 P2-6 实测改判，原 1.62 会让壁灯悬空**）───────────────
 * 栏板在 x∈[12.0,12.6] 的通长实心构件**只有 5 条**（审查线把截面全枚举了）：
 *   ashlar x[11.88,12.60] y[0.00,0.25]   基座下层
 *   ashlar x[11.95,12.53] y[0.25,0.50]   基座上层
 *   ashlar x[12.07,12.41] y[0.50,1.12]   低栏板
 *   ashlar x[11.99,12.49] y[1.24,1.36]   **中横梁** ← 本档落点
 *   gold   x[11.84,12.64] y[2.42,2.60]   金压顶
 * 其余 1.45~1.79 那一带**通长构件 0 件**，只有 292 根离散瓶柱（zLen 0.26、柱距 1.63）。
 * 原 y=1.62 的壁座 y 区间恰好落在 [1.45,1.79] ⇒ 逐站算「壁座中心 → 最近瓶柱」z 距
 * 为 0.43 / 0.48 / 0.24 / 0.67 / **0.05** / 0.77 ⇒ **只有 −307.5 那 1 座真贴柱，
 * 其余 10 座壁座背后是空的**（截图里能透出路面）。
 *
 * 落点选 **中横梁 y=1.30**（而不是低栏板 0.95）的原因：壁座 x 区间是 [12.37,12.47]，
 *   低栏板外表面只到 x=12.41 ⇒ x 只咬 **0.04m**（壁座厚 0.1，60% 外挑），AABB 会过但
 *   物理上只是薄搭边；中横梁 x 到 12.49 ⇒ x 咬 **0.10m**、y 咬 **0.12m**，真正贴实。
 *   ⇒ 判据写成「双轴咬合各 ≥0.08m」（见 tests/r37_castle.test.ts），把"薄搭边"钉红。
 * ⚠ x 千万别往外推（>12.47 就脱离所有通长构件，立刻回到 0/12）。
 * ⚠ 外挑已知：烛杯/焰外沿 x ≈ 12.79 > 桥面半宽 12.6 ⇒ **外挑 0.19m 在桥面轮廓外**
 *   （真实壁灯外挑正常，本轮保留，但不再假装没有）。
 */
const R37_SCONCE = {
  perSide: 6,
  spacing: 10.5,
  zStart: GATE.z + GATE.depth / 2 + 2,
  y: 1.3,
  out: 0.18
} as const;
/** 内部街墙 5 盲拱节拍（参考图 A 中墙段：龛心距=墙宽 1/5、龛宽=间距 2/3、
 *  龛高=墙高 2/3、龛底离地=墙高 1/6）+ 雕像龛交替（壁龛与盲拱交替的明暗节奏） */
const R32_WALL_RHYTHM = {
  /** 近区街区块数界（k < near 才铺满密度；远区经 DEEP_FAR / 本界双减） */
  near: 8,
  /** 后排长墙 5 龛节拍块筛选（k%8===0 ⇒ 每 8 块一面，控预算） */
  rearMod: 8
} as const;
/** 街巷连拱廊 / 跨街廊加密（R32：二进院落 + 侧廊更密） */
const R32_CORRIDOR = {
  /** 院内中景体量连拱廊块筛选（k%4===1 且非 apse/钟楼位） */
  cloisterMod: 4,
  /** 新增跨街封闭拱顶廊 z（块心 k=1/15；既有 3 座在 R30_CROSSINGS） */
  extraCrossings: [-427.5, -1071.5]
} as const;

/* ═══════════════════ R33 · 二进院落建筑层（aerial 去重复） ═══════════════════
 * 用户/主理人目检：airial 机位只读到沿街两列重复体块，x≈26..44 的院落带空。
 * 本层把 R31_COURTYARD 的「隔块单一中景盒」升级为**四种体量母题轮换**：
 *   ① apse + 圣器室侧殿（拱顶/暖窗/木檐/大理石基座）
 *   ② bellTower + 章室（低坡侧殿 + 暖窗 + 木梁）
 *   ③ cloister 长侧廊（大理石柱列 + 木梁 + 瓦顶 + 三联暖窗）
 *   ④ 双山墙礼拜堂 + 中央烟囱/灯笼塔（aerial 最明显的非重复轮廓）
 * 母题按 k%4 轮换（20 街区 ⇒ 每母题 5 块），两种镜像侧同母题、街区不同 ⇒
 * 空中读成 4 种屋顶节奏而不是一条复读机。
 * 纪律：全部落在 |x|≥26（>行车走廊 8）；低配档只减柱/卷叶/窗棂密度，
 * 建筑长度/屋顶跨度/层数不变（铁律 33）。
 */
const R33_COURTYARD = {
  /** 附属体量的街向进深起点/终点（局部 x；世界 |x| = 15.5 + 此值） */
  annexX: 30.5,
  annexW: 7.0,
  annexD: 9.0,
  /** R33 目检修正：12.5m 的侧殿整座被前排 17.9m 殿身+44m 塔挡住，aerial 读不到。
   * 抬到 22m（+屋脊 2.4 + 小尖塔 5.5 ⇒ 屋脊线 29.9m），才能在前排屋脊之上
   * 形成第二层轮廓。结构长度在两档一致，只改绝对高度（非 tier 差分）。 */
  annexH: 22.0,
  /** 双山墙体量（母题④） */
  twinZ: 12.5,
  twinW: 6.4,
  twinD: 9.5,
  twinH: 22.0,
  /** 中央烟囱/灯笼塔（46m：aerial 上越过前排 31/44m 塔线，形成明显高点） */
  stackW: 5.2,
  stackH: 46,
  /** 院落暖窗：窗宽/窗高/离地（glass 桶，凹进 dark 缝 0.16m） */
  winW: 3.0,
  winH: 4.8,
  winBase: 4.2
} as const;

/* ═══════════════════ R34 · 近中区装饰密度回砍（P0：sphere 口径峰值对位） ═══════════════════
 * 起因（主理人 R34 P0 裁决，记录在案）：`tests/r32_budget.test.ts` 的可见 tri 判据
 * 改用 three.js 真实剔除口径 **boundingSphere** 后，六点采样峰值实测 **250,202 tri
 * @ z=−500**（bbox 口径只有 186,294 ⇒ 漏计 22%），越 `R31_BUDGET.visibleTri` 200k
 * 键 25% ⇒ 裁决**不许抬键**，回砍 z0/z1/z2（viewer z ≥ −460 可见区）+ 中区临界带。
 *
 * 砍法（铁律 33 合规：只降**装饰密度**，几何长度 / 体量 / 跨度 / 层数一律不动）：
 *   ① **hero 街区（k < hero）**：保留全装饰 —— 入口正面首批街面，是近景 hero 读法；
 *   ② **其余街区（k ≥ hero）**：关闭「尺度 <0.6m、在 200m 外降到亚像素」的
 *      **重复**细饰 —— 窗棂 + 子拱光、龛立像与龛楣卷叶、锥面卷叶、垂幔浮雕、
 *      角塔飞扶壁、檐口小尖塔加密、垛口加密、盲拱列 / 墙顶敞廊的街区密度。
 *      判据：0.3m 物件在 200m 处 ≈0.86px（fov55° / 1080p ≈19.6px 每度）⇒ 降密不可辨；
 *      而 650m 的 ZONE_VIEW_RANGE + ~200m 的区包围球半径决定了这些区在行车段
 *      **恒在视锥内**，是 sphere 口径峰值的主体。
 *   ③ 保留项（不可砍）：殿/塔/连墙/角塔体量、街面连廊（corridorRun，用户令"连廊"）、
 *      檐口带 corniceBand（FBX Cornice_2 语汇）、券框（只换桶位不删）。
 */
const R34_DENSITY = {
  /** hero 街区数（k < hero 保留全装饰；=2 ⇒ 街区 0/1，落在 z1 门楼正后方） */
  hero: 2,
  /** 非 hero 街区的檐口小尖塔数（原 9 ⇒ 剪影节奏仍在，只是不再每 1.9m 一根） */
  eavePinnacles: 5,
  /** 非 hero 街区的垛口节拍（原 2.4 ⇒ 4.8 减半，垛口总数/连墙长度不变） */
  merlonPitch: 4.8,
  /** 非 hero 街区的墙顶敞廊街区筛选模（原 k%2 ⇒ k%4，敞廊长度不变） */
  cloisterMod: 4
} as const;

/* ═══════════════════ 基础几何 ═══════════════════ */

/**
 * 米制平面 UV：按顶点法线主轴挑投影平面。
 * 用局部**位置**而非 0..1 参数化，是为了让相邻构件的砌缝在世界里连续；
 * 硬切换的接缝落在 90° 棱上（石构件的棱本来就有硬阴影），看不出来。
 */
export function planarUV(geo: THREE.BufferGeometry, tile: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    const nx = nor ? Math.abs(nor.getX(i)) : 0;
    const ny = nor ? Math.abs(nor.getY(i)) : 1;
    const nz = nor ? Math.abs(nor.getZ(i)) : 0;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = x / tile;
      v = z / tile;
    } else if (nx >= nz) {
      u = z / tile;
      v = y / tile;
    } else {
      u = x / tile;
      v = y / tile;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** 轴对齐方块（12 tri）。中心点 + 三边尺寸。
 *  R29：允许 `'dark'`（近黑内衬/窗缝）—— 它不属于石材质族（无 TILE 口径），
 *  UV 只用于占位（dark 材质无贴图），因此给 1.0 兜底即可。 */
export function box(
  kind: CastleKind | 'dark',
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  planarUV(g, kind === 'dark' ? 1 : TILE[kind]);
  return g;
}

/** 绕 z 轴旋转的方块（双坡屋顶 / 辐射金刺）。12 tri。 */
export function boxRot(
  kind: CastleKind,
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
  rotZ: number
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotZ !== 0) g.rotateZ(rotZ);
  g.translate(cx, cy, cz);
  planarUV(g, TILE[kind]);
  return g;
}

/**
 * 多棱锥 / 棱台（尖塔 / 宝瓶柱 / 火盆焰）：锥 = 16 tri（8 面 + 底），棱台（开口）= 16 tri。
 * topRadius ≤ 0 → 圆锥。低配：多棱统一钳到 4 面。
 */
export function spire(
  kind: CastleKind,
  radiusBottom: number,
  radiusTop: number,
  height: number,
  sides: number,
  cx: number,
  cy: number,
  cz: number,
  thetaStart = 0
): THREE.BufferGeometry {
  const s = LOW_DETAIL && sides > 4 ? 4 : sides;
  const g =
    radiusTop <= 0.0001
      ? new THREE.ConeGeometry(radiusBottom, height, s, 1, false, thetaStart)
      : new THREE.CylinderGeometry(radiusTop, radiusBottom, height, s, 1, true, thetaStart);
  g.translate(cx, cy + height / 2, cz);
  planarUV(g, TILE[kind]);
  return g;
}

/**
 * 收分方柱（桥墩束柱 / 灯柱柱身）：4 面棱台，面朝轴（thetaStart = π/4）。
 * r = 宽 / √2（4 边形外接半径 → 面宽）。
 */
export function pierColumn(
  wBottom: number,
  wTop: number,
  h: number,
  cx: number,
  cy: number,
  cz: number
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(
    wTop / Math.SQRT2,
    wBottom / Math.SQRT2,
    h,
    4,
    1,
    true,
    Math.PI / 4
  );
  g.translate(cx, cy + h / 2, cz);
  planarUV(g, TILE.ashlar);
  return g;
}

/** 火焰锥（MeshBasic 发光体，不贴图 ⇒ 不需要 UV）。
 * R32 落地审查（对照 Fab thumbnail.jpg）：参考图火盆在 250m 外仍读出大团暖焰，
 * 原始锥体（r/h 调用值）过小 ⇒ 统一在形状函数内放大 r×1.35 / h×1.4。
 * 顶点数不变（段数固定）⇒ 三口径（全显/zone-visible/渲染）全部零漂移。 */
function flame(r: number, h: number, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r * 1.35, h * 1.4, LOW_DETAIL ? 6 : 8, 1);
  g.translate(cx, cy + (h * 1.4) / 2, cz);
  return g;
}

/* ═══════════════════ 双心尖拱 ═══════════════════ */

/**
 * 双心尖拱点列：x 从 −halfW 到 +halfW，y 从 springY 升到 springY+rise+cusp。
 *
 * `cusp`：**提尖**。纯两心圆在 rise/halfW ≈ 0.7 时顶角还有 ~117°，近看读成"圆肩"。
 * 这里在两心圆基础上叠一个只作用在 |x| < halfW·cuspW 范围内的竖直抬升
 * y += cusp·(1−|x|/W)^1.5：拱顶抬 cusp、肩部不动 ⇒ 顶角收到 ~90°，出明确尖点。
 * **拱顶高度 = springY + rise + cusp，与半径无关**（两心圆的解析性质），
 * 所以内圈（券线）与外圈（券线+band）共享同一拱顶 —— 这是"等厚券线"的前提。
 */
function archByRadius(
  halfW: number,
  springY: number,
  R: number,
  segPerHalf: number,
  cusp = 0,
  cuspW = 0.5
): [number, number][] {
  const c = R - halfW;
  const apexAngle = Math.acos(-c / R);
  const tipW = halfW * cuspW;
  const pts: [number, number][] = [];
  const lift = (x: number): number => {
    if (cusp <= 0) return 0;
    const ax = Math.abs(x);
    if (ax >= tipW) return 0;
    return cusp * Math.pow(1 - ax / tipW, 1.5);
  };
  for (let i = 0; i <= segPerHalf; i += 1) {
    const a = Math.PI + (apexAngle - Math.PI) * (i / segPerHalf);
    const x = c + R * Math.cos(a);
    pts.push([x, springY + R * Math.sin(a) + lift(x)]);
  }
  for (let i = segPerHalf - 1; i >= 0; i -= 1) {
    pts.push([-pts[i][0], pts[i][1]]);
  }
  return pts;
}

export function pointedArch(
  halfW: number,
  springY: number,
  rise: number,
  segPerHalf = 7,
  cusp = 0,
  cuspW = 0.5
): [number, number][] {
  const R = (rise * rise + halfW * halfW) / (2 * halfW);
  return archByRadius(halfW, springY, R, segPerHalf, cusp, cuspW);
}

/**
 * 反解**内圈** rise（御桥旧双层尖拱券廊时代的遗产，R28 扁拱化后不再需要：
 * 扁拱矢高由 VIADUCT.archRise 常量直给）。保留 archByRadius/pointedArch 供
 * 城门/钟楼/主殿的尖拱件使用（那些仍是两心圆尖拱）。
 */

/** ExtrudeGeometry 收尾：补法线 + 米制 UV（尖拱件共用） */
export function finishArch(g: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  g.computeVertexNormals();
  planarUV(g, tile);
  return g;
}

/**
 * 拱上墙 ＝「以尖拱为下边界的墙」。不用 Shape.holes 挖洞：拱洞直通地面时洞与轮廓
 * 在底边相接 ⇒ 退化，earcut 会吐零面积三角形。
 * 剖面在 x-y 平面，**沿 −z 挤出**（0 → −depth）。
 */
function archWall(
  halfW: number,
  springY: number,
  topY: number,
  rise: number,
  depth: number,
  segPerHalf = 7,
  cusp = 0,
  cuspW = 0.5
): THREE.BufferGeometry {
  const arch = pointedArch(halfW, springY, rise, segPerHalf, cusp, cuspW);
  const shape = new THREE.Shape();
  shape.moveTo(arch[0][0], arch[0][1]);
  for (let i = 1; i < arch.length; i += 1) shape.lineTo(arch[i][0], arch[i][1]);
  shape.lineTo(halfW, topY);
  shape.lineTo(-halfW, topY);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.translate(0, 0, -depth);
  return finishArch(geo, TILE.ashlar);
}

/**
 * 拱上墙 · 坐在**券线外缘**上（御桥 spandrel 用）：下边界 = 外圈拱曲线
 * （与 archBand 同一组圆心/半径，R+band），顶到 topY。
 * archWall（下边界 = 内圈曲线）用于城门主体——那里的下边界就是门洞开口本身。
 */
function archWallOuter(
  halfW: number,
  springY: number,
  topY: number,
  rise: number,
  band: number,
  depth: number,
  segPerHalf = 7,
  cusp = 0,
  cuspW = 0.5
): THREE.BufferGeometry {
  const R = (rise * rise + halfW * halfW) / (2 * halfW);
  const outer = archByRadius(halfW + band, springY, R + band, segPerHalf, cusp, cuspW);
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i += 1) shape.lineTo(outer[i][0], outer[i][1]);
  shape.lineTo(halfW + band, topY);
  shape.lineTo(-(halfW + band), topY);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.translate(0, 0, -depth);
  return finishArch(geo, TILE.ashlar);
}

/** 券线（archivolt）：沿拱背的等厚环带（外圈与内圈共享拱顶 ⇒ 真等厚）。 */
export function archBand(
  halfW: number,
  springY: number,
  rise: number,
  band: number,
  depth: number,
  segPerHalf = 7,
  cusp = 0,
  cuspW = 0.5
): THREE.BufferGeometry {
  const R = (rise * rise + halfW * halfW) / (2 * halfW);
  const inner = archByRadius(halfW, springY, R, segPerHalf, cusp, cuspW);
  const outer = archByRadius(halfW + band, springY, R + band, segPerHalf, cusp, cuspW);
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i += 1) shape.lineTo(outer[i][0], outer[i][1]);
  shape.lineTo(inner[inner.length - 1][0], inner[inner.length - 1][1]);
  for (let i = inner.length - 2; i >= 0; i -= 1) shape.lineTo(inner[i][0], inner[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.translate(0, 0, -depth);
  return finishArch(geo, TILE.ashlar);
}

/** 实心尖拱板（尖拱窗背板 / 盲龛底）：y 从 0 起、顶到 springY+rise+cusp。 */
export function archPlate(
  halfW: number,
  springY: number,
  rise: number,
  depth: number,
  segPerHalf = 6,
  cusp = 0
): THREE.BufferGeometry {
  const arch = pointedArch(halfW, springY, rise, segPerHalf, cusp);
  const shape = new THREE.Shape();
  shape.moveTo(-halfW, 0);
  shape.lineTo(arch[0][0], arch[0][1]);
  for (let i = 1; i < arch.length; i += 1) shape.lineTo(arch[i][0], arch[i][1]);
  shape.lineTo(halfW, 0);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.translate(0, 0, -depth);
  return finishArch(geo, TILE.wall);
}

/** 券线 · x 向居中挤出版（御桥用）。 */
function archBandX(
  halfW: number,
  springY: number,
  rise: number,
  band: number,
  depth: number,
  segPerHalf = 7,
  cusp = 0,
  cuspW = 0.5
): THREE.BufferGeometry {
  const g = archBand(halfW, springY, rise, band, depth, segPerHalf, cusp, cuspW);
  g.rotateY(Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  return g;
}

/** 拱上墙（外缘版）· x 向居中挤出版（御桥 spandrel 用）。 */
function archWallOuterX(
  halfW: number,
  springY: number,
  topY: number,
  rise: number,
  band: number,
  depth: number,
  segPerHalf = 7,
  cusp = 0,
  cuspW = 0.5
): THREE.BufferGeometry {
  const g = archWallOuter(halfW, springY, topY, rise, band, depth, segPerHalf, cusp, cuspW);
  g.rotateY(Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  return g;
}

/**
 * ── R30 清理 ───────────────────────────────────────────────────────────────
 * `archPlateX`（x 向居中挤出的实心尖拱板）随 lancetWindowX 整族删除而失去唯一
 * 调用点（尖拱窗背板改走 castleDetail.traceryWindow 的 archPlate + 局部旋转），
 * 按 noUnusedLocals 纪律一并删除；`archBandX` / `archWallOuterX` 仍被御桥主券/
 * 侧拱占用（保留）。
 */

/* ═══════════════════ ① 御桥：扁拱 + 双层桥面 + 通天柱列 ═══════════════════ */

/**
 * 御桥结构（24 跨，静态全进 ashlar/gold 桶）。
 *
 * ── R28 形制更正（A：FBX R28-T2 精测，判废 R27 的双层尖拱券廊）────────────
 * Mesh.486 实测：主券是**单心圆弧扁拱**（净跨 51 / 矢高 13.37 / R=2.03 归一化
 * rms 3mm ⇒ 矢跨比 0.26），**下层券廊不存在**——是「双层桥面（+11.4/−20）+
 * 单层拱廊 + 通天柱列落谷底（y=−224.23）」。比例层换算（×0.2822）：
 *   起拱线 −8.06 / 拱顶 −4.28 / 下层桥面 −8.86 / 墩宽 3.05 / 桥下净高 66.5。
 * 尖拱族函数在 rise < halfW 时解析退化为单心圆弧（apexAngle < 90°），
 * cusp=0 即扁拱，无需新几何器。
 *
 * 横断面（x > 0 侧，桥面 y=0）：
 *   |x| ≤ 7.4   车行带（深色铺装，归 makePaving）
 *   7.8..16.6   步道（白色铺装，归 makePaving）
 *   中央区 x∈[−7.8,7.8]：主券扁拱（起拱 −8.06 / 拱顶 −4.28）+ spandrel 填到桥面
 *   侧区 x∈[7.6,16.6]：同形制侧拱（侧区读数与参考图 2497fab5/3d084b59 的单排
 *                      大拱一致；「双层」读法由下层桥面横带承担，非双层券廊）
 *   墩位（z 站）：4 束柱从谷底（−66）通天到起拱线，墩头封到桥面
 *   每站桥脸 1 枚叶形金垂饰（G5 identity）
 */
export function makeViaduct(): StoneBuckets {
  const b = emptyBuckets();
  const span = (VIADUCT.zNear - VIADUCT.zFar) / VIADUCT.spans; // 17.4375
  const half = span / 2; // 8.71875
  const bedY = -VIADUCT.gorgeDepth + 0.5; // 墩脚埋在谷底之上 0.5m

  /* ── 扁拱几何参数（cusp=0：单心圆弧；rise/矢高由常量直给）── */
  const archSpring = -VIADUCT.archSpringDrop; // −8.06（起拱线）
  const archCrown = -VIADUCT.archCrownDrop; // −4.28（拱顶）
  const rise = archCrown - archSpring; // 3.77（矢高）
  const slabTop = archSpring; // 下层桥面顶 = 起拱线（拱从桥面顶起拱）
  const slabBottom = -VIADUCT.secondTierDrop; // −8.86
  const band = 1.1;
  const mainDepth = 2 * (7.4 + 0.4); // 15.6（略宽于车行带）
  const sideIn = 7.6;
  const sideOut = VIADUCT.totalHalf - 0.12; // 16.6
  const sideDepth = sideOut - sideIn; // 9.0
  const sideMid = (sideIn + sideOut) / 2; // 12.1（侧墩束中心）

  for (let k = 0; k < VIADUCT.spans; k += 1) {
    const zc = VIADUCT.zNear - (k + 0.5) * span; // 开间中心
    // 中央主券：ashlar 券带 + 金饰线 + spandrel（坐在券线外缘上 → 铺装面）
    b.ashlar.push(archBandX(half, archSpring, rise, band, mainDepth, 9, 0).translate(0, 0, zc));
    b.gold.push(archBandX(half + band, archSpring, rise, 0.16, mainDepth, 9, 0).translate(0, 0, zc));
    b.ashlar.push(archWallOuterX(half, archSpring, 0, rise, band, mainDepth, 9, 0).translate(0, 0, zc));
    for (const side of [-1, 1] as const) {
      // 侧区扁拱 + 金饰线 + spandrel（外缘 → y=0）
      b.ashlar.push(archBandX(half, archSpring, rise, band, sideDepth, 9, 0).translate(side * sideMid, 0, zc));
      b.gold.push(archBandX(half + band, archSpring, rise, 0.16, sideDepth, 9, 0).translate(side * sideMid, 0, zc));
      b.ashlar.push(archWallOuterX(half, archSpring, 0, rise, band, sideDepth, 9, 0).translate(side * sideMid, 0, zc));
    }
  }

  /* ── 下层桥面（双层读法来源）：通长横带，顶 = 起拱线、底 = secondTierDrop ── */
  {
    const zLen = VIADUCT.zNear - VIADUCT.zFar;
    const zMid = (VIADUCT.zNear + VIADUCT.zFar) / 2;
    const slabH = slabTop - slabBottom; // 0.8
    b.ashlar.push(box('ashlar', 2 * VIADUCT.totalHalf, slabH, zLen, 0, slabBottom + slabH / 2, zMid));
    // 桥脸金线（下层桥面外棱一道，读作"分层线"）
    for (const side of [-1, 1] as const) {
      b.gold.push(box('gold', 0.14, 0.1, zLen, side * (VIADUCT.totalHalf - 0.07), slabBottom + 0.12, zMid));
    }
  }

  /* ── 墩（通天束柱 + 墩头）：spans+1 个站，z 从 zNear 到 zFar ── */
  const colW = (VIADUCT.pierW - 3 * 0.12) / VIADUCT.pierColumns; // 0.67（pierW 3.05）
  const taper = VIADUCT.pierTaper; // 0.93
  // 末站（k=spans，z=−358.5）落在城门进深里：中央束柱+墩头会捅进门洞隧道
  // （车从 −351.5 穿到 −365.5，|x|≤1.8 的柱群正在路中间）⇒ 中央墩整站不建。
  for (let k = 0; k <= VIADUCT.spans; k += 1) {
    const zs = VIADUCT.zNear - k * span;
    const inGate = Math.abs(zs - VIADUCT.zFar) < 1e-6;
    for (let c = 0; c < VIADUCT.pierColumns; c += 1) {
      const off = (c - (VIADUCT.pierColumns - 1) / 2) * (colW + 0.12);
      // 侧墩：谷底 → 起拱线（通天柱列，FBX 落 y=−224 的比例层）
      b.ashlar.push(pierColumn(colW, colW * taper, slabTop - bedY, sideMid + off, bedY, zs));
      b.ashlar.push(pierColumn(colW, colW * taper, slabTop - bedY, -(sideMid + off), bedY, zs));
      // 中央墩：谷底 → 起拱线；末站让位门洞
      if (!inGate) b.ashlar.push(pierColumn(colW, colW * taper, slabTop - bedY, off, bedY, zs));
    }
    // 束柱金环（G5 束柱读法的关键）：每侧墩顶 + 墩中两道金箍，把「整片墙」读回「细柱束」
    for (const sx of [-sideMid, sideMid]) {
      b.gold.push(box('gold', sideDepth + 0.2, 0.2, 0.22, sx, slabTop - 0.15, zs));
      b.gold.push(box('gold', sideDepth + 0.2, 0.18, 0.2, sx, slabTop * 0.55, zs));
    }
    if (!inGate) {
      b.gold.push(box('gold', mainDepth + 0.2, 0.2, 0.22, 0, slabTop - 0.15, zs));
    }
    // 墩头：把站位的券口封成"实心弓"——从下层桥面底一直到铺装面
    // （起拱线在墩头里，可见开口从墩头面起算，不会出现悬空券端）
    b.ashlar.push(box('ashlar', sideDepth, -slabBottom, 2.2, sideMid, slabBottom / 2, zs));
    b.ashlar.push(box('ashlar', sideDepth, -slabBottom, 2.2, -sideMid, slabBottom / 2, zs));
    if (!inGate) b.ashlar.push(box('ashlar', mainDepth, -slabBottom, 2.2, 0, slabBottom / 2, zs));
    // 叶形金垂饰（G5 identity）：墩头桥脸正中，檐下一枚下垂金叶
    for (const side of [-1, 1] as const) {
      const leaf = spire('gold', 0.34, 0.05, 0.85, 6, side * (sideOut - 0.35), -1.6, zs, Math.PI);
      b.gold.push(leaf);
      b.gold.push(box('gold', 0.5, 0.12, 0.5, side * (sideOut - 0.35), -0.95, zs));
    }
  }
  return b;
}

/* ═══════════════════ ② 栏板（2.2m 金顶） ═══════════════════ */

/**
 * 栏板：双侧连续，z ∈ [VIADUCT.zNear, 城门脸 **−351.5**]，中心线 x = **±12.24**。
 * ⚠ 两处数值都是 R37 按现值订正的（原写 x = ±16.36 是 R29 桥面收窄
 *   totalHalf 16.72 → 12.6 **之前**的过期读数；照旧值摆饰件会飘到桥外 4m 空中）。
 * 结构（自下而上）：2 层基座梁 → 圆柱瓶柱（r 0.13，节拍 1.63）→ 中横梁 →
 * 金压顶（0.18）→ 每跨一枚金徽章（菱形 1.3 高 + 金尖，坐在墩位上方）。
 * 全静态合并：基座/横梁/压顶是通长条件（12 tri/侧/层），瓶柱按节拍逐根推入
 * （ashlar 桶），徽章推 gold 桶。
 */
export function makeParapet(): StoneBuckets {
  const b = emptyBuckets();
  const zNear = VIADUCT.zNear;
  const zFar = GATE.z + GATE.depth / 2; // 城门脸 −351.5
  const len = zNear - zFar;
  const zMid = (zNear + zFar) / 2;
  // ⚠ R37-A 更正：此处原注「16.36」是 R29 桥面收窄（totalHalf 16.72 → **12.6**）
  // 之前的**过期读数**，本轮按现值订正为 12.24。别再拿 16.36 当栏板线用 ——
  // 那会把灯具/饰件摆到桥面外 4m 的空中（数值实测见 tests/r37_castle.test.ts）。
  const x = VIADUCT.totalHalf - 0.36; // 12.24（比桥沿内收 0.36）
  const { h, pitch, postRadius, capH, emblemH } = PARAPET;

  // 基座两层（plinthLayers）：0..0.28 / 0.28..0.50
  const plinthH = 0.5;
  const layerH = plinthH / PARAPET.plinthLayers;
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < PARAPET.plinthLayers; i += 1) {
      const w = 0.72 - i * 0.14; // 下层略宽（叠涩收分）
      const y0 = i * layerH;
      b.ashlar.push(box('ashlar', w, layerH, len, side * x, y0 + layerH / 2, zMid));
    }
    // 中横梁（瓶柱中段，读作"有栏丝"而不是一排裸柱）
    b.ashlar.push(box('ashlar', 0.5, 0.12, len, side * x, 1.3, zMid));
    // 金压顶
    b.gold.push(box('gold', 0.8, capH, len, side * x, h - capH / 2, zMid));
  }

  // 瓶柱：圆柱 r 0.13，节拍 pitch，从基座顶到压顶底
  const postH = h - plinthH - capH; // 1.52
  const count = Math.floor(len / pitch);
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < count; i += 1) {
      const z = zNear - 0.8 - i * pitch;
      if (z < zFar + 0.4) break;
      b.ashlar.push(
        new THREE.CylinderGeometry(postRadius, postRadius, postH, LOW_DETAIL ? 6 : 8, 1, true)
      );
      const g = b.ashlar[b.ashlar.length - 1];
      g.translate(side * x, plinthH + postH / 2, z);
      planarUV(g, TILE.ashlar);
    }
  }

  // 金徽章：每跨一枚（坐在墩位上方栏板中央）。菱形 = 方板绕 z 转 45°，
  // 对角线 = 板边长 × √2 ⇒ 板边长取 emblemH/√2 时竖向对角线正好 emblemH。
  const span = (VIADUCT.zNear - VIADUCT.zFar) / VIADUCT.spans;
  const plate = emblemH / Math.SQRT2; // 0.92
  for (let k = 0; k < VIADUCT.spans; k += 1) {
    const zs = VIADUCT.zNear - k * span;
    if (zs > zNear - 0.5 || zs < zFar + 0.5) continue;
    for (const side of [-1, 1] as const) {
      const parts: THREE.BufferGeometry[] = [];
      const d = box('gold', plate, plate, 0.14, 0, 0, 0);
      d.rotateZ(Math.PI / 4);
      parts.push(d);
      parts.push(spire('gold', 0.09, 0, 0.42, 6, 0, plate / 2 + 0.02, 0));
      const emblem = mergeSafe(parts);
      parts.forEach((p) => p.dispose());
      emblem.translate(side * x, plinthH + emblemH / 2, zs);
      b.gold.push(emblem);
    }
  }

  /* ── R32 桥栏杆精化（参考图 B：柱顶金箍环 + 柱间低石栏板嵌间歇金条）────────
   * ① 低石栏板：基座顶（0.5）→ 中横梁（1.3）之间的 0.62m 矮板，通长每侧 1 条
   *    （12 tri/侧）——「柱间低栏板」读法，原来瓶柱之间是空的；
   * ② 间歇金条：栏板外棱每 3 根柱距（≈4.9m）一条小金条（12 tri/条）；
   * ③ 柱顶金箍环：每 3 根瓶柱一道 6 面金箍（12 tri/道）——参考图「柱顶金箍环」，
   *    全铺 ≈+8k tri 超预算，故隔 2 根布置（节拍仍在）。 */
  for (const side of [-1, 1] as const) {
    b.ashlar.push(box('ashlar', 0.34, 0.62, len, side * x, 0.5 + 0.31, zMid));
    const stripPitch = pitch * 3;
    const strips = Math.floor(len / stripPitch);
    for (let i = 0; i < strips; i += 1) {
      const sz = zNear - 1.2 - i * stripPitch;
      if (sz < zFar + 0.5) break;
      b.gold.push(box('gold', 0.12, 0.3, 0.44, side * (x + 0.1), 0.5 + 0.31, sz));
    }
    for (let i = 0; i < count; i += 3) {
      const z = zNear - 0.8 - i * pitch;
      if (z < zFar + 0.4) break;
      b.gold.push(spire('gold', postRadius + 0.05, postRadius + 0.05, 0.14, 6, side * x, plinthH + postH, z));
    }
  }

  /* ── R32 桥栏火盆（WCArchBraizer 3.18×3.88×2.77 比例层；参考图 B 桥两侧
   * 栏杆柱顶 6–8 盏/侧暖金火盆）：白石墩座 + 金碗盆 + 盆口沿 + 尖焰。
   * 立在栏板压顶之上（y 2.6 起），|x| = 栏板线 ⇒ 不进行车道、不侵走廊。 */
  {
    const n = R32_BRAZIER.perSide;
    const bzLen = R32_BRAZIER.zIn - R32_BRAZIER.zOut;
    for (let i = 0; i < n; i += 1) {
      const cz = R32_BRAZIER.zIn - (bzLen * (i + 0.5)) / n;
      for (const side of [-1, 1] as const) {
        const cx = side * R32_BRAZIER.x;
        b.ashlar.push(box('ashlar', 0.72, 0.5, 0.72, cx, 2.6 + 0.25, cz)); // 石墩座
        b.gold.push(spire('gold', 0.26, 0.44, R32_BRAZIER.bowlH, 8, cx, 3.1, cz)); // 金碗盆（下收口）
        b.gold.push(spire('gold', 0.48, 0.48, 0.12, 8, cx, 3.1 + R32_BRAZIER.bowlH, cz)); // 盆口沿
        b.flame.push(flame(0.3, R32_BRAZIER.flameH, cx, 3.1 + R32_BRAZIER.bowlH + 0.12, cz));
      }
    }
  }

  /* ── R37-A 引桥烛台式壁灯（参考图「引桥两侧烛台式发光壁灯」）──────────────────
   * 与既有 R32 桥栏火盆（**落地墩座 + 金碗盆**，7 盏/侧、间距 ~53m、坐在压顶之上）
   * 是**两种不同灯具**，不要混：
   *   · 火盆 = 陈设（大、稀、在栏板顶上）；
   *   · 壁灯 = **挂在栏板外壁的烛台**（小、密、贴在栏杆柱节拍上），
   *     参考图读作「引桥两侧一排连续的暖光点」，是御桥夜景的节奏来源。
   * 故本段**新增**壁灯而不是改火盆参数。
   *
   * 布置纪律（踩坑防护）：
   *   · **显式 for 循环逐座 push**，绝不用任何 `distribution` 字段 —— 生成器不读
   *     该字段，写下去会被静默读空 ⇒ 全部实例 position=(0,0,0)（历史事故：394 实例
   *     /75,648 面全毁）。每座的 x/y/z 都由下面的算式显式给出。
   *   · 合批：几何直接进 gold / flame 桶（桶内 mergeSafe 合批）⇒ **0 新增 mesh/DC**；
   *     两桶都是既有桶，gold 走 6 区分区、flame 全局 1 mesh。
   *   · 数量硬上限 12 座（6 盏/侧），间距 10.5m，z = **−349.5 / −339 / −328.5 /
   *     −318 / −307.5 / −297**（实测，城门近段）—— 那里是御桥的 hero 读段；
   *     不铺满 423m 全桥（那要 ~40 座，超上限）。
   *
   * ⚠⚠ 峰值点（carZ=−500）的实际开销 —— **本条原注释写错，R37 落地审查 P2-2 后重写**。
   *   原注：「壁灯落 z1 区 ⇒ 峰值点已被剔除、零影响」。这句**两头都不准**：
   *     ① 12 座并非全落 z1：只有最北那**1 站**（z=−349.5，两侧共 2 座）在 z1
   *        （−462..−340）；其余 **5 站 10 座**落在 **z0**（60..−340）。
   *     ② 「距区心 360m < ZONE_VIEW_RANGE 650 ⇒ 可见」这个推理**混淆了两件事** ——
   *        ZONE_VIEW_RANGE 只管 `mesh.visible`（距离显隐），**递交量还要过视锥剔除**。
   *   Node 实测（与渲染器同源的 boundingSphere + intersectsSphere，carZ=−500）：
   *     · `castle-gold-z0`：vis=**true** 但 **inFrustum=false** —— 包围球 cz=−149 /
   *       r=210，相机在 z=−491.8 朝 −Z ⇒ 整个球落在相机**后方**，被视锥剔除。
   *       ⇒ z0 那 10 座金件在峰值点**确实不计**（原结论方向对，但理由不是"距离"）。
   *     · `castle-gold-z1`：**inFrustum=true**（cz=−401 / r=168）⇒ z=−349.5 那
   *       2 座的金件（≈96 tri）**计入峰值**。
   *     · `castle-flame`：**全局桶**（cz=−638 / r=677）恒在锥内 ⇒ 12 座的焰
   *       （12 × 24 = **192 tri**）**恒计入峰值**，且计入**每一个**采样点。
   *   ⇒ 峰值点真实增量 ≈ **288 tri**（96 金 + 192 焰），既不是 0、也不是全额 672。
   *     672 全额里约 384 tri 只在 z0 前方的采样点（z=+40/0/−200）才计入。
   *   结论不变（预算仍过：峰值 190,322 ≤ 200,000），但**论证已换成实测**。 */
  {
    const { perSide, spacing, zStart, y, out } = R37_SCONCE;
    for (let i = 0; i < perSide; i += 1) {
      // ⚠ 方向：御桥段 z 从 zNear（≈+61，北端）**递减**到城门脸 **−351.5**。
      //   故「从城门往北铺」= z **递增**（zStart + i·spacing）；写成 zStart − i·spacing
      //   会一路穿进城内（从 −349.5 起算，第 2~6 座落在 z **−360..−402**，已在城门之后
      //   的城内段，壁灯会浮在街屋里面）⇒ 判据已写进 tests/r37_castle.test.ts 的御桥 z 段断言。
      const cz = zStart + i * spacing;
      for (const side of [-1, 1] as const) {
        const wall = side * (x + out); // 贴栏板外壁（比栏板中心线外挪 out）
        // ① 壁座（贴墙方板）
        b.gold.push(box('gold', 0.1, 0.34, 0.3, wall, y, cz));
        // ② 曲臂（从壁座横向挑出）
        b.gold.push(box('gold', 0.26, 0.08, 0.08, side * (x + out + 0.13), y + 0.06, cz));
        // ③ 烛杯（下收上敞的浅杯）
        b.gold.push(spire('gold', 0.07, 0.13, 0.14, 6, side * (x + out + 0.26), y + 0.14, cz));
        // ④ 蜡烛（细柱）
        b.gold.push(box('gold', 0.09, 0.24, 0.09, side * (x + out + 0.26), y + 0.26, cz));
        // ⑤ 焰（emissive，靠 bloom 出光晕）
        b.flame.push(flame(0.1, 0.3, side * (x + out + 0.26), y + 0.4, cz));
      }
    }
  }
  return b;
}

/* ═══════════════════ ③ 铺装（三带：深车行带 + 浅边带 + 白步道） ═══════════════════ */

export interface PavingKit {
  /** 车行带（深色 floor 材质 + vertexColor 分档）—— 1 mesh */
  road: THREE.BufferGeometry;
  /** 步道（白 ashlar 材质）—— 1 mesh */
  walk: THREE.BufferGeometry;
}

/** 给几何写一个恒定顶点色（同一材质内的明暗分档） */
function paintColor(geo: THREE.BufferGeometry, v: number): void {
  const count = (geo.getAttribute('position') as THREE.BufferAttribute).count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    arr[i * 3] = v;
    arr[i * 3 + 1] = v;
    arr[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** 平面 + 米制 UV（一张 floor 贴图 = tile 米） */
function pavePlane(
  w: number,
  d: number,
  y: number,
  cx: number,
  cz: number,
  tile: number
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, cz);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * d) / tile);
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * 铺装。参考图 7cd7329c 桥面是**三段等分**：中间深色车行带 + 两侧浅色条石边带
 * （各 ≈1/3 路宽）；步道（人行道）是白色 ashlar。
 *   road：|x| ≤ 7.4，z ∈ [260, MAIN_HALL.z=−1300]（起步点后方 → 主殿正面=撞击面，
 *         R28 路端统一收口：旧 −1400 判废，其后由主殿遮挡，不做尽头截断）
 *   walk：桥上段 |x| ∈ [7.8, 16.6]（z ∈ [60, 城门脸]）；城内段 |x| ∈ [7.8, 15.4]
 *        （城门隧道内 7.8..10 是隧道地面，10..15.4 埋进门墩，城外无步道）
 */
export function makePaving(): PavingKit {
  const roadParts: THREE.BufferGeometry[] = [];
  const walkParts: THREE.BufferGeometry[] = [];
  const paveTile = STONE_TILE_METERS.floor * 2; // 9.6m/张 ⇒ 石板缝 ≈2.4m
  const walkTile = STONE_TILE_METERS.ashlar; // 2.8m/张
  const roadNear = 260;
  const roadFar = MAIN_HALL.z; // −1300（R28：主殿正面收口，替代旧 −1400）
  const roadLen = roadNear - roadFar;
  const roadMid = (roadNear + roadFar) / 2;
  const edgeW = ROAD_W / 3; // 4.93（三段等分）
  const y = 0.012; // 路面之上 12mm（polygonOffset 双保险）

  // 车行带 + 浅色边带（同一材质，vertexColor 分档）
  const center = pavePlane(ROAD_W - 2 * edgeW, roadLen, y, 0, roadMid, paveTile);
  paintColor(center, 0.62); // 深带（材质基色已是深炭灰，再乘 0.62）
  roadParts.push(center);
  for (const side of [-1, 1] as const) {
    const g = pavePlane(edgeW, roadLen, y, side * (ROAD_W / 2 - edgeW / 2), roadMid, paveTile);
    paintColor(g, 1.28); // 浅带（逆光下 1.55 会过曝成纯白，1.28 是 r26c 实测值）
    roadParts.push(g);
  }

  // 步道：桥上段（到桥沿 16.6）+ 城内段（到建筑前脸 15.4）
  const gateFront = GATE.z + GATE.depth / 2; // −351.5
  const bridgeLen = VIADUCT.zNear - gateFront;
  walkParts.push(
    pavePlane(VIADUCT.totalHalf - 7.8, bridgeLen, 0.014, (7.8 + VIADUCT.totalHalf) / 2, (VIADUCT.zNear + gateFront) / 2, walkTile)
  );
  const innerLen = gateFront - roadFar;
  walkParts.push(
    pavePlane(INNER.faceHalf - 7.8, innerLen, 0.014, (7.8 + INNER.faceHalf) / 2, (gateFront + roadFar) / 2, walkTile)
  );

  return {
    road: mergeSafe(roadParts),
    walk: mergeSafe(walkParts)
  };
}

/* ═══════════════════ ④ 火盆灯柱 ═══════════════════ */

/**
 * 火盆灯柱：节拍 44m 双侧，x = ±(totalHalf − inset)。全高 8.6m（R28 由 7.5 上调，
 * V §7.1 灯柱总高 1.75×W_kit ≈ 8.6；参考图里灯柱是强立面存在）。
 * 形制（G3 identity，R28 重做）：
 *   3 级白石墩座 → **白石圆柱身**（主柱 + 四角小束柱 = 束柱观感，**不是金锥体**）
 *   → 金箍带 ×3 → **金碗形火盆**（上口大、向下收口 + 口沿金圈）→ **尖焰**（上尖下宽）。
 * 石件进 ashlar、火盆进 gold、火焰进 flame（MeshBasic 靠 bloom）。
 */
export function makeLamps(): StoneBuckets {
  const b = emptyBuckets();
  const x = VIADUCT.totalHalf - LAMP.inset; // 16.17
  const zNear = VIADUCT.zNear - 22; // 38
  const zFar = GATE.z + GATE.depth / 2; // −351.5（城门内不立灯）
  const { h, poleW, braizerH, flameH, bandCount } = LAMP;
  const baseH = 1.2;
  const rimH = 0.13;
  const shaftTop = h - braizerH - rimH - flameH; // 6.57（柱身顶 = 火盆底）
  const shaftH = shaftTop - baseH; // 5.37

  for (let z = zNear; z > zFar; z -= LAMP.pitch) {
    for (const side of [-1, 1] as const) {
      const cx = side * x;
      // 3 级白石墩座
      b.ashlar.push(box('ashlar', 1.15, 0.35, 1.15, cx, 0.175, z));
      b.ashlar.push(box('ashlar', 0.82, 0.55, 0.82, cx, 0.625, z));
      b.ashlar.push(box('ashlar', 0.95, 0.3, 0.95, cx, 1.05, z));
      // 白石圆柱身：主圆柱 + 四角小束柱（束柱观感，参考图 2a302891 实证）
      const main = new THREE.CylinderGeometry(poleW * 0.62, poleW * 0.68, shaftH, LOW_DETAIL ? 6 : 10, 1, true);
      main.translate(cx, baseH + shaftH / 2, z);
      planarUV(main, TILE.ashlar);
      b.ashlar.push(main);
      for (const ox of [-1, 1] as const) {
        for (const oz of [-1, 1] as const) {
          const g = new THREE.CylinderGeometry(0.15, 0.17, shaftH, 6, 1, true);
          g.translate(cx + ox * poleW * 0.42, baseH + shaftH / 2, z + oz * poleW * 0.42);
          planarUV(g, TILE.ashlar);
          b.ashlar.push(g);
        }
      }
      // 柱身金箍带 ×3（V：束柱观感的金箍 2~3 道）
      for (let i = 0; i < bandCount; i += 1) {
        const by = baseH + (shaftH * (i + 0.5)) / bandCount;
        b.gold.push(spire('gold', poleW * 0.8, poleW * 0.74, 0.14, 10, cx, by, z));
      }
      // 金碗形火盆：上口大（r 0.62）向下收口（r 0.30）——碗，不是锥（G3）
      b.gold.push(spire('gold', 0.3, 0.62, braizerH, 10, cx, shaftTop, z));
      b.gold.push(spire('gold', 0.68, 0.68, rimH, 10, cx, shaftTop + braizerH, z)); // 盆口沿金圈
      // 尖焰（上尖下宽，2400K 发光由材质/FLAME 色板承担）
      b.flame.push(flame(0.4, flameH, cx, shaftTop + braizerH + rimH, z));
    }
  }
  return b;
}

/* ═══════════════════ ⑤ 城门楼 ═══════════════════ */

/**
 * 城门楼（GATE 常量）：中心 z=−358.5，前脸朝 +z（来车方向），进深 14m 隧道。
 * 构成：中央尖拱门洞（20×30，dark 内衬 + 三层金券）→ 拱上白石体量（→44m）→
 * 双塔墩（|x| ∈ [10,17.5]，高 42，垛口 + 尖拱窗 + 金线 + 角小尖塔）→
 * 中央尖塔（44→55）+ 金饰圆盘 + 拱脚金饰带 + 火盆。
 */
export function makeGate(): StoneBuckets {
  const b = emptyBuckets();
  setDeepFar(false);
  const { z, openW, openH, archivoltBandH, halfW, depth } = GATE;
  const openHalf = openW / 2; // 10
  const halfD = depth / 2; // 7
  const zFront = z + halfD; // −351.5
  const zBack = z - halfD; // −365.5
  const cusp = 1.5;
  const rise = openH - cusp; // 28.5
  const towerW = halfW - openHalf; // 7.5
  const towerH = 42;
  const massTop = 44;
  const zMid = (zFront + zBack) / 2;

  // ── 门洞内衬（dark）：比石拱小 0.15 的同心拱管，前 0.2m 之后全黑 ⇒ 深门层次
  const liner = archBand(openHalf - 0.15, 0, rise, 0.3, depth, 10, cusp, 0.35);
  liner.translate(0, 0, zFront);
  b.dark.push(liner);

  // ── R32 门洞隧道木梁天花（wood 桶：驱车穿门抬头可见的暴露木构读法）：
  //    8 根横梁沿进深 1.65m 节拍，y≈28.2（远高于车顶 1.85 ⇒ 不侵走廊铁律）。
  for (let i = 0; i < 8; i += 1) {
    extra(b, 'wood', box('wood', openW - 1.5, 0.5, 0.5, 0, 28.2, zFront - 0.9 - i * 1.65));
  }

  // ── R36-A2 城门门扇（inner-wood 变体桶）：大门敞开，两扇巨型木门折靠门洞侧墙。
  //    尖拱剖面（springing ±10/0、apex 0/28.5+1.5 ⇒ 弧心 −35.6、半径 45.6）在
  //    |x|=9.06 处净高 ≈9.2m ⇒ 门高 7m 不穿拱；门厚 0.28 贴 liner（9.55）内侧留
  //    ≥21cm；|x| ≥ 9.06 > 8 走廊铁律不侵。门面朝路心（∓x）。门钉/徽章走
  //    gilded-aged（agedGold 桶）。每扇 ≈204 tri ×2。
  for (const side of [-1, 1] as const) {
    pour(
      b,
      mapParts(doorLeaf({ w: 8, h: 7 }), (g) => g.rotateY(-side * Math.PI / 2).translate(side * 9.2, 0, zFront - 4))
    );
  }

  // ── 中央石体量：以门洞拱形为下边界，顶到 massTop
  const mass = archWall(openHalf, 0, massTop, rise, depth, 10, cusp, 0.35);
  mass.translate(0, 0, zFront);
  b.ashlar.push(mass);
  // 体量顶檐口两层 + 中央尖塔（44 → 55 = totalH）+ 金宝顶
  // R33：中央塔冠改 crookedSpire（层叠卷叶金冠 + 金尖）；h=7.3 时实际冠高
  // 1.42×7.3≈10.4，仍收在 totalH=55 —— 不抬高门楼总高，只把「单一三角锥」换成
  // 参考图的「白石冠座 + 卷叶金钉 + 金尖」语汇。低配自动只保留锥身/金尖。
  b.ashlar.push(box('ashlar', openW + 1.4, 0.6, depth + 1.4, 0, massTop + 0.3, zMid));
  pour(
    b,
    mapParts(crookedSpire({ w: 2.8, h: 7.3, leaves: true }), (g) => g.translate(0, massTop + 0.6, zMid))
  );

  // ── 双塔墩
  for (const side of [-1, 1] as const) {
    const cx = side * (openHalf + towerW / 2); // ±13.75
    // 台基：宽度取 towerW（原 +1.2 会内挑 0.6m 进门洞净空，门洞下沿留豁口）
    b.ashlar.push(box('ashlar', towerW, 1.0, depth + 1.2, cx, 0.5, zMid));
    b.ashlar.push(box('ashlar', towerW, towerH, depth, cx, towerH / 2, zMid)); // 塔身
    // 塔顶檐口 + 垛口（尖顶 merlon：方块 + 4 面小尖帽）
    b.ashlar.push(box('ashlar', towerW + 0.6, 0.5, depth + 0.6, cx, towerH - 0.25, zMid));
    const merlonStep = (towerW - 0.6) / 4;
    for (let i = 0; i < 5; i += 1) {
      const mx = cx + (-towerW / 2 + 0.3 + (merlonStep * i));
      b.ashlar.push(box('ashlar', merlonStep * 0.62, 1.1, 1.3, mx, towerH + 0.55, zFront - 0.9));
      b.ashlar.push(spire('ashlar', 0.32, 0, 0.5, 4, mx, towerH + 1.1, zFront - 0.9));
    }
    // 塔面花格窗 ×2（R30 换装：金框 + 双棂 + 拱肩光 = 120 tri/扇；塔脸朝 +z ⇒ 用 Z 向窗）
    for (const wy of [12, 27]) {
      pour(
        b,
        mapParts(
          // R36 A3+B2：hero 窗 —— 竖棂 5 根（FBX 级 3–5）+ 真凹腔（墙皮↔券框 4 面 dark）
          traceryWindowZ({ halfW: 1.2, rise: 7.5, cusp: 1.0, frameOut: 0.5, plateBack: 0.3, mullions: 5, lights: true, subArches: true, recess: true }),
          (g) => g.translate(cx, wy, zFront)
        )
      );
      // R36-A3：卷叶 crockets 沿塔窗尖拱缘（3 片/侧，hero 塔面；低配/远区自动跳）
      pour(
        b,
        mapParts(
          crocketRun({ halfW: 1.2 * 0.92, rise: 7.5 * 0.9, count: 3, size: 0.18, cusp: 1.0 }),
          (g) => g.translate(cx, wy, zFront + 0.42)
        )
      );
    }
    // 塔面竖向金线 ×2
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.35, towerH - 1, 0.16, cx + ox * (towerW / 2 - 0.35), (towerH - 1) / 2 + 0.5, zFront - 0.08));
    }
    // ── R32 塔身四角金条（参考图 A/B「塔身四角金条 + 两侧竖向金条」）：四棱
    //    各一道竖金条（x/z 角位），基座金带一道 —— 与正脸两道合组六道金饰节奏。
    for (const ox of [-1, 1] as const) {
      for (const oz of [-1, 1] as const) {
        b.gold.push(
          box('gold', 0.2, towerH - 2, 0.2, cx + ox * (towerW / 2 - 0.1), (towerH - 2) / 2 + 1, zMid + oz * (halfD - 0.1))
        );
      }
    }
    b.gold.push(box('gold', towerW + 0.5, 0.3, 0.3, cx, 1.4, zFront - 0.1)); // 基座金带
    // ── G1 identity：墩身金 V 纹（chevron）×4 层 + 菱形金章 ×2（V §7.1）──
    for (let i = 0; i < GATE_DECOR.vBandLevels; i += 1) {
      const vy = 4.5 + i * 5.2; // 4.5..20.1
      // V 字 = 两段斜板在墩面正中会合
      for (const ox of [-1, 1] as const) {
        b.gold.push(
          boxRot('gold', 3.4, 0.42, 0.22, cx + ox * (towerW / 4 - 0.2), vy + 0.9, zFront - 0.12, -ox * 0.72)
        );
      }
    }
    for (const by of [26, 34]) {
      // R36-A1：方板转 45° 必须走 boxRot（先转后移）——box() 预平移后再 rotateZ
      // 是绕**世界原点**旋转，菱形金章整枚飞到 −x 侧（「金菱形外飘」根因之一）。
      b.gold.push(boxRot('gold', 1.5, 1.5, 0.2, cx, by, zFront - 0.12, Math.PI / 4)); // 菱形
      b.gold.push(spire('gold', 0.16, 0, 0.5, 4, cx, by + 1.0, zFront - 0.12)); // 章尖
    }
    // 角小尖塔 ×4（前两后两）+ 顶饰金色四角星（G1：墩顶小尖塔+菱形/星形金饰）
    for (const ox of [-1, 1] as const) {
      for (const oz of [-1, 1] as const) {
        const px = cx + ox * (towerW / 2 - 0.7);
        const pz = zMid + oz * (halfD - 0.9);
        b.ashlar.push(box('ashlar', 1.1, 2.2, 1.1, px, towerH + 1.1, pz));
        b.ashlar.push(spire('ashlar', 0.55, 0, 3.2, 8, px, towerH + 2.2, pz, Math.PI / 8));
        // 四角星：两片正交菱形金片（R36-A1：同上，boxRot 先转后移）
        for (const r of [0, Math.PI / 2]) {
          b.gold.push(boxRot('gold', 0.34, 1.5, 0.12, px, towerH + 5.9, pz, r));
        }
      }
    }
    // 尖塔棱线金丝
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.1, 3.0, 0.1, cx + ox * (towerW / 2 - 0.7), towerH + 3.5, zFront - 1.5));
    }
  }

  // ── 飞拱（G1 identity）：双墩上方跨过门洞的浅拱 + 金边（参考图 kit③ 双墩间飞拱）
  {
    const flyHalf = openHalf + towerW; // 17.5（双墩外缘）
    const flySpring = openH - 4; // 26（起拱线贴门拱顶上）
    const fly = archBand(flyHalf, flySpring, 5.2, 0.7, 1.0, 9, 0.4, 0.4);
    fly.rotateY(Math.PI);
    fly.translate(0, 0, zFront - 0.15);
    b.gold.push(fly);
  }

  // ── 门洞三层金券（前脸同心，逐层退进墙内）：最宽一条最外挑，其余逐层内收。
  // archBand 挤出沿 −z，rotateY(π) 后沿 +z ⇒ 平移到 zBand 后占据 [zBand, zBand+dep]。
  let zBand = zFront + 0.05;
  for (const [band, dep] of [
    [1.3, 0.5],
    [0.85, 0.45],
    [0.5, 0.4]
  ] as const) {
    const g = archBand(openHalf, 0, rise, band, dep, 10, cusp, 0.35);
    g.rotateY(Math.PI);
    g.translate(0, 0, zBand);
    b.gold.push(g);
    zBand -= dep + 0.05;
  }

  // ── 金日轮/翼形饰（拱上正中，G1 identity）：竖面金盘 + 12 根辐射金刺 + 双侧翼卷
  // 尺寸按 GATE_DECOR：宽 ≈0.5×门楼全宽（17.5）、高 ≈0.18×门楼高（9.9）。
  // R30b（Phase 3 目检）：17.5m 金盘在 gate_hero 读作"撑满拱心的光板金币"，参考图
  // 同位是精巧的放射花饰。直径压到 ≤12.4m 并加花瓣环（低配跳过）→ 读作"饰"不是"盘"。
  const discY = GATE_DECOR.sunDiscYCrown; // 33.5
  const discR = Math.min(GATE_DECOR.sunDiscW / 2, 6.2); // 12.4m 直径上限
  const sunDisc = new THREE.CylinderGeometry(discR, discR, 0.7, 24);
  sunDisc.rotateX(Math.PI / 2); // 竖面（朝来车 +z）
  sunDisc.translate(0, discY, zFront - 0.1);
  planarUV(sunDisc, TILE.gold);
  b.gold.push(sunDisc);
  if (!isLowDetail()) {
    // 花瓣环（8 瓣，全圆周切向小金板）—— 消解大金盘的"硬币感"
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      b.gold.push(
        boxRot('gold', 0.9, 0.42, 0.5, Math.cos(a) * (discR + 0.28), discY + Math.sin(a) * (discR + 0.28), zFront - 0.16, a + Math.PI / 2)
      );
    }
  }
  for (let i = 0; i < 12; i += 1) {
    const a = Math.PI + (i / 11) * Math.PI; // 上半圆放射
    const spike = boxRot('gold', 1.2, 0.34, 0.7, Math.cos(a) * (discR + 0.7), discY + Math.sin(a) * (discR + 0.7), zFront - 0.06, a + Math.PI / 2);
    b.gold.push(spike);
  }
  for (const side of [-1, 1] as const) {
    // 双侧翼卷（两段斜板 + 端珠）
    b.gold.push(boxRot('gold', 5.5, 0.5, 0.7, side * (discR + 2.4), discY + 2.8, zFront - 0.06, side * 0.5));
    b.gold.push(boxRot('gold', 3.8, 0.45, 0.7, side * (discR + 4.6), discY + 1.0, zFront - 0.06, side * 0.95));
    b.gold.push(spire('gold', 0.45, 0, 1.4, 6, side * (discR + 6.2), discY + 0.3, zFront - 0.06));
  }
  // 日轮芯（前置小金盘 + 金珠）
  b.gold.push(spire('gold', discR * 0.42, discR * 0.42, 0.5, 16, 0, discY, zFront + 0.05));
  b.gold.push(spire('gold', 0.5, 0.5, 0.6, 8, 0, discY + discR + 1.6, zFront - 0.06));
  // ── R32 门楣两侧金菱形（参考图 A 城门楣「中央对称卷叶 + 两侧金菱形」）：
  //    日轮左右各一枚 2.6m 金菱（方板转 45°）+ 菱尖，与中央放射饰形成三段式对称。
  //    R36-A1（金菱形外飘修复）：菱形坐在**中央石体量面**（楣板，半宽 = openHalf=10）
  //    上，原写法横偏写死 discR+4.2=10.4 ⇒ 外缘 12.24 越出楣板爬到塔墩（±10 之外）。
  //    统一走 diamondFit 楣宽钳制（转 45° 后横向半跨 = 边长×√2/2 ⇒ 外缘 ≤ 楣板半宽）。
  for (const side of [-1, 1] as const) {
    const fit = diamondFit(2.6, discR + 4.2, openHalf);
    const halfSpan = (fit.side * Math.SQRT2) / 2;
    if (fit.side > 1e-4 && fit.dx > 1e-4) {
      const dx = fit.dx;
      // R36-A1：转 45° 必须走 boxRot（先转后移）—— box() 预平移 + rotateZ 是绕
      // 世界原点转，菱形整枚飞离门楣（外飘根因）；boxRot 后中心稳定在 (±dx, discY+0.6)。
      const dm = boxRot('gold', fit.side, fit.side, 0.34, side * dx, discY + 0.6, zFront - 0.12, Math.PI / 4);
      b.gold.push(dm);
      b.gold.push(spire('gold', 0.22, 0, 0.8, 4, side * dx, discY + 0.6 + halfSpan + 0.18, zFront - 0.12));
    }
  }

  // ── 拱脚金饰带（archivoltBandH = 9.6 ⇒ 三道水平金带落在起拱区 0..9.6）
  // ⚠ 只铺两侧塔墩（|x| ∈ [10.3, 17.2]），**绝不横穿门洞**：y=1.2 那条原先是
  // 通长 22.6m 跨过整洞，车顶（≈1.5m）过门必穿金带 —— tunnel_drive 机位首拍
  // 三条金带充满前景即此因。起拱区的金饰读法由「塔墩三道横带 + 门洞三层同心
  // 金券（下面的 archBand 循环）」共同承担，与参考图金饰分布（拱券/塔身/檐口）一致。
  for (let i = 0; i < 3; i += 1) {
    const by = 1.2 + i * ((archivoltBandH - 2.4) / 2);
    for (const side of [-1, 1] as const) {
      const cx = side * (openHalf + towerW / 2); // 塔墩中心 ±13.75
      b.gold.push(box('gold', towerW - 0.6, 0.35, 0.5, cx, by, zFront - 0.25));
    }
  }

  // ── 火盆 ×4（立在台基上，门前）
  for (const bx of [-1, 1] as const) {
    for (const off of [11.5, 15.5]) {
      const cx = bx * off;
      const cz = z - halfD + 1.2;
      b.ashlar.push(box('ashlar', 1.1, 1.0, 1.1, cx, 0.5, cz));
      b.gold.push(spire('gold', 0.3, 0.5, 1.2, 10, cx, 1.0, cz));
      b.flame.push(flame(0.36, 0.6, cx, 2.2, cz));
    }
  }

  /* ── R30 构件库复刻（castleDetail；FBX SM_Gat Contrforce/Window/Decor 语汇）────
   * ① 飞扶壁 ×2：SM_Gat Contrforce3_Full（1.68×18.21×0.73）的飞拱读法——外墩立在
   *    门楼前脸之前（z≈zFront+5.2，|x|≈10.1 的步道位上、**>走廊 8**），飞拱向后
   *    向上落到中央石体量前脸（y 8→29），与既有金飞拱（y 26）共同承担参考图门楼
   *    双墩的飞拱构图。
   *    形体局部：墙面 x=0、向 +x 伸出、depth 沿 z；立面朝 +z ⇒ **rotateY(−π/2)**
   *    把「伸出轴」对到世界 +z（墩 therefore 落在立面之前）、「厚度轴」对到世界 x。
   * ② 卷叶 ×20：大门尖拱斜边（12）+ 金飞拱斜边（8）。
   * ③ 雕像龛 ×4：双塔前脸上带（y 38，菱形金章 34 之上、檐口 41.5 之下）。 */
  for (const side of [-1, 1] as const) {
    // R32：扶壁对（pairGap 2.4 ⇒ 双墩沿街向并立）+ 墩顶尖拱覆盆 + 墩身竖金条
    // （参考图 B 扶壁语汇；FBX Contrforce_1 1.79×6.64×2.19 实测比例保持）
    const fb = flyingButtress({
      baseY: 0,
      springY: 8,
      topY: 29,
      reach: 6,
      depth: 1.1,
      band: 0.55,
      pierW: 1.7,
      pinnacle: true,
      coping: true,
      goldStrips: true,
      pairGap: 2.4,
      secondArch: false
    });
    pour(b, mapParts(fb, (g) => g.rotateY(-Math.PI / 2).translate(side * 10.1, 0, zFront)));
  }
  // 门洞三层金券的最外挑面在 zFront+0.55 ⇒ 卷叶坐在其外（+0.07）
  pour(
    b,
    mapParts(
      crocketRun({ halfW: openHalf, rise, count: 6, size: 0.42, cusp, side: 'both' }),
      (g) => g.translate(0, 0, zFront + 0.62)
    )
  );
  // 金飞拱外挑面在 zFront+0.85 ⇒ 卷叶坐在其外
  pour(
    b,
    mapParts(
      crocketRun({ halfW: openHalf + towerW, rise: 5.2, count: 4, size: 0.3, cusp: 0.4, side: 'both' }),
      (g) => g.translate(0, 26, zFront + 0.92)
    )
  );
  for (const side of [-1, 1] as const) {
    const cx = side * (openHalf + towerW / 2);
    const nishe = statueNicheZ({ halfW: 0.85, rise: 2.6, cusp: 0.5 });
    pour(b, mapParts(nishe, (g) => g.translate(cx, 37.5, zFront - 0.05)));
  }
  /* ── R33 门洞山花屏：由实心金板改**透空金屏** ────────────────────────────
   * gate_hero 目检（verify/r33_phase3b/high_gate_hero.png）：12×16m 实心金屏
   * 在门洞内读成一块封住拱门的金墙，既挡掉隧道纵深又像未完成的占位面。
   * 参考图该位是「金框 + 尖拱分格」的透空山花，后面能看到幽深入口。现改
   * openwork（框 + 3 尖拱 + 竖棂 + 短十字），不再产整幅板面；后方隧道 liner
   * 与木梁自然成为深色背景。几何总高/外框尺寸不变。 */
  pour(
    b,
    mapParts(
      gildedScreen({ w: 12, h: 16, cross: true, openwork: true, bays: 3 }),
      (g) => g.rotateY(Math.PI / 2).translate(0, 9, zFront + 0.05)
    )
  );
  return b;
}

/* ═══════════════════ ⑤c 塔群（G2：中央钟楼 + 双铃塔 + 细尖塔 + 翼墙） ═══════════════════ */

/**
 * 塔群 = 参考图 7cd7329c 主构图的 identity（R27 完全缺失，G2 P0）：
 * 中央钟楼坐在门楼体量上方（z 门楼带内，基座不占 |x|<ROAD_HALF 行车走廊），
 * 双铃塔列于门楼双墩外侧，细尖塔更外，翼墙向两侧展开封住立面宽度。
 * 高度阶梯：钟楼 98 > 铃塔 86 > 细尖塔 66 > 翼墙 29 > 门楼 55（V §7.1 体块排序）。
 * 铃塔顶用 **dark 桶**做深色坡顶（参考图铃塔是深色尖顶），钟楼冠顶用 gold。
 */
export function makeTowerGroup(): StoneBuckets {
  const b = emptyBuckets();
  setDeepFar(false);
  const gz = GATE.z; // −358.5
  const gd = GATE.depth; // 14
  const zFront = gz + gd / 2; // 门楼前脸 −351.5

  /* ── 中央钟楼（R32 参考图 B 主塔五层结构；常量 w14/baseY40/totalH98/clockY65 不变）──
   * 五层（自下而上）：
   *   ① 基座层 44.5..50：中央尖拱门龛（dark + 金券）+ 金色放射扇板 + 扶壁对×3 对递减；
   *   ② 狭长尖拱窗层 50..60：三扇狭长尖拱窗（金线框）+ 层间横向金饰带（y=60）；
   *   ③ 钟楼层 60..78：正面圆形钟表（clockY=65，金面 + 刻度）+ 双联尖拱窗×2 组
   *      （14m 塔脸放不下 3 组 + 6.5m 钟，参考图「×3 组」按脸宽折为 2 组 + 钟位本身）；
   *   ④ 收缩段 78..86：细长尖拱窗×2 + 竖向金条×4（间距节拍）；
   *   ⑤ 尖顶 86..98：四角小尖塔 + 主双层尖顶 + 顶端金十字/放射尖饰。 */
  {
    const { w, baseY, clockY, clockD } = TOWER_GROUP.clock; // totalH 98 = y4(86) + 12 尖顶段
    const y1 = 52; // ① 基座层顶（拱门 45.2..49.4 + 放射扇板 49.4..52）
    const y2 = 60; // ② 狭长窗层顶（横金带）
    const y3 = 78; // ③ 钟楼层顶（檐口）
    const y4 = 86; // ④ 收缩段顶
    // 台基（咬合门楼体量顶 massTop=44）
    b.ashlar.push(box('ashlar', w + 2.6, 4.5, gd + 1.8, 0, baseY + 2.25, gz));
    // 塔身四段收分（阶梯=砌层感：44.5 → 50 → 60 → 78 → 86）
    b.ashlar.push(box('ashlar', w + 1.6, y1 - 44.5, gd + 0.8, 0, 44.5 + (y1 - 44.5) / 2, gz));
    b.ashlar.push(box('ashlar', w + 1.2, y2 - y1, gd + 0.6, 0, y1 + (y2 - y1) / 2, gz));
    b.ashlar.push(box('ashlar', w + 0.6, y3 - y2, gd + 0.3, 0, y2 + (y3 - y2) / 2, gz));
    b.ashlar.push(box('ashlar', w - 0.2, y4 - y3, gd - 0.1, 0, y3 + (y4 - y3) / 2, gz));
    // 檐口（③/④ 分界）+ 金线
    b.ashlar.push(box('ashlar', w + 2.2, 1.2, gd + 1.4, 0, y3 + 0.6, gz));
    b.gold.push(box('gold', w + 2.4, 0.22, gd + 1.6, 0, y3 + 1.35, gz));
    // ②/③ 层间横向金饰带（参考图 B 第 2/4 层间金带；y=60）
    b.gold.push(box('gold', w + 1.9, 0.3, gd + 0.9, 0, y2, gz));
    // ①/② 层间金带（基座收口）
    b.gold.push(box('gold', w + 2.2, 0.26, gd + 1.1, 0, y1, gz));
    // ① 中央尖拱门龛（dark 背板 + 金券）+ 金色放射扇板
    //   ⚠ z 口径：各段塔身盒深 = gd+delta ⇒ 前脸 fZ(delta) = gz+(gd+delta)/2；
    //     脸挂件必须相对**该段前脸**定位（zFront 是门楼前脸，比塔脸还靠前 0.4，
    //     直接贴 zFront 会把件埋进塔身——R31 时钟指针即因此不可见，R32 一并修正）。
    {
      const f1 = gz + (gd + 0.8) / 2; // ① 段前脸
      const aHalf = 2.6;
      const aRise = 3.6;
      const plate = archPlate(aHalf - 0.2, 0, aRise, 1.4, 7, 0.6);
      plate.rotateY(Math.PI);
      plate.translate(0, 45.2, f1 - 1.5); // 背板在脸内 0.1..1.5
      b.dark.push(plate);
      const ring = archBand(aHalf, 0, aRise, 0.32, 0.55, 7, 0.6, 0.45);
      ring.rotateY(Math.PI);
      ring.translate(0, 45.2, f1 - 0.1); // 金券外挑 0.45
      b.gold.push(ring);
      // 金色放射扇板（扇骨 5 根自 (0, 49.8) 放射 ±33°）+ 扇板横梁（收在 ① 段内）
      for (let i = 0; i < 5; i += 1) {
        const a = -0.58 + (i / 4) * 1.16;
        const L = 2.4;
        b.gold.push(boxRot('gold', 0.46, L, 0.3, Math.sin(a) * L * 0.5, 49.8 + Math.cos(a) * L * 0.5, f1 + 0.05, a));
      }
      b.gold.push(box('gold', 5.4, 0.42, 0.34, 0, 49.5, f1 + 0.05));
    }
    // ①b 扶壁对 ×3 对（参考图 B 主塔两侧 3 对递减扶壁：reach/topY 向外递减）
    for (const side of [-1, 1] as const) {
      for (const [wx, sy, ty] of [
        [9.2, 45.5, 58],
        [11.3, 47.5, 55],
        [13.2, 49.5, 52.5]
      ] as const) {
        const fb = flyingButtress({
          baseY: 44.5,
          springY: sy,
          topY: ty,
          reach: 3.4,
          depth: 1.0,
          band: 0.5,
          pierW: 1.15,
          pinnacle: false,
          secondArch: false,
          coping: true,
          goldStrips: sy < 48,
          pairGap: 2.0
        });
        pour(b, mapParts(fb, (g) => g.rotateY(-Math.PI / 2).translate(side * wx, 0, zFront)));
      }
    }
    // ② 狭长尖拱窗 ×3（金线框；窗宽 0.9 ⇒ 无子拱，mullions 2；R36-B2 真凹腔）
    const f2 = gz + (gd + 0.6) / 2; // ② 段前脸
    for (const wx of [-4.6, 0, 4.6]) {
      pour(
        b,
        mapParts(
          traceryWindowZ({ halfW: 0.45, rise: 6.6, cusp: 0.7, frameOut: 0.42, plateBack: 0.28, mullions: 2, lights: false, recess: true }),
          (g) => g.translate(wx, 51.2, f2)
        )
      );
    }
    // ③ 圆形钟表（前脸竖面）：金圈 + 近黑盘 + 金指针（clockY=65；R32 修正指针埋没）
    const f3 = gz + (gd + 0.3) / 2; // ③ 段前脸
    const ring = new THREE.CylinderGeometry(clockD / 2 + 0.55, clockD / 2 + 0.55, 0.34, 20);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, clockY, f3 + 0.05);
    planarUV(ring, TILE.gold);
    b.gold.push(ring);
    const face = new THREE.CylinderGeometry(clockD / 2, clockD / 2, 0.3, 20);
    face.rotateX(Math.PI / 2);
    face.translate(0, clockY, f3 + 0.1);
    planarUV(face, TILE.wall);
    b.dark.push(face);
    // 指针贴在盘面前缘（R31 旧位 cz−0.2 埋在盘后 ⇒ 不可见）
    b.gold.push(box('gold', 0.32, clockD * 0.62, 0.12, 0, clockY, f3 + 0.28)); // 时针（垂直）
    b.gold.push(box('gold', clockD * 0.48, 0.32, 0.12, clockD * 0.24, clockY, f3 + 0.28)); // 分针
    // ③b 双联尖拱窗 ×2 组（钟左右；subArches = Window2_4 双联语汇）
    //   R36 A3+B2：hero 窗竖棂 2→5（宽窗 3.1m，FBX 3–5 根带内）+ 真凹腔
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(
          traceryWindowZ({
            halfW: 1.55,
            rise: 6.2,
            cusp: 0.7,
            frameOut: 0.48,
            plateBack: 0.3,
            mullions: 5,
            lights: true,
            subArches: true,
            recess: true
          }),
          (g) => g.translate(side * 4.9, 62.5, f3)
        )
      );
    }
    // ④ 收缩段：细长尖拱窗 ×2 + 竖向金条 ×4（间距节拍；R36-B2 真凹腔）
    const f4 = gz + (gd - 0.1) / 2; // ④ 段前脸
    for (const wx of [-2.6, 2.6]) {
      pour(
        b,
        mapParts(
          traceryWindowZ({ halfW: 0.42, rise: 4.6, cusp: 0.7, frameOut: 0.4, plateBack: 0.26, mullions: 2, lights: false, recess: true }),
          (g) => g.translate(wx, 79.4, f4)
        )
      );
    }
    for (const gx of [-5.6, -1.9, 1.9, 5.6]) {
      b.gold.push(box('gold', 0.26, y4 - y3 - 0.6, 0.16, gx, y3 + (y4 - y3) / 2, f4 + 0.02));
    }
    // ⑤ 尖顶：四角小尖塔 + 主双层尖顶 + 顶端金十字/放射尖饰
    for (const ox of [-1, 1] as const) {
      for (const oz of [-1, 1] as const) {
        const px = ox * (w / 2 - 0.6);
        const pz = gz + oz * (gd / 2 - 0.5);
        b.ashlar.push(box('ashlar', 1.3, 1.1, 1.3, px, y4 + 0.55, pz));
        b.ashlar.push(spire('ashlar', 0.62, 0, 2.6, 4, px, y4 + 1.1, pz, Math.PI / 4));
        b.gold.push(spire('gold', 0.16, 0, 0.9, 4, px, y4 + 3.7, pz));
      }
    }
    // 主尖顶（R33：上段由光板金锥改 **卷叶尖冠 crookedSpire** ——
    // 参考图主塔冠是层层卷叶金钉，而不是单一三角锥。下段白石八棱锥保持，
    // 卷叶只替换上段披顶的形体语言；低配档 crookedSpire 自动跳卷叶、保留同长度锥身。）
    b.ashlar.push(spire('ashlar', 3.3, 0, 5.6, 8, 0, y4, gz, Math.PI / 8));
    pour(
      b,
      mapParts(crookedSpire({ w: 2.4, h: 4.8, leaves: true }), (g) => g.translate(0, y4 + 5.6, gz))
    );
    b.gold.push(spire('gold', 0.5, 0.5, 0.8, 8, 0, y4 + 5.4, gz)); // 冠座金珠
    // 顶端金十字（竖 + 横）+ 放射尖饰（finialOrnament）
    // crookedSpire 实际总高 = 1.42h（锥身 h + 金尖 0.42h）
    const topY = y4 + 5.6 + 4.8 * 1.42; // ≈98.4
    b.gold.push(box('gold', 0.34, 3.0, 0.34, 0, topY + 1.5, gz));
    b.gold.push(box('gold', 1.7, 0.34, 0.34, 0, topY + 2.2, gz));
    // R36-A1：lintelHalf = 所在楣板半宽（此处 = 金十字横臂 1.7 宽之半 0.85）
    pour(b, mapParts(finialOrnament({ r: 1.0, lintelHalf: 0.85 }), (g) => g.translate(0, topY + 3.0, gz)));
  }

  /* ── 双铃塔（拱形钟室挂钟；顶为深色坡顶 = dark 桶）── */
  for (const side of [-1, 1] as const) {
    const cx = side * TOWER_GROUP.bell.x; // ±25
    const { w, totalH, bellY, bellOpenH } = TOWER_GROUP.bell;
    const shaftTop = 68; // 檐口
    b.ashlar.push(box('ashlar', w + 2.4, 2, w + 2.4, cx, 1, gz)); // 台基
    // R40 P0-1 塔身「上白下灰」垂直材质分区（参考图双通道像素明证，代码此前上下全 ashlar）：
    //   下段 2..35 改走已有 grey 桶（castle.ts variantMaterial('ashlar-grey')，复用 ashlar
    //   图集 ⇒ 0 新贴图 / 0 新材质实例）；上段 35..68 保持 ashlar 象牙白。台基保留白石（基座惯例）。
    //   ⚠ 与翼墙灰石（L1742/L1790）完全同构：box 第一参仍传 'ashlar'（UV 图集族 = TILE.ashlar
    //     1.2m），否则砌块尺度差一倍（R37-A 落地审查 P2-1 教训，tests/r37_castle.test.ts 锁比值 1.0）。
    //   ⚠ DC：塔身 bbox z 中值 = gz = −358.5，与翼墙灰石同落 ZONE_EDGES_6 的 z1 区（−340..−460）；
    //     grey-z1 mesh 已存在（翼墙），本件 merge 进去 ⇒ **静态 DC +0**（灰石仍 1 个分区 mesh）。
    pushVariant(b, 'grey', box('ashlar', w + 0.6, 33, w + 0.6, cx, 2 + 16.5, gz)); // 塔身下段 2..35（灰石）
    b.ashlar.push(box('ashlar', w, shaftTop - 35, w, cx, 35 + (shaftTop - 35) / 2, gz)); // 塔身上段 35..68（白石）
    b.ashlar.push(box('ashlar', w + 1.6, 1.2, w + 1.6, cx, shaftTop + 0.6, gz)); // 檐口
    b.gold.push(box('gold', w + 1.8, 0.22, w + 1.8, cx, shaftTop + 1.35, gz)); // 檐口金线
    // 尖顶：**R29 改白石**（原 dark 深色坡顶）。参考图（7cd7329c / 2497fab5）双铃塔
    // 顶部是**白石收分尖顶 + 金饰尖**，没有一片黑屋顶；原实现的黑锥在 gate_hero 机位
    // 读成"卡通巫婆帽"（verify/r29_c2/gate_hero.png 实证），是全场景最刺眼的一处失真。
    // R32：改**单层螺旋尖刺**（5 段 8 棱收分 + 逐段 thetaStart 旋转 = 扭转杆身，
    //      参考图「内侧塔高 68% 单层螺旋尖刺」的次塔语汇）+ 金尖。
    for (let i = 0; i < 5; i += 1) {
      b.ashlar.push(
        spire('ashlar', 1.55 - i * 0.16, 1.4 - i * 0.16, 3.2, 8, cx, shaftTop + 1.2 + i * 3.2, gz, i * 0.42)
      );
    }
    b.gold.push(spire('gold', 0.42, 0, 1.8, 6, cx, totalH - 0.6, gz));
    // 钟室：拱框（gold 券线）+ 近黑内衬 + 金钟（V：钟高 = 开口高 2/3）
    const openHalf = bellOpenH * 0.42; // 拱宽 ≈ 高的 0.84（1:1.2 拱）
    {
      const frame = archBand(openHalf, 0, bellOpenH * 0.72, 0.34, 0.5, 7, 0.6, 0.45);
      frame.rotateY(Math.PI);
      frame.translate(cx, bellY, zFront);
      b.gold.push(frame);
    }
    {
      const plate = archPlate(openHalf - 0.2, 0, bellOpenH * 0.72, 0.8, 7, 0.6);
      plate.rotateY(Math.PI);
      plate.translate(cx, bellY, zFront - 0.8);
      b.dark.push(plate);
    }
    // 金钟（碗形 + 吊环，挂在拱室中央）
    // R32 落地审查（对照 Fab thumbnail.jpg）：参考图金钟几乎填满拱室开口，
    // 原 0.66 在 250m 外读成"黑拱里一点小影" ⇒ 0.80（底半径 0.27·开口 < 拱半宽
    // 0.42·开口、钟顶 0.62·开口 < 拱肩 0.72·开口，几何余量均核过）。
    // 顶点数不变 ⇒ 三口径零漂移。
    const bellH = bellOpenH * 0.80;
    b.gold.push(spire('gold', bellH * 0.34, bellH * 0.2, bellH * 0.78, 10, cx, bellY + 0.4, zFront - 0.5, 0));
    b.gold.push(box('gold', bellH * 0.68, 0.22, 0.3, cx, bellY + 0.4, zFront - 0.5)); // 钟唇
    b.gold.push(spire('gold', 0.16, 0.16, 0.5, 6, cx, bellY + 0.4 + bellH * 0.78, zFront - 0.5)); // 吊环
    // 塔身金饰条 ×2 + 尖拱窗 ×1（钟室下）
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.3, 30, 0.16, cx + ox * (w / 2 - 0.4), 20, zFront - 0.1));
    }
    {
      // R30 换装花格窗（铃塔身窗，前脸；R36 A3+B2：竖棂 3 + 真凹腔）
      pour(
        b,
        mapParts(
          traceryWindowZ({ halfW: 0.8, rise: 4.6, cusp: 0.6, frameOut: 0.45, plateBack: 0.28, mullions: 3, lights: true, recess: true }),
          (g) => g.translate(cx, 44, zFront)
        )
      );
    }
  }

  /* ── 细尖塔 ×2（kit④ 语言：全塔 1:6.2，上段杆件 1:11.3）──
   * R32：改**双层十字尖顶**（参考图「外侧塔高 52% 双层十字尖顶」的次塔语汇）——
   * 细杆中段加鼓身 + 两道金十字（下小上大）+ 金尖；原单杆金珠读不出"双层」。 */
  for (const side of [-1, 1] as const) {
    const cx = side * TOWER_GROUP.spire.x; // ±42
    const { w, totalH } = TOWER_GROUP.spire;
    b.ashlar.push(box('ashlar', w + 2, 1.6, w + 2, cx, 0.8, gz)); // 台基
    b.ashlar.push(box('ashlar', w, 38, w, cx, 1.6 + 19, gz)); // 基座段 1.6..39.6
    b.ashlar.push(box('ashlar', w * 0.86, 8, w * 0.86, cx, 39.6 + 4, gz)); // 中段收分
    // R32 中段鼓身（三层节奏的中层显式化）+ 金箍
    b.ashlar.push(box('ashlar', w * 0.98, 4.4, w * 0.98, cx, 53.5, gz)); // 鼓身 51.3..55.7
    b.gold.push(box('gold', w * 1.06, 0.3, w * 1.06, cx, 51.3, gz));
    // 上段细杆（1:11.3）
    const rodH = totalH - 55.7;
    b.ashlar.push(pierColumn(rodH / TOWER.spireAspect, (rodH / TOWER.spireAspect) * 0.7, rodH, cx, 55.7, gz));
    // 金饰带 ×2 + 双层金十字 + 金尖
    b.gold.push(box('gold', w + 0.5, 0.3, w + 0.5, cx, 20, gz));
    b.gold.push(box('gold', w * 0.9 + 0.4, 0.3, w * 0.9 + 0.4, cx, 43, gz));
    // 下层金十字（鼓头顶，小）
    b.gold.push(box('gold', 0.26, 2.0, 0.26, cx, 57.4, gz));
    b.gold.push(box('gold', 1.3, 0.26, 0.26, cx, 57.9, gz));
    // 上层金十字（杆身中段，大）
    b.gold.push(box('gold', 0.34, 3.0, 0.34, cx, 61.5, gz));
    b.gold.push(box('gold', 2.0, 0.34, 0.34, cx, 62.4, gz));
    b.gold.push(spire('gold', 0.5, 0, 2.2, 6, cx, totalH, gz));
    // 细杆金珠
    b.gold.push(spire('gold', 0.3, 0.3, 0.5, 6, cx, totalH - 3, gz));
  }

  /* ── 翼墙（门楼双墩外侧 → ±55，封住参考图立面宽度）── */
  {
    const { xEnd, h } = TOWER_GROUP.wing;
    const xIn = GATE.halfW; // 17.5（门楼半宽）
    for (const side of [-1, 1] as const) {
      const cx = side * (xIn + xEnd) / 2;
      const w = xEnd - xIn; // 37.5
      /* R37-A 灰石分区：翼墙墙身 **wall 桶 → grey 桶**。
       *
       * ⚠ 源桶名订正（R37 落地审查 P2-1）：这里原先写「源桶是 inner-stone 内壁档」是
       *   **误记**。`inner-stone` 是**材质 id**（castle.ts 的 `VARIANT_BUCKETS.wall`
       *   映射出来的变体材质），**从来不是 castleKit 里的桶名**；castleKit 里这一行
       *   历史上一直是 `b.wall.push(...)`，即 **wall 桶**（`git show 4b6f78b:...` 实证）。
       *   「桶」与「材质」是两层：桶决定进哪个数组，材质由 castle.ts 在 commit 时挂。
       *
       * ⚠ 同时修一处**真 bug**（同因）：原写作 `box('wall', …)` —— `box()` 的第一个
       *   参数是 **UV 图集族**（决定 TILE 米数），改桶时漏改它 ⇒ `wall` 族按 TILE 2.4m
       *   烘 UV，却挂 ashlar 图集（TILE 1.2m）⇒ 灰石砌块读作 **0.6m**，而邻接的 ashlar
       *   主体是 **0.3m**，**砌块尺度差一倍**（Node 直跑实测）。改成 `box('ashlar', …)`
       *   后两族 UV 密度比 = **1.0**（判据见 tests/r37_castle.test.ts）。
       *
       * 为什么要换桶：wall 桶在 castle.ts 里挂的是 inner-stone = **室内**标定
       *   （env 0.45 / color 0x8e979e），挂到室外翼墙上会偏暗偏闷；参考图的灰石是
       *   **受天光的冷灰**（翼墙/分节/阴影面偏灰）。ashlar-grey 与主体 ashlar 同砌块
       *   形制、同缝宽（同一张图集），只换颜色乘子 ⇒ 远看是「同一堵墙的阴影面」。
       * 代价：**0 新增 tri / 0 新增贴图**（只是换桶；贴图仍是 ashlar 那一套）。 */
      pushVariant(b, 'grey', box('ashlar', w, h, 8, cx, h / 2, gz)); // 墙身
      b.ashlar.push(box('ashlar', w + 0.8, 0.6, 8.8, cx, h + 0.3, gz)); // 顶叠涩
      b.gold.push(box('gold', w + 1, 0.24, 9, cx, h + 0.78, gz)); // 檐口金带
      // 垛口（齿 1:1，节拍 2.4）
      const merlons = Math.floor(8 / 2.4);
      for (let m = 0; m < merlons; m += 1) {
        const mz = gz - 4 + (8 * (m + 0.5)) / merlons;
        b.ashlar.push(box('ashlar', w, 1.2, 8 / merlons / 2, cx, h + 1.4, mz));
        b.gold.push(spire('gold', 0.22, 0, 0.4, 4, cx, h + 2, mz));
      }
      // 尖拱窗 ×3（墙内壁朝路心）—— R30 换装花格窗（金框 + 双棂 + 拱肩光）
      for (let i = 0; i < 3; i += 1) {
        const wz = gz - 2.8 + i * 2.8;
        // 先镜像（局部 z=0 居中）再平移到世界位——反序会让 −side 窗落到 −wz
        // R36 A3+B2：翼墙 hero 窗竖棂 3 + 真凹腔
        pour(
          b,
          mapParts(
            traceryWindowX({ halfW: 0.85, rise: 5.0, cusp: 0.7, frameOut: 0.45, plateBack: 0.3, mullions: 3, lights: true, recess: true }),
            (g) => {
              if (side < 0) g.rotateY(Math.PI);
              return g.translate(side * xIn, 3.2, wz);
            }
          )
        );
      }
      // 竖向金饰条 ×2（翼墙外棱）
      for (const ox of [-1, 1] as const) {
        b.gold.push(box('gold', 0.3, h - 1, 0.16, side * (xIn + (ox < 0 ? 0.4 : w - 0.4)), (h - 1) / 2 + 0.6, gz + 4.1));
      }
    }

    /* ── R29 横向拓展：翼墙外延（55 → 95）+ 扶壁塔节奏 ──────────────────────
     * 用户令「宫殿建筑群需要像参考图一样**横向拓展**以使得建筑丰富」。
     * 参考图（2a302891 / 2497fab5 / 3d084b59）的立面读法是**连续的竖向节奏**：
     * 高塔 → 低墙 → 扶壁塔 → 更高的角塔，横向拉满整个画面宽度。
     * 现行 TOWER_GROUP.wing.xEnd=55 只到画面 1/3，两侧直接空掉 ⇒ 读成"孤零零一组门楼"。
     * 本段在 55→95 补：低墙(h22) + 3 座扶壁塔(h 34/46/40) + 角塔(h62) + 金饰带，
     * 全部 box/spire（12~16 tri），不做 lancetWindow（182 tri/扇，铺满必爆预算）。 */
    const ext = R29_WING_EXT;
    for (const side of [-1, 1] as const) {
      const x0 = xEnd;
      const x1 = ext.xEnd;
      const cx = side * (x0 + x1) / 2;
      const w = x1 - x0;
      // 外延墙身（比主翼墙低 7m，形成"主-次"层次而不是一条平墙）
      // R37-A 灰石分区：同翼墙墙身，改走 grey 桶（注释见翼墙处）。
      // ⚠ UV 族必须跟着桶一起改：box 第一参是图集族（TILE 米数），漏改会让砌块尺度差一倍。
      pushVariant(b, 'grey', box('ashlar', w, 22, 7, cx, 11, gz));
      b.ashlar.push(box('ashlar', w + 0.6, 0.55, 7.6, cx, 22.3, gz));
      b.gold.push(box('gold', w + 0.8, 0.2, 7.8, cx, 22.7, gz));
      // 垛口（节拍 2.4，与外延墙同长）
      const merlons = Math.floor(w / 2.4);
      for (let m = 0; m < merlons; m += 1) {
        const mz = gz - 3.5 + (7 * (m + 0.5)) / merlons;
        b.ashlar.push(box('ashlar', w / merlons * 0.55, 1.1, 0.8, cx + side * (-w / 2 + (w * (m + 0.5)) / merlons), 23, mz));
      }
      // 扶壁塔节奏：34 / 46 / 40（中间最高，参考图的"塔簇"读法）
      // R32：四座次塔三级节奏显式化（台基 / 身 / 中段鼓身 / 檐口 = 4 级退台）
      //     + 塔身四角金条 + 两侧竖向金条 + 基座金带（参考图 A/B 塔身金饰）；
      //     中间塔（46m ≈ 52% 钟楼）加**双层十字尖顶**（外侧次塔语汇）。
      const towers: readonly (readonly [number, number])[] = [
        [x0 + 8, 34],
        [x0 + 21, 46],
        [x0 + 34, 40]
      ];
      for (const [tx, th] of towers) {
        const px = side * tx;
        b.ashlar.push(box('ashlar', 6.4, 1.2, 9, px, 0.6, gz));
        b.ashlar.push(box('ashlar', 5.8, th - 1.2 - 2.2, 8.2, px, 1.2 + (th - 3.4) / 2, gz));
        // R32 中段鼓身（三级节奏的中层）
        b.ashlar.push(box('ashlar', 6.5, 0.7, 8.9, px, 1.2 + (th - 3.4) * 0.55, gz));
        b.ashlar.push(box('ashlar', 7.0, 0.8, 9.4, px, th - 1.0, gz)); // 檐口
        b.gold.push(box('gold', 7.2, 0.22, 9.6, px, th - 0.55, gz)); // 金压顶
        b.ashlar.push(spire('ashlar', 4.2, 0, 5.4, 8, px, th - 0.6, gz, Math.PI / 8));
        b.gold.push(spire('gold', 0.42, 0, 1.6, 6, px, th + 4.8, gz));
        // R32 四角金条（塔身四棱）+ 基座金带
        for (const gx of [-1, 1] as const) {
          for (const gz2 of [-1, 1] as const) {
            b.gold.push(box('gold', 0.2, th - 3.4, 0.2, px + gx * 2.85, 1.2 + (th - 3.4) / 2, gz + gz2 * 4.05));
          }
        }
        b.gold.push(box('gold', 6.6, 0.26, 9.2, px, 1.45, gz));
        // 竖向金饰条（塔面 3 道，参考图的"金线拉高"语言）
        for (const gx of [-1.6, 0, 1.6]) {
          b.gold.push(box('gold', 0.24, th * 0.62, 0.14, px + gx, th * 0.42, gz + 4.2));
        }
        // 深色窗缝 ×2（远读节拍）
        b.dark.push(box('dark', 0.5, 4.2, 1.4, px, th * 0.62, gz + 4.15));
        /* ── R33 翼墙次塔立面精化：正面补两扇真实花格窗 ─────────────────
         * gate_hero 目检（verify/r33_phase3/high_gate_hero.png）：外延三座次塔
         * 的正面以前只有 3 道金线 + 一条 dark 细缝，在 240m 机位读作「白盒子」。
         * 参考图次塔（7cd7329c）每层都有尖拱窗洞。这里上下各补一扇 96-tri
         * traceryWindowZ（金框 + 双棂 + 深背板），间距按塔高 0.32/0.70 分带；
         * 低配档仍走同一几何长度，仅窗棂由 castleDetail 内部降密度（铁律 33）。 */
        for (const wy of [th * 0.32, th * 0.7]) {
          pour(
            b,
            mapParts(
              // R36-B2：次塔 hero 窗真凹腔（竖棂保持 2 —— 窗宽 1.1m 仅容双棂）
              traceryWindowZ({ halfW: 0.55, rise: 3.4, cusp: 0.6, frameOut: 0.4, plateBack: 0.24, mullions: 2, lights: false, recess: true }),
              (g) => g.translate(px, wy, gz + 4.12)
            )
          );
        }
        // R32 中间塔（46m）：双层十字尖顶（下小上大两枚金十字卡在锥顶上）
        if (th >= 46) {
          b.gold.push(box('gold', 0.3, 2.2, 0.3, px, th + 2.2, gz));
          b.gold.push(box('gold', 1.5, 0.3, 0.3, px, th + 2.8, gz));
          b.gold.push(box('gold', 0.36, 3.0, 0.36, px, th + 5.6, gz));
          b.gold.push(box('gold', 2.1, 0.36, 0.36, px, th + 6.6, gz));
        }
      }
      // 角塔（横向终端，最高 62 + 尖顶 → 收住立面）
      const ax = side * (x1 - 3.5);
      b.ashlar.push(box('ashlar', 10, 1.4, 10, ax, 0.7, gz));
      b.ashlar.push(box('ashlar', 9, 58, 9, ax, 1.4 + 29, gz));
      b.ashlar.push(box('ashlar', 10.2, 1.0, 10.2, ax, 60.4, gz));
      b.gold.push(box('gold', 10.4, 0.26, 10.4, ax, 61.0, gz));
      b.ashlar.push(spire('ashlar', 6.4, 0, 12, 8, ax, 61.2, gz, Math.PI / 8));
      b.gold.push(spire('gold', 0.5, 0, 2.2, 6, ax, 73.2, gz));
      for (const gx of [-2.6, 0, 2.6]) {
        b.gold.push(box('gold', 0.3, 40, 0.16, ax + gx, 22, gz + 4.6));
      }
      b.dark.push(box('dark', 0.7, 6, 1.8, ax, 46, gz + 4.5));
    }
  }

  /* ── R30 构件库复刻（castleDetail；SM_Gat/Det Contrforce/Window/Decor/Beam 语汇）──
   * ① 翼墙盲拱列 ×2 行：参考图构件 2 的 identity（矮墙尖拱凹龛）落到门楼翼墙内壁
   *    （窗带之上 y 12..18，避开街面三扇花格窗与竖向金饰条）。
   * ② 钟室拱卷叶 ×20（双铃塔 ×10）：沿钟室尖拱斜边等距小金卷叶。
   * ③ 铃塔外侧雕像龛 ×4：铃塔侧壁外棱（y 40，Decor 家族语汇）。
   * ④ 细尖塔纹章顶饰 ×2：塔冠金尖之上（y≈68.4）的金色放射纹章。
   * ⑤ 翼墙顶连廊 ×2（城门楼↔翼墙之间）：楼面 32m（垛口 31.6 之上），
   *    内缘咬合门楼塔墩外侧面（|x|=17.5）⇒「城门楼与翼墙之间」的高架廊道。 */
  {
    for (const side of [-1, 1] as const) {
      const xIn = GATE.halfW; // 17.5（翼墙内缘 = 门楼半宽）
      // ① 盲拱列（4 龛，龛心距 2.2 ⇒ 跨 6.6m，落在 8m 墙深内）
      pour(
        b,
        mapParts(blindArcadeRow({ count: 4, halfW: 0.55, rise: 5.6, pitch: 2.2, cusp: 0.5 }), (g) => {
          if (side < 0) g.rotateY(Math.PI);
          return g.translate(side * xIn, 12, gz);
        })
      );
      // ③ 铃塔外侧雕像龛（铃塔身宽 w+0.6 ⇒ 外侧面 |x| = bell.x + (w+0.6)/2）
      const bellCx = side * TOWER_GROUP.bell.x;
      pour(
        b,
        mapParts(statueNicheX({ halfW: 0.72, rise: 2.5, cusp: 0.5 }), (g) => {
          if (side > 0) g.rotateY(Math.PI); // +x 面朝外 ⇒ 镜像
          return g.translate(side * (TOWER_GROUP.bell.x + (TOWER_GROUP.bell.w + 0.6) / 2), 40, gz);
        })
      );
      // ⑤ 翼墙顶连廊（内缘咬门楼塔墩）
      pour(b, mapParts(corridorGallery({ len: 7, width: 36, floorY: 32 }), (g) => g.translate(side * 36, 0, gz)));
      // ② 钟室拱卷叶（只做 +side 时 bellCx 已在循环里——这里按 cx 逐铃塔产）
      pour(
        b,
        mapParts(
          crocketRun({ halfW: TOWER_GROUP.bell.bellOpenH * 0.42, rise: TOWER_GROUP.bell.bellOpenH * 0.72, count: 5, size: 0.3, cusp: 0.6 }),
          (g) => g.translate(bellCx, TOWER_GROUP.bell.bellY, zFront + 0.55)
        )
      );
      // ④ 细尖塔纹章顶饰（R36-A1：lintelHalf = 上层金十字横臂 2.0 宽之半 1.0）
      const spx = side * TOWER_GROUP.spire.x;
      pour(b, mapParts(finialOrnament({ r: 0.55, lintelHalf: 1.0 }), (g) => g.translate(spx, 68.4, gz)));
    }
  }
  return b;
}

/* ═══════════════════ ⑤d 主殿（撞击目标 · 城内终点宫殿） ═══════════════════ */

/**
 * 主殿 = 用户指令「castle 内部最后撞上的实体建筑」（R28 替代旧路障，G2/P0）。
 * 正面立面 z=−1300 即物理撞击面（CRASH_WALL.z）；形制取 kit③ 门楼模块语言：
 *   前排门楼段 frontW 56（中央封闭大拱门龛 clearW 16 × clearH 24 + 金日轮/翼形饰）
 *   两翼墙 ±28 → ±65（facadeW 130，纯视觉）+ 后排主殿身（rearDepth 37）
 *   尖顶冠 crownH 100（kit④ 细杆语言，**无钟面**——钟楼 identity 归 TOWER_GROUP）
 *   前广场 14.5m：大台阶 4 级 + 火盆阵（HALL_BRAZIER：门龛火盆对 + 广场列阵）
 * 门龛**封闭不可通行**（深色内衬 + 金券 + 门楣金饰）⇒ 整车撞立面（H1「无穿透」）。
 */
export function makeMainHall(): StoneBuckets {
  const b = emptyBuckets();
  setDeepFar(false); // 主殿为近景 hero 建筑，不做远区减法
  const { z, depth, frontDepth, frontW, clearW, clearH, frontH, crownH, facadeW, wingInner, wingOuter } = MAIN_HALL;
  const zFront = z; // −1300（立面）
  const zBack = z - depth; // −1360
  const zMidFront = zFront - frontDepth / 2; // 前排中心 −1311.5

  /* ── 前排门楼段（frontW 56 × frontH 70）── */
  {
    // 台基两层
    b.ashlar.push(box('ashlar', frontW + 3, 1.2, frontDepth + 2, 0, 0.6, zMidFront));
    b.ashlar.push(box('ashlar', frontW + 1.4, 1.0, frontDepth + 1, 0, 1.7, zMidFront));
    // 殿身（55 宽 × 60 高，2.7..62.7）
    const bodyH = frontH - 7.3;
    b.ashlar.push(box('ashlar', frontW, bodyH, frontDepth, 0, 2.7 + bodyH / 2, zMidFront));
    // 中央封闭大拱门龛（dark 内衬 + 金券 3 层 + 楣饰）
    const openHalf = clearW / 2; // 8
    /* ── R39 回炉 · `clearH` 语义修正（拱顶高度）─────────────────────────────
     * 改前：`rise = clearH − 2.4 = 21.6`，而两心尖拱的**拱顶** = springY + rise
     *   + cusp = 2.4 + 21.6 + 1.1 = **y 25.1** ⇒ 实际净高只有 25.1m、h/w = **1.26**，
     *   与 r28Layout 注释「clearH 44 / h/w = 44/20 = 2.2」和 FBX `Arch_3` 的 2.41
     *   **两个都不符**（差在 cusp 没算，且 rise 被当成"总高"用）。
     *   后果（立面栅格实证）：门洞是 20×23m 的矮胖拱，近黑三角压在立面正中。
     * 改后：按 clearH 的原意（净高 44）反解 rise = clearH − springY − cusp = **40.5**
     *   ⇒ 拱顶 y = 2.4 + 40.5 + 1.1 = **44.0**，h/w = **2.20**（贴 FBX 2.41 的下沿）。
     *   tri 零变化：archBand/archPlate 的面数只由 segPerHalf 决定，与 rise 无关。
     * 连带：券四级 / 暗龛板 / 龛拱卷叶 / 拱头花格屏全部改用同一组 PORTAL_* 常量。 */
    const PORTAL_SPRING = 2.4;
    const PORTAL_CUSP = 1.1;
    const rise = clearH - PORTAL_SPRING - PORTAL_CUSP; // 40.5 ⇒ 拱顶 44.0
    /* ── R39 ④ 中央门洞重构：四级退台尖拱券 ──────────────────────────────────
     * 改前（R33）：三层券 band 1.5/0.95/0.55，前脸 +0.05/−1.10/−2.05 —— 后两层的
     * 挤出体全在 z<zFront 的**实心殿身里**（殿身前脸恰在 z=zFront），
     * 只有最外一层真的看得见，其余两层白占 ~300 tri。
     * 改后：四层券**全部前凸**（前脸 0.88/0.62/0.42/0.24，逐层内收 ~0.22），
     * band 加宽到 1.9/1.35/0.95/0.62 ⇒ 近景读作"层层退台的尖拱券"，门扇（前脸 0.14）
     * 退在最内层之后 ⇒ 真实纵深阴影（不再是贴片）。
     * ⚠ 设计稿的「三级退台各进深 0.8m（合计内凹 2.4m）」在**实心殿身**上不可能实现
     *   （z<zFront 即入石，且撞面约束限凸出 ≤0.9m）；本实现是等效退台：
     *   0.88 → 0.14 共 **0.74m** 纵深落差，观感等价、可复核（.qa/r39_hall/report.md）。
     */
    for (const [band, dep, front] of [
      [1.9, 0.85, 0.88],
      [1.35, 0.75, 0.62],
      [0.95, 0.65, 0.42],
      [0.62, 0.55, 0.24]
    ] as const) {
      const g = archBand(openHalf, PORTAL_SPRING, rise, band, dep, 9, PORTAL_CUSP, 0.45);
      g.rotateY(Math.PI);
      g.translate(0, 0, zFront + front - dep);
      b.gold.push(g);
    }
    // 暗龛背板（前脸 +0.04，压在殿身前脸之外 ⇒ 不 z-fight，且在四级券之**后**
    // ⇒ 券的每一级都读到自己的阴影）。厚度只 0.12m：殿身是实心盒，厚的没有任何收益。
    b.dark.push(archPlate(openHalf - 0.3, PORTAL_SPRING, rise, 0.12, 9, PORTAL_CUSP).translate(0, 0, zFront + 0.04));
    /* ── R39 ④b 双扇木门 + 石质半月楣（tympanum）────────────────────────────
     * 门扇落 **door 桶**（castle.variantMaterial('inner-wood')，木图集已备）+
     * 门钉/徽章落 **agedGold 桶**（gilded-aged 做旧金）⇒ **0 新贴图、0 新 DC**
     * （`castle-door` / `castle-agedGold` 两个全局 mesh 由 makeGate 早已存在）。
     * 纵深读数：券四级前脸 0.88/0.62/0.42/0.24，门扇前脸 +0.14（含门钉 0.11）⇒
     * 门在最内层券**之后** 0.1m、暗龛背板（+0.04）**之前** ⇒ 三层次序成立。
     * 落 y 2.4 起（台基顶 y 2.2 之上）—— 台基是第一级踏步，门不下沉到车道。
     * ⚠ door/agedGold 是**全局单 mesh**（不参与 z-zone 剔除）⇒ 逐 tri 全额递交，
     *   量必须小：2 扇门 = door 240 + agedGold 168 = **408 tri**（预算 ≤1,500 内）。
     */
    for (const s of [-1, 1] as const) {
      /* 两扇各 4.6 宽，中心 **±2.52**。为什么不是设计稿的「门缝 0.1」（±2.35）：
       * `doorLeaf` 自带 0.22 宽立门框（落在 w/2+0.11 处），中心取 ±2.35 时两扇的内框
       * 会**互叠 0.34m**，且在 y/z 面完全共面 ⇒ 0.34×9m 的共面条带必然 z-fight。
       * ±2.52 是两框**恰好对接**（x=0 处面接触、法线相反 ⇒ 各向背面剔除，不打架）的
       * 唯一取值，读作「双扇门 + 0.44m 中挺」，门扇净缝 0.44（比 0.1 宽，但中挺把它
       * 读成"双开"而不是"一条缝"）。 */
      pour(b, mapParts(doorLeaf({ w: 4.6, h: 9, studs: true }), (g) => g.translate(s * 2.52, 2.7, zFront - 0.06)));
    }
    /* 石质半月楣（tympanum）浮雕：12.4 × 3.2 ashlar 板 + 3 枚四叶金章 + 中央小尖拱。
     * 宽度取 12.4 而非设计稿 14：拱内净宽在 y 12..15 只有 ±6.6~5.5（见下），
     * 14m 板两侧会顶穿券线；12.4 留 0.6 余量，且板在券线**之后**（+0.10 < 0.24），
     * 越界部分被券挡住不影响读数。 */
    b.ashlar.push(box('ashlar', 12.4, 3.2, 0.16, 0, 13.8, zFront + 0.10));
    for (const tx of [-4.0, 0, 4.0] as const) {
      pour(b, mapParts(quatrefoilMedal({ r: 0.8 }), (g) => g.translate(tx, 13.8, zFront + 0.20)));
    }
    {
      // 中央小尖拱（券线坐在楣板上；ashlar 石作，不进 gold —— 金只在四叶章上）
      const spandrelArch = archBand(2.0, 12.8, 2.4, 0.28, 0.22, 3, 0.4, 0.45);
      spandrelArch.rotateY(Math.PI);
      spandrelArch.translate(0, 0, zFront + 0.14);
      b.ashlar.push(spandrelArch);
    }
    /* ── R39 回炉 P0-1：**拱头石质花格屏**（3 扇尖窗 + 顶部小玫瑰窗）──────────
     * 问题（主理人立面目检）：门洞净腔里除了门（9m）与半月楣（3.2m）之外全是 dark，
     *   正立面读作"一整块近黑三角"，跟 R33 拆掉的大金盘是同一种病 —— 换了颜色还是
     *   "一块东西堵住门"。栅格实测（.qa/r39_hall/stats.mjs，改前）：门洞内 dark
     *   可见 **383.6 m²**、立面 dark 像素占比 **3.50%**。
     * 修法：在半月楣之上（y 17.4）到拱顶之前填一面**石质透空花格屏**：
     *   3 扇并排尖窗（中扇更高，Window1 语汇）+ 顶 1 个 Ø5 玫瑰形圆窗
     *   （roseWindow 去掉外缘卷叶）+ 芯部金饰（Ø3.2 芯 + 6 短刺，≤120 tri）。
     *   石框落 ashlar、芯落 glass、其后 dark **只作缝隙阴影**（不再是大面积）。
     * ── 收边核算（逐高比对"拱内净宽"，全部留正余量，故无需裁剪也不露黑角）──
     *   两心尖拱：R = (rise²+halfW²)/(2·halfW) = (40.5²+8²)/16 = 106.52，c = 98.52；
     *   净半宽 x(y) = R·√(1−((y−2.4)/R)²) − c
     *     y 17.4 → ±7.00 ｜ 屏最外沿（边扇 4.45）✓ 余 2.55
     *     y 26.2 → ±5.41 ｜ 边扇尖顶外包络 ±4.45 ✓ 余 0.96
     *     y 29.2 → ±4.63 ｜ 中扇尖顶 ±1.70 ✓
     *     y 33.0 → ±3.66 ｜ Ø5 玫瑰外包络 ±3.42 ✓ 余 0.24（最紧的一处）
     *   ⚠ 为什么不是设计稿的 **Ø7**：Ø7 外包络 = 3.5+0.92 = ±4.42 > 拱在 y33 的 ±3.66
     *     ⇒ 圆窗两侧必露黑角（这正是"矩形屏塞进尖拱、四角露黑"的同型错误）。
     *     Ø5 是本拱内**能整圆装下的最大直径**；若要 Ø7 必须把拱顶再抬到 ≈52（h/w 2.6，
     *     越过 FBX 2.41），会与 y55 的玫瑰窗挤在一起 ⇒ 不取。
     * ── 纵深 ── 屏 base z = zFront+0.06、frameOut 0.16 ⇒ 前脸 **0.22**，
     *   在四级券最内层前脸 0.24 之**后**、暗龛板 0.04 之**前** ⇒「券 → 屏 → 龛」
     *   三层次序成立，且**不占撞面凸出预算**（0.22 ≪ 0.9）。
     */
    /* 拱头石质填料（y ≥ 16.6 的拱腔填石）：dark 只留在门/楣周边作缝隙阴影。
     * 层序（沿 +z 从后到前）：暗龛板 0.04 → **石填料 0.07** → 花格屏 0.10 → 金芯 0.51。 */
    b.ashlar.push(
      archHeadPlate(openHalf - 0.3, PORTAL_SPRING, rise, 16.6, 0.06, 9, PORTAL_CUSP).translate(0, 0, zFront + 0.07)
    );
    {
      const SCREEN_Z = zFront + 0.10;
      const screenLancet: readonly (readonly [number, number, number, 2 | 3])[] = [
        [-3.0, 1.15, 8, 2],
        [0, 1.4, 11, 3],
        [3.0, 1.15, 8, 2]
      ];
      for (const [lx, halfW, rs, mull] of screenLancet) {
        pour(
          b,
          mapParts(
            traceryWindowZ({
              halfW,
              rise: rs,
              cusp: 0.75,
              frameOut: 0.16,
              plateBack: 0.22,
              mullions: mull,
              lights: true,
              recess: true,
              subArches: false,
              goldFrame: false
            }),
            (g) => g.translate(lx, 17.4, SCREEN_Z)
          )
        );
      }
      // 顶部小玫瑰窗（Ø5；去掉外缘卷叶以装进拱内，depth 0.30 收在券线之后）
      pour(
        b,
        mapParts(roseWindow({ r: 2.5, petals: 8, spokes: 12, ringSegs: 16, depth: 0.3, leaves: 0 }), (g) =>
          g.translate(0, 33.0, zFront + 0.08)
        )
      );
      /* 芯饰：金芯 + 6 根短刺（P0-2 允许保留的唯一"门楣聚焦"）。
       * ⚠ 设计稿写 Ø3.2，那是配 Ø7 圆窗的比例；本拱内只能放下 **Ø5**（见上表），
       *   Ø3.2 会占 64% 直径 ⇒ 立面目检读作"圆窗中间又贴了一枚金币"（正是要消解的
       *   读法）。按同一比例降到 **Ø1.8（36%）+ 刺长 0.55**，读作窗芯而不是币。 */
      const hubR = 0.9;
      const hub = new THREE.CylinderGeometry(hubR, hubR * 0.66, 0.3, 12);
      hub.rotateX(Math.PI / 2);
      hub.translate(0, 33.0, zFront + 0.32);
      planarUV(hub, TILE.gold);
      b.gold.push(hub);
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        b.gold.push(
          boxRot('gold', 0.55, 0.13, 0.14, Math.cos(a) * (hubR + 0.32), 33.0 + Math.sin(a) * (hubR + 0.32), zFront + 0.3, a)
        );
      }
    }
    // R29 暗龛背衬：archPlate 由 9 段挤出，段缝与拱形边界之间会漏出背后的亮石，
    // 在近景读成"竖向梯子条纹"（verify/r29_final/hall_front.png 龛内实测）。
    // 这里补一块整幅近黑背板兜底（位于龛底，不与立面共面 ⇒ 无 z-fighting）。
    b.dark.push(box('dark', clearW + 1.6, clearH + 1.6, 1.2, 0, (clearH + 1.6) / 2, zFront - frontDepth + 0.8));
    /* ── R39 回炉 P0-2：**拆掉整组「金日轮/翼形饰」**──────────────────────────
     * 主理人立面目检：玫瑰窗（Ø13 @ y62）正下方紧贴一个 Ø14 金日轮（R29 语汇：
     * 实心金盘 → R39 上一版改的透空金环 + 16 放射金线 + 12 金刺 + 8 花瓣 +
     * 双侧翼卷 + 黑底），两个同心圆上下叠，读作"大圆套小圆 / 钟面"；且它的黑底
     * 又贡献一块黑洞。**整组移除**（含 dark 圆盘与 glass），只把"门楣聚焦"降级成
     * 花格屏顶圆窗中心的 Ø3.2 金芯 + 6 短刺（见 P0-1 屏块末，≈130 tri）。
     * 移除量（实测）：gold 环 56 + 放射线 192 + 花瓣 96 + 金刺 144 + 翼卷 3×2 件
     * + dark 24 + glass 24 ⇒ 约 **−620 tri**。
     * ⚠ 与 R39 上一版的关系：上一版把"实心金盘"改成"透空金环"是为了消解"金币"
     *   读法；但主理人判断"两个圆叠在一起"本身就是冗余 ⇒ 本版直接删除整个语汇，
     *   门洞上方改用"花格屏 + 小玫瑰窗"，立面只剩 **一个** 大圆（y62 玫瑰窗）。
     */
    // 门龛两侧尖拱窗列（R29 横向拓展：按 frontW 分 4 开间/侧，铺满 88m 立面）
    /* ── R39 ⑤ 比例修正（hero 窗）───────────────────────────────────────────
     * 实测硬伤：hero 尖窗高宽比 **3.33**（rise 7.0 / 净宽 2.1〔halfW .55×2 + frameOut .5×2〕），
     * FBX 标准尖窗 `WCArchElemWindow1_Full` = **6.58**（1.07×7.04）。
     * 根因：`frameOut` 把**净宽**撑大了 —— 券框是"框架"，不是"洞口"。
     * 改法：rise 7.0 → **9.5**、frameOut 0.5 → **0.35** ⇒ 整体 1.8 × 9.5 = h/w **5.28**。
     * 为什么不继续收 halfW：主殿在 300~470m 实机距离上，0.55m 半宽已 ~2px；再收就消失。
     * （tri 零变化：archBand 的面数只由 segPerHalf 决定，与 band/frameOut 无关。）
     */
    for (const side of [-1, 1] as const) {
      const halfFront = frontW / 2;
      const bays = 4;
      const baySpan = (halfFront - (openHalf + 3.2)) / bays;
      for (let i = 0; i < bays; i += 1) {
        const wx = side * (openHalf + 3.2 + baySpan * (i + 0.62));
        // R30 换装花格窗（金框 + 双棂 + 拱肩光；原 lancetWindow 182 tri → 120 tri）
        // R36 A3+B2：主立面 hero 窗竖棂 3 + 真凹腔；R39 ⑤：rise 9.5 / frameOut 0.35
        pour(
          b,
          mapParts(
            traceryWindowZ({ halfW: 0.55, rise: 9.5, cusp: 0.8, frameOut: 0.35, plateBack: 0.32, mullions: 3, lights: true, recess: true }),
            (g) => g.translate(wx, 6.5, zFront)
          )
        );
        // R36-A3：卷叶 crockets 沿主立面窗尖拱缘（2 片/侧，控 tri）
        pour(
          b,
          mapParts(
            crocketRun({ halfW: 0.55 * 0.92, rise: 9.5 * 0.9, count: 2, size: 0.16, cusp: 0.8 }),
            (g) => g.translate(wx, 6.5, zFront + 0.42)
          )
        );
        // 每开间一根竖向金饰条（参考图的"金线拉高"语言）
        b.gold.push(box('gold', 0.42, frontH - 9, 0.18, wx + side * 2.1, (frontH - 9) / 2 + 4, zFront + 0.05));
        // 开间之间的壁柱（白石竖带，制造竖向节奏而不是一块平墙）
        if (i < bays - 1) {
          const px = side * (openHalf + 3.2 + baySpan * (i + 1));
          b.ashlar.push(box('ashlar', 1.5, frontH - 8, 0.9, px, (frontH - 8) / 2 + 3, zFront + 0.35));
        }
      }
    }
    /* ── R39 ⑤b 三道通长横金饰带：由「30.4m 厚的通体大板」改「前脸薄贴带」──────
     * 改前：`box('gold', frontW+0.6, 0.34, frontDepth+0.4, …, zMidFront)` —— 实体是
     * 30.4m 厚的金板穿过整个殿身，前脸凸出 **+0.2**；hero 窗 rise 抬到 9.5 后
     * 窗拱顶（y 16.8）会跨过 y=14 那道带 ⇒ 金带压在**玻璃前面** 0.06m，
     * 切窗（改前 rise 7.0 拱顶 13.8，不跨 y=14，所以没暴露）。
     * 改后：厚度收到 0.07、前脸 +0.03（< 窗暗板 +0.06、玻璃 +0.14、券框 +0.35）
     * ⇒ 横带**压在窗洞之后**，读作"线脚被窗打断"（真哥特立面的正确读法），
     * 同时去掉 30m 厚的不可见实体板。tri 不变（同 12 面 box）。
     */
    for (let i = 0; i < 3; i += 1) {
      b.gold.push(box('gold', frontW + 0.6, 0.34, 0.07, 0, 14 + i * 12, zFront + 0.03 - 0.035));
    }
    /* ══════════════ R39 ①②③ 正立面三段 FBX 级雕刻 ══════════════════════════
     * 分带实测（改前，.qa/r39_hall/report.md）：y 72..96 = **0 件** / y 52..72 = 5 件
     * 小饰 / 玫瑰窗**完全缺失**。三段一次补齐（全部包 isLowDetail ⇒ 低档 0 产出）：
     *   ① 玫瑰窗：x=0、**圆心 y 62、r 6.5**（Ø13m = 立面 96m 的 13.5%，FBX §7
     *      「玫瑰窗占整体高 5%~7%」按主殿尺度放大到 13.5% —— 理由是主殿在 961m 峰值
     *      帧之外、实机最近可视距离 ≈300m，5% 的玫瑰窗（4.8m）在该距离只有 ~6px，
     *      读不出来）；外圈石券框 + 8 片卷叶 + 玻璃 + dark 深腔（详见玉 roseWindow）。
     *   ② y 72..96 上空带：8 扇高窄尖窗（4/侧，h/w 6.8 ≈ FBX 6.58）+ 每扇 4 片卷叶
     *      + 3 根/侧壁柱顶尖塔 + y=72 / y=93.4 两道**齿饰檐口**（dentilBand）。
     *   ③ y 52..72 空带：玫瑰窗两侧各 2 座雕像龛（x ±12/±20，y 56）+ 龛内垂幔浮雕
     *      作"雕像读法"（FBX 无雕像，§2「FBX 无雕像」；用 draperyRelief 替代并注释）
     *      + 两侧各一列**盲拱**（盲拱 3 龛，补 y 52..72 的两翼空白）。
     */
    if (!isLowDetail()) {
      // ── ① 玫瑰花窗（Ø13m，圆心 y 62）──
      pour(b, mapParts(roseWindow({ r: 6.5, petals: 16, spokes: 20, ringSegs: 28 }), (g) => g.translate(0, 62, zFront)));

      // ── ② y 72..96 上空带 ──
      const bays2 = 4;
      const baySpan2 = (frontW / 2 - (openHalf + 3.2)) / bays2;
      for (const side of [-1, 1] as const) {
        for (let i = 0; i < bays2; i += 1) {
          const wx = side * (openHalf + 3.2 + baySpan2 * (i + 0.62));
          // 高窄尖窗（整体 2.3 × 15.7 ⇒ h/w 6.8；FBX Window1_Full 6.58）
          pour(
            b,
            mapParts(
              traceryWindowZ({ halfW: 0.85, rise: 15, cusp: 0.7, frameOut: 0.3, plateBack: 0.32, mullions: 3, lights: true, recess: true }),
              (g) => g.translate(wx, 74, zFront)
            )
          );
          // 沿尖拱缘 4 片卷叶（count 2 = 每侧 2 片；size 0.55 = 门龛 1.2 的小一档）
          pour(
            b,
            mapParts(
              crocketRun({ halfW: 0.85 * 0.92, rise: 15 * 0.9, count: 2, size: 0.55, cusp: 0.7 }),
              (g) => g.translate(wx, 74, zFront + 0.3)
            )
          );
        }
        /* 窗间壁柱顶尖塔 ×5/侧（3 根落在下排壁柱正上方 + 两端封檐各 1）。
         * ⚠ **不用 pinnacleCluster**：它的 footprint 是 **w×w 方阵**（w 2.3 ⇒ 2.3m 深）
         * + 4 角副塔再外扩 0.62w ⇒ 贴 z 向立面放置时凸出量到 **2.04m**（实测，
         * 木已成舟的撞面 ≤0.9 约束不允许）。改用「方座 + 八棱鼓 + 锥顶 + 金尖」
         * 手工小尖塔（Decor_9 语汇同族），径向半径 0.6 ⇒ 凸出 0.90m，正好卡在约束上。
         * tri 52/根（box 12 + 鼓 16 + 锥 16 + 金尖 8），5 根/侧 ⇒ 520。 */
        const pinnacle = (px: number): void => {
          b.ashlar.push(box('ashlar', 1.2, 0.5, 0.9, px, 89.75, zFront + 0.3));
          b.ashlar.push(spire('ashlar', 0.6, 0.45, 1.5, 4, px, 90.0, zFront + 0.3, Math.PI / 4));
          b.ashlar.push(spire('ashlar', 0.44, 0, 1.9, 4, px, 91.5, zFront + 0.3, Math.PI / 4));
          b.gold.push(spire('gold', 0.16, 0, 0.5, 4, px, 93.4, zFront + 0.3));
        };
        for (let i = 0; i < bays2 - 1; i += 1) pinnacle(side * (openHalf + 3.2 + baySpan2 * (i + 1)));
        // 两端封檐尖塔（x = 11.2 与 43.2：立面竖向节奏的收头）
        pinnacle(side * (openHalf + 3.2));
        pinnacle(side * (frontW / 2 - 0.8));
      }
      // 两道齿饰檐口（FBX Cornice 标准高 1.41 + 齿列；proj 0.7 < 壁柱 0.8 ⇒ 壁柱在前）
      for (const yy of [72, 93.4] as const) {
        pour(
          b,
          mapParts(dentilBand({ len: frontW + 2, h: 1.41, toothW: 0.42, gap: 0.34, proj: 0.7 }), (g) =>
            g.rotateY(Math.PI / 2).translate(0, yy, zFront)
          )
        );
      }

      // ── ③ y 52..72 空带：雕像龛 + 盲拱列 双排（玫瑰窗两侧）───────────────
      /* 横向落位不是拍脑袋：本带在 y 52..72 只有**满高壁柱**是障碍（1.5m 宽，前脸
       * +0.8，x = openHalf+3.2 + 8.2×(i+1) = ±19.4 / ±27.6 / ±35.8），其余是平墙。
       * 于是可用的"开间"是 4 段：A 11.9..18.65（心 15.3）、B 20.15..26.85（心 23.5）、
       * C 28.35..35.05（心 31.7）、D 36.55..43.5（心 40）。
       *   A = 雕像龛（x 11.6，龛环外缘 10.62..12.58 —— 比设计稿的 ±12 内移 0.4，
       *       因为 A 区还要塞一列盲拱，11.6 是两者唯一不打架的位置）+ 盲拱列（x 16.4）
       *   B = 金线柱（见 ⑥ 的四叶章列；改到平墙才看得见 —— 原落点 ±28 正好在壁柱
       *       ±27.6 上，Ø3m 金盘有 1.5m 埋在壁柱后面）
       *   C = 雕像龛（x 31.7）  D = 盲拱列（x 40）
       * ⚠ 设计稿的「x = ±12/±20 各 2 座龛」里 **±20 不可行**：满高壁柱 ±19.4（1.5 宽）
       *   把 18.65..20.15 占死，1.6m 宽的龛压上去会被壁柱切掉一半。
       * 双排（y 56 / y 64.5）依据：本带 20m 高、88m 宽 = 1,760 m²，单排只占 1/3 高度；
       * FBX 门楼正立面同一带里是 2~3 层叠置的盲龛（`fbx_elev` 11.19..15.87 段实体
       * 占比 0.39 = 上部镂空/开窗带）。 */
      for (const side of [-1, 1] as const) {
        // ── 第一排（y 56）：雕像龛 ×2 + 盲拱列 ×2 ──
        for (const nx of [11.6, 31.7] as const) {
          const cx = side * nx;
          // 龛框（金环 + 楣卷叶）：statueNicheZ 自带的凹腔/立像落在 z<zFront 的实心
          // 殿身里（face 'z' 的既有缺陷，见下方 dark 板的补法），这里只借它的框。
          pour(b, mapParts(statueNicheZ({ halfW: 0.8, rise: 3.0, cusp: 0.5 }), (g) => g.translate(cx, 56, zFront)));
          // 龛内深腔：dark 板**抬到墙面外 +0.03**（否则整块埋在实心石里、看不见）
          b.dark.push(archPlate(0.72, 0, 2.9, 0.1, 3, 0.5).translate(cx, 56, zFront + 0.03));
          // 龛内垂幔浮雕（"雕像读法"；前脸 +0.10 = 龛框 0.4 之内 ⇒ 读作凹）
          pour(
            b,
            mapParts(draperyRelief({ w: 1.4, h: 3.2, folds: 3 }), (g) =>
              g.rotateY(Math.PI / 2).translate(cx, 56.3, zFront - 0.25)
            )
          );
        }
        for (const nx of [16.4, 40] as const) {
          pour(
            b,
            mapParts(blindArcadeRow({ count: 2, halfW: 0.7, rise: 5.5, pitch: 3.2, cusp: 0.5 }), (g) =>
              g.rotateY(Math.PI / 2).translate(side * nx, 56, zFront)
            )
          );
        }
        // ── 第二排（y 64.5）：四列盲拱（比第一排小一号，读作"上收的叠层"）──
        for (const nx of [15.3, 23.5, 31.7, 40] as const) {
          pour(
            b,
            mapParts(blindArcadeRow({ count: 2, halfW: 0.62, rise: 4.4, pitch: 3.2, cusp: 0.5 }), (g) =>
              g.rotateY(Math.PI / 2).translate(side * nx, 64.5, zFront)
            )
          );
        }
      }
    }
    // 檐口 + 垛口
    b.ashlar.push(box('ashlar', frontW + 2.4, 1.4, frontDepth + 1.8, 0, frontH - 0.7, zMidFront));
    b.gold.push(box('gold', frontW + 2.6, 0.26, frontDepth + 2, 0, frontH + 0.15, zMidFront));
    // R4-2 主殿前排檐口加 corniceBand（参考图檐口退台线脚；rotateY(+π/2) 使局部 −x 外挑转到 +z 朝向观察者）。
    // 落点 z 取 zFront+0.9（正脸在 z=-1300，既有檐口 box 前脸 ≈ -1299.1）：带体凸出约 0.3m，可见且不穿模（zMidFront 会埋入殿身 15m，已弃用）。
    if (!isLowDetail()) {
      pour(
        b,
        mapParts(
          corniceBand({ len: frontW + 2.4, proj: 0.6, h: 1.2 }),
          (g) => g.rotateY(Math.PI / 2).translate(0, frontH - 0.7, zFront + 0.9)
        )
      );
    }
    const merlons = Math.floor(frontDepth / 2.4);
    for (let m = 0; m < merlons; m += 1) {
      const mz = zBack + 1 + (frontDepth * (m + 0.5)) / merlons;
      b.ashlar.push(box('ashlar', frontW, 1.4, frontDepth / merlons / 2, 0, frontH + 1.1, mz));
    }
    /* ── R29 正立面「精装」：檐口小尖塔排 + 顶部叠涩线脚 ──────────────────
     * 参考图 7cd7329c 的主殿/门楼天际线是一圈**密集小尖塔**（crocket pinnacle），
     * 这是"哥特"识别度最高的剪影特征。当前主殿顶部只有光板 + 单根冠，
     * 88m 宽的立面顶部是一条平线 ⇒ 读作"白盒子"（verify/r29_c1/hall_front.png）。
     * 这里沿 frontW 铺一排 13 根小尖塔（16 tri/根）+ 顶部金饰线脚。 */
    {
      const n = 13;
      for (let k = 0; k < n; k += 1) {
        const px = -frontW / 2 + 1.6 + (k * (frontW - 3.2)) / (n - 1);
        b.ashlar.push(box('ashlar', 1.5, 1.3, 1.5, px, frontH + 1.5, zFront - 1.2));
        b.gold.push(spire('gold', 0.28, 0, 0.5, 4, px, frontH + 2.15, zFront - 1.2));
        b.ashlar.push(spire('ashlar', 1.0, 0, 3.6, 4, px, frontH + 2.1, zFront - 1.2, Math.PI / 4));
      }
      // 顶部叠涩线脚（三段退台，参考图的檐口层次）
      b.ashlar.push(box('ashlar', frontW + 3.0, 0.5, frontDepth + 2.4, 0, frontH + 0.25, zMidFront));
      b.ashlar.push(box('ashlar', frontW + 3.6, 0.42, frontDepth + 3.0, 0, frontH - 0.2, zMidFront));
      // R32-A2 桶位更正：205×47.6m **水平**冠座顶板（顶面+底面 19,637 m² = 全场景
      // gold 表面积 8.8%）→ ashlar。它在 96m 高**水平朝上**，街面只读到 0.16m 侧边
      // ⇒ 属"体量件误投 gold 桶"（T1 情形 a）。金饰留在**可见**处（见下方 1738 金饰带）。
      b.ashlar.push(box('ashlar', frontW + 3.8, 0.16, frontDepth + 3.2, 0, frontH + 0.52, zMidFront));
    }
    // 尖顶冠（kit④ 细杆语言，无钟面）
    const rodH = crownH - frontH; // 34
    b.ashlar.push(box('ashlar', 9, 5, 9, 0, frontH + 2.5, zMidFront)); // 冠座
    b.gold.push(spire('gold', 3.6, 0, rodH - 5, 8, 0, frontH + 5, zMidFront, Math.PI / 8));
    b.gold.push(spire('gold', 0.5, 0.5, 0.8, 8, 0, frontH + 4.9, zMidFront));
    b.gold.push(spire('gold', 0.42, 0, 2.4, 6, 0, crownH, zMidFront));
  }

  /* ── 两翼墙（±28 → ±65，低于前排，纯视觉件不参与碰撞）── */
  {
    const wingH = 62; // R29：36 → 62（主殿 frontH 96，翼墙 0.65× 主殿 → 层次明确不塌）
    for (const side of [-1, 1] as const) {
      const cx = side * (wingInner + wingOuter) / 2;
      const w = wingOuter - wingInner; // 37
      b.ashlar.push(box('ashlar', w, wingH, frontDepth, cx, wingH / 2, zMidFront));
      /* R39 ⑤c 翼墙叠涩：0.6 → **1.4**（FBX `WCArchElemCornice_2_Full` 檐口标准高
       * **1.41**，真值表 §6 `CORNICE_H`）。原 0.6 只有 43% 标准高 ⇒ 翼墙顶读作
       * "薄薄一条白边"。改后顶部金线随之上移 0.8（1.4/2 − 0.6/2 = 0.4 → 金线 y
       * 由 wingH+0.78 抬到 wingH+1.18），总高仍 < 前排檐口 95.3，层次不变。 */
      b.ashlar.push(box('ashlar', w + 0.8, 1.4, frontDepth + 0.8, cx, wingH + 0.7, zMidFront));
      b.gold.push(box('gold', w + 1, 0.24, frontDepth + 1, cx, wingH + 1.58, zMidFront));
      // 垛口 + 金齿饰（垛口底面随叠涩上移到 wingH+1.4）
      const merlons = Math.floor(frontDepth / 2.4);
      for (let m = 0; m < merlons; m += 1) {
        const mz = zBack + 1 + (frontDepth * (m + 0.5)) / merlons;
        b.ashlar.push(box('ashlar', w, 1.2, frontDepth / merlons / 2, cx, wingH + 2.0, mz));
        b.gold.push(spire('gold', 0.2, 0, 0.38, 4, cx, wingH + 2.6, mz));
      }
      // 尖拱窗列（朝路心；R29 由 3 扇扩到 5 扇，跟上 frontDepth 30 的纵深）
      // R30 换装花格窗（金框 + 双棂 + 拱肩光）；R36 A3+B2：竖棂 3 + 真凹腔
      /* R39 ⑤d 翼墙窗：**整族迁移到可见立面** + 比例修正。
       * ⚠ 改前是 R30 遗留的**死几何**：翼墙的临街面是 **+z**（前脸与主立面同面，
       *   z=zFront），而窗用 `traceryWindowX` 挂在 |x| = wingInner = 44 的 x 法向面上，
       *   且 wz ∈ [zMidFront−11, zMidFront+11] = [−1326, −1304] —— 全部落在
       *   翼墙体（z −1330..−1300）**内部**，10 扇窗一辈子没被看见（立面栅格实证：
       *   改前两翼 61×62m 全白）。R39 把它换成 `traceryWindowZ` 平移到 zFront ⇒
       *   **tri 零变化**（同型号几何，只是从不可见变可见），同时按 ⑤ 比例修正
       *   rise 5.6 → 7.4、frameOut 0.45 → 0.32（2.44 × 7.4 ⇒ h/w 3.03，
       *   与后排窗 2.61 / hero 窗 5.28 形成梯度）。 */
      for (let i = 0; i < 5; i += 1) {
        const wx = side * (46 + ((i + 0.5) * 57) / 5);
        pour(
          b,
          mapParts(
            traceryWindowZ({ halfW: 0.9, rise: 7.4, cusp: 0.75, frameOut: 0.32, plateBack: 0.3, mullions: 3, lights: true, recess: true }),
            (g) => g.translate(wx, 6, zFront)
          )
        );
      }
      /* ── R39 回炉 P1：翼墙上层**两层窄窗** + 每层窗下薄金线 ──────────────────
       * 改前：翼墙 61×62m 里只有 y6..14 一排窗，y>15 的 50m 是纯白（栅格实测：
       *   y∈[15,62] 区装饰覆盖率 **1.22%**），占整幅立面宽度的 40%。
       * 补两层窗（y 24 / y 40，每层 4 扇，halfW .7 / rise 8 / frameOut .28
       *   ⇒ 整体 1.96 × 8.75，h/w **4.47**，介于后排 2.61 与 hero 5.28 之间），
       *   每层窗下补一道 0.16 高薄金线（前脸 +0.04）把三层串成竖向节奏。
       * ⚠ 两处对设计稿的修正（数字见 .qa/r39_hall/report.md）：
       *   ① 翼宽**不是 37m 而是 61m**（`wingOuter − wingInner = 105 − 44`；代码里
       *      `// 37` 是 R29 残留注释）⇒ 4 扇按可用段 47..95 均分，pitch 12m；
       *   ② 上层窗**不与底层 5 扇对齐**：底层第 5 扇在 x 97.3，而翼墙外端有一对
       *      雕像龛在 |x| = wingOuter−6 = **99**（y 20 / y 40），98.15..99.85 已被占，
       *      4 扇落在 53/65/77/89 才不会压到龛框。
       */
      // ⚠ 低档守卫：新增装饰件在远档必须零产出（铁律 33「只降装饰密度」+ 低档 tri 只降不涨）
      if (!isLowDetail()) for (const wy of [24, 40] as const) {
        for (let i = 0; i < 4; i += 1) {
          const wx = side * (47 + ((i + 0.5) * 48) / 4);
          pour(
            b,
            mapParts(
              traceryWindowZ({
                halfW: 0.7,
                rise: 8,
                cusp: 0.7,
                frameOut: 0.28,
                plateBack: 0.28,
                mullions: 2,
                lights: true,
                recess: true
              }),
              (g) => g.translate(wx, wy, zFront)
            )
          );
        }
        // 窗下薄金线（0.16 高；前脸 +0.04 ⇒ 不抢券框的 0.28）
        b.gold.push(box('gold', wingOuter - wingInner - 2, 0.16, 0.08, side * ((wingInner + wingOuter) / 2), wy - 0.5, zFront + 0.04));
      }
      /* 竖向金饰条 ×2（翼墙外棱）：改前落 z = zMidFront + frontDepth/2 − 0.2 = −1300.2
       * ⇒ 整条**埋在翼墙面里 0.2m**（同 ⑤d 的死几何）。R39 抬到前脸 zFront+0.05，
       * 并把「内侧根」从 x=wingInner+0.5 移到内棱 wingInner+0.9（避开 ⑤d 窗列），
       * 外棱由 x=wingInner+w−0.5 = 80.5（**翼墙中部**，明显是算错）改到 wingOuter−0.9。 */
      b.gold.push(box('gold', 0.32, wingH - 2, 0.16, side * (wingInner + 0.9), (wingH - 2) / 2 + 1, zFront + 0.05));
      b.gold.push(box('gold', 0.32, wingH - 2, 0.16, side * (wingOuter - 0.9), (wingH - 2) / 2 + 1, zFront + 0.05));
    }
  }

  /* ── 后排主殿身（rearDepth 37，低于前排，侧视多层体量 2497fab5 相容）── */
  {
    const rearH = 30;
    b.ashlar.push(box('ashlar', facadeW - 6, 1, depth - frontDepth + 2, 0, 0.5, zBack + (depth - frontDepth) / 2));
    b.ashlar.push(box('ashlar', facadeW - 8, rearH, depth - frontDepth, 0, 1 + rearH / 2, zBack + (depth - frontDepth) / 2));
    b.ashlar.push(box('ashlar', facadeW - 6, 1.2, depth - frontDepth + 1.4, 0, 1 + rearH + 0.6, zBack + (depth - frontDepth) / 2));
    // R32-A2 桶位更正：后殿块 90.6×32m **水平**顶盖（5,862 m²）→ ashlar（同上：水平朝上不可读）
    b.ashlar.push(box('ashlar', facadeW - 5, 0.24, depth - frontDepth + 1.6, 0, 1 + rearH + 1.4, zBack + (depth - frontDepth) / 2));
    // 双坡顶（石 → R31 改 roof 桶：斜面瓦，材料丰富度）
    {
      const cz = zBack + (depth - frontDepth) / 2;
      const run = (facadeW - 8) / 2;
      const ridgeY = 1 + rearH + 4.5;
      for (const rs of [-1, 1] as const) {
        const lx = rs < 0 ? -run / 2 : run / 2;
        extra(b, 'roof', boxRot('roof', Math.hypot(run, 4.5), 0.5, depth - frontDepth - 2, lx, (1 + rearH + 1.2 + ridgeY) / 2, cz, -rs * Math.atan2(4.5, run)));
      }
      b.gold.push(box('gold', 0.4, 3.2, 0.4, 0, ridgeY + 1.6, cz)); // 屋脊金十字
      b.gold.push(box('gold', 1.8, 0.4, 0.4, 0, ridgeY + 2.4, cz));
    }
    // 后排尖拱窗 ×8（朝 +z 面；R29 由 4 扇铺到 ±0.36×facadeW，跟上 210m 立面）
    // R30 换装花格窗（无拱肩光的 96 tri 版——后排属远景带，节流；R36-B2 真凹腔）
    // R39 ⑤e 后排窗比例：rise 5.2 → **6.8**（frameOut 保持 0.45 —— 后排窗在 200m
    //   宽的远景带、无近景读法，收框只会让 8 扇窗在 210m 立面上消失）。
    //   改前 2.6 × 5.2 ⇒ h/w 2.00；改后 2.6 × 6.8 ⇒ **2.61**。
    for (let i = 0; i < 8; i += 1) {
      const wx = -facadeW * 0.36 + (i * facadeW * 0.72) / 7;
      pour(
        b,
        mapParts(
          traceryWindowZ({ halfW: 0.85, rise: 6.8, cusp: 0.7, frameOut: 0.45, plateBack: 0.3, mullions: 2, recess: true }),
          (g) => g.translate(wx, 5, zBack + (depth - frontDepth))
        )
      );
    }
  }

  /* ── 前广场带：**R29 删除大台阶**（用户令「主殿前的台阶去除」）──────────────
   * 视觉线实证（截图 321Z）：4 级台阶 + 台基在驾驶员视角里横穿整幅车道
   * （画面 y 33–48%），把主殿基座整条遮住，被读成"阻隔模块/挡墙"。
   * 现改为**完全平整**的广场：铺装由 castle.ts 的 pave-road / pave-walk 连续覆盖到
   * 主殿立面，这里不再生成任何 y > 0.02 的横穿体块（走廊探针的判据同此）。
   * `MAIN_HALL.stepLevels` 已置 0，保留常量位以免旧引用报错。 */
  {
    const plazaNear = z - MAIN_HALL.plazaDepth; // −1282
    // 大门火盆对（门龛两侧 ±11）
    for (const side of [-1, 1] as const) {
      const cx = side * HALL_BRAZIER.gatePairX;
      b.ashlar.push(box('ashlar', 1.1, 1.0, 1.1, cx, 0.5, z - 3.2));
      b.gold.push(spire('gold', 0.34, 0.62, 1.15 * HALL_BRAZIER.gatePairScale, 10, cx, 1.0, z - 3.2)); // 金碗盆（下收口）
      b.gold.push(spire('gold', 0.72, 0.72, 0.14, 10, cx, 1.0 + 1.15 * HALL_BRAZIER.gatePairScale, z - 3.2)); // 盆口沿
      b.flame.push(flame(0.4, 0.75 * HALL_BRAZIER.flameScale, cx, 1.0 + 1.15 * HALL_BRAZIER.gatePairScale + 0.14, z - 3.2));
    }
    // 列阵火盆（广场两侧各 2 座，z 节拍 5，栏板内侧 1.5）
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < HALL_BRAZIER.arrayCount; i += 1) {
        const cx = side * (ROAD_HALF + HALL_BRAZIER.arrayInset);
        const cz = plazaNear + 3.5 + i * HALL_BRAZIER.arrayPitch;
        b.ashlar.push(box('ashlar', 0.9, 0.8, 0.9, cx, 0.4, cz));
        b.gold.push(spire('gold', 0.28, 0.52, 1.15, 10, cx, 0.8, cz));
        b.gold.push(spire('gold', 0.6, 0.6, 0.12, 10, cx, 0.8 + 1.15, cz));
        b.flame.push(flame(0.34, 0.72, cx, 0.8 + 1.15 + 0.12, cz));
      }
    }
  }

  /* ── R30 构件库复刻（castleDetail；SM_Det Contrforce/Decor/Cornice 语汇）────────
   * ① 飞扶壁 ×6（每侧 3 座）：FBX Contrforce 家族的核心语汇落到主殿正立面——
   *    广场上的外墩（|x| = 13.5/21.5/29.5，墩在立面之前 z≈zFront+5.3）飞拱升至
   *    殿身 y≈78，与开间壁柱错开半个节拍 ⇒ 参考图主立面的"扶壁节奏"。
   *    ⚠ 探针纪律：墩/拱全部 |x|≥12.2（>走廊 8）、y≥2.7；落点在立面 z=zFront
   *    （minZ −1300.7 < 白名单 −1298 ⇒ 探针跳过，属设计内贴面件）。
   * ② 翼墙盲拱列 ×14（每侧 7 龛）：参考图构件 2 identity 落到两翼内壁（窗带之上）。
   * ③ 大龛拱卷叶 ×16：沿门龛尖拱斜边等距小金卷叶（cusp 1.1 同门龛）。
   * ④ 雕像龛 ×5：正立面开间起点 |x|=13（窗顶之上 y 40）+ 冠座前脸。
   * ⑤ 纹章顶饰 ×1：尖顶冠金尖之上（y≈131）的金色放射纹章（天际线收口）。
   * ⑥ 翼墙顶连廊 ×2（主殿两翼之间 wingInner 44→wingOuter 105）：楼面 64m，
   *    沿两翼顶（垛口 64.6 之上）贯通 wingOuter。 */
  {
    // ① 飞扶壁 ×6（每侧 3 座）。形体局部：墙面 x=0、向 +x 伸出、depth 沿 z；
    //    立面朝 +z ⇒ rotateY(−π/2)：伸出轴 → 世界 +z（墩落在广场之前 z≈zFront+5.3）、
    //    厚度轴 → 世界 x（墩宽 2.6 沿街向）⇒ 真 3D 飞扶壁（墩-拱-落点），
    //    不是贴在立面上的平面弧板。
    //   R32：改**扶壁对**（pairGap 3.2 ⇒ 每位双墩）+ 墩顶尖拱覆盆 + 墩身竖金条，
    //    三对**递减**（reach 7→6.2→5.4 / pierW 2.6→2.3→2.0，参考图 B 递减扶壁对）。
    for (const side of [-1, 1] as const) {
      for (const [wx, reach, pierW] of [
        [13.5, 7.0, 2.6],
        [21.5, 6.2, 2.3],
        [29.5, 5.4, 2.0]
      ] as const) {
        /* ── R41 悬空修复（用户主诉：主殿左右两边的柱子悬空了）──────────────────
         * 病根：原 `baseY: 2.7` 是**殿身底**（殿身 y2.7..62.7），但飞扶壁外墩落在
         *   z≈zFront+5.7 的**广场**上（台基 frontDepth 只到 z=−1295.5，墩在 −1294.3
         *   即台基之外的广场），广场承托面 y≈0.012。⇒ 基座底 minY=2.70 悬空 **2.69m**，
         *   副拱肋最低点 1.42 也悬空（probe2 实测 `.img2threejs/r41_probe2_bundle.mjs`）。
         *   ⚠ 探针"支撑面检索"命中的 y[2.70,3.20] 承托件其实是**它自己的基座**
         *     （自证伪影），不是地面 —— 别拿它当"已接合"的证据。
         * 修复：baseY 2.7 → **−0.02**（= ground 顶 y−0.02；x=13.5 处步道 0.014 会略埋
         *   3.4cm、x=21.5/29.5 处与地面齐平；基座 1.1m 宽的外扩体把这点埋深完全盖住）。
         *   零 tri 变化：pierColumn 是 4 面柱、高度不进面数；box 恒 12 tri。 */
        const fb = flyingButtress({
          baseY: -0.02,
          springY: 12,
          topY: 78,
          reach,
          depth: 1.4,
          band: 0.55,
          pierW,
          pinnacle: true,
          coping: true,
          goldStrips: true,
          pairGap: 3.2
        });
        pour(b, mapParts(fb, (g) => g.rotateY(-Math.PI / 2).translate(side * wx, 0, zFront)));
      }
    }
    // ② 翼墙盲拱列（7 龛/侧，窗带 6..11.6 之上 y 14 起）
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(blindArcadeRow({ count: 7, halfW: 0.62, rise: 6.4, pitch: 3.4, cusp: 0.55 }), (g) => {
          if (side < 0) g.rotateY(Math.PI);
          return g.translate(side * wingInner, 14, zMidFront);
        })
      );
    }
    // ③ 大龛拱卷叶（R4-7：size 0.4 → 1.2 匹配 FBX Decor_1 量级；低配跳过）
    if (!isLowDetail()) {
      pour(
        b,
        mapParts(
          crocketRun({ halfW: clearW / 2, rise: clearH - 2.4, count: 8, size: 1.2, cusp: 1.1 }),
          (g) => g.translate(0, 2.4, zFront + 0.65)
        )
      );
      /* ── R39 ⑥c 门龛两侧竖向卷叶金饰带 ────────────────────────────────────
       * 用户令「金是细线/线脚 + 卷叶」。这里沿 x=±(openHalf+2.1)=±10.1 竖向排
       * 10 片金卷叶（y 3..23），**叶轴沿墙面外法线 +z**（= 门侧壁的 jamb crocket）。
       * ⚠ 偏离设计稿的 `crocketRun({pts: 竖线})`：crocketRun 的点列模式按
       *   `tangent + π/2` 定轴，竖线的切向是 +y ⇒ 叶轴会变成 −y（整列叶片朝下），
       *   读不出"贴在门侧壁上的卷叶"。故此处按 crocketRun 的同一形体参数
       *   （锥 size*2.6 长 + 6 面珠 12 tri）手排，轴向改为 +z。tri 相同（20/片）。 */
      const leafCones: THREE.BufferGeometry[] = [];
      // ⚠ 作用域纪律：`openHalf` 是 makeGate 与「前排门楼段」各自作用域的局部量，
      //   本段（R30 构件库块）必须**用自己的量**，不许跨块偷名字（TS2304 曾因此编译红）。
      const jambHalf = clearW / 2 + 2.1; // 门洞半宽 + 券外沿余量 = 10.1
      for (const side of [-1, 1] as const) {
        for (let k = 0; k < 10; k += 1) {
          const ly = 3 + k * 2.15;
          // ⚠ 凸出量受撞面约束（≤0.9m）：锥长 0.9 / 中心 +0.25 ⇒ 前脸 0.70；
          //   首版用 crocketRun 的 size 0.8（锥长 2.08、中心 0.42）会顶到 1.07m，收小。
          const cone = new THREE.ConeGeometry(0.26, 0.9, 4, 1);
          cone.rotateX(Math.PI / 2); // 锥轴 → +z（墙面外法线）
          cone.translate(side * jambHalf, ly, zFront + 0.25);
          planarUV(cone, TILE.gold);
          leafCones.push(cone);
          const bead = new THREE.CylinderGeometry(0.15, 0.15, 0.22, 6, 1, true);
          bead.rotateX(Math.PI / 2);
          bead.translate(side * jambHalf, ly, zFront + 0.34);
          planarUV(bead, TILE.gold);
          leafCones.push(bead);
        }
      }
      b.gold.push(mergeSafe(leafCones));
      leafCones.forEach((g) => g.dispose());
      for (const side of [-1, 1] as const) {
        // 守卫雕像龛（门洞两侧各 1 座，y≈10；与 ③ 的 y 56 龛同款，只降一档尺寸）
        pour(b, mapParts(statueNicheZ({ halfW: 0.75, rise: 3.0, cusp: 0.5 }), (g) => g.translate(side * 11.6, 10, zFront)));
        // 龛内深腔（同 y56 龛：dark 板抬到墙面外 0.03，否则埋在实心殿身里）
        b.dark.push(archPlate(0.67, 0, 2.9, 0.1, 3, 0.5).translate(side * 11.6, 10, zFront + 0.03));
        pour(
          b,
          mapParts(draperyRelief({ w: 1.2, h: 3.6, folds: 3 }), (g) =>
            g.rotateY(Math.PI / 2).translate(side * 11.6, 10.2, zFront - 0.25)
          )
        );
      }
    }
    // ④ 雕像龛 ×5（正立面开间起点 |x|=13、窗顶之上 y 40）+ 冠座前脸
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(statueNicheZ({ halfW: 0.8, rise: 3.0, cusp: 0.5 }), (g) => g.translate(side * 13, 40, zFront - 0.05))
      );
    }
    // R4-6 主殿 hero 雕像龛（中央拱两侧 + 翼墙外端；0 DC，复用 statueNicheZ，低配跳过）
    if (!isLowDetail()) {
      for (const side of [-1, 1] as const) {
        pour(b, mapParts(statueNicheZ({ halfW: 0.8, rise: 3.0, cusp: 0.5 }), (g) => g.translate(side * 14, 30, zFront - 0.05)));
      }
      for (const side of [-1, 1] as const) {
        pour(b, mapParts(statueNicheZ({ halfW: 0.8, rise: 3.0, cusp: 0.5 }), (g) => g.translate(side * (wingOuter - 6), 20, zFront - 0.05)));
      }
    }
    // 冠座（y 96..101、路侧面 z = zMidFront+4.5）前脸
    pour(
      b,
      mapParts(statueNicheZ({ halfW: 0.8, rise: 3.0, cusp: 0.5 }), (g) => g.translate(0, 97.5, zMidFront + 4.4))
    );
    // ⑤ 纹章顶饰（冠尖之上；R36-A1：lintelHalf = 冠尖金尖底半径 0.42）
    pour(b, mapParts(finialOrnament({ r: 0.7, lintelHalf: 0.42 }), (g) => g.translate(0, crownH + 2.6, zMidFront)));
    // ⑥ 翼墙顶连廊（翼墙顶 62 + R39 叠涩 1.4 + 金线 0.24 + 垛口 1.2 ≈ 64.9 ⇒ 楼面 65.3）
    //    R39 ⑤c 把叠涩 0.6 抬到 1.4（FBX 1.41）后，垛口顶由 64.6 升到 64.6+0.8 = 64.6？——
    //    精确账：叠涩顶 62+1.4=63.4、垛口 63.4..64.6、金齿 64.6..64.98 ⇒ 楼面必须 ≥65.0，
    //    原 64.8 会与垛口/金齿穿插 ⇒ 抬到 65.3。
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(corridorGallery({ len: frontDepth - 4, width: 56, floorY: 65.3 }), (g) =>
          g.translate(side * (wingInner + wingOuter) / 2, 0, zMidFront)
        )
      );
    }
    /* ── R31 ⑦ 两翼飞扶壁 ×4（每侧 2 座；参考图最显著语汇：前排段 ↔ 翼墙空中连接）──
     * 墩落在翼墙前方广场边（|x| = 52/70，z ≈ zFront+6.5），飞拱升至翼墙顶带
     * （y 62）。探针纪律：墩/拱全部 |x| ≥ 51（>走廊 8）、y ≥ 2.7。
     * ⑧ 主尖塔簇 ×2（pinnacleCluster：前排段冠座两肩）+ 祭坛台座（marble）。 */
    for (const side of [-1, 1] as const) {
      for (const wx of [52, 70]) {
        /* R41 同款悬空修复：两翼飞扶壁墩落在 |x|=52/70 的广场地面（y−0.02），
         * 原 baseY 2.7 同样悬空 2.69m（probe2 实测）。零 tri 变化。 */
        const fb = flyingButtress({
          baseY: -0.02,
          springY: 34,
          topY: 62,
          reach: 9,
          depth: 1.5,
          band: 0.55,
          pierW: 2.8,
          pinnacle: true
        });
        pour(b, mapParts(fb, (g) => g.rotateY(-Math.PI / 2).translate(side * wx, 0, zFront)));
      }
    }
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(pinnacleCluster({ w: 4.2, h: 7.5 }), (g) =>
          g.translate(side * (frontW / 2 - 4), frontH + 3.4, zMidFront)
        )
      );
      // A 线 ① 卷叶尖塔（crockedSpire）：叠在 pinnacleCluster 顶冠之上，密布金卷叶
      pour(
        b,
        mapParts(crookedSpire({ w: 2.2, h: 6.5 }), (g) =>
          g.translate(side * (frontW / 2 - 4), frontH + 3.4 + 7.5, zMidFront)
        )
      );
    }
    // A 线 ③ 白色垂幔浮雕（draperyRelief）：主殿正立面两侧悬挂白石材垂幔 + 金系带
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(draperyRelief({ w: 10, h: 30, folds: 6 }), (g) =>
          g.translate(side * (frontW / 2 - 9), 6.5, zFront - 0.05)
        )
      );
    }
    // A 线 ⑥ 金饰比例提升：正立面金徽章（大金盘）竖向阵列 + 横向金饰带（宽面金，增覆盖）
    /* ── R39 ⑥ 金饰语言纠偏：12 枚 Ø3m 金圆盘 → **四叶金章 + 通高金竖线** ──────────
     * 用户令「金色是**细线 / 线脚**，不是大金盘」。改前每侧 6 枚 r=1.5 实心金盘
     * （y 16..71，节拍 11m）在 300~470m 实测读作"波点 / 金币"。改后：
     *   ① 章体换 `quatrefoilMedal(r 0.85)`：四尖瓣 + 芯珠，直径 1.7m 但**金面 −76%**
     *      （实心盘 2.0m² 面 ≈ 64 tri → 四叶章 ≈0.9m² 面 / 84 tri）；
     *   ② 每侧加一条 **0.22m 通高金竖线**（y 10..72）串起 6 枚章 ⇒ 读作
     *      "金色细竖线 + 小章"（设计稿给的备选方案），与既有横向金箍形成格构。
     * 低档：quatrefoilMedal 整件返回空 ⇒ 12 枚章在低档消失（只降装饰密度）。
     */
    if (!isLowDetail()) {
      for (const side of [-1, 1] as const) {
        /* 落位修正（R39 实测）：原落点 x = ±(frontW/2 − 16) = **±28** —— 正好压在
         * 满高壁柱（±27.6，1.5m 宽、前脸 +0.8）上，Ø3m 金盘有 1.5m 埋在壁柱后面，
         * 于是"波点"只露出半边。改到平墙开间 B 的心 **±23.5**（20.15..26.85，
         * 两侧壁柱 ±19.4 / ±27.6 之外），金线 + 章都完整可见。 */
        const mx = side * 23.5;
        b.gold.push(box('gold', 0.22, 62, 0.14, mx, 41, zFront + 0.04));
        for (let i = 0; i < 6; i += 1) {
          pour(b, mapParts(quatrefoilMedal({ r: 0.85 }), (g) => g.translate(mx, 16 + i * 11, zFront + 0.12)));
        }
      }
    }
    /* ── R39 ⑦ 基座菱形章（FBX §4「菱形章：基座前缘，占基座高 30%」）──────────
     * 本轮首次把「基座前缘的菱形装饰」落到主殿：3 枚/侧（x ±14/±22/±30，
     * 0.9×1.4 绕 z 转 45° = 菱形，长对角 2.0m ≈ 基座高 2.6m 的 77% 视觉跨度）。
     * 落 **agedGold 桶**（做旧金，与门钉同档）⇒ 全局单 mesh，6 枚 72 tri。
     * 落位 y 1.7 / z = zFront + 0.55：第一级台基前脸 +1.0、第二级 +0.5，
     * y 1.2..2.2 区间只有第二级挡着 ⇒ 章凸出 0.05 恰好读到；再往外被第一级的
     * 1.0m 前脸完全遮住（这也是 BF 基座章只在前缘一条带里的原因）。 */
    if (!isLowDetail()) {
      for (const side of [-1, 1] as const) {
        for (const dx of [14, 22, 30] as const) {
          pushVariant(b, 'agedGold', boxRot('gold', 0.9, 1.4, 0.22, side * dx, 1.7, zFront + 0.55, Math.PI / 4));
        }
      }
    }
    // 大理石墙裙（marble 桶；主殿正立面基座带，贴面 z=zFront+0.08 不凸出撞击面；
    // R29 广场平整令仍在 —— 不放任何 y>0.02 的广场横穿体块，大理石只上墙面）
    extra(b, 'marble', box('marble', frontW + 2, 2.6, 0.16, 0, 1.3, zFront + 0.08));
    /* ── R39 ④c 拆除 R33 的中央透空金屏（14×20m）──────────────────────────
     * 拆因（用户点名 + 实测）：`gildedScreen({w:14,h:20,openwork,bays:3})` 是一面
     * **挡在门前的金屏**——它把 y 2.6..22 整段门洞糊住，玩家在 300~470m 读到的是
     * 「一块大金币」，门/纵深/祭坛全部读不出来（R33 已把它从实心改透空，但"金
     * 占据门洞"这一层没解）。现由 ④ 的四级退台券 + 双扇木门 + 石质半月楣取代：
     * 同一位置改读「券 → 楣 → 门」三层纵深，金只剩券线。
     * 连带删除：屏后 12.8×18.4 的 dark 深龛背板（改前在 zFront−2.2 = **实心殿身
     * 内部**，本来就不可能被看见，12 tri 纯浪费）。
     * 保留：门洞两侧的一对小雕像龛（它们是"屏—龛—门"三层里的"龛"层，且已落在
     * 券线外侧，与新构图不冲突）。 */
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(
          statueNicheZ({ halfW: 0.72, rise: 2.5, cusp: 0.5, plateBack: 0.42 }),
          (g) => g.translate(side * 8.45, 4.2, zFront - 0.05)
        )
      );
    }

    /* ── R32 材料丰富度 + 参考图精化（A 线）────────────────────────────────
     * ⑨ 翼墙外端雕像龛 ×2（每侧 1）：壁龛与盲拱交替的明暗节奏从内街扩展到主殿两翼
     *    （盲拱列 7 龛在内带，雕像龛补外端 ⇒ 参考图 A 中墙段的交替读法）；
     * ⑩ 门龛内大理石祭坛（marble 桶）+ 木梁天花（wood 桶）：主殿/祭坛/台阶的大理石
     *    语义与殿内木构语义——祭坛在龛内（z<zFront）不侵广场平整令与撞击面；
     * ⑪ 广场列阵火盆 +2/侧（HALL_BRAZIER 之外补 Reference B 殿前广场火盆密度）。 */
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(statueNicheZ({ halfW: 0.85, rise: 3.1, cusp: 0.5 }), (g) =>
          g.translate(side * (wingOuter - 6), 40, zFront - 0.05)
        )
      );
    }
    {
      // ⑩ 祭坛（大理石：坛座 + 两级退台 + 坛背金十字）坐在龛底（z = zFront−3.2 起）
      const az = zFront - 3.2;
      extra(b, 'marble', box('marble', 7.2, 1.1, 3.0, 0, 0.55, az));
      extra(b, 'marble', box('marble', 6.0, 0.9, 2.4, 0, 1.55, az - 0.3));
      extra(b, 'marble', box('marble', 4.8, 0.7, 1.8, 0, 2.35, az - 0.6));
      b.gold.push(box('gold', 0.24, 1.8, 0.24, 0, 3.6, az - 1.1)); // 坛背金十字
      b.gold.push(box('gold', 1.1, 0.24, 0.24, 0, 4.1, az - 1.1));
      // R40 P1-2 死几何清理：删除龛顶 6 根木梁天花（原 6×12=72 tri，wood 全局单 mesh 常驻递交）。
      //   定罪（tools/r40_geo_probe.mjs 逐几何 bbox，Δ fresh-vs-fresh）：这 6 根
      //     x −9.4..9.4 / y 42.55..43.05 / z −1314.28..−1301.72，bbox **完全落在殿身前排
      //     实心盒**（frontW 88 × bodyH 88.7 × frontDepth 30 ⇒ x±44 / y2.7..91.4 / z−1330..−1300）
      //     内部；前方又被同盒实心前脸 + 暗龛背板（archPlate @ zFront+0.04）遮挡 ⇒ 永不可见。
      //   与 R39 记录「6 根门洞木梁死几何（72 tri 全局常驻）」一致，此处落实删除。
      //   ⚠ 保留：①翼墙顶连廊 2 根（corridorGallery，x±46..102 / y≈65，在殿身盒外，可见）；
      //     ②城门隧道 8 根（makeGate L1166-1169，y≈28.2）——门洞可贯通、隧道内仰视可见，
      //     前方花格屏仅 y≤17 且城门无暗龛背板，**无法证明永不可见 ⇒ 保留**（不盲删）。
    }
    // ⑪ 广场列阵火盆 +2/侧（z 节拍 5，接在既有 arrayCount 之后）
    {
      const plazaNear = z - MAIN_HALL.plazaDepth;
      for (const side of [-1, 1] as const) {
        for (let i = 0; i < 2; i += 1) {
          const cx = side * (ROAD_HALF + HALL_BRAZIER.arrayInset + 1.6);
          const cz = plazaNear + 3.5 + (HALL_BRAZIER.arrayCount + i) * HALL_BRAZIER.arrayPitch;
          b.ashlar.push(box('ashlar', 0.9, 0.8, 0.9, cx, 0.4, cz));
          b.gold.push(spire('gold', 0.28, 0.52, 1.15, 10, cx, 0.8, cz));
          b.gold.push(spire('gold', 0.6, 0.6, 0.12, 10, cx, 0.8 + 1.15, cz));
          b.flame.push(flame(0.34, 0.72, cx, 0.8 + 1.15 + 0.12, cz));
        }
      }
    }
  }
  return b;
}

/**
 * ── R30 窗语汇换装说明（lancetWindow → castleDetail.traceryWindowX/Z）──────────
 * 原 `lancetWindowX/Z`（券框 7 段 + 背板 6 段 + 窗台 ≈182 tri/扇）已**整族删除**：
 * 全部 399 个挂载点（城门塔 4 / 塔群 5 / 主殿 26 / 城内 360 + 角塔 40）换成
 * `castleDetail.traceryWindowX/Z`（金框 3 段 + 背板 2 段 + 竖棂 + 拱肩光，
 * 96~120 tri/扇）—— FBX Window 全系的「尖拱 + 分格 + 金框」语汇（r30_plan §2
 * 差距清单第 3 项），同时城内街面净省 ≈66 tri/扇。
 * ⚠ 删除后 archPlateX 只余 makeViaduct 的尖拱窗背板一处在用；archBandX 仍被
 *   御桥主券/侧拱占用（两函数保留）。
 */

/* ═══════════════════ ⑥ 城内大街 ═══════════════════ */

/**
 * 城内大街：过门后 z ∈ [INNER.zNear, INNER.zFar=−1285.5]（R28：街区数由公式
 * floor((zNear−zFar)/blockLen)=20 自动成立，末段让位主殿广场 14.5m + 主殿），
 * 街侧建筑前脸 |x| = faceHalf = 15.5，进深 8（插进崖体消除缝）。每 46m 一个街区，
 * 每街区每侧：
 *   殿（块中央，TOWER.hallW 12.5 × TOWER.hallH 17.9 × 8，双坡顶 + 金十字 + 3 尖拱窗）
 *   塔（块左四分位，8 宽 × 36 高 + 9.5 尖顶，3 尖拱窗）
 *   三段连墙（带叠涩 + 垛口，B 段开一窗）
 *   火盆 ×2
 * 尖拱窗尺寸按 TOWER.windowW/H 的比例层放大（1.068×7.039 是 1:1 人体尺度，
 * 直接搬到 17.9m 的殿上会小得读不出；这里按建筑尺度等比放到 ~1.8×7）。
 * ⚠ 殿尺寸一律 import TOWER.hallW/hallH（R27 曾硬编码 12.5/17.3，audit §3 判罚：
 *    改常量不生效的暗坑——常量必须从布局真源来）。
 *
 * ── 局部坐标配方（本函数一切形体先按局部建，再一次性贴到世界）──────────────
 * 局部：前脸在 x=0、墙体向 +x 延伸、z 以块心为 0。世界化只有一步：
 *   side=+1（左侧楼，世界 x = +faceHalf + 局部 x）直接 translate(+faceHalf, 0, zc)；
 *   side=−1（右侧楼，世界 x = −faceHalf − 局部 x）先 rotateY(π) 再 translate(−faceHalf, 0, zc)。
 * rotateY(π) 同时翻转 x 与 z —— 本函数所有形体都对块心 z 对称（窗 ±4.2/0、
 * 屋顶居中、金线 ±4.6），镜像后集合不变；rotZ 的坡向符号也随镜像自动翻正。
 * R30：窗语汇换装为 castleDetail.traceryWindowX（券框朝 −x 外挑，左右两侧因此
 * 都恰好朝街面）；新增街面低拱廊 / 街区角塔 / 山面体积 / 隔街区盲拱列（见下）。
 * 旧版直接算世界坐标，结果殿身把 12.5 排到了 x（进深）上：前脸跑到 13.25、
 * 窗框整体埋进墙体一扇不剩，坡屋顶出挑 2.6m —— 已由本配方纠正。
 */
export function makeInnerCity(): StoneBuckets {
  const b = emptyBuckets();
  const { zNear, zFar, faceHalf, blockLen } = INNER;
  const blocks = Math.floor((zNear - zFar) / blockLen); // 21
  const depth = 8;

  for (let k = 0; k < blocks; k += 1) {
    const zc = zNear - blockLen / 2 - k * blockLen; // 块中心
    // A 线 ⑦ 远区 LOD 减法：最远 1/3 街区（最深 z 区）置 DEEP_FAR —— 跳过卷叶 /
    // 子拱 / 窗棂 / 壁龛立像 / 瓶柱加密等纯装饰密度（几何长度不变，铁律 33）。
    const far = k >= blocks - Math.floor(blocks / 3);
    setDeepFar(far);
    /**
     * R32-A2 · **近区标志（gold 桶收敛的主开关，主理人 T1）**：
     * 参考图「白石为主 + 金色点缀」的读法只在**近景**成立 —— 中/远区建筑按参考图
     * 是"成片的白建筑 + 暖金窗光"，金饰（窗金框 / 龛楣卷叶 / 锥面卷叶）在中远区
     * 既读不出来、又白白堆高 gold-tri 占比。故：
     *   近区（k < 8）：保留金券框 + 卷叶（参考图 hero 读法）；
     *   中区（8 ≤ k < 14）：券框落 ashlar（石券）、卷叶关；
     *   远区（k ≥ 14）：DEEP_FAR 族内自裁 + 同上。
     * ⚠ 只动**桶位与装饰密度**，所有长度/体量参数逐项不变（铁律 33，见 A_line_report §5）。
     */
    const nearZone = k < R32_WALL_RHYTHM.near;
    /**
     * R34 回砍 · **街区装饰密度档**：`hero`（k < R34_DENSITY.hero）保留全装饰，
     * 其余街区走「减密档」（`trim`），只关重复细饰、不动任何长度/体量。
     * 详见 R34_DENSITY 常量块注释（含 sphere 口径峰值的对位依据）。
     */
    const hero = k < R34_DENSITY.hero;
    const trim = !hero;
    /** 减密档的窗参数：窗棂 0 枝 + 子拱光关（与 low / DEEP_FAR 同语义，见 TraceryOpts.mullions）。
     *  R36-A3：hero 街区窗竖棂 2→3（FBX 级立面 3–5 根带内）；trim 档仍整组关。 */
    const winMullions = trim ? 0 : 3;
    const winSubs = trim ? false : undefined;
    const merlonPitch = hero ? 2.4 : R34_DENSITY.merlonPitch;
    for (const side of [-1, 1] as const) {
      /** 局部 → 世界（见上方配方）：side=+1 直达，side=−1 过 rotateY(π) 镜像 */
      const put = <T extends THREE.BufferGeometry>(g: T): T => {
        if (side < 0) g.rotateY(Math.PI);
        g.translate(side * faceHalf, 0, zc);
        return g;
      };

      /* ── 殿（块中央）：沿街宽 TOWER.hallW，墙高 TOWER.hallH ── */
      const hallW = TOWER.hallW;
      const hallH = TOWER.hallH;
      b.ashlar.push(put(box('ashlar', depth + 0.8, 0.6, hallW + 1.4, depth / 2 + 0.4, 0.3, 0))); // 台基
      /* ── R32-A2 T2 材料丰富度 ④：殿前**大理石基座带**（marble 桶）──────────
       * 参考图街面建筑基座比墙身亮一档（石台阶/台明）；贴在前脸（局部 x=−0.25，
       * 世界 |x|≈15.25，> 走廊 8）不侵入行车带。12 tri ×40。 */
      extra(b, 'marble', put(box('marble', 0.5, 1.2, hallW + 1.2, -0.25, 0.9, 0)));
      /* ── R36-A2 内庭门扇（door=inner-wood / 门钉徽章=agedGold）：hero 街区块殿
       * 双开木门（内庭门扇），坐在大理石基座（y≤1.5）之上、窗带（y 8.5）之下。
       * 门面朝街（局部 −x）⇒ rotateY(−π/2) 把 +z 门面转向 −x；门背 −0.26..0.02
       * 骑墙面 2cm 防 z-fight。每扇 ≈204 tri ×2 ×hero 块数。 */
      if (hero) {
        for (const dz of [-2.1, 2.1]) {
          pour(
            b,
            mapParts(doorLeaf({ w: 2.6, h: 4.8 }), (g) => put(g.rotateY(-Math.PI / 2).translate(-0.12, 1.5, dz)))
          );
        }
      }
      b.ashlar.push(put(box('ashlar', depth, hallH, hallW, depth / 2, 0.6 + hallH / 2, 0))); // 殿身
      const wallTop = 0.6 + hallH; // 17.9
      const eaveY = wallTop + 0.5; // 18.4
      const ridgeY = wallTop + 1.5; // 19.4
      const run = depth / 2 + 0.6; // 4.6（半进深 + 出挑）
      const slopeLen = Math.hypot(run, ridgeY - eaveY); // 4.707
      const slopeAng = Math.atan2(ridgeY - eaveY, run); // 0.213
      /* ── R32-A2 T2 材料丰富度 ⑤：殿内**木构屋架梁**（wood 桶）────────────
       * 殿坡顶之下、山墙之间露出的木梁（哥特厅堂木屋架读法）。12 tri ×40。 */
      extra(b, 'wood', put(box('wood', depth - 1, 0.3, hallW - 1, depth / 2, wallTop - 1.0, 0)));
      for (const rs of [-1, 1] as const) {
        // rs=−1：檐口朝街面（局部 x 0 端）下倾；rs=+1：檐口朝背侧下倾。
        // R31：坡顶改 **roof 桶**（斜面瓦）—— 材料丰富度四桶点亮之一。
        const lx = rs < 0 ? (depth / 2 - run) / 2 : (depth / 2 + run) / 2;
        extra(b, 'roof', put(boxRot('roof', slopeLen, 0.5, hallW + 1.2, lx, (eaveY + ridgeY) / 2, 0, -rs * slopeAng)));
      }
      b.ashlar.push(put(box('ashlar', 0.7, 0.5, hallW + 1.2, depth / 2, ridgeY + 0.25, 0))); // 屋脊
      b.gold.push(put(box('gold', 0.28, 2.4, 0.28, depth / 2, ridgeY + 1.7, 0))); // 金十字竖
      b.gold.push(put(box('gold', 1.4, 0.28, 0.28, depth / 2, ridgeY + 2.3, 0))); // 金十字横
      // R29 加层：屋脊上再起一层「屋上塔屋」（不与双坡顶穿插，读作退台钟屋）
      b.ashlar.push(put(box('ashlar', depth - 3, 5.5, hallW - 4, depth / 2, ridgeY + 2.75, 0)));
      b.ashlar.push(put(box('ashlar', depth - 2.6, 0.5, hallW - 3.6, depth / 2, ridgeY + 5.75, 0)));
      b.ashlar.push(put(spire('ashlar', 1.5, 0, 3.4, 8, depth / 2, ridgeY + 6, 0, Math.PI / 8)));
      // R29 角塔 ×2（殿前脸两角，丰富立面节拍）
      for (const oz of [-hallW / 2 + 0.8, hallW / 2 - 0.8]) {
        b.ashlar.push(put(box('ashlar', 1.8, 7.5, 1.8, 0.9, 4.35, oz)));
        b.ashlar.push(put(spire('ashlar', 1.0, 0, 2.6, 8, 0.9, 8.1, oz, Math.PI / 8)));
      }
      for (const wz of [-4.2, 0, 4.2]) {
        // R30 换装花格窗（城内街立面主干：金框 + 双棂，96 tri/扇；原 lancet 182）
        pour(
          b,
          mapParts(
            traceryWindowX({
              halfW: 0.9,
              rise: 6.2,
              cusp: 0.8,
              frameOut: 0.45,
              plateBack: 0.28,
              mullions: winMullions,
              subArches: winSubs,
              goldFrame: nearZone,
              goldTracery: false,
              recess: hero
            }),
            (g) => put(g.translate(0, 8.5, wz))
          )
        );
      }
      for (const sz of [-4.6, 4.6]) {
        b.gold.push(put(box('gold', 0.3, 17, 0.16, -0.08, 9.5, sz)));
      }

      /* ── R29 立面「精装」三件套（用户令：毛坯 → 精装）──────────────────
       * 实测（verify/r29_c1/inner_street.png）：殿身正面除 3 扇窗外是**整片白墙**，
       * 灰缝平铺 ⇒ 读作"毛坯箱体"。参考图（3d084b59 / 2497fab5）的街墙读法是：
       *   ① 水平**分层线脚**（string course）把立面切成 3 段，段间有进深差；
       *   ② 竖向**壁柱/扶壁**（buttress）与窗交替，形成节奏；
       *   ③ 檐口一排**小尖塔**（crocket pinnacle），剪影立刻"哥特化"。
       * 全部 box/spire（12~16 tri），确定性节拍，无随机。 */
      {
        const faceX = 0; // 前脸局部 x
        // ① 分层线脚 ×3（突出 0.28，宽出墙面 0.55）
        for (const sy of [6.2, 11.4, 16.6]) {
          b.ashlar.push(put(box('ashlar', 0.55, 0.34, hallW + 1.5, faceX - 0.12, sy, 0)));
          b.gold.push(put(box('gold', 0.14, 0.1, hallW + 1.6, faceX - 0.4, sy + 0.02, 0)));
        }
        // ② 壁柱 ×4（与窗交替，突出 0.55，带斜顶帽）
        for (const pz of [-7.1, -2.1, 2.1, 7.1]) {
          b.ashlar.push(put(box('ashlar', 1.1, hallH - 1.2, 1.3, faceX - 0.35, 0.6 + (hallH - 1.2) / 2, pz)));
          b.ashlar.push(put(box('ashlar', 1.5, 0.4, 1.7, faceX - 0.45, wallTop - 0.25, pz)));
          b.ashlar.push(put(spire('ashlar', 0.85, 0, 2.4, 4, faceX - 0.45, wallTop - 0.05, pz, Math.PI / 4)));
        }
        // ③ 檐口小尖塔排（节拍 3.2，只在屋脊线以下，不抢双坡顶）
        //    R34 回砍：非 hero 街区 9 → R34_DENSITY.eavePinnacles（5），剪影节奏保留、
        //    单根 0.34m 半径在 200m 外已亚像素 ⇒ 加密不可辨。
        const eaveN = hero ? 9 : R34_DENSITY.eavePinnacles;
        for (let i = 0; i < eaveN; i += 1) {
          const pz = -hallW / 2 + 0.8 + (i * (hallW - 1.6)) / (eaveN - 1);
          b.ashlar.push(put(spire('ashlar', 0.34, 0, 1.9, 4, faceX - 0.2, wallTop + 0.2, pz, Math.PI / 4)));
        }
      }

      /* ── 塔（块左右四分位各一座，R29 节奏加密）：局部 z = ±blockLen/4 ── */
      const addTower = (tzC: number): void => {
        b.ashlar.push(put(box('ashlar', 9.4, 1.2, 9.4, depth / 2, 0.6, tzC))); // 塔基
        b.ashlar.push(put(box('ashlar', 8, 34.8, depth, depth / 2, 1.2 + 34.8 / 2, tzC))); // 塔身
          b.ashlar.push(put(box('ashlar', 9, 0.9, 9, depth / 2, 36.45, tzC))); // 檐口叠涩
        // R32-A2 材料丰富度：塔尖披顶 = 瓦/铅 ⇒ **roof 桶**（原 ashlar，与 crookedSpire ② 同口径）
        extra(b, 'roof', put(spire('roof', 3.1, 0, 9.5, 8, depth / 2, 36.9, tzC, Math.PI / 8))); // 尖顶
        for (const wy of [8, 26]) {
          // R30 换装花格窗（塔身窗）
          pour(
            b,
            mapParts(
              traceryWindowX({
                halfW: 0.75,
                rise: 5.6,
                cusp: 0.7,
                frameOut: 0.45,
                plateBack: 0.28,
                mullions: winMullions,
                subArches: winSubs,
                goldFrame: nearZone,
                goldTracery: false,
                recess: hero
              }),
              (g) => put(g.translate(0, wy, tzC))
            )
          );
        }
        for (const sz of [-3.2, 3.2]) {
          b.gold.push(put(box('gold', 0.3, 34, 0.16, -0.08, 18, tzC + sz)));
        }
      };
      addTower(-blockLen / 4);
      addTower(blockLen / 4);

      /* ── 连墙（塔→殿 / 殿→塔，R29 抬高 9→14：沿街立面连贯不留空档）── */
      const linkH = 14;
      const links: readonly (readonly [number, number])[] = [
        [-blockLen / 2, -blockLen / 4 - 4.7], // 块首 → 塔背
        [blockLen / 4 + 4.7, blockLen / 2] // 塔2前 → 块尾
      ];
      for (let li = 0; li < links.length; li += 1) {
        const [za, zb] = links[li];
        const len = zb - za;
        if (len <= 1) continue; // <1m 的薄片不建（R29：原来两段 0.55m 碎墙纯废 tri）
        const lz = (za + zb) / 2;
        b.wall.push(put(box('wall', depth, linkH, len, depth / 2, linkH / 2, lz)));
        b.ashlar.push(put(box('ashlar', depth + 0.6, 0.5, len + 0.6, depth / 2, linkH + 0.25, lz))); // 顶叠涩
        const merlons = Math.max(1, Math.floor(len / merlonPitch));
        for (let m = 0; m < merlons; m += 1) {
          const mz = za + (len * (m + 0.5)) / merlons;
          b.ashlar.push(put(box('ashlar', depth, 1.1, 0.8, depth / 2, linkH + 1.05, mz)));
          b.ashlar.push(put(spire('ashlar', 0.34, 0, 0.5, 4, depth / 2, linkH + 1.6, mz)));
        }
        // 连墙开一扇花格窗（R30 换装；窗高 5.4+cusp 0.7 ⇒ 基座 1.8、顶 7.9，不出墙顶）
        // R30 位移：窗从墙心移到「内端 5m 处」——街区角塔（R30，z=∓22.5、深 5）
        // 会咬掉连墙外端 3m，窗放内端才不被埋（winZ：link1 = za+5，link2 = zb−5）
        const winZ = li === 0 ? za + 5 : zb - 5;
        pour(
          b,
          mapParts(
            traceryWindowX({
              halfW: 0.8,
              rise: 5.4,
              cusp: 0.7,
              frameOut: 0.45,
              plateBack: 0.28,
              mullions: winMullions,
              subArches: winSubs,
              goldFrame: nearZone,
              goldTracery: false,
              recess: hero
            }),
            (g) => put(g.translate(0, 1.8, winZ))
          )
        );
        // R29 深色窗缝 ×3（远读节拍，12 tri/条，不用 lancetWindow）
        for (const sz of [-len / 3, 0, len / 3]) {
          b.dark.push(put(box('dark', 0.4, 4.6, 1.5, -0.08, 8.6, lz + sz)));
        }
        // R30 檐口带（castleDetail.corniceBand：FBX Cornice_2 18.30×1.41×0.68 分层檐口）
        // 落在连墙上带（叠涩 14.0..14.5 之下 y 11.5 起）⇒ 参考图矮墙的"檐口饰带"分层读法
        pour(b, mapParts(corniceBand({ len: len + 0.6, proj: 0.6, h: 1.2 }), (g) => put(g.translate(-0.15, 11.5, lz))));
        /* ── R32-A2 T2 材料丰富度 ①：连墙檐口下**暴露木梁**（wood 桶）──────────
         * 参考图街巷连墙/廊下普遍露出木构梁头（哥特民用建筑的木楼板梁端）；
         * 12 tri/根 ×2 墙 ×20 块 ×2 侧 = 80 根。只加木梁，不改连墙长度（铁律 33）。 */
        extra(b, 'wood', put(box('wood', 0.4, 0.34, len - 0.4, -0.28, 12.15, lz)));
        // A 线 ③ 白色垂幔浮雕（draperyRelief）：连墙窗上悬挂白石材垂幔 + 金系带
        //     （远区经 DEEP_FAR 折页减半；仅在近/中区铺设，控制 tri）
        //     R34 回砍：再收到 **hero 街区** —— 垂幔折页 0.4m 级，非 hero 街区在
        //     200m 外折页全糊成一片，而它 156 tri/墙 ×2 墙 ×40 块侧是重复细饰大头。
        //     连墙长度/窗位/檐口逐项不变（铁律 33）。
        if (!far && hero) {
          pour(b, mapParts(draperyRelief({ w: len - 2, h: 4.6, folds: 4 }), (g) => put(g.translate(0, 8.4, lz))));
        }
        // R32 街墙加密 ①：连墙上带雕像龛 ×2（近区、每墙首段；壁龛与窗/垂幔交替，
        //     参考图 A「壁龛与盲拱交替形成立面明暗节奏」的街面版。龛位避让既有窗位）
        //     R34 回砍：228 tri/龛 ×2 龛 ⇒ 同律收到 hero 街区（立像 0.5m 级）。
        if (!far && hero && li === 0) {
          for (const nz of [za + 1.6, zb - 1.6]) {
            pour(b, mapParts(statueNicheX({ halfW: 0.62, rise: 2.6, cusp: 0.5 }), (g) => put(g.translate(0, 2.4, nz))));
          }
        }
      }

      /* ── R30 ① 内部加密 + 街面连廊（用户令「检查城堡内部：建筑少且矮、无连廊」）──
       * ① 街区角塔 ×2：块两端（局部 z=∓22.5，深 5 只咬连墙外端 3m——连墙窗已避让到
       *    内端）31m 塔身 + 尖顶 + 金压顶 + 深色窗缝 + 金饰条 + 花格窗 + 柱头环 +
       *    檐口带 + 雕像龛；块首塔隔街区再加纹章顶饰。沿街每 23m 一座塔 ⇒
       *    「塔-墙-塔」连续节奏（建筑少且矮的对症解；低配档不裁，铁律 33）。
       * ② 街面低拱廊（连廊主体）：楼面 8.2m（>走廊 4.5、低于街窗基座 8.5），
       *    柱列/栏板全部落在 |x|≥10.9 区内（**不占 |x|<8 行车走廊**），沿街连接
       *    本块全部建筑前脸（殿/塔/连墙/角塔）⇒「沿街连接各建筑」。
       * ③ 连墙飞扶壁 ×2（每连墙 1 座）：FBX Contrforce 语汇落到矮连墙——外墩在
       *    拱廊之外（|x|≈9.7，>走廊 8），飞拱跨过拱廊楼面（8.2）落到连墙上带
       *    （y 9.5→11.9）。⚠ 挂载与 put() 惯例相反：扶壁伸出轴要朝**街心**，
       *    故 side=+1 预 rotateY(π)、side=−1 直达（put 只给 side<0 镜像）。
       * ④ 前排塔盲拱列（隔街区）：参考图构件 1/2 的 identity（尖拱凹龛）落到两座
       *    前排塔街面上带（y 18，塔窗 8..15.4 与 26..31.6 之间）。
       * ⑤ 殿山面体积：坡顶山墙三棱柱（8 tri）+ 山尖小顶 + 斜边卷叶 ×2/边。 */
      {
        const ctH = R30_CORNER.h;
        const ctw = R30_CORNER.w;
        const ctd = R30_CORNER.d;
        /** 街区角塔（ctz = 块内 z；finial = 是否加纹章顶饰） */
        const cornerTower = (ctz: number, finial: boolean): void => {
          /* ── R32-A2 T2 材料丰富度 ②：角塔**大理石基座裙**（marble 桶）────────
           * 参考图主塔/次塔基座比塔身亮一档（大理石台基），本轮把 9.2×6.2×1.0 的
           * 基座带从 ashlar 提到 marble ⇒ 四桶覆盖率。12 tri/座 ×80。 */
          extra(b, 'marble', put(box('marble', ctw + 1.2, 1.0, ctd + 1.2, ctw / 2, 0.5, ctz)));
          b.ashlar.push(put(box('ashlar', ctw + 1.2, 1.2, ctd + 1.2, ctw / 2, 0.6, ctz)));
          b.ashlar.push(put(box('ashlar', ctw, ctH - 1.2 - 2.6, ctd, ctw / 2, 1.2 + (ctH - 3.8) / 2, ctz)));
          /* R33：删除塔内木构楼板（原 2 层/座 ×80 座 = 1,920 tri）。
           * 塔身是封闭实心 ashlar，楼板整块埋在墙体内、从任何机位都不可见；
           * wood 桶又是全街单 mesh（每 tri 每个机位全额计入 visibleTri）。
           * 把预算让给院落里真正可见的木檐/木梁（见 R33 二进院母题）。 */
          b.ashlar.push(put(box('ashlar', ctw + 1.4, 0.8, ctd + 1.4, ctw / 2, ctH - 1.6, ctz)));
          // R32-A2：街区角塔尖顶披顶 → roof 桶（瓦顶），金只留"尖饰"
          extra(b, 'roof', put(spire('roof', ctw * 0.62, 0, 6.5, 8, ctw / 2, ctH - 1.2, ctz, Math.PI / 8)));
          // R32-A2：角塔顶 9.6×6.6m **水平**金压顶板 → ashlar。该板顶面/底面合计
          // 10,708 m²（占全场景 gold 表面积 4.8%），但在 31m 塔顶**水平朝上**，街面
          // 读作一条 0.22m 的边 —— 属"体量件误投 gold 桶"（主理人 T1 情形 a）。
          b.ashlar.push(put(box('ashlar', ctw + 1.6, 0.22, ctd + 1.6, ctw / 2, ctH - 0.75, ctz)));
          b.dark.push(put(box('dark', 0.6, 5.5, 1.6, -0.06, ctH * 0.4, ctz)));
          b.gold.push(put(box('gold', 0.3, ctH - 4, 0.16, -0.08, (ctH - 4) / 2 + 2, ctz + ctd / 2 - 0.3)));
          // 塔尖柱头环（castleDetail.capitalCollar：收分托石 + 金箍，坐在尖顶根部）
          //   R34 回砍：24 tri/座 ×2 座 ×40 块侧，0.5m 高托石 ⇒ 收到 hero 街区。
          if (hero) {
            pour(b, mapParts(capitalCollar({ r: ctw * 0.5, h: 0.5 }), (g) => put(g.translate(ctw / 2, ctH - 1.4, ctz))));
          }
          // 檐口带（castleDetail.corniceBand：FBX Cornice_2 分层檐口，塔身中带上沿）
          //   保留（R34 不可砍项：FBX 语汇 + 1.0m 高、中远区仍读得出分层）
          pour(b, mapParts(corniceBand({ len: ctd + 1.6, proj: 0.55, h: 1.0 }), (g) => put(g.translate(0, ctH - 4.5, ctz))));
          pour(
            b,
            mapParts(
              traceryWindowX({
                halfW: 0.6,
                rise: 4.4,
                cusp: 0.7,
                frameOut: 0.4,
                plateBack: 0.26,
                mullions: winMullions,
                subArches: winSubs,
                goldFrame: nearZone,
                goldTracery: false,
                recess: hero
              }),
              (g) => put(g.translate(0, 8, ctz))
            )
          );
          // 角塔雕像龛（R34 回砍：228 tri/龛 ×2 座 ⇒ 收到 hero 街区）
          if (hero) {
            pour(
              b,
              mapParts(statueNicheX({ halfW: 0.62, rise: 2.4, cusp: 0.5, crocket: nearZone }), (g) =>
                put(g.translate(0, 16, ctz))
              )
            );
          }
          // R36-A1：lintelHalf = 尖冠基座（crookedSpire w 1.7）半宽 0.85
          if (finial) pour(b, mapParts(finialOrnament({ r: 0.5, lintelHalf: 0.85 }), (g) => put(g.translate(ctw / 2, ctH + 5.6, ctz))));
          // A 线 ① 卷叶尖塔（crockedSpire）顶冠；R32-A2 锥面金卷叶仅近区（leaves）
          //   R34 回砍：卷叶 96 tri/座 ×7 座/块侧 —— 0.15m 卷叶在 200m 外亚像素，
          //   `leaves` 由「近区（k<8）」再收到 **hero 街区**；锥体本身两档都保留。
          pour(
            b,
            mapParts(crookedSpire({ w: 1.7, h: 5.2, leaves: hero }), (g) =>
              put(g.translate(ctw / 2, ctH + 1.8, ctz))
            )
          );
          // A 线 ② 角塔飞扶壁（街面墩 → 塔身，内城塔群语汇拓展；pinnacle:false 控 tri）
          //   R34 回砍：104 tri/座 ×2 座 ×40 块侧，且是**双档都在**的实心件
          //   （远档 LOD 不裁）⇒ 中区 peak 的硬成本。收到 hero 街区。
          if (hero) {
            const cfb = flyingButtress({ baseY: 0, springY: 9, topY: 22, reach: 6, depth: 1.0, band: 0.5, pierW: 1.3, pinnacle: false });
            pour(b, mapParts(cfb, (g) => put(g.rotateY(Math.PI).translate(0, 0, ctz))));
          }
        };
        // R34 回砍：纹章顶饰（finialOrnament，108 tri）由「隔街区」收到 hero 街区
        cornerTower(-(blockLen / 2 - 0.5), hero && k % 2 === 0);
        cornerTower(blockLen / 2 - 0.5, false);
        // ② 街面低拱廊（连廊主体；局部 x∈[−4.5,−1.0] ⇒ 世界 |x|∈[11.0,14.5]）
        pour(
          b,
          mapParts(
            corridorRun({
              len: blockLen - 2,
              width: R30_ARCADE.width,
              floorY: R30_ARCADE.floorY,
              pitch: R30_ARCADE.pitch,
              archRise: R30_ARCADE.rise
            }),
            (g) => put(g.translate(-1.0, 0, 0))
          )
        );
        // ③ 连墙飞扶壁（每连墙 1 座；形体局部墙在 x=0、向 +x 伸，而街面在 −x）
        for (const [za, zb] of links) {
          if (zb - za <= 1) continue;
          const lz = (za + zb) / 2;
          const fb = flyingButtress({
            baseY: 0,
            springY: 9.5,
            topY: 11.9,
            reach: 6.5,
            depth: 1.0,
            band: 0.55,
            pierW: 1.4,
            pinnacle: false
          });
          pour(b, mapParts(fb, (g) => (side > 0 ? g.rotateY(Math.PI) : g).translate(side * faceHalf, 0, zc + lz)));
        }
        // ④ 前排塔盲拱列（隔街区，两座前排塔街面上带 y 18）
        //    R34 回砍：492 tri/列 ×2 塔 —— 龛 1.0m 宽 / 4.2m 高，隔街区铺 10 块
        //    ⇒ 单块侧 492 tri 的重复细饰。收到 hero 街区（k%2 隔块规则不变）。
        if (hero && k % 2 === 0) {
          for (const tz of [-blockLen / 4, blockLen / 4]) {
            pour(
              b,
              mapParts(blindArcadeRow({ count: 3, halfW: 0.5, rise: 4.2, pitch: 2.3, cusp: 0.5 }), (g) =>
                put(g.translate(0, 18, tz))
              )
            );
          }
        }
        // ⑤ 殿山面体积（三棱柱 + 山尖小顶 + 斜边卷叶 ×2/边）
        for (const gz2 of [-(hallW / 2 - 0.15), hallW / 2 - 0.15]) {
          const shape = new THREE.Shape();
          shape.moveTo(0.25, wallTop - 0.15);
          shape.lineTo(depth - 0.25, wallTop - 0.15);
          shape.lineTo(depth / 2, ridgeY + 0.12);
          shape.closePath();
          const gable = new THREE.ExtrudeGeometry(shape, {
            depth: 0.3,
            bevelEnabled: false,
            curveSegments: 1,
            steps: 1
          });
          gable.translate(0, 0, -0.15);
          b.ashlar.push(put(finishArch(gable, STONE_TILE_METERS.ashlar).translate(0, 0, gz2)));
          b.ashlar.push(put(spire('ashlar', 0.42, 0, 1.5, 6, depth / 2, ridgeY + 0.1, gz2)));
          // 山墙斜边卷叶 ×2/边（金，参考图坡顶金饰）
          //   R32-A2：只降**装饰密度**——中区（8 ≤ k < 14）关闭（不可读、纯 tri 负担）；
          //   R34 回砍：再由「近区（k<8）」收到 **hero 街区** —— 0.15m 卷叶在
          //   200m 外亚像素，40 tri/条 ×4 条/块侧是纯 tri 负担。
          //   山墙斜边长度 / 坡顶几何逐项不变（铁律 33）。
          if (!hero) continue;
          for (const e of [
            [
              [0.45, wallTop - 0.1],
              [depth / 2, ridgeY + 0.05]
            ],
            [
              [depth - 0.45, wallTop - 0.1],
              [depth / 2, ridgeY + 0.05]
            ]
          ] as const) {
            pour(
              b,
              mapParts(crocketRun({ pts: e, count: 2, size: 0.15 }), (g) => put(g.translate(0, 0, gz2)))
            );
          }
        }
      }

      /* ── R29/R31 后排体量 ×3 排：沿街立面之后的高墙 + 第二进院落 + 远景塔簇 ──
       * R31 天际线五层（用户令「更多、更高、更有层次」，不要一马平川）：
       *   街墙 24（+墙顶敞廊 31）→ 前排塔 56~74 → 院落后殿/钟楼 56~64 →
       *   第三排 82~88 → 第四排远景 88。R31 改动：
       *   ① 后排墙 20→24 + 墙顶敞廊（隔块；marble 柱列 = 材料丰富度主力）；
       *   ② 第二进院落带 x 28..44（apse 隔块 / 钟楼隔三块 / 中景体量）；
       *   ③ 第三排外移 27..42 → 46..61（给院落让位），塔 78→82、中央塔 84→88；
       *   ④ 第四排外移 43..58 → 63..78。
       * 走廊纪律：全部 |x| ≥ 15.5+9 = 24.5。 */
      {
        const r1 = R29_REAR_ROW;
        const r1x = (r1.xIn + r1.xOut) / 2;
        const r1w = r1.xOut - r1.xIn;
        b.wall.push(put(box('wall', r1w, r1.wallH, blockLen, r1x, r1.wallH / 2, 0)));
        b.ashlar.push(put(box('ashlar', r1w + 0.6, 0.5, blockLen + 0.6, r1x, r1.wallH + 0.25, 0)));
        /* ── R32 街墙加密 ②：后排长墙 5 盲拱节拍 + 雕像龛交替（参考图 A 中墙段）────
         * 节拍按参考图判读：龛心距 = 墙宽 1/5、龛宽 = 间距 2/3、龛高 = 墙高 2/3、
         * 龛底离地 = 墙高 1/6；「盲拱 ×3 + 雕像龛 ×2」五站位交替 ⇒ 立面明暗节奏
         * （FBX Arch_3.001 龛深 1.16m 的比例层：plateBack 0.8）。
         * 铺量：k%8===0（每 8 块一面）控预算；远区经 DEEP_FAR 由族内自裁立像/卷叶。
         * 位置：龛底抬到墙高 1/6+1（前排建筑 17.9 屋脊之上仍可读的可见带）。 */
        if (k % R32_WALL_RHYTHM.rearMod === 0) {
          const p5 = blockLen / 5; // 9.2 龛心距
          const half5 = (p5 * 2) / 3 / 2; // 龛宽 = 间距 2/3
          const base5 = r1.wallH / 6 + 1;
          pour(
            b,
            mapParts(
              blindArcadeRow({ count: 3, halfW: half5, rise: (r1.wallH * 2) / 3, pitch: p5 * 2, cusp: 0.5, plateBack: 0.8 }),
              (g) => put(g.translate(r1.xIn + 0.05, base5, 0))
            )
          );
          for (const nz of [-p5, p5]) {
            pour(
              b,
              mapParts(statueNicheX({ halfW: 1.15, rise: 4.4, cusp: 0.5, plateBack: 0.5, crocket: nearZone }), (g) =>
                put(g.translate(r1.xIn + 0.05, base5 + 1.5, nz))
              )
            );
          }
        }
        // R31 ① 墙顶敞廊（隔块；回廊柱列骑在 24m 墙顶 —— 街面透过前排建筑间隙可见）
        //   R34 回砍：588 tri/座 —— 柱 0.84m 径、隔块铺 10 块。改 k%4（隔三块），
        //   敞廊**长度/柱距/层高一概不变**（铁律 33），只降街区重复次数。
        if (k % R34_DENSITY.cloisterMod === 0) {
          pour(
            b,
            mapParts(
              cloisterArcade({
                len: blockLen - 6,
                depth: R31_CLOISTER.depth,
                colH: R31_CLOISTER.colH,
                colR: 0.42,
                pitch: R31_CLOISTER.pitch,
                archRise: R31_CLOISTER.archRise
              }),
              (g) => put(g.translate(r1.xIn + R31_CLOISTER.depth / 2 - 0.2, r1.wallH + 0.4, 0))
            )
          );
        }
        for (const [oz, th] of r1.towers) {
          b.ashlar.push(put(box('ashlar', r1w + 2, 1.4, 13, r1x, 0.7, oz)));
          b.ashlar.push(put(box('ashlar', r1w, th - 1.4 - th * 0.2, 11, r1x, 1.4 + (th - 1.4 - th * 0.2) / 2, oz)));
          b.ashlar.push(put(box('ashlar', r1w + 1.6, 1, 12.6, r1x, th - th * 0.2 + 0.1, oz)));
          // R32-A2：后排塔尖披顶 → roof 桶（瓦顶）
          extra(b, 'roof', put(spire('roof', 5.4, 0, th * 0.2, 8, r1x, th - th * 0.2 + 0.6, oz, Math.PI / 8)));
          // A 线 ① 卷叶尖塔（crockedSpire）顶冠：后排塔尖收口
          //   R32-A2：锥面金卷叶由「非远区」收紧到「仅近区」（中区不可读，纯 tri 负担）
          //   R34 回砍：再收到 **hero 街区**（与角塔卷叶同一判据）。
          pour(
            b,
            mapParts(crookedSpire({ w: 2.2, h: th * 0.18, leaves: hero }), (g) =>
              put(g.translate(r1x, th - th * 0.1 + 0.6, oz))
            )
          );
          // 窗缝只落在「前排塔尖(44.3)以上」的可见带里，别做被挡住的废 tri
          if (th > 52) {
            for (const f of [0.35, 0.7]) {
              b.dark.push(put(box('dark', 0.5, 4.4, 2.4, r1.xIn + 0.05, 44.3 + (th - 44.3) * f, oz)));
            }
          }
        }
        /* ── R33 二进院落建筑层（x≈26..44）：四母题轮换 + 四桶近中景点亮 ─────
         * 详见文件头 R33_COURTYARD。母题不是「隔块才有一座」的稀疏补齐，而是
         * **每个街区都有一座可读的二进院体量**，按 k%4 变换轮廓：
         *   k%4=0 → apse 后殿 + 圣器室侧殿
         *   k%4=1 → bellTower 钟楼 + 章室侧殿
         *   k%4=2 → 长回廊 + 低坡侧殿（三联暖窗）
         *   k%4=3 → 双山墙礼拜堂 + 中央烟囱/灯笼塔
         * 这样 aerial 沿街读到四条不同的屋脊节奏，而不再是两列重复盒。 */
        {
          const cy = R31_COURTYARD;
          const R33 = R33_COURTYARD;
          /** 附属侧殿/章室/圣器室：结构长度双档一致，只由 nearZone/far 控装饰密度 */
          const annex = (cx: number, cz: number, hExtra = 0): void => {
            const h = R33.annexH + hExtra;
            const half = R33.annexW / 2;
            // 大理石基座（近中景可见的亮一档台明）
            extra(b, 'marble', put(box('marble', R33.annexW + 0.8, 0.9, R33.annexD + 0.6, cx, 0.45, cz)));
            // 石殿身
            b.ashlar.push(put(box('ashlar', R33.annexW, h, R33.annexD, cx, 0.9 + h / 2, cz)));
            // 双坡瓦顶（屋脊沿 z）—— roof 桶在近中景进入可见带
            const ridge = 2.4;
            const slope = Math.hypot(half + 0.35, ridge);
            for (const rs of [-1, 1] as const) {
              extra(
                b,
                'roof',
                put(
                  boxRot(
                    'roof',
                    slope,
                    0.32,
                    R33.annexD + 0.6,
                    cx + rs * (half / 2 + 0.18),
                    0.9 + h + ridge / 2,
                    cz,
                    -rs * Math.atan2(ridge, half)
                  )
                )
              );
            }
            // 暴露木檐（街面 −x 端，木梁读法）
            extra(b, 'wood', put(box('wood', 0.42, 0.36, R33.annexD + 0.2, cx - half - 0.12, 0.9 + h - 0.18, cz)));
            // 两扇暖窗：dark 深腔 + 前贴 glass 薄片（2 tri/扇；凹进 0.14m）
            for (const dz of [-R33.annexD * 0.24, R33.annexD * 0.24]) {
              b.dark.push(put(box('dark', 0.3, R33.winH + 0.4, R33.winW + 0.4, cx - half + 0.08, R33.winBase + R33.winH / 2, cz + dz)));
              const pane = new THREE.PlaneGeometry(R33.winW, R33.winH);
              pane.rotateY(-Math.PI / 2);
              pane.translate(cx - half - 0.02, R33.winBase + R33.winH / 2, cz + dz);
              planarUV(pane, TILE.glass);
              extra(b, 'glass', put(pane));
            }
            // 近区加小尖塔/烟囱冠；低配/远区只保留体量（铁律 33）
            if (!far) {
              b.ashlar.push(put(spire('ashlar', 1.15, 0, 5.5, 4, cx, 0.9 + h + ridge, cz + R33.annexD * 0.32, Math.PI / 4)));
              b.gold.push(put(spire('gold', 0.22, 0, 1.1, 4, cx, 0.9 + h + ridge + 5.3, cz + R33.annexD * 0.32)));
            }
          };

          const motif = ((k % 4) + 4) % 4;
          const variant = (k * 7) % 3; // 0/1/2 的确定性高度差，避免同母题完全等高
          /* ── R36-A2 pave-damp 内庭地面铺装（pave 变体桶：floor 图集 + 微湿潮斑）
           * 二进院带地坪（世界 x 25.5..43.5），y 0.03..0.08 —— 离地 ≥3cm（防
           * z-fight 余量 ≥2cm 铁律）、与 pave-walk（|x|≤15.4 / y 0.014）零重叠。
           * 建筑基座压在板上（板顶 0.08 埋进基座 0..0.9 内，不出面）。
           * 只铺近/中区前 8 块（hero 可读带），12 tri/块；far/DEEP_FAR 跳过。 */
          if (!far && k < 8) {
            extra(b, 'pave', put(box('floor', 18, 0.05, blockLen - 4, 19, 0.055, 0)));
            /* ── R37-A 内庭地坪**拼花带**（内部材料丰富度深化①）──────────────────
             * 参考图内庭地坪不是一整块匀色板，板面上有一条**窄向的拼花/导向带**。
             * 用 pave-damp 变体桶（floor 图集 + 微湿潮斑）铺一条 1.4m 宽的窄带压在
             * 地坪板之上。**位置口径按实订正（R37 P2-7）**：
             *   · x = 19 是**这块地坪板自己的中线**（板宽 18、x∈[10,28]），
             *     **不是**院落/街区中轴 —— 旧注释写「中轴」是错的，别再照它推坐标。
             *   · y 逐值算清（旧注释 y 与实际差 5mm，正是本条被打回的原因）：
             *       地坪板  y=0.055 h=0.05 ⇒ **板顶 = 0.08**
             *       拼花带  y=0.1075 h=0.015 ⇒ **带底 = 0.10**、带顶 = 0.115
             *       ⇒ 离板间隙 = 0.10 − 0.08 = **20mm**，正好压住本项目
             *         「离面 ≥2cm 防 z-fight」的铁律（旧值 y=0.0925 ⇒ 带底 0.085
             *         ⇒ 间隙只有 **5mm**，不达标）。
             * 代价：12 tri/块 × 8 块 = **96 tri**，进既有 pave 桶 ⇒ **0 新增 DC**。 */
            extra(b, 'pave', put(box('floor', 1.4, 0.015, blockLen - 6, 19, 0.1075, 0)));
          }

          if (motif === 0) {
            // ① 后殿半圆室（apex 朝街）+ 圣器室侧殿
            pour(
              b,
              mapParts(
                apseDrum({ r: cy.apse.r, h: cy.apse.h, segs: 12, roofRise: cy.apse.h * 0.26 }),
                (g) => put(g.translate(cy.apse.x, 0, 0))
              )
            );
            annex(R33.annexX, blockLen * 0.32, variant * 1.1);
          } else if (motif === 1) {
            // ② 钟楼 + 章室（低坡侧殿，与钟楼形成「高塔-低屋」层次）
            pour(
              b,
              mapParts(bellTower({ w: cy.bell.w, totalH: cy.bell.h }), (g) =>
                put(g.translate(cy.bell.x, 0, 0))
              )
            );
            annex(R33.annexX, -blockLen * 0.32, variant * 1.2);
          } else if (motif === 2) {
            // ③ 长回廊 + 低坡侧殿：中景盒降到 22m（天际线留空给后排），前脸补三联暖窗
            const mid = 22 + variant * 1.5;
            const mw = cy.xOut - cy.xIn - 4;
            const mz = (cy.xIn + cy.xOut) / 2;
            b.wall.push(put(box('wall', mw, mid, blockLen - 14, mz, mid / 2, 0)));
            b.ashlar.push(put(box('ashlar', mw + 0.8, 0.6, blockLen - 13, mz, mid + 0.3, 0)));
            // 三联暖窗（dark 深腔 + glass 面）+ 大理石基座 + 木檐
            extra(b, 'marble', put(box('marble', 0.35, 2.2, blockLen - 12, cy.xIn + 0.12, 1.1, 0)));
            for (const wz of [-10, 0, 10]) {
              b.dark.push(put(box('dark', 0.32, 6.0, 3.1, cy.xIn + 0.1, 8.2, wz)));
              const pane = new THREE.PlaneGeometry(2.7, 5.4);
              pane.rotateY(-Math.PI / 2);
              pane.translate(cy.xIn - 0.02, 8.2, wz);
              planarUV(pane, TILE.glass);
              extra(b, 'glass', put(pane));
            }
            extra(b, 'wood', put(box('wood', 0.4, 0.38, blockLen - 14, cy.xIn - 0.12, mid - 0.3, 0)));
            // 长回廊（marble 柱列 + 尖拱 + 木梁 + 斜瓦顶）
            pour(
              b,
              mapParts(
                cloisterArcade({
                  len: blockLen - 10,
                  depth: 2.6,
                  colH: 7.0,
                  colR: 0.38,
                  pitch: 4.6,
                  archRise: 2.7
                }),
                (g) => put(g.translate(cy.xIn + 1.6, 0, 0))
              )
            );
            // 中景体量坡顶瓦（两片）
            const ridgeY2 = mid + 2.2;
            for (const rs of [-1, 1] as const) {
              const lx = rs < 0 ? mz - mw / 4 : mz + mw / 4;
              extra(
                b,
                'roof',
                put(boxRot('roof', Math.hypot(mw / 2, 2.2), 0.4, blockLen - 14, lx, (mid + ridgeY2) / 2, 0, -rs * Math.atan2(2.2, mw / 2)))
              );
            }
            // ④b 院内楼梯塔（48m + 瓦顶）：四母题里唯一的长回廊块也需要一个
            // 越过前排 44m 塔线的竖向高点，否则 aerial 上该块仍是「一条低屋脊」。
            {
              const tx = cy.xIn + 5.0;
              const tz = blockLen * 0.3;
              extra(b, 'marble', put(box('marble', 5.0, 1.0, 5.0, tx, 0.5, tz)));
              b.ashlar.push(put(box('ashlar', 4.2, 48, 4.2, tx, 24, tz)));
              extra(b, 'roof', put(spire('roof', 3.4, 0, 5.4, 8, tx, 48, tz, Math.PI / 8)));
              for (const wy of [14, 30]) {
                const pane = new THREE.PlaneGeometry(1.6, 4.2);
                pane.rotateY(-Math.PI / 2);
                pane.translate(tx - 2.11, wy, tz);
                planarUV(pane, TILE.glass);
                extra(b, 'glass', put(pane));
              }
            }
          } else {
            // ④ 双山墙礼拜堂 + 中央烟囱/灯笼塔：aerial 唯一有「两坡 + 高烟囱」轮廓的母题
            for (const zs of [-1, 1] as const) {
              const h = R33.twinH + variant * 1.2;
              const cz = zs * R33.twinZ;
              const cx = R33.annexX + 1.0;
              extra(b, 'marble', put(box('marble', R33.twinW + 0.7, 0.8, R33.twinD + 0.5, cx, 0.4, cz)));
              b.ashlar.push(put(box('ashlar', R33.twinW, h, R33.twinD, cx, 0.8 + h / 2, cz)));
              const half = R33.twinW / 2;
              const ridge = 2.8;
              const slope = Math.hypot(half + 0.3, ridge);
              for (const rs of [-1, 1] as const) {
                extra(
                  b,
                  'roof',
                  put(
                    boxRot(
                      'roof',
                      slope,
                      0.34,
                      R33.twinD + 0.5,
                      cx + rs * (half / 2 + 0.15),
                      0.8 + h + ridge / 2,
                      cz,
                      -rs * Math.atan2(ridge, half)
                    )
                  )
                );
              }
              // 山墙玻璃三联（朝向街面 −x；aerial 与街面都能读到暖窗）
              for (const dz of [-2.1, 0, 2.1]) {
                const pane = new THREE.PlaneGeometry(1.65, 4.2);
                pane.rotateY(-Math.PI / 2);
                pane.translate(cx - half - 0.01, 6.0, cz + dz);
                planarUV(pane, TILE.glass);
                extra(b, 'glass', put(pane));
                b.dark.push(put(box('dark', 0.26, 4.6, 1.9, cx - half + 0.08, 6.0, cz + dz)));
              }
              extra(b, 'wood', put(box('wood', 0.38, 0.34, R33.twinD, cx - half - 0.1, 0.8 + h - 0.2, cz)));
            }
            // 中央烟囱/灯笼塔：高 22m，顶部小瓦帽 + 3 条 glass 光缝
            const sx = R33.annexX + 1.2;
            extra(b, 'marble', put(box('marble', R33.stackW + 0.8, 1.0, R33.stackW + 0.8, sx, 0.5, 0)));
            b.ashlar.push(put(box('ashlar', R33.stackW, R33.stackH, R33.stackW, sx, R33.stackH / 2, 0)));
            extra(b, 'roof', put(spire('roof', R33.stackW * 0.8, 0, 5.6, 8, sx, R33.stackH, 0, Math.PI / 8)));
            b.gold.push(put(spire('gold', 0.24, 0, 1.2, 4, sx, R33.stackH + 5.5, 0)));
            for (const wz of [-1.5, 0, 1.5]) {
              const pane = new THREE.PlaneGeometry(0.55, 2.0);
              pane.rotateY(-Math.PI / 2);
              pane.translate(sx - R33.stackW / 2 - 0.01, R33.stackH * 0.62, wz);
              planarUV(pane, TILE.glass);
              extra(b, 'glass', put(pane));
            }
          }
        }
        // 第三排（R31 外移 46..61，纯天际线体量）
        const r2 = R29_REAR2;
        const r2x = (r2.xIn + r2.xOut) / 2;
        const r2w = r2.xOut - r2.xIn;
        b.wall.push(put(box('wall', r2w, r2.wallH, blockLen, r2x, r2.wallH / 2, 0)));
        for (const oz of [-11, 11]) {
          b.ashlar.push(put(box('ashlar', r2w, r2.towerH, 14, r2x, r2.towerH / 2, oz)));
          b.ashlar.push(put(box('ashlar', r2w + 2, 1.2, 16, r2x, r2.towerH + 0.6, oz)));
          // R32-A2 桶位纪律：第三排（远景）塔尖披顶**保留 ashlar**（同上，不入不可剔除桶）
          b.ashlar.push(put(spire('ashlar', 6.5, 0, 15, 8, r2x, r2.towerH + 1.2, oz, Math.PI / 8)));
          b.dark.push(put(box('dark', 0.5, 5, 3, r2.xIn + 0.05, r2.towerH * 0.8, oz)));
          /* ── R32-A2 T2 材料丰富度 ⑥：后排塔**窗玻璃**（glass 桶）──────────
           * R33 修正：原 box 整个嵌在 dark 腔内（x=xIn+0.18），从街面被 dark
           * 前脸挡住，等于 12 tri 全不可见。改为**贴 dark 前脸的 2-tri 薄片**：
           * x=xIn−0.01（街面侧）、法线朝 −x，既真可见又从 12 tri/扇降到 2 tri/扇
           * （80 扇省 800 tri）。这是「空气墙玻璃」的读法，不是几何长度缩短。 */
          {
            const pane = new THREE.PlaneGeometry(2.6, 4.4);
            pane.rotateY(-Math.PI / 2);
            pane.translate(r2.xIn - 0.01, r2.towerH * 0.8, oz);
            planarUV(pane, TILE.glass);
            extra(b, 'glass', put(pane));
          }
        }
        /* ── R30/R31 第三排中央高塔（块心、第三排位；R31 外移 + 84 → 88）──────── */
        const rc = R30_REAR_CORE;
        const rcTop = rc.h - 1.4 - 12;
        b.ashlar.push(put(box('ashlar', rc.w + 1.6, 1.4, rc.w + 1.6, r2x, 0.7, 0)));
        b.ashlar.push(put(box('ashlar', rc.w, rcTop, rc.w, r2x, 1.4 + rcTop / 2, 0)));
        b.ashlar.push(put(box('ashlar', rc.w + 1.8, 1.0, rc.w + 1.8, r2x, rc.h - 12.4, 0)));
        // R32-A2 桶位纪律：中央高塔（第三排，远景）尖披顶**保留 ashlar**。
        //   塔尖瓦顶只给"近中景真被读到"的前排塔/街区角塔/后排塔；远景排只贡献剪影
        //   且靠雾退远，不值得占用不可剔除桶的 visibleTri 预算（见 castleDetail 文件头）。
        b.ashlar.push(put(spire('ashlar', rc.w * 0.5, 0, 12, 8, r2x, rc.h - 12, 0, Math.PI / 8)));
        // R32-A2：**桶位更正** —— 原 17×17m 水平金压顶板（40 座，顶面+底面合计
        // 23,773 m² = 全场景 gold 表面积的 **10.7%**）改 ashlar。它在 76m 塔顶
        // **水平朝上**，街面只读到 0.24m 的侧边 ⇒ 是"体量件误投 gold 桶"（T1 情形 a），
        // 也是 gold 表面积口径被虚高的最大单项。
        b.ashlar.push(put(box('ashlar', rc.w + 2, 0.24, rc.w + 2, r2x, rc.h - 11.8, 0)));
        b.dark.push(put(box('dark', 0.7, 6, 2.0, r2.xIn + 0.05, rc.h * 0.55, 0)));
        pour(
          b,
          mapParts(
            traceryWindowX({
              halfW: 0.62,
              rise: 4.6,
              cusp: 0.7,
              frameOut: 0.4,
              plateBack: 0.26,
              mullions: winMullions,
              subArches: winSubs,
              goldFrame: nearZone,
              goldTracery: false,
              recess: hero
            }),
            (g) => put(g.translate(0, 26, 0))
          )
        );
        // R34 回砍：中央高塔雕像龛（228 tri）由「隔街区」收到 hero 街区
        if (hero && k % 2 === 0) {
          pour(
            b,
            mapParts(statueNicheX({ halfW: 0.62, rise: 2.6, cusp: 0.5, crocket: nearZone }), (g) =>
              put(g.translate(0, 40, 0))
            )
          );
        }
        // A 线 ① 卷叶尖塔（crockedSpire）顶冠：内城中央高塔收口（卷叶仅近区）
        //   R34 回砍：卷叶同律收到 hero 街区（锥体保留）。
        pour(b, mapParts(crookedSpire({ w: 3.4, h: 9, leaves: hero }), (g) => put(g.translate(r2x, rc.h - 6, 0))));
        /* ── R30/R31 第四排远景体量（隔块；R31 外移 43..58 → 63..78）──────────────
         * R32：奇数块原本整排空置 ⇒ 天际线断档。补「矮墙 + 单塔」体量（纯盒体，
         * 12~16 tri/件，wall/ashlar 桶）⇒ 四排体量沿全街连续不断档。 */
        if (k % 2 === 0) {
          const r4x = (R31_ROW4.xIn + R31_ROW4.xOut) / 2;
          const r4w = R31_ROW4.xOut - R31_ROW4.xIn;
          b.wall.push(put(box('wall', r4w, R31_ROW4.wallH, blockLen, r4x, R31_ROW4.wallH / 2, 0)));
          for (const oz of [-14, 14]) {
            b.ashlar.push(put(box('ashlar', r4w, R31_ROW4.towerH, 16, r4x, R31_ROW4.towerH / 2, oz)));
            b.ashlar.push(put(box('ashlar', r4w + 2, 1.2, 18, r4x, R31_ROW4.towerH + 0.6, oz)));
            // R32-A2 桶位纪律：第四排（远景）塔尖披顶**保留 ashlar**
            b.ashlar.push(put(spire('ashlar', 6.5, 0, 14, 8, r4x, R31_ROW4.towerH + 1.2, oz, Math.PI / 8)));
            b.dark.push(put(box('dark', 0.6, 6, 2.4, R31_ROW4.xIn + 0.05, 60, oz)));
            // R32-A2 T2 ⑥：第四排塔窗玻璃（glass 桶）；R33 同后排修正：
            // 2-tri 前脸薄片（法线朝街面）替代被 dark 腔挡住的 12-tri box。
            {
              const pane = new THREE.PlaneGeometry(2.0, 5.4);
              pane.rotateY(-Math.PI / 2);
              pane.translate(R31_ROW4.xIn - 0.01, 60, oz);
              planarUV(pane, TILE.glass);
              extra(b, 'glass', put(pane));
            }
          }
        } else {
          const r4x = (R31_ROW4.xIn + R31_ROW4.xOut) / 2;
          const r4w = R31_ROW4.xOut - R31_ROW4.xIn;
          b.wall.push(put(box('wall', r4w, R31_ROW4.wallH - 8, blockLen, r4x, (R31_ROW4.wallH - 8) / 2, 0)));
          b.ashlar.push(put(box('ashlar', r4w, 58, 12, r4x, 29, 0)));
          b.ashlar.push(put(box('ashlar', r4w + 2, 1.2, 14, r4x, 58.6, 0)));
          // R32-A2 桶位纪律：奇数块第四排（远景）塔尖披顶**保留 ashlar**
          b.ashlar.push(put(spire('ashlar', 5.5, 0, 12, 8, r4x, 59.2, 0, Math.PI / 8)));
          b.dark.push(put(box('dark', 0.6, 5, 2.4, R31_ROW4.xIn + 0.05, 40, 0)));
          // R32-A2 T2 ⑥：奇数块第四排塔窗玻璃（glass 桶）；R33 同律改 2-tri 前脸薄片。
          {
            const pane = new THREE.PlaneGeometry(2.0, 4.4);
            pane.rotateY(-Math.PI / 2);
            pane.translate(R31_ROW4.xIn - 0.01, 40, 0);
            planarUV(pane, TILE.glass);
            extra(b, 'glass', put(pane));
          }
        }
      }

      /* ── 火盆 ×2（连墙墙根，探出街面 0.7）── */
      for (const bz of [-blockLen / 2 + 2, 8]) {
        b.ashlar.push(put(box('ashlar', 0.9, 0.8, 0.9, -0.7, 0.4, bz)));
        b.gold.push(put(spire('gold', 0.26, 0.42, 0.9, 8, -0.7, 0.8, bz)));
        b.flame.push(put(flame(0.3, 0.5, -0.7, 1.7, bz)));
      }
      /* ── R32 街面火盆 +1/侧（隔块；WCArchBraizer 语录：石墩座 + 金碗盆 + 尖焰）──
       * 参考图 B 桥/街火盆密度；落在街面 |x|≈14.8（拱廊柱列之外、不侵走廊 8）。 */
      if (k % 2 === 0) {
        const bz2 = -blockLen / 2 + 12;
        b.ashlar.push(put(box('ashlar', 0.85, 0.75, 0.85, -0.7, 0.38, bz2)));
        b.gold.push(put(spire('gold', 0.24, 0.4, 0.85, 8, -0.7, 0.75, bz2)));
        b.gold.push(put(spire('gold', 0.44, 0.44, 0.11, 8, -0.7, 1.6, bz2)));
        b.flame.push(put(flame(0.28, 0.46, -0.7, 1.71, bz2)));
      }
    }
  }

  /* ── R29 远景剪影带：横向拓展的最外层（|x| 120…175，两侧沿全街铺设）───────
   * 参考图的"建筑丰富"有一半来自**远景层叠的天际线**：近景塔 → 中景墙 → 远景塔簇，
   * 三层进深压在一起才有城市感。本段是纯剪影：只入 wall / ashlar 桶，不参与碰撞、
   * 不投影、靠雾自然退远；全部 box/spire（12~16 tri），确定性取模排布（不随机）。 */
  {
    const s = R29_SKYLINE;
    const span = s.xOut - s.xIn;
    for (const side of [-1, 1] as const) {
      for (let z = s.zNear; z >= s.zFar; z -= 100) {
        const k = Math.round((s.zNear - z) / 100);
        const hIn = 34 + ((k * 37) % 26);
        const hOut = 62 + ((k * 53) % 34);
        b.wall.push(box('wall', span, hIn, 34, side * (s.xIn + span * 0.28), hIn / 2, z));
        b.ashlar.push(box('ashlar', 22, hOut, 26, side * (s.xIn + span * 0.72), hOut / 2, z - 12));
        // R32-A2：远景剪影塔尖披顶 → roof 桶（瓦顶）；塔顶**金尖饰**保留 gold
        extra(b, 'roof', spire('roof', 9, 0, 16, 6, side * (s.xIn + span * 0.72), hOut, z - 12));
        b.gold.push(spire('gold', 0.5, 0, 2.4, 6, side * (s.xIn + span * 0.72), hOut + 15.8, z - 12));
      }
    }
  }

  /* ── R30 ③ 跨街封闭拱顶连廊 ×3（连廊 · 跨路连接两侧）────────────────────────
   * z = 块心 k=3/8/13（确定性，避开门洞带 z∈[−372,−345] 与广场带 [−1285.5,−1300]）；
   * 跨度 21m（|x|≤10.5）正好搭到两侧街面拱廊屋顶外棱（|x|≈10.6）。
   * 楼面 12m + 胸墙 2m + 筒拱 1.7m ⇒ 全部几何 y ≥ 11.75 > 走廊上沿 4.5m
   * （r29_corridor_probe 判据：车从拱顶廊下穿过不侵廊）。
   * R32：加密到 5 座（+2 座在块心 k=1/15；用户令「连廊/跨街廊…更密的内部结构」），
   * 且楼面下加**木梁**（wood 桶：跨街廊的暴露木构读法，材料丰富度四桶之一）。 */
  for (const cz of [...R30_CROSSINGS, ...R32_CORRIDOR.extraCrossings]) {
    pour(b, mapParts(corridorCrossing({ span: 21, width: 4.4, floorY: 12, rise: 1.7 }), (g) => g.translate(0, 0, cz)));
    for (const s of [-1, 1] as const) {
      extra(b, 'wood', box('wood', 0.34, 0.34, 4.4, s * 5.4, 11.6, cz));
      extra(b, 'wood', box('wood', 0.34, 0.34, 4.4, s * 2.2, 11.6, cz));
    }
  }
  // R38-P0-9：本函数块循环里会把 DEEP_FAR 置 true（最远 1/3 街区），**必须在退出前复位**，
  // 否则该模块级全局会泄漏给后续工厂 pass / 重跑，静默丢卷叶 / 立像 / 子拱 / 窗棂。
  setDeepFar(false);
  return b;
}
