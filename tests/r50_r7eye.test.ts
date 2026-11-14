/**
 * R50-B · R7 cabinDriver/passenger 眼点与 R27 内饰抬升关系护栏。
 *
 * 数值来源：`.qa/r49/PHASE2C_SPEC.md`（工单）+ R49 探针实测 dash-upper 顶 0.962
 * （未抬升前装配 y）。运行时装配路径（外部壳异步、canvas atlas）在 Node 下无法
 * 实例化座舱相机，故按 r48_lamp/r49_visual 同风格钉**参数不变量**：
 *   ① 眼点 y ≥ dashUpperTop(=0.962 + LIFT) + 0.02  ⇒ 不被仪表台挡死
 *   ② 眼点 y ≤ 顶棚下沿 1.44                        ⇒ 不穿顶
 *   ③ `#r49r7eye=off` 回滚钩子存在                  ⇒ A/B 可逐位回 R49 前
 * 像素级验收（≥12% 可见车外）走 Edge headless 探针 #view=cabinDriver（near=0.05），
 * 不在单测内做。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, '..', rel), 'utf-8').replace(/\r\n/g, '\n');
const ADAPTER = 'src/model/R7Adapter.ts';

describe('R50-B · R7 眼点校准（默认开）', () => {
  it('driver.eye.y = 1.29 / target.y = 1.16；passenger 同步对齐；rear 不动', () => {
    const s = src(ADAPTER);
    // R50-Bv4：eye 1.40→1.29（A/B 证明眼点非主因，1.40 贴顶棚有穿顶风险且无收益；
    // 回调到 A/B 扫描最优 c01 = 1.29，与 `.qa/r50/glassab/ab_meta.json` 的 eye 一致）
    expect(s).toContain('([0.300, 1.290, -0.090] as [number, number, number])');
    expect(s).toContain('([0.150, 1.160, 1.950] as [number, number, number])');
    expect(s).toContain('([-0.300, 1.290, -0.090] as [number, number, number])');
    expect(s).toContain('([-0.140, 1.160, 1.750] as [number, number, number])');
    // rear：R69 任务#4 把 cabinRear 重标为「看主驾座椅+AB柱」机位（R69R7SEAT_VIEW 分支）；
    // R68 基线眼点/target 字面量仍保留在 off 分支 ⇒ 逐位回滚成立。
    expect(s).toContain('const R69R7SEAT_VIEW: boolean =');
    expect(s).toContain('([0.0, 1.42, -1.30] as [number, number, number])'); // R69 on 眼点
    expect(s).toContain('([0.12, 0.62, 0.35] as [number, number, number])'); // R69 on target
    expect(s).toContain('([0.0, 1.230, -0.700] as [number, number, number])'); // off 基线眼点
    expect(s).toContain('([0.0, 1.030, 1.300] as [number, number, number])'); // off 基线 target
  });

  it('R27 内饰抬升量降到 0.14（默认态）；回滚分支保 0.26', () => {
    const s = src(ADAPTER);
    expect(s).toContain('export const R27_INTERIOR_LIFT = R49R7EYE_FIX ? 0.14 : 0.26;');
  });

  it('关系护栏：eye.y ≥ dashUpperTop + 0.02 且 ≤ 顶棚下沿 1.44', () => {
    // dash-upper 顶 = R7_DASH_UPPER_TOP_BASE(0.962) + R27_INTERIOR_LIFT(默认态 0.14)
    // 顶棚下沿 = R7_HEAD_LINER_Y(1.44)，眼点硬上限
    const s = src(ADAPTER);
    const baseMatch = s.match(/export const R7_DASH_UPPER_TOP_BASE = ([\d.]+);/);
    const linerMatch = s.match(/export const R7_HEAD_LINER_Y = ([\d.]+);/);
    const liftMatch = s.match(/export const R27_INTERIOR_LIFT = R49R7EYE_FIX \? ([\d.]+) : [\d.]+;/);
    const marginMatch = s.match(/export const R7_EYE_CLEAR_MARGIN = ([\d.]+);/);
    expect(baseMatch, 'R7_DASH_UPPER_TOP_BASE 常量缺失').not.toBeNull();
    expect(linerMatch, 'R7_HEAD_LINER_Y 常量缺失').not.toBeNull();
    expect(liftMatch, 'R27_INTERIOR_LIFT 默认分支缺失').not.toBeNull();
    expect(marginMatch, 'R7_EYE_CLEAR_MARGIN 常量缺失').not.toBeNull();
    const base = Number(baseMatch![1]);
    const liner = Number(linerMatch![1]);
    const lift = Number(liftMatch![1]);
    const margin = Number(marginMatch![1]);
    const dashUpperTop = base + lift;
    const eyeY = 1.29;
    expect(eyeY, `eye.y ${eyeY} 必须 ≥ dashUpperTop ${dashUpperTop} + ${margin}`).toBeGreaterThanOrEqual(
      dashUpperTop + margin,
    );
    expect(eyeY, `eye.y ${eyeY} 必须 ≤ 顶棚下沿 ${liner}`).toBeLessThanOrEqual(liner);
  });
});

describe('R50 · cabin 车顶内壁剔除（真修 R47 DoubleSide 回归）', () => {
  it('阈值常量存在且落在「眼点之上、顶棚下沿之下」⇒ 剔除带正好是挡视线的车顶内壁', () => {
    const s = src(ADAPTER);
    expect(s).toContain('export const R50_ROOF_CLIP_WORLD_Y');
    // 默认阈值 = IIFE 兜底 return（`#r50roofclip=` 可 A/B 覆盖）
    const clipMatch = s.match(/return m \? Number\(m\[1\]\) : ([\d.]+);/);
    expect(clipMatch, 'R50_ROOF_CLIP_WORLD_Y 默认阈值缺失').not.toBeNull();
    const clip = Number(clipMatch![1]);
    const liner = Number(s.match(/export const R7_HEAD_LINER_Y = ([\d.]+);/)![1]);
    const eyeY = 1.29; // 与 R7_INTERIOR_VIEWS.driver.eye.y（默认开态）同源
    // 眼点之下不剔（保方向盘/仪表台/ hood 视野），顶棚下沿之上必剔（车顶内壁全清）
    expect(clip, `车顶剔除阈值 ${clip} 必须 ≥ 眼点 ${eyeY}`).toBeGreaterThanOrEqual(eyeY);
    expect(clip, `车顶剔除阈值 ${clip} 必须 ≤ 顶棚下沿 ${liner}`).toBeLessThanOrEqual(liner);
  });

  it('剔除机制 + 三重回滚钩子存在', () => {
    const s = src(ADAPTER);
    // R80：纯函数 index 剔除抽到 src/model/roofCull.ts（V800 与本车共用），
    // R7Adapter 保留同名 re-export ⇒ 既有 import 路径（含护栏）不破。
    expect(s).toContain("export { buildRoofCulledIndex } from './roofCull';");
    expect(src('src/model/roofCull.ts')).toContain('export function buildRoofCulledIndex(');
    // R71 修③：applyRoofCull 现按机位传阈值（cabinRear 1.42 / 其余 1.30），
    // 认两态：旧单参调用 `applyRoofCull(interior && r47CabinFix);` 或新双参调用
    // `applyRoofCull(\n  interior && r47CabinFix,\n  ...R7_REAR_ROOF_CLIP_WORLD_Y...);`
    expect(
      /applyRoofCull\(\s*interior && r47CabinFix/.test(s),
      'applyRoofCull 须以 interior && r47CabinFix 作为 active 实参调用',
    ).toBe(true);
    // A/B 回滚：关车顶剔除 → 回 R47 base（车顶内壁重新遮挡）
    expect(s).toContain('r50roof=off');
    expect(s).toContain('/(?:^|[#&])r50roof=off/i');
    // R47 / R49 原有回滚钩子未被破坏
    expect(s).toContain('r47cabin=off');
    expect(s).toContain('r49r7eye=off');
  });

  it('剔除不新建材质实例、不连带轮（body 与 4 轮各自独立 geometry）', () => {
    // R81 二轮：函数体仍在 roofCull.ts；判据按主理人 GLB 逐三角定量复核**重新定罪**为
    //   「车顶区(maxY 口径) && ny>0.5 朝上外表面」⇒ 只剔朝上车顶外表面，
    //   骨架(|ny|<0.5) 与朝下内壁(ny<−0.5) 全部保留。
    //   ⚠ 派单一轮处方「minY 全过线 + 法线朝下」已被推翻：GLB 是单层薄壳，
    //     黑亮面板 = 朝上外表面的背面（cabin DoubleSide），只剔内壁会 100% 复发。
    //   下列**只读 index / 不动材质**的结构不变量逐条等价保留
    //   （旧断言一条不删、不放宽，仅语义注释更新 + 追加新判据断言）。
    const c = src('src/model/roofCull.ts');
    expect(c).toContain('const full = new Uint32Array(src);');
    expect(c).toContain('const culled = new Uint32Array(src);');
    // 抽出 buildRoofCulledIndex 函数体，确认它只碰 index/position/normal，不碰材质 side/visible
    const fnStart = c.indexOf('export function buildRoofCulledIndex(');
    expect(fnStart, 'buildRoofCulledIndex 缺失').toBeGreaterThanOrEqual(0);
    const fnBody = c.slice(fnStart, c.indexOf('\n}', fnStart) + 2);
    expect(fnBody).toContain('geometry.getIndex()');
    expect(fnBody).not.toContain('.side');
    expect(fnBody).not.toContain('.visible');
    expect(fnBody).not.toContain('.material');
    // ── R81 二轮新语义逐条钉死（追加，不替换上面的既有断言）──────────────
    // ① 车顶区用 maxY 口径（region），不是一轮的 minY 收窄
    expect(fnBody).toContain('const region = Math.max(y0, y1, y2) > roofLocal;');
    // ② 只剔朝上外表面：ny > 阈值；水平判据 |ny| >= 阈值 同时成立
    expect(fnBody).toContain('const upward = ny > ROOF_CULL_HORIZONTAL_NY;');
    expect(fnBody).toContain('horizontal = Math.abs(ny) >= ROOF_CULL_HORIZONTAL_NY;');
    expect(fnBody).toContain('hit = region && upward && horizontal;');
    expect(fnBody).toContain("const nrm = geometry.getAttribute('normal');");
    // ③ mode 分支：'r80' 逐位回 R80 maxY 一刀切（A/B 回滚），默认 'r81'
    expect(fnBody).toContain("if (mode === 'r80') {");
    expect(fnBody).toContain('hit = Math.max(y0, y1, y2) > roofLocal;');
    // ④ 缺省 normal 优雅退化：不抛错、不返回 null，退化为只按 minY 的保守窄带
    expect(fnBody).toContain('const allAbove = Math.min(y0, y1, y2) > roofLocal;');
    expect(fnBody).toContain('else if (!useNormal) {');
    expect(fnBody).toContain('hit = allAbove && horizontal;');
    expect(fnBody).toContain('const useNormal = mode === \'r81\' && !!nrm && nrm.itemSize >= 3;');
    expect(c).toContain('export const ROOF_CULL_HORIZONTAL_NY = 0.5;');
    expect(c).toContain("export type RoofCullMode = 'r81' | 'r80';");
    // ⑤ 4 参签名：R7Adapter 两处 3 参调用继承默认 mode；默认态由模块级常量
    //    R81_ROOF_CULL_DEFAULT_MODE 给出（13:39:57 第 4 次落盘，取代字面量 'r81'），
    //    `#r81r7roofcull=off` ⇒ 'r80' 让 R7 逐位回 R50 已验证的 maxY 判据。
    //    node/SSR 无 window ⇒ 恒 'r81'（护栏可复现）；V800Adapter 显式传 mode 不受影响。
    expect(c).toContain('mode: RoofCullMode = R81_ROOF_CULL_DEFAULT_MODE');
    expect(c).toContain('const R81_ROOF_CULL_DEFAULT_MODE: RoofCullMode =');
    expect(c).toContain('r81r7roofcull=off');
    // 显式 mode='r80' 逐位回 R80（A/B 回滚契约），运行时逐位验证见 r81_regression §3
    expect(fnBody).toContain("if (mode === 'r80') {");
  });

  it('R81 二轮判据语义：只剔「车顶区朝上外表面」，骨架 / 朝下内壁逐位保留', () => {
    // 源码级等价性（弱）；真·运行时逐位验证见 tests/r81_regression.test.ts §3
    // （手工 Uint32 index + position + normal 小几何，断言骨架 / 内壁 culled 逐位保留）。
    const c = src('src/model/roofCull.ts');
    // full 恒为原 index 逐位拷贝 ⇒ 外部机位逐位恢复不变
    expect(c).toContain('const full = new Uint32Array(src);');
    // culled 只把命中三角的三索引置 0，其余照抄 ⇒ 未命中三角逐位保留
    expect(c).toContain('const culled = new Uint32Array(src);');
    expect(c).toContain('culled[t * 3] = 0;');
    expect(c).toContain('culled[t * 3 + 1] = 0;');
    expect(c).toContain('culled[t * 3 + 2] = 0;');
    // roofTris 只在命中时自增 ⇒ 计数 == 被剔三角数
    expect(c).toContain('roofTris++;');
    expect(c).toContain('return { full, culled, roofTris, totalTris };');
    // 二轮定量定罪口径（注释里的 GLB 实测量，供后人核对判据来源）
    expect(c).toContain('966,484 tri');
    expect(c).toContain('73,262 tri'); // 朝上车顶外表面 = 唯一应剔靶点
    expect(c).toContain('59,824 tri'); // 骨架 = 必须保留
    expect(c).toContain('9,196 tri');  // 朝下内壁 = 必须保留
  });
});

describe('R50-B · #r49r7eye=off 回滚钩子（逐位回 R49 前）', () => {
  it('存在 off 分支：eye 1.285 / target 1.020 / LIFT 0.26', () => {
    const s = src(ADAPTER);
    // 钩子正则与 r48tone/r47cabin 同款
    expect(s).toContain('r49r7eye=off');
    expect(s).toContain('/(?:^|[#&])r49r7eye=off/i');
    // 回滚值逐位对齐 R49 前
    expect(s).toContain('([0.300, 1.285, -0.090] as [number, number, number])');
    expect(s).toContain('([0.150, 1.020, 1.950] as [number, number, number])');
    expect(s).toContain('([-0.300, 1.285, -0.090] as [number, number, number])');
    expect(s).toContain('([-0.140, 1.020, 1.750] as [number, number, number])');
    // 回滚分支 LIFT = 0.26
    expect(s).toContain('R49R7EYE_FIX ? 0.14 : 0.26');
  });
});

describe('R50-B · 红线守卫', () => {
  it('未改外壳 profile / 玻璃透光 / transmission（R12 铁律未破）', () => {
    const s = src(ADAPTER);
    expect(s).toContain('mat.transmission = 0;');
    expect(s).toContain('sm.castShadow = false;');
    // 未在本文件给任何材质赋非 0 的 transmission（R12 铁律）
    expect(s).not.toMatch(/transmission\s*=\s*[1-9]/);
    expect(s).not.toMatch(/transmission:\s*[1-9]/);
  });

  it('未缩放 mesh.scale（工单禁令，本次不涉）', () => {
    const s = src(ADAPTER);
    expect(s).not.toMatch(/\.scale\.set\(/);
    expect(s).not.toMatch(/\.scale\s*=\s*new THREE\.Vector3/);
  });
});
