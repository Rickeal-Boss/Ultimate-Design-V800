/**
 * R36-C1 · 前轮拱内衬（arch liner，手写件）。
 *
 * 病灶（外部审查定罪）：前轮拱内顶部「橙褐色块」两轮残留。消去法（#hidemat 对照）
 * 与静态排查（winding 43 面法线一致 / 轮胎半径余量 70mm 无穿模）指向**拱内面材质
 * 归属**：拱内顶面随 body-lower（paint）走暖色反光/图集残留，在阴影腔里读成橙褐
 * 补丁。轮拱语义应为「哑光黑护板」（spec 材质名即「哑光黑（格栅/护板/轮拱）」）。
 *
 * 修法：在拱腔内顶补一层哑光黑衬板（部分圆柱壳，r 0.415–0.437 落在轮胎 0.382 与
 * 拱 0.452 之间的 70mm 余量带），覆盖拱顶 100° 弧段、轴向只铺可视近侧 —— 无论
 * 拱内面是反光/串色/漏色都被衬板遮住，同时给轮拱正确的暗腔读法。
 *
 * 材质：matte-black 语义（纯色无图，双面防掠射剔除）。局部系：轮心原点，
 * 轴向沿世界 x（映射由调用方 rotateY(π/2) 后平移到轮心）。
 * 单侧 ≈ 220 tri（8 段 × 2 环 × 2 面 + 端环）。
 *
 * R143-C（R7 轮拱内衬覆盖率）：`ARCH_LINER` 常量是 **V800/R7 共用默认**（V800
 * 前拱只 fl/fr、R7 四角全铺）。R7 需更高覆盖率（后拱透舱内 cognac 皮革），
 * 但 **不得改 ARCH_LINER 默认**——那会同时改 V800（参考基准车，已过审）并打碎
 * `r65_archliner_hoodcam` 护栏（钉 spanDeg=210/centerDeg=95）。故加可选 override
 * 分支：V800 调 `createWheelArchLiner(c.side)` 走默认（逐位不变），R7 调
 * `createWheelArchLiner(c.side, { spanDeg:270, centerDeg:90, width:0.40 })` 走 R143 覆盖。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

export const WHEEL_ARCH_LINER_MATERIAL_ID = 'r22-arch-liner';

/** R143-C · 单调用方覆盖项（缺省回落 ARCH_LINER 常量，保持向后兼容）。 */
export interface ArchLinerOverride {
  /** 拱顶弧段（度，绕轮轴，90°=拱顶）。R143：R7 210→270（封下部斜下象限）。 */
  spanDeg?: number;
  /** 弧段中心角（度，90=拱顶对称）。R143：R7 95→90（弧心对齐正上）。 */
  centerDeg?: number;
  /** 轴向宽度。R143：R7 0.335→0.40（贴拱腔宽、向舱内收 65mm 封侧隙）。 */
  width?: number;
  /** 弧段数。缺省 10（R143 不升——哑光黑在阴影腔，27°/段弦高 11mm 不读面）。 */
  segs?: number;
  /**
   * R143-C2/C4 · 轮内侧内挡板圆盘半径（0/缺省=不加）。Phase3 打回：270°/90°/0.40
   * 挡下拱但后轮拱**上右橙斑 persist**（经拱口内缘/轮辐外侧隙漏舱内 cognac）。
   * R143-C2 置外板缘平面（radius 0.415）**无效**（罩轮外、够不到 0.449+ 环带）。
   * R143-C4 改**内板缘平面**（藏胎后）+ 半径 0.485（盖 rOut0.449–拱缘0.49 环带）。
   * 半径约束：> 轮胎 0.383、< 拱缘实测 ≈0.49（留 5mm）。
   * ⚠ R143-C2 终验：该圆盘在 x=0.528（内板缘）被**轮胎角径完全遮蔽**（盘角径
   * ≈16.8° < 轮胎 ≈20.6°）⇒ 消去法 A/B 逐字节不变。判为无效，改由 R143-C4
   * 内板缘面 + 0.485 半径封漏（见 buildArchLinerBaffle 头注）。
   */
  baffleRadius?: number;
  /** R143-C3 · 内衬内半径 override（R7 专用）。默认 ARCH_LINER.rIn=0.415。
   *  Phase3 打回：0.415 与轮胎 0.38 之间留 35mm 径向隙 ⇒ 上右斜视穿舱。压到
   *  0.383（胎外 3mm）封此隙。约束 > 轮胎 0.38、< rOut。 */
  rIn?: number;
  /** R143-C3 · 内衬外半径 override（R7 专用）。默认 ARCH_LINER.rOut=0.437。
   *  0.437 与拱 0.452 之间留 15mm 径向隙 ⇒ 漏舱。抬到 0.449（拱内 3mm）封此隙。
   *  约束 > rIn、< 拱 0.452。 */
  rOut?: number;
}

