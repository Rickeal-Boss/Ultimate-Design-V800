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
    // rear 保持 R49 值（后排无台面遮挡问题，工单明令不动）
    expect(s).toContain('eye: [0.0, 1.230, -0.700] as [number, number, number]');
    expect(s).toContain('target: [0.0, 1.030, 1.300] as [number, number, number]');
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
    // 纯函数 index 剔除 + cabin 态应用
    expect(s).toContain('export function buildRoofCulledIndex(');
    expect(s).toContain('applyRoofCull(interior && r47CabinFix);');
    // A/B 回滚：关车顶剔除 → 回 R47 base（车顶内壁重新遮挡）
    expect(s).toContain('r50roof=off');
    expect(s).toContain('/(?:^|[#&])r50roof=off/i');
    // R47 / R49 原有回滚钩子未被破坏
    expect(s).toContain('r47cabin=off');
    expect(s).toContain('r49r7eye=off');
  });

  it('剔除不新建材质实例、不连带轮（body 与 4 轮各自独立 geometry）', () => {
    const s = src(ADAPTER);
    // buildRoofCulledIndex 只读 geometry、返回 index 双缓冲，绝不 touch material/side
    expect(s).toContain('const full = new Uint32Array(src);');
    expect(s).toContain('const culled = new Uint32Array(src);');
    // 抽出 buildRoofCulledIndex 函数体，确认它只碰 index/position，不碰材质 side/visible
    const fnStart = s.indexOf('export function buildRoofCulledIndex(');
    expect(fnStart, 'buildRoofCulledIndex 缺失').toBeGreaterThanOrEqual(0);
    const fnBody = s.slice(fnStart, s.indexOf('\n}', fnStart) + 2);
    expect(fnBody).toContain('geometry.getIndex()');
    expect(fnBody).not.toContain('.side');
    expect(fnBody).not.toContain('.visible');
    expect(fnBody).not.toContain('.material');
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
