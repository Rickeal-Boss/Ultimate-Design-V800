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
import { GATE, INNER, LAMP, PARAPET, ROAD_W, VIADUCT } from './r27Layout';

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

/* ═══════════════════ 基础几何 ═══════════════════ */

/**
 * 米制平面 UV：按顶点法线主轴挑投影平面。
 * 用局部**位置**而非 0..1 参数化，是为了让相邻构件的砌缝在世界里连续；
 * 硬切换的接缝落在 90° 棱上（石构件的棱本来就有硬阴影），看不出来。
 */
function planarUV(geo: THREE.BufferGeometry, tile: number): void {
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

/** 轴对齐方块（12 tri）。中心点 + 三边尺寸。 */
function box(
  kind: CastleKind,
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  planarUV(g, TILE[kind]);
  return g;
}

/** 绕 z 轴旋转的方块（双坡屋顶 / 辐射金刺）。12 tri。 */
function boxRot(
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
function spire(
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
function pierColumn(
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

function pointedArch(
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
 * 反解**内圈** rise：使券线**外缘拱冠恰好落在 crownY**（御桥三排券对齐铺装面/层间线用）。
 *
 * 双心尖拱的解析性质：内圈 (halfW, R) 的外圈 = (halfW+band, R+band)（同一组圆心、
 * 半径 +band —— 这才是等厚券线）。外圈拱冠（未提尖）高度
 *   apex_o = √((halfW+band)·(2R + band − halfW))
 * 令 apex_o = crownY − cusp − springY ≡ A，可解
 *   R = (A²/(halfW+band) − band + halfW) / 2，rise = √(2R·halfW − halfW²)
 * （旧代码直接令 rise = crownY − band − cusp − springY，把外冠算高 0.15~0.33m，
 *  spandrel 的拱边界会穿过 topY 自交，铺装面上会冒出一道拱冠。）
 */
function riseForCrown(
  halfW: number,
  band: number,
  springY: number,
  crownY: number,
  cusp: number
): number {
  const A = crownY - cusp - springY;
  const R = (A * A / (halfW + band) - band + halfW) / 2;
  return Math.sqrt(Math.max(0, 2 * R * halfW - halfW * halfW));
}

/** ExtrudeGeometry 收尾：补法线 + 米制 UV（尖拱件共用） */
function finishArch(g: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
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
function archBand(
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
function archPlate(
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

/** 实心尖拱板 · x 向居中挤出版（尖拱窗背板用）。 */
function archPlateX(
  halfW: number,
  springY: number,
  rise: number,
  depth: number,
  segPerHalf = 6,
  cusp = 0
): THREE.BufferGeometry {
  const g = archPlate(halfW, springY, rise, depth, segPerHalf, cusp);
  g.rotateY(Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  return g;
}

/* ═══════════════════ ① 御桥：拱 + 墩 + 夯土墙 ═══════════════════ */

/**
 * 御桥结构（24 跨，静态全进 ashlar 桶）。
 *
 * 横断面（x > 0 侧，桥面 y=0）：
 *   |x| ≤ 7.4   车行带（深色铺装，归 makePaving）
 *   7.8..16.6   步道（白色铺装，归 makePaving）
 *   中央区 x∈[−7.8,7.8]：主券（spring −7.85 / band 1.6）+ 拱上夯土墙（spandrel）
 *   侧区 x∈[7.6,16.6]：一层券廊（spring −5.0）+ 二层券廊（spring −12.9）+ 各自 spandrel
 *   墩位（z 站）：侧区 4 束柱（床面 −59.5 → −5.0）+ 墩头方块；中央区 4 束柱（→ −7.85）+ 墩头
 *
 * 「开间」读法：每跨一个通高开口被一层券（上）/ 二层券（中）两层券廊分格，
 * 中间以 spandrel 隔断 ⇒ 参考图 2497fab5 的双层尖拱廊读法。
 * 拱顶一律比铺装面低一个 band 厚（外冠恰好落在 y=0），铺装 12~14mm 贴上不 z-fight。
 */
export function makeViaduct(): StoneBuckets {
  const b = emptyBuckets();
  const span = (VIADUCT.zNear - VIADUCT.zFar) / VIADUCT.spans; // 17.4375
  const half = span / 2; // 8.71875
  const bedY = -VIADUCT.gorgeDepth + 0.5; // 墩脚埋在谷底之上 0.5m

  /* ── 三排券的几何参数（外冠一律 riseForCrown 反解，精确落在目标线上）── */
  // 中央主券：外冠 y=0（铺装面）
  const mainBand = 1.6;
  const mainCusp = 0.9;
  const mainSpring = -VIADUCT.archRise; // −7.85
  const mainRise = riseForCrown(half, mainBand, mainSpring, 0, mainCusp); // 5.184
  const mainDepth = 2 * (7.4 + 0.4); // 15.6（略宽于车行带）
  // 侧区一层券：外冠 y=0（铺装面）
  const t1Band = 0.9;
  const t1Cusp = 0.7;
  const t1Spring = -5.0;
  const t1Rise = riseForCrown(half, t1Band, t1Spring, 0, t1Cusp); // 2.985
  // 侧区二层券：外冠 y=−5.0（= 一层券 spring，层间咬合）
  const t2Band = 0.9;
  const t2Cusp = 1.0;
  const t2Spring = -VIADUCT.secondTierDrop; // −12.9
  const t2Rise = riseForCrown(half, t2Band, t2Spring, t1Spring, t2Cusp); // 5.942
  // 侧区 x 范围（步道下方整幅）
  const sideIn = 7.6;
  const sideOut = VIADUCT.totalHalf - 0.12; // 16.6
  const sideDepth = sideOut - sideIn; // 9.0
  const sideMid = (sideIn + sideOut) / 2; // 12.1（侧墩束中心）
  const cuspW = 0.45;

  for (let k = 0; k < VIADUCT.spans; k += 1) {
    const zc = VIADUCT.zNear - (k + 0.5) * span; // 开间中心
    // 中央主券 + 拱上夯土墙（spandrel 坐在券线**外缘**上 → 铺装面）
    const mainBandGeo = archBandX(half, mainSpring, mainRise, mainBand, mainDepth, 9, mainCusp, cuspW);
    mainBandGeo.translate(0, 0, zc);
    b.ashlar.push(mainBandGeo);
    const mainSpandrel = archWallOuterX(half, mainSpring, 0, mainRise, mainBand, mainDepth, 9, mainCusp, cuspW);
    mainSpandrel.translate(0, 0, zc);
    b.ashlar.push(mainSpandrel);
    for (const side of [-1, 1] as const) {
      // 一层券 + spandrel（外缘 → y=0）
      const t1 = archBandX(half, t1Spring, t1Rise, t1Band, sideDepth, 9, t1Cusp, cuspW);
      t1.translate(side * sideMid, 0, zc);
      b.ashlar.push(t1);
      const s1 = archWallOuterX(half, t1Spring, 0, t1Rise, t1Band, sideDepth, 9, t1Cusp, cuspW);
      s1.translate(side * sideMid, 0, zc);
      b.ashlar.push(s1);
      // 二层券 + spandrel（外缘 → 一层券 spring −5.0）
      const t2 = archBandX(half, t2Spring, t2Rise, t2Band, sideDepth, 9, t2Cusp, cuspW);
      t2.translate(side * sideMid, 0, zc);
      b.ashlar.push(t2);
      const s2 = archWallOuterX(half, t2Spring, t1Spring, t2Rise, t2Band, sideDepth, 9, t2Cusp, cuspW);
      s2.translate(side * sideMid, 0, zc);
      b.ashlar.push(s2);
    }
  }

  /* ── 墩（束柱 + 墩头）：25 个站（k=0..spans），z 从 zNear 到 zFar ── */
  const colW = (VIADUCT.pierW - 3 * 0.12) / VIADUCT.pierColumns; // 1.0875
  const taper = VIADUCT.pierTaper; // 0.93
  // 末站（k=spans，z=−358.5）落在城门进深里：中央束柱+墩头会捅进门洞隧道
  // （车从 −351.5 穿到 −365.5，|x|≤1.8 的柱群正在路中间）⇒ 中央墩整站不建。
  const lastStation = VIADUCT.zFar;
  for (let k = 0; k <= VIADUCT.spans; k += 1) {
    const zs = VIADUCT.zNear - k * span;
    const inGate = Math.abs(zs - lastStation) < 1e-6;
    for (let c = 0; c < VIADUCT.pierColumns; c += 1) {
      const off = (c - (VIADUCT.pierColumns - 1) / 2) * (colW + 0.12);
      // 侧墩：床面 bedY → 二层券 spring（−12.9）。pierColumn 的 cy 是**底部**、
      // 高 = top − bottom（曾把符号写反成 −spring−bedY = 72.4m，束柱捅到桥面上方
      // 12.9m，车视位整条路心被白色柱墙堵死 —— r27_env_final 首拍实证）。
      b.ashlar.push(pierColumn(colW, colW * taper, t2Spring - bedY, sideMid + off, bedY, zs));
      b.ashlar.push(pierColumn(colW, colW * taper, t2Spring - bedY, -(sideMid + off), bedY, zs));
      // 中央墩：床面 → 主券 spring（−7.85）；末站让位门洞
      if (!inGate) b.ashlar.push(pierColumn(colW, colW * taper, mainSpring - bedY, off, bedY, zs));
    }
    // 墩头：把站位的券口封成"实心弓"——侧区从最低起拱 −12.9 一直到铺装面
    // （两层券的 spring 都在墩头里，可见开口从墩头面起算，不会出现悬空券端）
    b.ashlar.push(box('ashlar', sideDepth, -t2Spring, 2.2, sideMid, t2Spring / 2, zs));
    b.ashlar.push(box('ashlar', sideDepth, -t2Spring, 2.2, -sideMid, t2Spring / 2, zs));
    if (!inGate) b.ashlar.push(box('ashlar', mainDepth, -mainSpring, 2.2, 0, mainSpring / 2, zs));
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
 *   road：|x| ≤ 7.4，z ∈ [260, −1400]（起步点后方 → 路障外 100m）
 *   walk：桥上段 |x| ∈ [7.8, 16.6]（z ∈ [60, 城门脸]）；城内段 |x| ∈ [7.8, 15.4]
 *        （城门隧道内 7.8..10 是隧道地面，10..15.4 埋进门墩，城外无步道）
 */
export function makePaving(): PavingKit {
  const roadParts: THREE.BufferGeometry[] = [];
  const walkParts: THREE.BufferGeometry[] = [];
  const paveTile = STONE_TILE_METERS.floor * 2; // 9.6m/张 ⇒ 石板缝 ≈2.4m
  const walkTile = STONE_TILE_METERS.ashlar; // 2.8m/张
  const roadNear = 260;
  const roadFar = -1400;
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
 * 火盆灯柱：节拍 44m 双侧，x = ±(totalHalf − inset)。全高 7.5m：
 * 3 级墩座 → 束柱柱身 → 金焰火盆（碗形向下收口）→ 尖焰（上尖下宽，不是球）。
 * 石件进 ashlar、火盆进 gold、火焰进 flame（MeshBasic）。
 */
export function makeLamps(): StoneBuckets {
  const b = emptyBuckets();
  const x = VIADUCT.totalHalf - LAMP.inset; // 16.17
  const zNear = VIADUCT.zNear - 22; // 38
  const zFar = GATE.z + GATE.depth / 2; // −351.5（城门内不立灯）
  const { h, poleW, braizerH, flameH } = LAMP;
  const braizerY = h - braizerH - flameH; // 5.05

  for (let z = zNear; z > zFar; z -= LAMP.pitch) {
    for (const side of [-1, 1] as const) {
      const cx = side * x;
      // 3 级墩座
      b.ashlar.push(box('ashlar', 1.0, 0.35, 1.0, cx, 0.175, z));
      b.ashlar.push(box('ashlar', 0.7, 0.55, 0.7, cx, 0.625, z));
      b.ashlar.push(box('ashlar', 0.85, 0.3, 0.85, cx, 1.05, z));
      // 束柱柱身（3 根细方柱成一束：参考图 2a302891 实证为束柱非单柱；收分）
      for (const ox of [-0.13, 0, 0.13]) {
        b.ashlar.push(pierColumn(poleW * 0.42, poleW * 0.42 * 0.8, braizerY - 1.2, cx + ox, 1.2, z));
      }
      // 柱身金饰环 ×2（参考图：灯柱柱身有金色几何装饰带）
      for (const rf of [0.35, 0.68]) {
        b.gold.push(spire('gold', 0.3, 0.27, 0.09, 10, cx, 1.2 + (braizerY - 1.2) * rf, z));
      }
      // 金焰火盆（碗形：上口小、底部大）
      b.gold.push(spire('gold', 0.32, 0.55, braizerH, 10, cx, braizerY, z));
      // 火盆口沿金圈
      b.gold.push(spire('gold', 0.4, 0.4, 0.12, 10, cx, braizerY + braizerH, z));
      // 尖焰
      b.flame.push(flame(0.4, flameH, cx, braizerY + braizerH, z));
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
    // 塔面尖拱窗 ×2（券框 ashlar + 背板 dark；塔脸朝 +z ⇒ 用 Z 向窗）
    for (const wy of [12, 27]) {
      const win = lancetWindowZ(1.2, 7.5, 0.3, 1.0, 0.5, 0.3);
      win.frame.translate(cx, wy, zFront);
      b.ashlar.push(win.frame);
      win.plate.translate(cx, wy, zFront);
      b.dark.push(win.plate);
    }
    // 塔面竖向金线 ×2
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.35, towerH - 1, 0.16, cx + ox * (towerW / 2 - 0.35), (towerH - 1) / 2 + 0.5, zFront - 0.08));
    }
    // 角小尖塔 ×4（前两后两）
    for (const ox of [-1, 1] as const) {
      for (const oz of [-1, 1] as const) {
        const px = cx + ox * (towerW / 2 - 0.7);
        const pz = zMid + oz * (halfD - 0.9);
        b.ashlar.push(box('ashlar', 1.1, 2.2, 1.1, px, towerH + 1.1, pz));
        b.ashlar.push(spire('ashlar', 0.55, 0, 3.2, 8, px, towerH + 2.2, pz, Math.PI / 8));
      }
    }
    // 尖塔棱线金丝
    for (const ox of [-1, 1] as const) {
      b.gold.push(box('gold', 0.1, 3.0, 0.1, cx + ox * (towerW / 2 - 0.7), towerH + 3.5, zFront - 1.5));
    }
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

  // ── 金饰圆盘（拱上正中）：金盘 + 8 根辐射金刺 + 前置小金盘
  const discY = 33.5;
  b.gold.push(spire('gold', 2.8, 2.8, 0.7, 16, 0, discY, zFront - 0.35));
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const spike = boxRot('gold', 1.0, 0.3, 0.7, Math.cos(a) * 3.1, discY + Math.sin(a) * 3.1, zFront - 0.3, a + Math.PI / 2);
    b.gold.push(spike);
  }
  b.gold.push(spire('gold', 1.8, 1.8, 0.5, 16, 0, discY, zFront - 0.05));

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
  return b;
}

/**
 * 尖拱窗单元 · **±x 朝向墙**（城内建筑前脸用）：拱宽沿 z、厚度沿 x。
 * 局部约定：墙面在 x=0、墙体向 +x 延伸；券框外挑到 x ∈ [−frameOut, 0]（朝街面），
 * 背板嵌进墙体 x ∈ [0, plateBack]。窗台随框一起外挑。
 */
function lancetWindowX(
  halfW: number,
  rise: number,
  band: number,
  cusp: number,
  frameOut: number,
  plateBack: number
): { frame: THREE.BufferGeometry; plate: THREE.BufferGeometry } {
  const frame = archBandX(halfW, 0, rise, band, frameOut, 7, cusp, 0.45); // x ∈ [−f/2, f/2]
  frame.translate(-frameOut / 2, 0, 0); // x ∈ [−frameOut, 0]
  const sill = box('ashlar', frameOut + 0.2, 0.3, 2 * (halfW + band) + 0.3, -frameOut / 2, 0.15, 0);
  const plate = archPlateX(halfW - band * 0.6, 0, rise, plateBack, 7, cusp); // x ∈ [−p/2, p/2]
  plate.translate(plateBack / 2, 0, 0); // x ∈ [0, plateBack]
  return { frame: mergeSafe([frame, sill]), plate };
}

/**
 * 尖拱窗单元 · **±z 朝向墙**（城门塔楼前脸用）：拱宽沿 x、厚度沿 z。
 * 局部约定：墙面在 z=0、墙体向 −z 延伸；券框外挑到 z ∈ [0, frameOut]（朝来车），
 * 背板嵌进墙体 z ∈ [−plateBack, 0]。
 */
function lancetWindowZ(
  halfW: number,
  rise: number,
  band: number,
  cusp: number,
  frameOut: number,
  plateBack: number
): { frame: THREE.BufferGeometry; plate: THREE.BufferGeometry } {
  const frame = archBand(halfW, 0, rise, band, frameOut, 7, cusp, 0.45); // z ∈ [−f, 0]
  frame.rotateY(Math.PI); // z ∈ [0, frameOut]
  const sill = box('ashlar', 2 * (halfW + band) + 0.3, 0.3, frameOut + 0.2, 0, 0.15, frameOut / 2);
  const plate = archPlate(halfW - band * 0.6, 0, rise, plateBack, 6, cusp); // z ∈ [−p, 0]
  return { frame: mergeSafe([frame, sill]), plate };
}

/* ═══════════════════ ⑥ 城内大街 ═══════════════════ */

/**
 * 城内大街：过门后 z ∈ [−365.5, −1350]，街侧建筑前脸 |x| = faceHalf = 15.5，
 * 进深 8（插进崖体消除缝）。每 46m 一个街区，每街区每侧：
 *   殿（块中央，12.5×17.9×8，双坡顶 + 金十字 + 3 尖拱窗）
 *   塔（块左四分位，8 宽 × 36 高 + 9.5 尖顶，3 尖拱窗）
 *   三段连墙（带叠涩 + 垛口，B 段开一窗）
 *   火盆 ×2
 * 尖拱窗尺寸按 TOWER.windowW/H 的比例层放大（1.068×7.039 是 1:1 人体尺度，
 * 直接搬到 17.9m 的殿上会小得读不出；这里按建筑尺度等比放到 ~1.8×7）。
 */
/**
 * 城内大街：过门后 z ∈ [−365.5, −1350]，街侧建筑前脸 |x| = faceHalf = 15.5，
 * 进深 8（插进崖体消除缝）。每 46m 一个街区，每街区每侧：
 *   殿（块中央，沿街宽 12.5 × 墙高 17.3 × 进深 8，双坡顶 + 金十字 + 3 尖拱窗）
 *   塔（块左四分位，8 宽 × 36 高 + 9.5 尖顶，3 尖拱窗）
 *   三段连墙（带叠涩 + 垛口，B 段开一窗）
 *   火盆 ×2
 *
 * ── 局部坐标配方（本函数一切形体先按局部建，再一次性贴到世界）──────────────
 * 局部：前脸在 x=0、墙体向 +x 延伸、z 以块心为 0。世界化只有一步：
 *   side=+1（左侧楼，世界 x = +faceHalf + 局部 x）直接 translate(+faceHalf, 0, zc)；
 *   side=−1（右侧楼，世界 x = −faceHalf − 局部 x）先 rotateY(π) 再 translate(−faceHalf, 0, zc)。
 * rotateY(π) 同时翻转 x 与 z —— 本函数所有形体都对块心 z 对称（窗 ±4.2/0、
 * 屋顶居中、金线 ±4.6），镜像后集合不变；rotZ 的坡向符号也随镜像自动翻正。
 * 注意：lancetWindowX 的券框朝 −x 外挑，左右两侧因此都恰好朝街面。
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
    for (const side of [-1, 1] as const) {
      /** 局部 → 世界（见上方配方）：side=+1 直达，side=−1 过 rotateY(π) 镜像 */
      const put = <T extends THREE.BufferGeometry>(g: T): T => {
        if (side < 0) g.rotateY(Math.PI);
        g.translate(side * faceHalf, 0, zc);
        return g;
      };

      /* ── 殿（块中央）：沿街宽 12.5，墙高 17.3 ── */
      const hallW = 12.5;
      const hallH = 17.3;
      b.ashlar.push(put(box('ashlar', depth + 0.8, 0.6, hallW + 1.4, depth / 2 + 0.4, 0.3, 0))); // 台基
      b.ashlar.push(put(box('ashlar', depth, hallH, hallW, depth / 2, 0.6 + hallH / 2, 0))); // 殿身
      const wallTop = 0.6 + hallH; // 17.9
      const eaveY = wallTop + 0.5; // 18.4
      const ridgeY = wallTop + 1.5; // 19.4
      const run = depth / 2 + 0.6; // 4.6（半进深 + 出挑）
      const slopeLen = Math.hypot(run, ridgeY - eaveY); // 4.707
      const slopeAng = Math.atan2(ridgeY - eaveY, run); // 0.213
      for (const rs of [-1, 1] as const) {
        // rs=−1：檐口朝街面（局部 x 0 端）下倾；rs=+1：檐口朝背侧下倾
        const lx = rs < 0 ? (depth / 2 - run) / 2 : (depth / 2 + run) / 2;
        b.ashlar.push(put(boxRot('ashlar', slopeLen, 0.5, hallW + 1.2, lx, (eaveY + ridgeY) / 2, 0, -rs * slopeAng)));
      }
      b.ashlar.push(put(box('ashlar', 0.7, 0.5, hallW + 1.2, depth / 2, ridgeY + 0.25, 0))); // 屋脊
      b.gold.push(put(box('gold', 0.28, 2.4, 0.28, depth / 2, ridgeY + 1.7, 0))); // 金十字竖
      b.gold.push(put(box('gold', 1.4, 0.28, 0.28, depth / 2, ridgeY + 2.3, 0))); // 金十字横
      for (const wz of [-4.2, 0, 4.2]) {
        const win = lancetWindowX(0.9, 6.2, 0.28, 0.8, 0.45, 0.28);
        win.frame.translate(0, 8.5, wz);
        win.plate.translate(0, 8.5, wz);
        b.ashlar.push(put(win.frame));
        b.dark.push(put(win.plate));
      }
      for (const sz of [-4.6, 4.6]) {
        b.gold.push(put(box('gold', 0.3, 17, 0.16, -0.08, 9.5, sz)));
      }

      /* ── 塔（块左四分位）：局部 z = −blockLen/4 ── */
      const tz = -blockLen / 4;
      b.ashlar.push(put(box('ashlar', 9.4, 1.2, 9.4, depth / 2, 0.6, tz))); // 塔基
      b.ashlar.push(put(box('ashlar', 8, 34.8, depth, depth / 2, 1.2 + 34.8 / 2, tz))); // 塔身
      b.ashlar.push(put(box('ashlar', 9, 0.9, 9, depth / 2, 36.45, tz))); // 檐口叠涩
      b.ashlar.push(put(spire('ashlar', 3.1, 0, 9.5, 8, depth / 2, 36.9, tz, Math.PI / 8))); // 尖顶
      for (const wy of [8, 17, 26]) {
        const win = lancetWindowX(0.75, 5.6, 0.26, 0.7, 0.45, 0.28);
        win.frame.translate(0, wy, tz);
        win.plate.translate(0, wy, tz);
        b.ashlar.push(put(win.frame));
        b.dark.push(put(win.plate));
      }
      for (const sz of [-3.2, 3.2]) {
        b.gold.push(put(box('gold', 0.3, 34, 0.16, -0.08, 18, tz + sz)));
      }

      /* ── 三段连墙（塔→殿 / 殿→块尾 / 块首→塔）── */
      const links: readonly (readonly [number, number])[] = [
        [-blockLen / 2, tz - 4.7], // 块首 → 塔背
        [tz + 4.7, -hallW / 2], // 塔前 → 殿背
        [hallW / 2, blockLen / 2] // 殿前 → 块尾
      ];
      for (let li = 0; li < links.length; li += 1) {
        const [za, zb] = links[li];
        const len = zb - za;
        if (len <= 0.5) continue;
        const lz = (za + zb) / 2;
        b.wall.push(put(box('wall', depth, 9, len, depth / 2, 4.5, lz)));
        b.ashlar.push(put(box('ashlar', depth + 0.6, 0.5, len + 0.6, depth / 2, 9.25, lz))); // 顶叠涩
        const merlons = Math.max(1, Math.floor(len / merlonPitch));
        for (let m = 0; m < merlons; m += 1) {
          const mz = za + (len * (m + 0.5)) / merlons;
          b.ashlar.push(put(box('ashlar', depth, 1.1, 0.8, depth / 2, 10.05, mz)));
          b.ashlar.push(put(spire('ashlar', 0.34, 0, 0.5, 4, depth / 2, 10.6, mz)));
        }
        // B 段（殿前连墙）开一窗：窗高 5.4+cusp 0.7 ⇒ 基座 1.8、顶 7.9，不出墙顶
        if (li === 2) {
          const win = lancetWindowX(0.8, 5.4, 0.26, 0.7, 0.45, 0.28);
          win.frame.translate(0, 1.8, lz);
          win.plate.translate(0, 1.8, lz);
          b.ashlar.push(put(win.frame));
          b.dark.push(put(win.plate));
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
  return b;
}
