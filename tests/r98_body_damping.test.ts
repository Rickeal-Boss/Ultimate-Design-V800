import { describe, expect, it } from 'vitest';
import { FREE_BODY_DAMPING } from '../src/config/freeBodyFeel';

describe('R98 车身动态阻尼', () => {
  it('侧倾/俯仰阻尼比 R96 写死的 6/4 更慢，呈现 heavier body', () => {
    expect(FREE_BODY_DAMPING.roll).toBeGreaterThan(0);
    expect(FREE_BODY_DAMPING.roll).toBeLessThan(6);
    expect(FREE_BODY_DAMPING.pitch).toBeGreaterThan(0);
    expect(FREE_BODY_DAMPING.pitch).toBeLessThan(4);
  });

  it('时间常数落在 0.25~0.35s（中大型旗舰车身余韵）', () => {
    const rollTau = 1 / FREE_BODY_DAMPING.roll;
    const pitchTau = 1 / FREE_BODY_DAMPING.pitch;
    expect(rollTau).toBeGreaterThanOrEqual(0.25);
    expect(rollTau).toBeLessThanOrEqual(0.30);
    expect(pitchTau).toBeGreaterThanOrEqual(0.30);
    expect(pitchTau).toBeLessThanOrEqual(0.35);
  });

  it('固定对象，运行时不可被业务代码改坏', () => {
    expect(Object.isFrozen(FREE_BODY_DAMPING)).toBe(true);
  });
});
