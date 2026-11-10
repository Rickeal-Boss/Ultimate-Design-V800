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
 */
import * as THREE from 'three';

export const WHEEL_ARCH_LINER_MATERIAL_ID = 'r22-arch-liner';

/** 轮拱衬板参数（轮胎 r0.382 / 拱 r0.452 之间） */
export const ARCH_LINER = {
  rIn: 0.415,
  rOut: 0.437,
  /**
   * 拱顶弧段（度，绕轮轴，0°=车外侧水平、90°=拱顶）。
   * R65：100→**180**——用户 11-10 截图「轮辐条间隙看穿到舱内 cognac 皮革」。
   * 旧 100° 只盖拱顶 ±50°，衬板两端（≈40°/140°）以下到拱口脚点（y0.18）留空，
   * 从侧向辐条间隙可斜视穿到舱内座椅/门板。180° 铺满上半圆（两端落到轮心高度
   * y0.382，仍在拱内、不外凸、不碰轮胎 0.382 内缘外的可视带）⇒ 封死看穿路径。
   * 内凹封（衬板半径 < 拱 0.452，藏在拱腔里），非 R18 删除的外凸围边。
   */
  spanDeg: 180,
  /** 轴向宽度（只铺可视近侧，= 轮胎宽 0.255 + 两侧各 4cm） */
  width: 0.335,
  /** 弧段数（180° 用 9 段，每段 20°，曲面平滑且 tri 仍低） */
  segs: 9
} as const;

/**
 * 生成单侧轮拱衬板（局部：轮心原点、轴向沿 +x、拱顶朝 +y）。
 * `side` 决定轴向铺向（+1 → x ∈ [0.04, width−0.04] 铺向车外）。
 */
export function createWheelArchLiner(side: 1 | -1 = 1): THREE.BufferGeometry {
  const { rIn, rOut, spanDeg, width, segs } = ARCH_LINER;
  const a0 = (Math.PI / 2 - (spanDeg * Math.PI) / 180 / 2);
  const a1 = (Math.PI / 2 + (spanDeg * Math.PI) / 180 / 2);
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
  return g;
}
