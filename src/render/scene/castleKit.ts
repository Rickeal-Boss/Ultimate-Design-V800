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
  draperyRelief,
  finialOrnament,
  flyingButtress,
  gildedScreen,
  gothicBay,
  mapParts,
  pinnacleCluster,
  pour,
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
 * （预算红线 R27_BUDGET：high ≤ 240k tri / DC ≤ 20；R29 改前实测 129,414 tri / 7 DC）：
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

/** 火焰锥（MeshBasic 发光体，不贴图 ⇒ 不需要 UV） */
function flame(r: number, h: number, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, LOW_DETAIL ? 6 : 8, 1);
  g.translate(cx, cy + h / 2, cz);
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
 * 栏板：双侧连续，z ∈ [VIADUCT.zNear, 城门脸 −351.5]，中心线 x = ±16.36。
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
  const x = VIADUCT.totalHalf - 0.36; // 16.36（比桥沿内收 0.36）
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
  const { z, openW, openH, archivoltBandH, totalH, halfW, depth } = GATE;
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

  // ── 中央石体量：以门洞拱形为下边界，顶到 massTop
  const mass = archWall(openHalf, 0, massTop, rise, depth, 10, cusp, 0.35);
  mass.translate(0, 0, zFront);
  b.ashlar.push(mass);
  // 体量顶檐口两层 + 中央尖塔（44 → 55 = totalH）+ 金宝顶
  b.ashlar.push(box('ashlar', openW + 1.4, 0.6, depth + 1.4, 0, massTop + 0.3, zMid));
  b.ashlar.push(spire('ashlar', 2.0, 0, totalH - massTop - 0.6, 8, 0, massTop + 0.6, zMid, Math.PI / 8));
  b.gold.push(spire('gold', 0.5, 0, 0.9, 8, 0, totalH - 0.9, zMid));

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
          traceryWindowZ({ halfW: 1.2, rise: 7.5, cusp: 1.0, frameOut: 0.5, plateBack: 0.3, mullions: 2, lights: true }),
          (g) => g.translate(cx, wy, zFront)
        )
      );
    }
    // 塔面竖向金线 ×2
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.35, towerH - 1, 0.16, cx + ox * (towerW / 2 - 0.35), (towerH - 1) / 2 + 0.5, zFront - 0.08));
    }
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
      const badge = box('gold', 1.5, 1.5, 0.2, cx, by, zFront - 0.12);
      badge.rotateZ(Math.PI / 4); // 菱形
      b.gold.push(badge);
      b.gold.push(spire('gold', 0.16, 0, 0.5, 4, cx, by + 1.0, zFront - 0.12)); // 章尖
    }
    // 角小尖塔 ×4（前两后两）+ 顶饰金色四角星（G1：墩顶小尖塔+菱形/星形金饰）
    for (const ox of [-1, 1] as const) {
      for (const oz of [-1, 1] as const) {
        const px = cx + ox * (towerW / 2 - 0.7);
        const pz = zMid + oz * (halfD - 0.9);
        b.ashlar.push(box('ashlar', 1.1, 2.2, 1.1, px, towerH + 1.1, pz));
        b.ashlar.push(spire('ashlar', 0.55, 0, 3.2, 8, px, towerH + 2.2, pz, Math.PI / 8));
        // 四角星：两片正交菱形金片
        for (const r of [0, Math.PI / 2]) {
          const star = box('gold', 0.34, 1.5, 0.12, px, towerH + 5.9, pz);
          star.rotateZ(r);
          b.gold.push(star);
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
    const fb = flyingButtress({
      baseY: 0,
      springY: 8,
      topY: 29,
      reach: 6,
      depth: 1.1,
      band: 0.66,
      pierW: 1.7,
      pinnacle: true
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
  // A 线 ① 鎏金山花屏（门洞 tympanum reredos：中央拱门后金山花 + 金十字；高效增金饰覆盖）
  pour(b, mapParts(gildedScreen({ w: 12, h: 16, cross: true }), (g) => g.rotateY(Math.PI / 2).translate(0, 9, zFront + 0.05)));
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

  /* ── 中央钟楼（identity 三件套：圆钟面 + 金冠尖顶 + 竖向金饰条贯通）── */
  {
    const { w, baseY, totalH, clockY, clockD } = TOWER_GROUP.clock;
    const shaftTop = 78; // 檐口（冠顶自此起）
    // 台基（咬合门楼体量顶 massTop=44）
    b.ashlar.push(box('ashlar', w + 2.6, 4.5, gd + 1.8, 0, baseY + 2.25, gz));
    // 塔身三段收分（阶梯=砌层感，44.5 → 78）
    b.ashlar.push(box('ashlar', w + 1.4, 13.5, gd + 0.6, 0, 44.5 + 6.75, gz)); // 44.5..58
    b.ashlar.push(box('ashlar', w + 0.5, 12, gd + 0.2, 0, 58 + 6, gz)); // 58..70
    b.ashlar.push(box('ashlar', w - 0.3, 8, gd - 0.2, 0, 70 + 4, gz)); // 70..78
    // 檐口 + 金线
    b.ashlar.push(box('ashlar', w + 2.2, 1.2, gd + 1.4, 0, shaftTop + 0.6, gz));
    b.gold.push(box('gold', w + 2.4, 0.22, gd + 1.6, 0, shaftTop + 1.35, gz));
    // 金冠尖顶（cone 8 面 + 金珠）
    b.gold.push(spire('gold', 3.4, 0, totalH - shaftTop - 1.2, 8, 0, shaftTop + 1.2, gz, Math.PI / 8));
    b.gold.push(spire('gold', 0.55, 0.55, 0.7, 8, 0, shaftTop + 1.1, gz));
    // 圆钟面（前脸，竖面）：金圈 + 近黑盘 + 金指针（V：钟面位于 0.62~0.70 塔高）
    const cz = zFront - 0.06;
    const ring = new THREE.CylinderGeometry(clockD / 2 + 0.55, clockD / 2 + 0.55, 0.34, 20);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, clockY, cz);
    planarUV(ring, TILE.gold);
    b.gold.push(ring);
    const face = new THREE.CylinderGeometry(clockD / 2, clockD / 2, 0.4, 20);
    face.rotateX(Math.PI / 2);
    face.translate(0, clockY, cz);
    planarUV(face, TILE.wall);
    b.dark.push(face);
    b.gold.push(box('gold', 0.32, clockD * 0.62, 0.16, 0, clockY, cz - 0.2)); // 时针（垂直）
    b.gold.push(box('gold', clockD * 0.48, 0.32, 0.16, clockD * 0.24, clockY, cz - 0.2)); // 分针
    b.gold.push(spire('gold', 0.42, 0.42, 0.6, 8, 0, shaftTop + 1.0, gz)); // 冠座金珠
    // 竖向金饰条 ×2（前脸贯通塔身）
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.4, shaftTop - 44.5, 0.18, ox * (w / 2 - 0.5), (44.5 + shaftTop) / 2, zFront - 0.12));
    }
    // 钟楼尖拱窗 ×1（钟上方）—— R30 换装花格窗（金框 + 双棂 + 拱肩光）
    {
      pour(
        b,
        mapParts(
          traceryWindowZ({ halfW: 1.1, rise: 5.2, cusp: 0.7, frameOut: 0.5, plateBack: 0.3, mullions: 2, lights: true }),
          (g) => g.translate(0, 69, zFront)
        )
      );
    }
  }

  /* ── 双铃塔（拱形钟室挂钟；顶为深色坡顶 = dark 桶）── */
  for (const side of [-1, 1] as const) {
    const cx = side * TOWER_GROUP.bell.x; // ±25
    const { w, totalH, bellY, bellOpenH } = TOWER_GROUP.bell;
    const shaftTop = 68; // 檐口
    b.ashlar.push(box('ashlar', w + 2.4, 2, w + 2.4, cx, 1, gz)); // 台基
    b.ashlar.push(box('ashlar', w + 0.6, 33, w + 0.6, cx, 2 + 16.5, gz)); // 塔身下段 2..35
    b.ashlar.push(box('ashlar', w, shaftTop - 35, w, cx, 35 + (shaftTop - 35) / 2, gz)); // 塔身上段 35..68
    b.ashlar.push(box('ashlar', w + 1.6, 1.2, w + 1.6, cx, shaftTop + 0.6, gz)); // 檐口
    b.gold.push(box('gold', w + 1.8, 0.22, w + 1.8, cx, shaftTop + 1.35, gz)); // 檐口金线
    // 尖顶：**R29 改白石**（原 dark 深色坡顶）。参考图（7cd7329c / 2497fab5）双铃塔
    // 顶部是**白石收分尖顶 + 金饰尖**，没有一片黑屋顶；原实现的黑锥在 gate_hero 机位
    // 读成"卡通巫婆帽"（verify/r29_c2/gate_hero.png 实证），是全场景最刺眼的一处失真。
    b.ashlar.push(spire('ashlar', w * 0.62, 0, totalH - shaftTop - 1.2, 8, cx, shaftTop + 1.2, gz, Math.PI / 8));
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
    const bellH = bellOpenH * 0.66;
    b.gold.push(spire('gold', bellH * 0.34, bellH * 0.2, bellH * 0.78, 10, cx, bellY + 0.4, zFront - 0.5, 0));
    b.gold.push(box('gold', bellH * 0.68, 0.22, 0.3, cx, bellY + 0.4, zFront - 0.5)); // 钟唇
    b.gold.push(spire('gold', 0.16, 0.16, 0.5, 6, cx, bellY + 0.4 + bellH * 0.78, zFront - 0.5)); // 吊环
    // 塔身金饰条 ×2 + 尖拱窗 ×1（钟室下）
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.3, 30, 0.16, cx + ox * (w / 2 - 0.4), 20, zFront - 0.1));
    }
    {
      // R30 换装花格窗（铃塔身窗，前脸）
      pour(
        b,
        mapParts(
          traceryWindowZ({ halfW: 0.8, rise: 4.6, cusp: 0.6, frameOut: 0.45, plateBack: 0.28, mullions: 2, lights: true }),
          (g) => g.translate(cx, 44, zFront)
        )
      );
    }
  }

  /* ── 细尖塔 ×2（kit④ 语言：全塔 1:6.2，上段杆件 1:11.3）── */
  for (const side of [-1, 1] as const) {
    const cx = side * TOWER_GROUP.spire.x; // ±42
    const { w, totalH } = TOWER_GROUP.spire;
    b.ashlar.push(box('ashlar', w + 2, 1.6, w + 2, cx, 0.8, gz)); // 台基
    b.ashlar.push(box('ashlar', w, 38, w, cx, 1.6 + 19, gz)); // 基座段 1.6..39.6
    b.ashlar.push(box('ashlar', w * 0.86, 8, w * 0.86, cx, 39.6 + 4, gz)); // 中段收分
    // 上段细杆（1:11.3）
    const rodH = totalH - 47.6;
    b.ashlar.push(pierColumn(rodH / TOWER.spireAspect, (rodH / TOWER.spireAspect) * 0.7, rodH, cx, 47.6, gz));
    // 金饰带 ×2 + 金尖
    b.gold.push(box('gold', w + 0.5, 0.3, w + 0.5, cx, 20, gz));
    b.gold.push(box('gold', w * 0.9 + 0.4, 0.3, w * 0.9 + 0.4, cx, 43, gz));
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
      b.wall.push(box('wall', w, h, 8, cx, h / 2, gz)); // 墙身
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
        pour(
          b,
          mapParts(
            traceryWindowX({ halfW: 0.85, rise: 5.0, cusp: 0.7, frameOut: 0.45, plateBack: 0.3, mullions: 2, lights: true }),
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
      b.wall.push(box('wall', w, 22, 7, cx, 11, gz));
      b.ashlar.push(box('ashlar', w + 0.6, 0.55, 7.6, cx, 22.3, gz));
      b.gold.push(box('gold', w + 0.8, 0.2, 7.8, cx, 22.7, gz));
      // 垛口（节拍 2.4，与外延墙同长）
      const merlons = Math.floor(w / 2.4);
      for (let m = 0; m < merlons; m += 1) {
        const mz = gz - 3.5 + (7 * (m + 0.5)) / merlons;
        b.ashlar.push(box('ashlar', w / merlons * 0.55, 1.1, 0.8, cx + side * (-w / 2 + (w * (m + 0.5)) / merlons), 23, mz));
      }
      // 扶壁塔节奏：34 / 46 / 40（中间最高，参考图的"塔簇"读法）
      const towers: readonly (readonly [number, number])[] = [
        [x0 + 8, 34],
        [x0 + 21, 46],
        [x0 + 34, 40]
      ];
      for (const [tx, th] of towers) {
        const px = side * tx;
        b.ashlar.push(box('ashlar', 6.4, 1.2, 9, px, 0.6, gz));
        b.ashlar.push(box('ashlar', 5.8, th - 1.2 - 2.2, 8.2, px, 1.2 + (th - 3.4) / 2, gz));
        b.ashlar.push(box('ashlar', 7.0, 0.8, 9.4, px, th - 1.0, gz)); // 檐口
        b.gold.push(box('gold', 7.2, 0.22, 9.6, px, th - 0.55, gz)); // 金压顶
        b.ashlar.push(spire('ashlar', 4.2, 0, 5.4, 8, px, th - 0.6, gz, Math.PI / 8));
        b.gold.push(spire('gold', 0.42, 0, 1.6, 6, px, th + 4.8, gz));
        // 竖向金饰条（塔面 3 道，参考图的"金线拉高"语言）
        for (const gx of [-1.6, 0, 1.6]) {
          b.gold.push(box('gold', 0.24, th * 0.62, 0.14, px + gx, th * 0.42, gz + 4.2));
        }
        // 深色窗缝 ×2（远读节拍）
        b.dark.push(box('dark', 0.5, 4.2, 1.4, px, th * 0.62, gz + 4.15));
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
      // ④ 细尖塔纹章顶饰
      const spx = side * TOWER_GROUP.spire.x;
      pour(b, mapParts(finialOrnament({ r: 0.55 }), (g) => g.translate(spx, 68.4, gz)));
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
    const rise = clearH - 2.4; // 21.6（起拱线 2.4 处）
    for (const [band, dep] of [
      [1.5, 0.6],
      [0.95, 0.5],
      [0.55, 0.45]
    ] as const) {
      const g = archBand(openHalf, 2.4, rise, band, dep, 9, 1.1, 0.45);
      g.rotateY(Math.PI);
      g.translate(0, 0, zFront + 0.05 - (band === 1.5 ? 0 : band === 0.95 ? 1.15 : 2.1));
      b.gold.push(g);
    }
    b.dark.push(archPlate(openHalf - 0.3, 2.4, rise, frontDepth - 1.2, 9, 1.1).translate(0, 0, zFront));
    // R29 暗龛背衬：archPlate 由 9 段挤出，段缝与拱形边界之间会漏出背后的亮石，
    // 在近景读成"竖向梯子条纹"（verify/r29_final/hall_front.png 龛内实测）。
    // 这里补一块整幅近黑背板兜底（位于龛底，不与立面共面 ⇒ 无 z-fighting）。
    b.dark.push(box('dark', clearW + 1.6, clearH + 1.6, 1.2, 0, (clearH + 1.6) / 2, zFront - frontDepth + 0.8));
    // 门楣：金日轮/翼形饰（竖面金盘 + 放射金刺 + 双侧翼卷）
    // R29 定尺：随 frontW 比例放大后（88×0.5=44m）日轮在 32m 机位**撑满整个画面**
    // （verify/r29_check/hall_front.png），压掉全部立面信息。改为**绝对上限**：
    // 直径 ≤24m（= 0.27×frontW）、高 ≤11m —— 仍是立面主视觉，但留出两侧开间。
    // R30b（Phase 3 目检 + 量化）：24m 光板金盘在 hall_front 读作"占位符金币"
    // （画面金覆盖 16.3% vs 参考 11.8%）。压到 ≤14m（=0.16×frontW）+ 花瓣环（低配
    // 跳过）—— 让"放射花饰"的语汇回到参考图轨道，同时给立面留出呼吸感。
    const discW = Math.min(frontW * 0.5, 14);
    const discH = Math.min(frontH * 0.18, 7);
    const discY = clearH + discH * 0.55; // ≈30.5
    const sunDisc = new THREE.CylinderGeometry(discW / 2, discW / 2, 0.7, 24);
    sunDisc.rotateX(Math.PI / 2);
    sunDisc.translate(0, discY - discH * 0.3, zFront - 0.1);
    planarUV(sunDisc, TILE.gold);
    b.gold.push(sunDisc);
    if (!isLowDetail()) {
      // 花瓣环（8 瓣，全圆周切向小金板）—— 消解大金盘的"硬币感"
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        b.gold.push(
          boxRot('gold', 0.9, 0.42, 0.5, Math.cos(a) * (discW / 2 + 0.28), discY - discH * 0.3 + Math.sin(a) * (discW / 2 + 0.28), zFront - 0.16, a + Math.PI / 2)
        );
      }
    }
    for (let i = 0; i < 12; i += 1) {
      const a = Math.PI + (i / 11) * Math.PI; // 上半圆放射
      const spike = boxRot('gold', 1.1, 0.32, 0.7, Math.cos(a) * (discW / 2 + 0.6), discY - discH * 0.3 + Math.sin(a) * (discW / 2 + 0.6), zFront - 0.06, a + Math.PI / 2);
      b.gold.push(spike);
    }
    for (const side of [-1, 1] as const) {
      // 双侧翼卷（两段斜板）
      b.gold.push(boxRot('gold', 6.5, 0.5, 0.7, side * (discW / 2 + 2.2), discY + 3.2, zFront - 0.06, side * 0.5));
      b.gold.push(boxRot('gold', 4.5, 0.45, 0.7, side * (discW / 2 + 4.6), discY + 1.2, zFront - 0.06, side * 0.95));
      b.gold.push(spire('gold', 0.5, 0, 1.6, 6, side * (discW / 2 + 6.4), discY + 0.4, zFront - 0.06));
    }
    // 门龛两侧尖拱窗列（R29 横向拓展：按 frontW 分 4 开间/侧，铺满 88m 立面）
    for (const side of [-1, 1] as const) {
      const halfFront = frontW / 2;
      const bays = 4;
      const baySpan = (halfFront - (openHalf + 3.2)) / bays;
      for (let i = 0; i < bays; i += 1) {
        const wx = side * (openHalf + 3.2 + baySpan * (i + 0.62));
        // R30 换装花格窗（金框 + 双棂 + 拱肩光；原 lancetWindow 182 tri → 120 tri）
        pour(
          b,
          mapParts(
            traceryWindowZ({ halfW: 1.0, rise: 6.0, cusp: 0.8, frameOut: 0.5, plateBack: 0.32, mullions: 2, lights: true }),
            (g) => g.translate(wx, 6.5, zFront)
          )
        );
        // 每开间一根竖向金饰条（参考图的"金线拉高"语言）
        b.gold.push(box('gold', 0.42, frontH - 9, 0.18, wx + side * 2.1, (frontH - 9) / 2 + 4, zFront - 0.1));
        // 开间之间的壁柱（白石竖带，制造竖向节奏而不是一块平墙）
        if (i < bays - 1) {
          const px = side * (openHalf + 3.2 + baySpan * (i + 1));
          b.ashlar.push(box('ashlar', 1.5, frontH - 8, 0.9, px, (frontH - 8) / 2 + 3, zFront + 0.35));
        }
      }
    }
    for (let i = 0; i < 3; i += 1) {
      b.gold.push(box('gold', frontW + 0.6, 0.34, frontDepth + 0.4, 0, 14 + i * 12, zMidFront));
    }
    // 檐口 + 垛口
    b.ashlar.push(box('ashlar', frontW + 2.4, 1.4, frontDepth + 1.8, 0, frontH - 0.7, zMidFront));
    b.gold.push(box('gold', frontW + 2.6, 0.26, frontDepth + 2, 0, frontH + 0.15, zMidFront));
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
      b.gold.push(box('gold', frontW + 3.8, 0.16, frontDepth + 3.2, 0, frontH + 0.52, zMidFront));
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
      b.wall.push(box('wall', w, wingH, frontDepth, cx, wingH / 2, zMidFront));
      b.ashlar.push(box('ashlar', w + 0.8, 0.6, frontDepth + 0.8, cx, wingH + 0.3, zMidFront));
      b.gold.push(box('gold', w + 1, 0.24, frontDepth + 1, cx, wingH + 0.78, zMidFront));
      // 垛口 + 金齿饰
      const merlons = Math.floor(frontDepth / 2.4);
      for (let m = 0; m < merlons; m += 1) {
        const mz = zBack + 1 + (frontDepth * (m + 0.5)) / merlons;
        b.ashlar.push(box('ashlar', w, 1.2, frontDepth / merlons / 2, cx, wingH + 1.2, mz));
        b.gold.push(spire('gold', 0.2, 0, 0.38, 4, cx, wingH + 1.8, mz));
      }
      // 尖拱窗列（朝路心；R29 由 3 扇扩到 5 扇，跟上 frontDepth 30 的纵深）
      // R30 换装花格窗（金框 + 双棂 + 拱肩光）
      for (let i = 0; i < 5; i += 1) {
        const wz = zMidFront - 11 + i * 5.5;
        // 先镜像再平移（反序会让 −side 窗落到 −wz）
        pour(
          b,
          mapParts(
            traceryWindowX({ halfW: 0.9, rise: 5.6, cusp: 0.75, frameOut: 0.45, plateBack: 0.3, mullions: 2, lights: true }),
            (g) => {
              if (side < 0) g.rotateY(Math.PI);
              return g.translate(side * wingInner, 6, wz);
            }
          )
        );
      }
      // 竖向金饰条 ×2（翼墙外棱）
      for (const ox of [-1, 1] as const) {
        b.gold.push(box('gold', 0.32, wingH - 2, 0.16, side * (wingInner + (ox < 0 ? 0.5 : w - 0.5)), (wingH - 2) / 2 + 1, zMidFront + frontDepth / 2 - 0.2));
      }
    }
  }

  /* ── 后排主殿身（rearDepth 37，低于前排，侧视多层体量 2497fab5 相容）── */
  {
    const rearH = 30;
    b.ashlar.push(box('ashlar', facadeW - 6, 1, depth - frontDepth + 2, 0, 0.5, zBack + (depth - frontDepth) / 2));
    b.ashlar.push(box('ashlar', facadeW - 8, rearH, depth - frontDepth, 0, 1 + rearH / 2, zBack + (depth - frontDepth) / 2));
    b.ashlar.push(box('ashlar', facadeW - 6, 1.2, depth - frontDepth + 1.4, 0, 1 + rearH + 0.6, zBack + (depth - frontDepth) / 2));
    b.gold.push(box('gold', facadeW - 5, 0.24, depth - frontDepth + 1.6, 0, 1 + rearH + 1.4, zBack + (depth - frontDepth) / 2));
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
    // R30 换装花格窗（无拱肩光的 96 tri 版——后排属远景带，节流）
    for (let i = 0; i < 8; i += 1) {
      const wx = -facadeW * 0.36 + (i * facadeW * 0.72) / 7;
      pour(
        b,
        mapParts(
          traceryWindowZ({ halfW: 0.85, rise: 5.2, cusp: 0.7, frameOut: 0.45, plateBack: 0.3, mullions: 2 }),
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
    for (const side of [-1, 1] as const) {
      for (const wx of [13.5, 21.5, 29.5]) {
        const fb = flyingButtress({
          baseY: 2.7,
          springY: 12,
          topY: 78,
          reach: 7,
          depth: 1.4,
          band: 0.8,
          pierW: 2.6,
          pinnacle: true
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
    // ③ 大龛拱卷叶（金券最外挑面 zFront+0.65 ⇒ 坐在其外）
    pour(
      b,
      mapParts(
        crocketRun({ halfW: clearW / 2, rise: clearH - 2.4, count: 8, size: 0.4, cusp: 1.1 }),
        (g) => g.translate(0, 2.4, zFront + 0.65)
      )
    );
    // ④ 雕像龛 ×5（正立面开间起点 |x|=13、窗顶之上 y 40）+ 冠座前脸
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(statueNicheZ({ halfW: 0.8, rise: 3.0, cusp: 0.5 }), (g) => g.translate(side * 13, 40, zFront - 0.05))
      );
    }
    // 冠座（y 96..101、路侧面 z = zMidFront+4.5）前脸
    pour(
      b,
      mapParts(statueNicheZ({ halfW: 0.8, rise: 3.0, cusp: 0.5 }), (g) => g.translate(0, 97.5, zMidFront + 4.4))
    );
    // ⑤ 纹章顶饰（冠尖 130..132.4 之上）
    pour(b, mapParts(finialOrnament({ r: 0.7 }), (g) => g.translate(0, crownH + 2.6, zMidFront)));
    // ⑥ 翼墙顶连廊（翼墙顶 62 + 叠涩 0.6 + 金线 0.24 + 垛口 1.2 ≈ 64 ⇒ 楼面 64.8）
    for (const side of [-1, 1] as const) {
      pour(
        b,
        mapParts(corridorGallery({ len: frontDepth - 4, width: 56, floorY: 64.8 }), (g) =>
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
        const fb = flyingButtress({
          baseY: 2.7,
          springY: 34,
          topY: 62,
          reach: 9,
          depth: 1.5,
          band: 0.85,
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
    for (let i = 0; i < 6; i += 1) {
      const my = 16 + i * 11;
      for (const side of [-1, 1] as const) {
        const mx = side * (frontW / 2 - 16);
        const med = new THREE.CylinderGeometry(1.5, 1.5, 0.4, 16);
        med.rotateX(Math.PI / 2);
        med.translate(mx, my, zFront - 0.12);
        planarUV(med, TILE.gold);
        b.gold.push(med);
      }
    }
    // 大理石墙裙（marble 桶；主殿正立面基座带，贴面 z=zFront+0.08 不凸出撞击面；
    // R29 广场平整令仍在 —— 不放任何 y>0.02 的广场横穿体块，大理石只上墙面）
    extra(b, 'marble', box('marble', frontW + 2, 2.6, 0.16, 0, 1.3, zFront + 0.08));
    // A 线 ① 鎏金山花屏（主殿正立面中央金山花 reredos + 金十字；薄板双面 = 高效增金饰覆盖）
    pour(b, mapParts(gildedScreen({ w: 14, h: 20, cross: true }), (g) => g.rotateY(Math.PI / 2).translate(0, 12, zFront + 0.15)));
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
  const merlonPitch = 2.4;

  for (let k = 0; k < blocks; k += 1) {
    const zc = zNear - blockLen / 2 - k * blockLen; // 块中心
    // A 线 ⑦ 远区 LOD 减法：最远 1/3 街区（最深 z 区）置 DEEP_FAR —— 跳过卷叶 /
    // 子拱 / 窗棂 / 壁龛立像 / 瓶柱加密等纯装饰密度（几何长度不变，铁律 33）。
    const far = k >= blocks - Math.floor(blocks / 3);
    setDeepFar(far);
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
      b.ashlar.push(put(box('ashlar', depth, hallH, hallW, depth / 2, 0.6 + hallH / 2, 0))); // 殿身
      const wallTop = 0.6 + hallH; // 17.9
      const eaveY = wallTop + 0.5; // 18.4
      const ridgeY = wallTop + 1.5; // 19.4
      const run = depth / 2 + 0.6; // 4.6（半进深 + 出挑）
      const slopeLen = Math.hypot(run, ridgeY - eaveY); // 4.707
      const slopeAng = Math.atan2(ridgeY - eaveY, run); // 0.213
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
            traceryWindowX({ halfW: 0.9, rise: 6.2, cusp: 0.8, frameOut: 0.45, plateBack: 0.28, mullions: 2 }),
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
        for (let k = 0; k < 9; k += 1) {
          const pz = -hallW / 2 + 0.8 + (k * (hallW - 1.6)) / 8;
          b.ashlar.push(put(spire('ashlar', 0.34, 0, 1.9, 4, faceX - 0.2, wallTop + 0.2, pz, Math.PI / 4)));
        }
      }

      /* ── 塔（块左右四分位各一座，R29 节奏加密）：局部 z = ±blockLen/4 ── */
      const addTower = (tzC: number): void => {
        b.ashlar.push(put(box('ashlar', 9.4, 1.2, 9.4, depth / 2, 0.6, tzC))); // 塔基
        b.ashlar.push(put(box('ashlar', 8, 34.8, depth, depth / 2, 1.2 + 34.8 / 2, tzC))); // 塔身
        b.ashlar.push(put(box('ashlar', 9, 0.9, 9, depth / 2, 36.45, tzC))); // 檐口叠涩
        b.ashlar.push(put(spire('ashlar', 3.1, 0, 9.5, 8, depth / 2, 36.9, tzC, Math.PI / 8))); // 尖顶
        for (const wy of [8, 26]) {
          // R30 换装花格窗（塔身窗）
          pour(
            b,
            mapParts(
              traceryWindowX({ halfW: 0.75, rise: 5.6, cusp: 0.7, frameOut: 0.45, plateBack: 0.28, mullions: 2 }),
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
            traceryWindowX({ halfW: 0.8, rise: 5.4, cusp: 0.7, frameOut: 0.45, plateBack: 0.28, mullions: 2 }),
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
        // A 线 ③ 白色垂幔浮雕（draperyRelief）：连墙窗上悬挂白石材垂幔 + 金系带
        //     （远区经 DEEP_FAR 折页减半；仅在近/中区铺设，控制 tri）
        if (!far) {
          pour(b, mapParts(draperyRelief({ w: len - 2, h: 4.6, folds: 4 }), (g) => put(g.translate(0, 8.4, lz))));
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
          b.ashlar.push(put(box('ashlar', ctw + 1.2, 1.2, ctd + 1.2, ctw / 2, 0.6, ctz)));
          b.ashlar.push(put(box('ashlar', ctw, ctH - 1.2 - 2.6, ctd, ctw / 2, 1.2 + (ctH - 3.8) / 2, ctz)));
          b.ashlar.push(put(box('ashlar', ctw + 1.4, 0.8, ctd + 1.4, ctw / 2, ctH - 1.6, ctz)));
          b.ashlar.push(put(spire('ashlar', ctw * 0.62, 0, 6.5, 8, ctw / 2, ctH - 1.2, ctz, Math.PI / 8)));
          b.gold.push(put(box('gold', ctw + 1.6, 0.22, ctd + 1.6, ctw / 2, ctH - 0.75, ctz)));
          b.dark.push(put(box('dark', 0.6, 5.5, 1.6, -0.06, ctH * 0.4, ctz)));
          b.gold.push(put(box('gold', 0.3, ctH - 4, 0.16, -0.08, (ctH - 4) / 2 + 2, ctz + ctd / 2 - 0.3)));
          // 塔尖柱头环（castleDetail.capitalCollar：收分托石 + 金箍，坐在尖顶根部）
          pour(b, mapParts(capitalCollar({ r: ctw * 0.5, h: 0.5 }), (g) => put(g.translate(ctw / 2, ctH - 1.4, ctz))));
          // 檐口带（castleDetail.corniceBand：FBX Cornice_2 分层檐口，塔身中带上沿）
          pour(b, mapParts(corniceBand({ len: ctd + 1.6, proj: 0.55, h: 1.0 }), (g) => put(g.translate(0, ctH - 4.5, ctz))));
          pour(
            b,
            mapParts(
              traceryWindowX({ halfW: 0.6, rise: 4.4, cusp: 0.7, frameOut: 0.4, plateBack: 0.26, mullions: 2 }),
              (g) => put(g.translate(0, 8, ctz))
            )
          );
          pour(
            b,
            mapParts(statueNicheX({ halfW: 0.62, rise: 2.4, cusp: 0.5 }), (g) => put(g.translate(0, 16, ctz)))
          );
          if (finial) pour(b, mapParts(finialOrnament({ r: 0.5 }), (g) => put(g.translate(ctw / 2, ctH + 5.6, ctz))));
          // A 线 ① 卷叶尖塔（crockedSpire）顶冠：白石八棱鼓 + 锥顶 + 锥面金卷叶 + 金尖
          pour(b, mapParts(crookedSpire({ w: 1.7, h: 5.2 }), (g) => put(g.translate(ctw / 2, ctH + 1.8, ctz))));
          // A 线 ② 角塔飞扶壁（街面墩 → 塔身，内城塔群语汇拓展；pinnacle:false 控 tri）
          const cfb = flyingButtress({ baseY: 0, springY: 9, topY: 22, reach: 6, depth: 1.0, band: 0.5, pierW: 1.3, pinnacle: false });
          pour(b, mapParts(cfb, (g) => put(g.rotateY(Math.PI).translate(0, 0, ctz))));
        };
        cornerTower(-(blockLen / 2 - 0.5), k % 2 === 0);
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
        if (k % 2 === 0) {
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
        // R31 ① 墙顶敞廊（隔块；回廊柱列骑在 24m 墙顶 —— 街面透过前排建筑间隙可见）
        if (k % 2 === 0) {
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
          b.ashlar.push(put(spire('ashlar', 5.4, 0, th * 0.2, 8, r1x, th - th * 0.2 + 0.6, oz, Math.PI / 8)));
          // A 线 ① 卷叶尖塔（crockedSpire）顶冠：后排塔尖收口（远区经 DEEP_FAR 裁卷叶）
          pour(b, mapParts(crookedSpire({ w: 2.2, h: th * 0.18 }), (g) => put(g.translate(r1x, th - th * 0.1 + 0.6, oz))));
          // 窗缝只落在「前排塔尖(44.3)以上」的可见带里，别做被挡住的废 tri
          if (th > 52) {
            for (const f of [0.35, 0.7]) {
              b.dark.push(put(box('dark', 0.5, 4.4, 2.4, r1.xIn + 0.05, 44.3 + (th - 44.3) * f, oz)));
            }
          }
        }
        /* ── R31 ② 第二进院落带（x 28..44；apse 隔块 / 钟楼隔三块 / 中景体量）────── */
        {
          const cy = R31_COURTYARD;
          if (k % 2 === 0) {
            // 后殿半圆室（apse；开口朝街 −x，锥顶 roof 桶）
            pour(
              b,
              mapParts(
                apseDrum({ r: cy.apse.r, h: cy.apse.h, segs: 12, roofRise: cy.apse.h * 0.26 }),
                (g) => put(g.translate(cy.apse.x, 0, 0))
              )
            );
          } else if (k % 3 === 0) {
            // 钟楼（WCBell 语录；四坡顶 roof 桶）
            pour(
              b,
              mapParts(bellTower({ w: cy.bell.w, totalH: cy.bell.h }), (g) =>
                put(g.translate(cy.bell.x, 0, 0))
              )
            );
          } else {
            // 中景体量（30m 级，补齐院落带天际线不断档）+ 哥特开间（gothicBay 复用单元）
            b.wall.push(put(box('wall', cy.xOut - cy.xIn - 4, cy.midH, blockLen - 12, (cy.xIn + cy.xOut) / 2, cy.midH / 2, 0)));
            b.ashlar.push(put(box('ashlar', cy.xOut - cy.xIn - 3, 0.6, blockLen - 11, (cy.xIn + cy.xOut) / 2, cy.midH + 0.3, 0)));
            b.dark.push(put(box('dark', 0.5, 5, 2.4, cy.xIn + 0.05, cy.midH * 0.62, 0)));
            pour(
              b,
              mapParts(
                gothicBay({ w: 9, h: cy.midH - 2, winRise: 7.5, winBaseY: 6, pinnacle: true }),
                (g) => put(g.translate(cy.xIn + 1.2, 0, 0))
              )
            );
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
          b.ashlar.push(put(spire('ashlar', 6.5, 0, 15, 8, r2x, r2.towerH + 1.2, oz, Math.PI / 8)));
          b.dark.push(put(box('dark', 0.5, 5, 3, r2.xIn + 0.05, r2.towerH * 0.8, oz)));
        }
        /* ── R30/R31 第三排中央高塔（块心、第三排位；R31 外移 + 84 → 88）──────── */
        const rc = R30_REAR_CORE;
        const rcTop = rc.h - 1.4 - 12;
        b.ashlar.push(put(box('ashlar', rc.w + 1.6, 1.4, rc.w + 1.6, r2x, 0.7, 0)));
        b.ashlar.push(put(box('ashlar', rc.w, rcTop, rc.w, r2x, 1.4 + rcTop / 2, 0)));
        b.ashlar.push(put(box('ashlar', rc.w + 1.8, 1.0, rc.w + 1.8, r2x, rc.h - 12.4, 0)));
        b.ashlar.push(put(spire('ashlar', rc.w * 0.5, 0, 12, 8, r2x, rc.h - 12, 0, Math.PI / 8)));
        b.gold.push(put(box('gold', rc.w + 2, 0.24, rc.w + 2, r2x, rc.h - 11.8, 0)));
        b.dark.push(put(box('dark', 0.7, 6, 2.0, r2.xIn + 0.05, rc.h * 0.55, 0)));
        pour(
          b,
          mapParts(
            traceryWindowX({ halfW: 0.62, rise: 4.6, cusp: 0.7, frameOut: 0.4, plateBack: 0.26, mullions: 2 }),
            (g) => put(g.translate(0, 26, 0))
          )
        );
        if (k % 2 === 0) {
          pour(
            b,
            mapParts(statueNicheX({ halfW: 0.62, rise: 2.6, cusp: 0.5 }), (g) => put(g.translate(0, 40, 0)))
          );
        }
        // A 线 ① 卷叶尖塔（crockedSpire）顶冠：内城中央高塔收口
        pour(b, mapParts(crookedSpire({ w: 3.4, h: 9 }), (g) => put(g.translate(r2x, rc.h - 6, 0))));
        /* ── R30/R31 第四排远景体量（隔块；R31 外移 43..58 → 63..78）────────────── */
        if (k % 2 === 0) {
          const r4x = (R31_ROW4.xIn + R31_ROW4.xOut) / 2;
          const r4w = R31_ROW4.xOut - R31_ROW4.xIn;
          b.wall.push(put(box('wall', r4w, R31_ROW4.wallH, blockLen, r4x, R31_ROW4.wallH / 2, 0)));
          for (const oz of [-14, 14]) {
            b.ashlar.push(put(box('ashlar', r4w, R31_ROW4.towerH, 16, r4x, R31_ROW4.towerH / 2, oz)));
            b.ashlar.push(put(box('ashlar', r4w + 2, 1.2, 18, r4x, R31_ROW4.towerH + 0.6, oz)));
            b.ashlar.push(put(spire('ashlar', 6.5, 0, 14, 8, r4x, R31_ROW4.towerH + 1.2, oz, Math.PI / 8)));
            b.dark.push(put(box('dark', 0.6, 6, 2.4, R31_ROW4.xIn + 0.05, 60, oz)));
          }
        }
      }

      /* ── 火盆 ×2（连墙墙根，探出街面 0.7）── */
      for (const bz of [-blockLen / 2 + 2, 8]) {
        b.ashlar.push(put(box('ashlar', 0.9, 0.8, 0.9, -0.7, 0.4, bz)));
        b.gold.push(put(spire('gold', 0.26, 0.42, 0.9, 8, -0.7, 0.8, bz)));
        b.flame.push(put(flame(0.3, 0.5, -0.7, 1.7, bz)));
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
        b.ashlar.push(spire('ashlar', 9, 0, 16, 6, side * (s.xIn + span * 0.72), hOut, z - 12));
        b.gold.push(spire('gold', 0.5, 0, 2.4, 6, side * (s.xIn + span * 0.72), hOut + 15.8, z - 12));
      }
    }
  }

  /* ── R30 ③ 跨街封闭拱顶连廊 ×3（连廊 · 跨路连接两侧）────────────────────────
   * z = 块心 k=3/8/13（确定性，避开门洞带 z∈[−372,−345] 与广场带 [−1285.5,−1300]）；
   * 跨度 21m（|x|≤10.5）正好搭到两侧街面拱廊屋顶外棱（|x|≈10.6）。
   * 楼面 12m + 胸墙 2m + 筒拱 1.7m ⇒ 全部几何 y ≥ 11.75 > 走廊上沿 4.5m
   * （r29_corridor_probe 判据：车从拱顶廊下穿过不侵廊）。 */
  for (const cz of R30_CROSSINGS) {
    pour(b, mapParts(corridorCrossing({ span: 21, width: 4.4, floorY: 12, rise: 1.7 }), (g) => g.translate(0, 0, cz)));
  }
  return b;
}
