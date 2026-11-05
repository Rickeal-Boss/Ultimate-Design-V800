/**
 * R48 灯组空洞 / 过曝修复 + 资产台账契约测试。
 *
 * 定罪依据（.qa/r48/、verify/r46/after/r48*）：
 *  - 消去法：隐藏 lamp_rear 纯白像素 4,218 不变；隐藏 body 白块→376、
 *    红灯 6,037→18,883 ⇒ 白块长在 body 洞口（用户口径「更深处是空洞」），
 *    且 body 一直挡着红灯组。
 *  - 运行时探针：R7 尾灯待机 emissiveIntensity 3.224 ⇒ ACES+bloom 把
 *    0xff1e14 的 G/B 也抬进饱和区 ⇒ 纯白过曝块、开/关灯 Δ≈0。
 *    V800 前灯开灯峰值 3.0 同病。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, '..', rel), 'utf-8').replace(/\r\n/g, '\n');

describe('R48 · 灯组过曝修复（压回线性可用区间）', () => {
  it('两台适配器都有开关且关闭态逐位回滚 R47 公式', () => {
    for (const f of ['src/model/V800Adapter.ts', 'src/model/R7Adapter.ts']) {
      const s = src(f);
      expect(s).toContain('const R48_LAMP_TONE');
      expect(s).toContain('r48tone=off');
      expect(s).toContain('R48_LAMP_TONE\n          ? 0.30 + (brakeLevel');
    }
  });

  it('V800 前灯峰值不再乘 headLevel 原值（3.2×0.9=2.88 过曝）', () => {
    const v = src('src/model/V800Adapter.ts');
    expect(v).toContain('0.12 + (headLevel / HEAD_BASE) * 0.78');
    expect(v).toContain(': 0.12 + headLevel * 0.9; // R47 原状');
  });

  it('R7 尾灯去掉历史 2.6 基座公式，改统一 0.85 斜率', () => {
    const r = src('src/model/R7Adapter.ts');
    expect(r).toContain('0.30 + (brakeLevel + snapT * SNAP_GAIN * 0.12) * 0.85');
  });
});

describe('R48 · R7 尾灯空洞补面', () => {
  it('深色盖板 + 灯组外推 + 贯穿红细带，且留 #r48hole=off 回滚', () => {
    const s = src('src/model/external/ExternalShell.ts');
    expect(s).toContain("housing.name = 'lamp_rear_housing'");
    expect(s).toContain('housing.position.set(0, 0.240 * s, -2.505)');
    expect(s).toContain("if (m.name === 'lamp_rear') m.position.z = -0.06;");
    expect(s).toContain("band.name = 'lamp_rear_band'");
    expect(s).toContain('r48hole=off');
  });

  it('盖板材质有独立 dispose（不泄漏新增材质实例）', () => {
    const s = src('src/model/external/ExternalShell.ts');
    expect(s).toContain('let lampHousingMat: THREE.MeshStandardMaterial | null = null;');
    expect(s).toContain('lampHousingMat?.dispose();');
  });
});

describe('R48 · 资产台账实测刷新 + 四轮判据保留', () => {
  it('两车 tri.body / bodyTri 与实测 GLB 一致', () => {
    const v800 = JSON.parse(src('src/assets/cars/v800/manifest.json'));
    const r7 = JSON.parse(src('src/assets/cars/r7/manifest.json'));
    expect(v800.tri.body).toBe(966_484);
    expect(v800.bodyTri).toBe(966_484);
    expect(v800.semantic.lamp_rear.tri).toBe(17_485);
    expect(r7.tri.body).toBe(882_300);
    expect(r7.bodyTri).toBe(882_300);
    expect(r7.semantic.lamp_rear.tri).toBe(14_333);
  });

  it('wheel-* 四键（hasWheelSplit 判据）全部保留', () => {
    for (const car of ['v800', 'r7']) {
      const m = JSON.parse(src(`src/assets/cars/${car}/manifest.json`));
      for (const k of ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']) {
        expect(m.tri[k]).toBeGreaterThan(50_000);
      }
    }
  });
});
