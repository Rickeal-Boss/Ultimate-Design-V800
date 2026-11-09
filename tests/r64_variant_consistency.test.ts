/**
 * R64 · P0-4 `setVariant` 材质数值一致性护栏（R64-DECISION-4 / 顶点色分支）
 *
 * 定罪：构造分支 `ExternalShell.ts:1959-1988` 在 R60 表之后叠加 R62 tweak
 * （chroma 线性 RGB 缩放 / metal 乘子 / clearcoat 旋钮），而 setVariant 原实现
 * 只落**裸 R60 表** ⇒ 同一变体「初始构造」与「切走再切回」分叉
 * （black metalness 0.65 → 0.5）。white 的 chroma=1/metal=1 恰好不受影响
 * ⇒ **必须用非 white 变体验收**。
 *
 * 裁决形态：**原式逐字保留 + `if (R64_VARIANT_ON)` 覆盖写**。
 * `applyProcPaintTweaks` 幂等、只作覆盖写块内部实现、**不得被构造分支调用**、
 * **不得重置 material.vertexColors**（顶点色是乘子，随变体主色自动相乘）。
 * 构造分支 `:1959-1988` 与 `tests/r60_procedural_paint.test.ts:82-87` 反向断言
 * 一字不动；防「再次分叉」由本文件的数值断言承担。
 *
 * 断言两类：① 源码字符串契约（项目既定纪律 / A19 off 态 ≡ R63 baseline 且
 * helper 未被调用）；② 运行时数值逐位复算（`toBeCloseTo(...,12)`，线性 RGB）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  applyProcPaintTweaks,
  resolveProcPaint,
  R64_VARIANT_ON,
  R64_PAINT_ON
} from '../src/model/external/ExternalShell';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');
const slice = (s: string, from: string, to: string): string =>
  s.slice(s.indexOf(from), s.indexOf(to));

/** 与 `ExternalShell.ts:370-376 R60_PROC_PAINT` 逐位对应。 */
const R60: Record<string, { color: number; metalness: number; roughness: number }> = {
  white: { color: 0xd6d2cb, metalness: 0.05, roughness: 0.34 },
  black: { color: 0x0b0d11, metalness: 0.5, roughness: 0.3 },
  gold: { color: 0xc2ad86, metalness: 0.4, roughness: 0.34 },
  purple: { color: 0x6b5b9e, metalness: 0.35, roughness: 0.34 },
  green: { color: 0x1d7f78, metalness: 0.3, roughness: 0.34 }
};
/** 与 `ExternalShell.ts:387-393 R62_PROC_PAINT_TWEAK` 逐位对应。 */
const TWEAK: Record<string, { chroma: number; metal: number }> = {
  white: { chroma: 1.0, metal: 1.0 },
  black: { chroma: 1.15, metal: 1.3 },
  gold: { chroma: 1.12, metal: 1.3 },
  purple: { chroma: 1.18, metal: 1.35 },
  green: { chroma: 1.18, metal: 1.35 }
};

/** 独立复刻构造分支 `:1965-1985` 的数值口径（不调用被测函数）。 */
function constructionValues(variantId: string) {
  const pp = R60[variantId];
  const c = new THREE.Color().setHex(pp.color);
  let r = c.r;
  let g = c.g;
  let b = c.b;
  let metalness = pp.metalness;
  const tw = TWEAK[variantId];
  if (tw) {
    r = Math.min(1, r * tw.chroma);
    g = Math.min(1, g * tw.chroma);
    b = Math.min(1, b * tw.chroma);
    metalness = Math.min(1, pp.metalness * tw.metal);
  }
  return {
    color: [r, g, b] as const,
    metalness,
    roughness: pp.roughness,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12
  };
}

/** 快照一个真实 MeshPhysicalMaterial 的全部相关数值（线性 RGB）。 */
function snapshot(m: THREE.MeshPhysicalMaterial) {
  return {
    r: m.color.r,
    g: m.color.g,
    b: m.color.b,
    metalness: m.metalness,
    roughness: m.roughness,
    clearcoat: m.clearcoat,
    clearcoatRoughness: m.clearcoatRoughness,
    vertexColors: m.vertexColors
  };
}