/** 轮拱衬板参数（轮胎 r0.382 / 拱 r0.452 之间） */
export const ARCH_LINER = {
  rIn: 0.415,
  rOut: 0.437,
  /**
   * 拱顶弧段（度，绕轮轴，90°=拱顶）。
   * R65：100→**180**——用户 11-10 截图「轮辐条间隙看穿到舱内 cognac 皮革」。
   * 旧 100° 只盖拱顶 ±50°，衬板两端（≈40°/140°）以下到拱口脚点（y0.18）留空，
   * 从侧向辐条间隙可斜视穿到舱内座椅/门板。180° 铺满上半圆 ⇒ 封死正上方看穿。
   * R65-G：用户真机截图仍见**拱口前/后象限**（近地两侧）透橙 ⇒ 180° 对称两端只落到
   * 轮心高度、斜下方仍开。改 **210° + 中心偏后(centerDeg 90→95)**：多盖斜下前后象限，
   * 端点落到轮心下 ~0.21（仍在拱腔暗处、藏胎后，不外凸、不碰胎 r0.382 内缘外的可视带）。
   * 内凹封（衬板半径 < 拱 0.452，藏在拱腔里），非 R18 删除的外凸围边。
   */
  spanDeg: 210,
  /** 弧段中心角（度，90=拱顶对称；>90 中心偏后，多盖后侧斜下象限） */
  centerDeg: 95,
  /** 轴向宽度（只铺可视近侧，= 轮胎宽 0.255 + 两侧各 4cm） */
  width: 0.335,
  /** 弧段数（210° 用 10 段，每段 21°，曲面平滑且 tri 仍低） */
  segs: 10
} as const;

/**
 * 生成单侧轮拱衬板（局部：轮心原点、轴向沿 +x、拱顶朝 +y）。
 * `side` 决定轴向铺向（+1 → x ∈ [0.04, width−0.04] 铺向车外）。
 * `override`：R143-C 单调用方覆盖（spanDeg/centerDeg/width/segs），缺省回落 ARCH_LINER。
 */
