/**
 * roofCull.ts —— 按 world-y 车顶区 + 朝上法线把外部壳 bodyMesh 的「车顶外表面」三角形退化（纯函数）。
 *
 * 出处：R50 为 R7 引入（`R7Adapter.buildRoofCulledIndex`）。R80 抽成共享纯模块并移植到
 * V800（V800 此前一直缺失）。R81 二轮按主理人 GLB 逐三角定量复核**重新定罪靶点**。
 *
 * ══ R81 二轮 · 最终定量依据（主理人 + 本线独立复跑 tools/r81_roofcull_glb_probe.py）══
 * V800 `body.glb` 966,484 tri，有 NORMAL，scale=4.75，roofWorldY=1.45 ⇒ roofLocal=0.305263。
 * 车顶区（R80 口径 `max(y) > roofLocal`）= **142,282 tri（14.72% 全车）**，法线分布：
 *   · `ny >  0.5` 朝上车顶**外表面** 73,262 tri（51.49%）
 *   · `|ny|<=0.5` 竖直/斜向（A 柱上段、侧窗上框、车顶边框＝用户说的「骨架」）59,824 tri（42.05%）
 *   · `ny < -0.5` 朝下内壁 9,196 tri（6.46%）
 * R7 `body.glb` 同构（@1.30 车顶区 102,857 tri，朝上 87,545 = 85.11%）⇒ 判据两车通用。
 *
 * 定罪修正（推翻本线一轮与派单前两封的处方）：
 *  ① **minY 不是主修法**：`min(y)>roofLocal` 只比 R80 少 1,286 tri（0.90%），「骨架消失」
 *     不是跨阈值大三角误伤，而是 R80 一刀切把 14.72% 全车上部（含 59,824 骨架）全剔了。
 *  ② **GLB 车顶是单层薄壳**，没有独立「朝下内壁」几何：cabin 态 bodyMesh 走 DoubleSide
 *     （R47 有意设计，R7Adapter:212-223 A/B 实证「#r47cabin=off 整壳隐藏 ⇒ 就是 bodyMesh
 *     内壁」），主驾抬头看到的「黑亮弧形面板」= **朝上外表面的背面**。只剔 ny<-0.5 内壁
 *     只剔 6.46%，黑亮面板 100% 复发；只剔 |ny|>=0.5 又会连 9,196 内壁一并误剔。
 *  ③ 正确靶点：**车顶区（maxY 口径）&& ny > 0.5 朝上外表面** ⇒ 剔 73,262 tri（全车 7.58%），
 *     保留 59,824 骨架 + 9,196 朝下内壁 = 69,020 tri。骨架全回来、黑亮面板全消失。
 *
 * 纯函数（只读 geometry + 显式 mode 入参 + 求值期固定的模块常量，返回新数组，
 *   无副作用 / **不在函数体内**读 window）⇒ 可单测。
 * - `full` 恒为原 index 逐位拷贝 ⇒ 外景态逐位恢复不变（零变化）。
 * - `culled` 只退化命中三角（三索引置 0 ⇒ 零面积 ⇒ GPU 不光栅化）。
 * - `mode='r80'` ⇒ 逐位回 R80 的 maxY 判据（A/B 回滚 + 旧护栏断言共用同一签名）。
 * - 无 normal 属性 ⇒ 退化为**只按 minY**（不抛错、不返回 null）：没有法线就无法判方向，
 *   退到「只剔完全落在车顶区的窄带」比 maxY 一刀切保守，跨阈值骨架仍保留。
 * - 非 Uint32 index 或无 index / position ⇒ 返回 null（调用方跳过，等同关闭剔除）。
 * - 可选第 4 参数 `mode` 向后兼容：R7Adapter 两处 3 参数调用 + re-export 取默认 ⇒ 两车同改。
 *
 * ══ R81 二轮补 · R7 独立 A/B 逃生门（落地审查风险 1）═════════════════════════
 * `R7Adapter.ts:1605 / :1890` 两处均为 **3 参数调用**（不传 mode），会继承本函数默认
 *   mode ⇒ 默认 'r81' 会把 R7 已 PASS 的 R50 maxY 判据**静默改掉**（R7 @1.30：R80
 *   剔 102,857 → 新判据只剔 87,545，多保回 15,312 tri = 竖直 13,156 + 朝下内壁 2,156），
 *   而 `#r81roofcull=off` 只定义在 V800Adapter 内 ⇒ R7 侧原本无法 A/B 回滚。
 * 修（审查线推荐方案①，白名单内实现、R7Adapter 零改动）：模块**求值期**读一次
 *   `#r81r7roofcull=off` ⇒ 默认 mode 回 'r80'（R7 逐位回 R50 已验证行为）；
 *   默认态仍 'r81'（两车同改、派单口径不变）。V800Adapter 始终显式传
 *   `R81_ROOF_CULL_MODE` ⇒ 不受此开关影响。
 * ⚠ 「两车同改」**未经 R7 三内饰机位（cabinDriver / cabinPassenger / cabinRear）真机
 *   目检**（沙箱无 GPU 浏览器，仅做 GLB 离线逐三角计数）；开关把风险从「不可回滚」
 *   降为「可回滚 + 待真机目检」，该目检仍列遗留。
 */