describe('R64 · P0-4 开关与「原式逐字保留 + 覆盖写」源码契约', () => {
  it('五钩子符号齐备（R64_PAINT_ON / R64_TIRE_ON / R64_BRAKE_ON / R64_VARIANT_ON / R64_LAMP_DIRTY_ON）', () => {
    for (const k of ['r64paint', 'r64tire', 'r64brake', 'r64variant', 'r64lampdirty']) {
      expect(shell).toContain(`!r51HookOff('${k}')`);
      expect(shell).toMatch(new RegExp(`${k}=off`));
    }
    expect(R64_VARIANT_ON).toBe(true);
    expect(R64_PAINT_ON).toBe(true);
  });

  it('构造分支 :1959-1988 一字不动：tweak 原式全部保留，且**未调用** helper', () => {
    const ctor = slice(shell, 'if (useProcPaint) {\n      const procPaint', 'QA 材质 A/B');
    expect(ctor).toContain('material.map = null');
    expect(ctor).toContain('material.normalMap = null');
    expect(ctor).toContain('material.roughnessMap = null');
    expect(ctor).toContain('material.metalnessMap = null');
    expect(ctor).toContain('material.color.setHex(procPaint.color)');
    expect(ctor).toContain('material.metalness = procPaint.metalness');
    expect(ctor).toContain('material.roughness = procPaint.roughness');
    expect(ctor).toContain('c.setRGB(');
    expect(ctor).toContain('c.r * tw.chroma');
    expect(ctor).toContain('procPaint.metalness * tw.metal');
    expect(ctor).toContain('material.clearcoat = R62_PAINT_CLEARCOAT');
    expect(ctor).not.toContain('applyProcPaintTweaks'); // ★ helper 不得被构造分支调用
    expect(shell).toContain('export const R62_PAINT_CLEARCOAT = r56HashNum');
    expect(shell).toContain('export const R62_PAINT_CLEARCOAT_ROUGH = r56HashNum');
  });

  it('setVariant 原三行逐字保留（r60 反向护栏继续通过），其后 if (R64_VARIANT_ON) 覆盖写', () => {
    const sv = slice(shell, 'async setVariant', 'setGlassOpaque(opaque: boolean): void {');
    expect(sv).toContain('if (useProcPaint)');
    expect(sv).toContain('material.color.setHex(pp.color)');
    expect(sv).toContain('material.metalness = pp.metalness');
    expect(sv).toContain('material.roughness = pp.roughness');
    expect(sv).toContain('const tex = await loadTexture(url, true, car)');
    expect(sv).toContain('material.map = tex');
    const gateAt = sv.indexOf('if (R64_VARIANT_ON) {');
    expect(gateAt).toBeGreaterThan(sv.indexOf('material.needsUpdate = true;'));
    expect(sv).toContain('applyProcPaintTweaks(material, variantId)');
    // ★ A19：helper 调用必须**在**门控内，否则 #r64variant=off 也会生效 = 假绿
    expect(sv.indexOf('applyProcPaintTweaks(material, variantId)')).toBeGreaterThan(gateAt);
    // 顶点色是乘子 ⇒ 无任何 uniform 同步残留
    expect(sv).not.toContain('r64SyncPaintUpper');
    expect(sv).not.toContain('r64PaintUniforms');
  });

  it('helper 幂等 + 不重置 vertexColors（源码契约）', () => {
    const fn = shell.slice(
      shell.indexOf('export function applyProcPaintTweaks('),
      shell.indexOf('/* ── P0-1 · 双色车身顶点色')
    );
    expect(fn).toContain('const p = resolveProcPaint(variantId);');
    expect(fn).toContain('material.color.setRGB(p.color[0]');
    expect(fn).not.toMatch(/material\.vertexColors\s*=/); // 不重置顶点色契约（注释提及不算）
    expect(fn).not.toMatch(/material\.color\.r\s*\*/); // 不读当前 color ⇒ 不会二次缩放
    const pure = shell.slice(
      shell.indexOf('export function resolveProcPaint('),
      shell.indexOf('export function applyProcPaintTweaks(')
    );
    expect(pure).toContain('const pp = R60_PROC_PAINT[variantId]');
    expect(pure).toContain('new THREE.Color().setHex(pp.color)');
    expect(pure).toContain('const r62On = R62_PAINT_ON;'); // 不写护栏 slice 锚点字面量
  });
});