export function createWheelArchLiner(
  side: 1 | -1 = 1,
  override?: ArchLinerOverride
): THREE.BufferGeometry {
  const rIn = override?.rIn ?? ARCH_LINER.rIn;
  const rOut = override?.rOut ?? ARCH_LINER.rOut;
  const spanDeg = override?.spanDeg ?? ARCH_LINER.spanDeg;
  const centerDeg = override?.centerDeg ?? ARCH_LINER.centerDeg;
  const width = override?.width ?? ARCH_LINER.width;
  const segs = override?.segs ?? ARCH_LINER.segs;
  const center = (centerDeg * Math.PI) / 180;
  const a0 = center - (spanDeg * Math.PI) / 180 / 2;
  const a1 = center + (spanDeg * Math.PI) / 180 / 2;
  const x0 = side > 0 ? 0.04 : -width + 0.04;
  const x1 = side > 0 ? width - 0.04 : -0.04;
  const pos: number[] = [];
  const idx: number[] = [];
  // 壳面（外环 + 内环，双面由材质 side 承担；顶点环带）
  const rings: [number, number][] = [
    [x0, rIn], [x0, rOut], [x1, rIn], [x1, rOut]
  ];
  const pt = (xi: number, ri: number, ai: number): void => {
    const [x, r] = rings[xi * 2 + ri];
    pos.push(x, Math.sin(ai) * r, Math.cos(ai) * r * -1);
  };
  for (let s = 0; s <= segs; s += 1) {
    const a = a0 + ((a1 - a0) * s) / segs;
    pt(0, 0, a); pt(0, 1, a); pt(1, 0, a); pt(1, 1, a);
    if (s < segs) {
      const b = s * 4;
      const n = b + 4;
      // 外壳面（rOut）
      idx.push(b + 1, n + 1, n + 3, b + 1, n + 3, b + 3);
      // 内壳面（rIn）
      idx.push(b + 0, n + 2, n + 0, b + 0, b + 2, n + 2);
      // 两侧封边（x0/x1 环）
      idx.push(b + 0, n + 1, n + 0, b + 0, b + 1, n + 1);
      idx.push(b + 2, n + 3, n + 2, b + 2, b + 3, n + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  // R143-C2 · 轮内侧内挡板：仅 override 显式给 baffleRadius 时并入（R7 专属；
  // V800 走缺省无 override ⇒ 不并入，逐位不变）。扇面盖住内板缘平面（a0→a1 弧、
  // 与壳面同角域），封死「拱口内缘/轮辐外侧隙」斜视穿舱路径。半径 = baffleRadius
  // （≤ 壳面 rOut，与壳缘 rIn 同界 ⇒ 无 z-fight、无径向缝）。
  if (override?.baffleRadius && override.baffleRadius > 0) {
    const baffle = buildArchLinerBaffle(side, width, a0, a1, override.baffleRadius);
    const merged = mergeSafe([g, baffle]);
    merged.computeBoundingBox();
    return merged;
  }
  return g;
}

/**
 * R143-C4 · 轮内侧内挡板（Phase3 终审 R143-C2 判无效后的正确落点）。
 * ⚠ R143-C2 的挡板（xEdge=width−0.04=外板缘平面）**罩在轮胎外**（world x 1.248 >
 * 胎面 1.016），A/B 逐字节不变：半径 0.415 < 橙斑半径 0.449+，够不到；且罩轮外缘。
 * R143-C4 修正两处：
 *   ① 移到**内板缘平面**（side=+1 → x=+0.03 / side=−1 → x=−0.03，world x≈0.918，
 *      在轮胎 x 0.761–1.016 之内、舱内皮革 x≤0.903 之外）——**藏在轮胎后面**，
 *      从车外侧看由胎面遮蔽、只在背面剔除角（橙斑）处露出，堵死透舱路径；
 *   ② 半径抬到 **0.48**（拱缘实测 ≈0.49 之内 10mm）——覆盖 rOut 0.449 与拱缘
 *      0.49 之间的 41mm 环带（Phase3 橙斑即此环带透舱）。
 * 扇面角域同壳面 a0→a1（270°，正上对称）——橙斑在右上象限（0–90°），在域内。
 * 底缘端点（a0/a1）半径·sin(−45°)=−0.343 ⇒ 世界 y≈0.037 > 0，不穿地。
 */
function buildArchLinerBaffle(
  side: 1 | -1,
  _width: number,
  a0: number,
  a1: number,
  radius: number,
  segs = 48
): THREE.BufferGeometry {
  // R143-C4：内板缘平面（+0.03/−0.03，world x≈0.918，胎内、皮革外、内衬板缘内 1cm）
  const xEdge = side > 0 ? 0.03 : -0.03;
  const pos: number[] = [];
  const nor: number[] = [];
  for (let s = 0; s < segs; s += 1) {
    const p0 = a0 + ((a1 - a0) * s) / segs;
    const p1 = a0 + ((a1 - a0) * (s + 1)) / segs;
    // 圆心（轮心）→ 弧点 p0 → 弧点 p1；壳面 y=sin*r / z=−cos*r 同约定
    pos.push(xEdge, 0, 0);
    pos.push(xEdge, Math.sin(p0) * radius, Math.cos(p0) * radius * -1);
    pos.push(xEdge, Math.sin(p1) * radius, Math.cos(p1) * radius * -1);
    // 双面材质（linerMat DoubleSide）承载，法线朝舱内（±x）即可；逐三角平面法线
    nor.push(side, 0, 0, side, 0, 0, side, 0, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
