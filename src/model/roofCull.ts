/**
 * roofCull.ts —— 按 world-y 阈值把外部壳 bodyMesh 的「车顶区」三角形退化（纯函数）。
 *
 * 出处：R50 为 R7 引入（`R7Adapter.buildRoofCulledIndex`）。R80 抽成共享纯模块：
 * V800 此前**没有**任何车顶内壁剔除（R74 注释「V800 无 roofCull 留空段」），
 * 导致 cabin 态外模车顶内壁（DoubleSide 深色亮面）与星顶盖板并存 ⇒ 主驾抬头看到
 * 「光滑黑亮弧形面板 + 上方锯齿白边」（用户 11-13 image#19）。
 *
 * 纯函数（只读 geometry，返回新数组，无副作用）⇒ 可单测。
 * - 分类判据：三角形三顶点的最大 world y（= local y × scale）> roofWorldY ⇒ 车顶 / 上框。
 * - `culled`：车顶三角三索引置 0（退化零面积 ⇒ GPU 不光栅化），其余照抄 ⇒ cabin 态用。
 * - `full`：原 index 逐位副本 ⇒ 外部机位恢复用（外部视角逐位不变）。
 * - 非 Uint32 index 或无 index/position ⇒ 返回 null（调用方跳过，等同关闭剔除）。
 */
import type * as THREE from 'three';

export function buildRoofCulledIndex(
  geometry: THREE.BufferGeometry,
  scale: number,
  roofWorldY: number,
): { full: Uint32Array; culled: Uint32Array; roofTris: number; totalTris: number } | null {
  const index = geometry.getIndex();
  if (!index || !(index.array instanceof Uint32Array)) return null;
  const pos = geometry.getAttribute('position');
  if (!pos) return null;
  const src = index.array;
  const totalTris = Math.floor(src.length / 3);
  const roofLocal = roofWorldY / scale;
  const full = new Uint32Array(src); // 副本（外部机位）
  const culled = new Uint32Array(src); // 副本（cabin 剔除）
  let roofTris = 0;
  for (let t = 0; t < totalTris; t++) {
    const i0 = src[t * 3];
    const i1 = src[t * 3 + 1];
    const i2 = src[t * 3 + 2];
    const maxY = Math.max(pos.getY(i0), pos.getY(i1), pos.getY(i2));
    if (maxY > roofLocal) {
      culled[t * 3] = 0;
      culled[t * 3 + 1] = 0;
      culled[t * 3 + 2] = 0;
      roofTris++;
    }
  }
  return { full, culled, roofTris, totalTris };
}