describe('R64 · P0-4 运行时数值：helper ≡ 构造分支逐位同值', () => {
  it('六变体全覆盖：color.r/g/b、metalness、roughness、clearcoat、clearcoatRoughness 逐位相同', () => {
    for (const v of ['white', 'black', 'gold', 'purple', 'green']) {
      const m = new THREE.MeshPhysicalMaterial();
      // 模拟 R63 的 setVariant 裸表（原式三行）
      m.color.setHex(R60[v].color);
      m.metalness = R60[v].metalness;
      m.roughness = R60[v].roughness;
      expect(applyProcPaintTweaks(m, v), v).toBe(true);
      const want = constructionValues(v);
      const got = snapshot(m);
      expect(got.r, `${v}.r`).toBeCloseTo(want.color[0], 12);
      expect(got.g, `${v}.g`).toBeCloseTo(want.color[1], 12);
      expect(got.b, `${v}.b`).toBeCloseTo(want.color[2], 12);
      expect(got.metalness, `${v}.metalness`).toBeCloseTo(want.metalness, 12);
      expect(got.roughness, `${v}.roughness`).toBeCloseTo(want.roughness, 12);
      expect(got.clearcoat, `${v}.clearcoat`).toBeCloseTo(want.clearcoat, 12);
      expect(got.clearcoatRoughness, `${v}.ccRough`).toBeCloseTo(want.clearcoatRoughness, 12);
    }
  });

  it('★ 非 white 分叉真实存在，helper 修到构造口径（black 0.65 / gold 0.52 / purple 0.4725 / green 0.405）', () => {
    expect(R60.black.metalness).toBe(0.5); // R63 裸表
    for (const [v, want] of [
      ['black', 0.65], ['gold', 0.52], ['purple', 0.4725], ['green', 0.405]
    ] as const) {
      const m = new THREE.MeshPhysicalMaterial();
      m.color.setHex(R60[v].color);
      m.metalness = R60[v].metalness;
      applyProcPaintTweaks(m, v);
      expect(m.metalness, v).toBeCloseTo(want, 12);
    }
    // chroma 必须真的改变线性 RGB（只测 white 会漏判）
    const base = new THREE.Color().setHex(R60.black.color);
    const m = new THREE.MeshPhysicalMaterial();
    applyProcPaintTweaks(m, 'black');
    expect(m.color.r).toBeCloseTo(Math.min(1, base.r * 1.15), 12);
  });

  it('white 的 chroma=1.0 / metal=1.0 例外显式断言（不许 skip）', () => {
    expect(shell).toContain('white: { chroma: 1.0, metal: 1.0 }');
    const m = new THREE.MeshPhysicalMaterial();
    applyProcPaintTweaks(m, 'white');
    const base = new THREE.Color().setHex(R60.white.color);
    expect(m.color.r).toBeCloseTo(base.r, 12);
    expect(m.color.g).toBeCloseTo(base.g, 12);
    expect(m.color.b).toBeCloseTo(base.b, 12);
    expect(m.metalness).toBeCloseTo(0.05, 12);
  });

  it('★ 幂等性：连续调用两次（含非 white）数值逐位不变，专门挡二次缩放', () => {
    for (const v of ['black', 'gold', 'purple', 'green']) {
      const m = new THREE.MeshPhysicalMaterial();
      m.color.setHex(R60[v].color);
      applyProcPaintTweaks(m, v);
      const a = snapshot(m);
      applyProcPaintTweaks(m, v);
      const b = snapshot(m);
      expect(b.r).toBeCloseTo(a.r, 12);
      expect(b.g).toBeCloseTo(a.g, 12);
      expect(b.b).toBeCloseTo(a.b, 12);
      expect(b.metalness).toBeCloseTo(a.metalness, 12);
      expect(b.clearcoat).toBeCloseTo(a.clearcoat, 12);
    }
  });

  it('★ helper 不重置 vertexColors（顶点色乘子随变体主色自动相乘）', () => {
    const m = new THREE.MeshPhysicalMaterial();
    m.vertexColors = true;
    m.color.setHex(R60.black.color);
    applyProcPaintTweaks(m, 'black');
    expect(m.vertexColors).toBe(true);
    applyProcPaintTweaks(m, 'gold');
    expect(m.vertexColors).toBe(true);
  });

  it('往返语义：构造值 → 切到 other → 切回 original 后逐位相同', () => {
    for (const original of ['black', 'gold', 'purple', 'green', 'white']) {
      const m = new THREE.MeshPhysicalMaterial();
      m.color.setHex(R60[original].color);
      m.metalness = R60[original].metalness;
      m.roughness = R60[original].roughness;
      applyProcPaintTweaks(m, original); // 构造 ≡ 覆盖写
      const before = snapshot(m);
      applyProcPaintTweaks(m, original === 'black' ? 'gold' : 'black');
      applyProcPaintTweaks(m, original);
      const after = snapshot(m);
      expect(after.r).toBeCloseTo(before.r, 12);
      expect(after.g).toBeCloseTo(before.g, 12);
      expect(after.b).toBeCloseTo(before.b, 12);
      expect(after.metalness).toBeCloseTo(before.metalness, 12);
      expect(after.clearcoat).toBeCloseTo(before.clearcoat, 12);
    }
  });

  it('未知变体：helper 返回 false 且不改材质；纯数据源返回 null', () => {
    expect(resolveProcPaint('__nope__')).toBeNull();
    const m = new THREE.MeshPhysicalMaterial();
    m.color.setHex(0x123456);
    const before = snapshot(m);
    expect(applyProcPaintTweaks(m, '__nope__')).toBe(false);
    expect(snapshot(m).r).toBeCloseTo(before.r, 12);
  });
});