import type * as THREE from 'three';

/** R81 车顶判据模式：'r81' 新（车顶区 && 朝上外表面，默认）/ 'r80' 旧（maxY，A/B 回滚）。 */
export type RoofCullMode = 'r81' | 'r80';
/** 法线阈值：|ny|>=0.5 视为水平面；ny>0.5 为朝上车顶外表面（骨架 |ny|≈0 保留）。 */
export const ROOF_CULL_HORIZONTAL_NY = 0.5;
/** R81 二轮补 · R7 独立 A/B 逃生门（落地审查风险 1）：
 *  `#r81r7roofcull=off` ⇒ 默认 mode 回 'r80'，R7Adapter 两处 3 参数调用无需改动即逐位
 *  回 R50 已验证的 maxY 判据；默认 'r81' ⇒ 两车同改。模块求值期读一次（函数体内不读
 *  window），Node / SSR 无 window ⇒ 恒 'r81'，护栏可复现。V800Adapter 显式传 mode ⇒ 不受影响。 */
const R81_ROOF_CULL_DEFAULT_MODE: RoofCullMode =
  typeof window !== 'undefined' && /(?:^|[#&])r81r7roofcull=off/i.test(window.location.hash)
    ? 'r80'
    : 'r81';

export function buildRoofCulledIndex(
  geometry: THREE.BufferGeometry,
  scale: number,
  roofWorldY: number,
  mode: RoofCullMode = R81_ROOF_CULL_DEFAULT_MODE,
): { full: Uint32Array; culled: Uint32Array; roofTris: number; totalTris: number } | null {
  const index = geometry.getIndex();
  if (!index || !(index.array instanceof Uint32Array)) return null;
  const pos = geometry.getAttribute('position');
  if (!pos) return null;
  const nrm = geometry.getAttribute('normal');
  const useNormal = mode === 'r81' && !!nrm && nrm.itemSize >= 3;
  const src = index.array;
  const totalTris = Math.floor(src.length / 3);
  const roofLocal = roofWorldY / scale;
  const full = new Uint32Array(src); // 副本（外部机位）——逐位拷贝，外景恢复零变化
  const culled = new Uint32Array(src); // 副本（cabin 剔除）
  let roofTris = 0;
  for (let t = 0; t < totalTris; t++) {
    const i0 = src[t * 3];
    const i1 = src[t * 3 + 1];
    const i2 = src[t * 3 + 2];
    const y0 = pos.getY(i0);
    const y1 = pos.getY(i1);
    const y2 = pos.getY(i2);
    // 全顶点在车顶区（跨阈值大三角不满足）——无 normal 时的保守退化带
    const allAbove = Math.min(y0, y1, y2) > roofLocal;
    // 三顶点平均法线 y；无 normal 时 horizontal 恒 true ⇒ 退化分支等价于只按 allAbove
    let horizontal = true;
    let ny = 0;
    if (useNormal && nrm) {
      ny = (nrm.getY(i0) + nrm.getY(i1) + nrm.getY(i2)) / 3;
      horizontal = Math.abs(ny) >= ROOF_CULL_HORIZONTAL_NY;
    }
    let hit: boolean;
    if (mode === 'r80') {
      // R80 旧判据（逐位等价，供 A/B 与旧断言）
      hit = Math.max(y0, y1, y2) > roofLocal;
    } else if (!useNormal) {
      // 缺省 normal：不抛错、不返回 null，退化为只按 minY（骨架仍保留）
      hit = allAbove && horizontal;
    } else {
      // R81 最终判据：车顶区（R80 的 maxY 口径）&& 朝上外表面 && 近水平。
      // 单层薄壳 + cabin DoubleSide ⇒ 朝上外表面的背面就是「黑亮弧形面板」。
      const region = Math.max(y0, y1, y2) > roofLocal;
      const upward = ny > ROOF_CULL_HORIZONTAL_NY;
      hit = region && upward && horizontal;
    }
    if (hit) {
      culled[t * 3] = 0;
      culled[t * 3 + 1] = 0;
      culled[t * 3 + 2] = 0;
      roofTris++;
    }
  }
  return { full, culled, roofTris, totalTris };
}
