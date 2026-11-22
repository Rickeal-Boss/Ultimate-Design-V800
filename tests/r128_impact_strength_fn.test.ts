/**
 * R128 · 撞击强度归一化纯函数（freeImpactStrength）回归。
 *
 * 背景：R127 把 wall/hall 事件强度归一化做成 FreeDrive 内部闭包，挑战撞主殿（crash 演出）
 * 的 shake/音效仍固定（0.5 / 1）。R128 把归一化提为**导出纯函数 freeImpactStrength**
 * 作单一真源，挑战撞主殿复用 `0.5 × strength` 缩放 —— 所有撞击通道同一口径。
 * 本测试钉死纯函数契约：
 *   ① 0 → 0（无撞击无反馈）；
 *   ② REF（25 m/s）→ 1（满幅基准）；
 *   ③ 超 REF（40）→ clamp 到 1；
 *   ④ 半幅（12.5）→ 0.5；
 *   ⑤ 负值 → 0（不反向）；
 *   ⑥ 单调递增（撞得越狠反馈越大）。
 */
import { describe, expect, it } from 'vitest';
import { FREE_IMPACT_STRENGTH_N_REF, freeImpactStrength } from '../src/core/FreeDrive';

describe('R128 freeImpactStrength 归一化纯函数', () => {
  it('0 → 0（无撞击无反馈）', () => {
    expect(freeImpactStrength(0)).toBe(0);
  });

  it('REF（25 m/s）→ 1（满幅基准）', () => {
    expect(freeImpactStrength(FREE_IMPACT_STRENGTH_N_REF)).toBe(1);
  });

  it('超 REF（40 m/s）→ clamp 到 1（不超界）', () => {
    expect(freeImpactStrength(40)).toBe(1);
  });

  it('半幅（12.5 m/s）→ 0.5', () => {
    expect(freeImpactStrength(FREE_IMPACT_STRENGTH_N_REF / 2)).toBeCloseTo(0.5, 9);
  });

  it('负值 → 0（不反向）', () => {
    expect(freeImpactStrength(-5)).toBe(0);
  });

  it('单调递增：撞得越狠反馈越大', () => {
    const s5 = freeImpactStrength(5);
    const s10 = freeImpactStrength(10);
    const s15 = freeImpactStrength(15);
    const s20 = freeImpactStrength(20);
    expect(s5).toBeLessThan(s10);
    expect(s10).toBeLessThan(s15);
    expect(s15).toBeLessThan(s20);
  });

  it('值域恒 ∈ [0,1]', () => {
    for (const v of [-10, 0, 3, 12.5, 25, 30, 99]) {
      const s = freeImpactStrength(v);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