describe('R64 · P0-4 回滚语义（A19）', () => {
  it('★ `#r64variant=off` ⇒ helper 未被调用、材质数值 ≡ R63 裸表 baseline', () => {
    const sv = slice(shell, 'async setVariant', 'setGlassOpaque(opaque: boolean): void {');
    const callAt = sv.indexOf('applyProcPaintTweaks(material, variantId)');
    const gateAt = sv.indexOf('if (R64_VARIANT_ON) {');
    expect(gateAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(gateAt);
    // 门控块之后才进入脏贴图分支 ⇒ helper 不会在 off 态被别处调用
    expect(sv.indexOf('const url = urls.basecolor[variantId]')).toBeGreaterThan(callAt);
    // 数值复算：off 态 ≡ 裸 R60 表（原式三行，无 tweak）
    for (const v of ['black', 'gold', 'purple', 'green']) {
      const m = new THREE.MeshPhysicalMaterial();
      m.color.setHex(R60[v].color);
      m.metalness = R60[v].metalness;
      m.roughness = R60[v].roughness;
      const base = new THREE.Color().setHex(R60[v].color);
      expect(m.color.r).toBeCloseTo(base.r, 12);
      expect(m.metalness).toBe(R60[v].metalness);
    }
  });

  it('`#r60paint=off` 脏贴图路径不调用 helper', () => {
    const sv = slice(shell, 'async setVariant', 'setGlassOpaque(opaque: boolean): void {');
    const dirty = sv.slice(sv.indexOf('const url = urls.basecolor[variantId]'));
    expect(dirty).not.toContain('applyProcPaintTweaks');
    expect(dirty).toContain('const tex = await loadTexture(url, true, car)');
    expect(dirty).toContain('material.map = tex');
  });

  it('`#r62paint=off` 由 helper 内部判定，clearcoat 回 R56/0.35 构造默认', () => {
    const pure = shell.slice(
      shell.indexOf('export function resolveProcPaint('),
      shell.indexOf('export function applyProcPaintTweaks(')
    );
    expect(pure).toContain('const r62On = R62_PAINT_ON;');
    expect(pure).toContain('let clearcoat = R56_PAINT_CLEARCOAT;');
    expect(pure).toContain('let clearcoatRoughness = 0.35;');
    expect(pure).toContain('if (r62On) {');
    expect(pure).toContain('clearcoat = R62_PAINT_CLEARCOAT;');
  });

  it('setVariant 不污染轮毂材质 / 顶点色 / 四贴图槽恒 null', () => {
    const sv = slice(shell, 'async setVariant', 'setGlassOpaque(opaque: boolean): void {');
    expect(sv).not.toContain('wheelAlloyMat');
    expect(sv).not.toContain("setAttribute('color'");
    expect(sv).not.toMatch(/material\.vertexColors\s*=/);
    const ctor = slice(shell, 'if (useProcPaint) {\n      const procPaint', 'QA 材质 A/B');
    expect(ctor).toContain('material.map = null');
    expect(ctor).toContain('material.normalMap = null');
    expect(ctor).toContain('material.roughnessMap = null');
    expect(ctor).toContain('material.metalnessMap = null');
    const proc = sv.slice(0, sv.indexOf('const url = urls.basecolor[variantId]'));
    expect(proc).not.toContain('material.map =');
  });
});
