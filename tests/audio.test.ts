/**
 * 涡扇化 EV 声浪的参数映射回归测试（纯函数层，不依赖 AudioContext）。
 *
 * 锁的是「设计契约」而非数值快照：
 * ① 单调性：spool 上升 → 频率/增益单调不降（全速度域无阶跃、无换挡顿挫）
 * ② 惯性：阶跃输入下 spool 不瞬变，半程耗时落在设计区间
 * ③ 边界：0 速度静音、限速/滑行 spool 回落、无 NaN 无越界
 *
 * 运行：npm test
 */
import { describe, expect, it } from 'vitest';
import {
  BLIP_LEVEL,
  ROAR_HZ0,
  ROAR_HZ1,
  RUMBLE_HZ0,
  RUMBLE_HZ1,
  SPOOL_FALL_TAU,
  SPOOL_RISE_TAU,
  WHINE_F0,
  WHINE_F1,
  spoolStep,
  spoolTarget,
  roarCenterHz,
  roarGain,
  rumbleFreq,
  rumbleGain,
  whineBladeFreq,
  whineDetuneHz,
  whineFreq,
  whineGain
} from '../src/audio/Sfx';
import { VEHICLE } from '../src/config/physics';

const DT = 1 / 120;
/** spool 采样序列（含边界） */
const SWEEP = Array.from({ length: 101 }, (_, i) => i / 100);

function isMonotoneNonDecreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1] - 1e-12) return false;
  }
  return true;
}

describe('spoolTarget：车速/动力状态 → 目标 spool', () => {
  it('静止恒为 0（无论是否通电，静止无声）', () => {
    expect(spoolTarget(0, true)).toBe(0);
    expect(spoolTarget(0, false)).toBe(0);
    expect(spoolTarget(-5, true)).toBe(0);
  });

  it('对车速单调不降，且钳位在 [0,1]', () => {
    const powered = SWEEP.map((n) => spoolTarget(n * VEHICLE.maxSpeedKmh, true));
    expect(isMonotoneNonDecreasing(powered)).toBe(true);
    expect(powered[0]).toBe(0);
    expect(powered[powered.length - 1]).toBeCloseTo(1, 10);
    for (const v of powered) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of powered) expect(v).toBeLessThanOrEqual(1);
    // 超速（>电子限速）不得越界
    expect(spoolTarget(VEHICLE.maxSpeedKmh * 2, true)).toBe(1);
  });

  it('滑行/限速（powered=false）目标低于满载，即「降滑行档」', () => {
    for (const n of [0.2, 0.5, 0.8, 1]) {
      const on = spoolTarget(n * VEHICLE.maxSpeedKmh, true);
      const off = spoolTarget(n * VEHICLE.maxSpeedKmh, false);
      expect(off).toBeLessThan(on);
      expect(off).toBeGreaterThan(0); // 滑行仍有连续降调，不是熄火
    }
    expect(spoolTarget(VEHICLE.maxSpeedKmh, false)).toBeCloseTo(0.55, 10);
  });

  it('非法输入不产生 NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(spoolTarget(bad, true))).toBe(true);
      expect(spoolTarget(bad, true)).toBe(0);
    }
  });
});

describe('spoolStep：一阶惯性（涡扇转子滞后）', () => {
  it('阶跃输入不瞬变：单帧只前进很小一步', () => {
    const first = spoolStep(0, 1, DT, true);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.05);
    const firstDown = spoolStep(1, 0, DT, false);
    expect(firstDown).toBeLessThan(1);
    expect(firstDown).toBeGreaterThan(0.95);
  });

  it('上升半程耗时 ≈ 0.5s×ln2（约 0.347s）', () => {
    let s = 0;
    let t = 0;
    while (s < 0.5 && t < 10) {
      s = spoolStep(s, 1, DT, true);
      t += DT;
    }
    expect(t).toBeGreaterThan(0.32);
    expect(t).toBeLessThan(0.38);
    expect(t).toBeCloseTo(SPOOL_RISE_TAU * Math.LN2, 2);
  });

  it('回落半程耗时 ≈ 0.9s×ln2（约 0.624s），明显慢于上升', () => {
    let s = 1;
    let t = 0;
    while (s > 0.5 && t < 10) {
      s = spoolStep(s, 0, DT, false);
      t += DT;
    }
    expect(t).toBeGreaterThan(0.58);
    expect(t).toBeLessThan(0.68);
    expect(t).toBeCloseTo(SPOOL_FALL_TAU * Math.LN2, 2);
    // 惰转比加速慢（涡扇特征）
    expect(SPOOL_FALL_TAU).toBeGreaterThan(SPOOL_RISE_TAU);
  });

  it('始终朝目标单调推进、不越界、不出 NaN', () => {
    let s = 0;
    for (let i = 0; i < 600; i++) {
      const next = spoolStep(s, 1, DT, true);
      expect(next).toBeGreaterThanOrEqual(s);
      expect(next).toBeLessThanOrEqual(1);
      expect(Number.isFinite(next)).toBe(true);
      s = next;
    }
    expect(s).toBeGreaterThan(0.99);

    for (let i = 0; i < 600; i++) {
      const next = spoolStep(s, 0, DT, false);
      expect(next).toBeLessThanOrEqual(s);
      expect(next).toBeGreaterThanOrEqual(0);
      s = next;
    }
    expect(s).toBeLessThan(0.01);
  });

  it('dt=0 / 非法 dt 保持不变；越界输入被钳位', () => {
    expect(spoolStep(0.4, 1, 0, true)).toBe(0.4);
    expect(spoolStep(0.4, 1, -1, true)).toBe(0.4);
    expect(spoolStep(0.4, 1, NaN, true)).toBe(0.4);
    expect(spoolStep(-3, 1, DT, true)).toBeGreaterThanOrEqual(0);
    expect(spoolStep(2, 0, DT, false)).toBeLessThanOrEqual(1);
    expect(spoolStep(0.5, NaN, DT, true)).toBeLessThanOrEqual(0.5);
  });
});

describe('层 1 · 核心啸叫 whine', () => {
  it('频率随 spool 单调上升，端点 190→1640Hz', () => {
    const freqs = SWEEP.map(whineFreq);
    expect(isMonotoneNonDecreasing(freqs)).toBe(true);
    expect(whineFreq(0)).toBeCloseTo(WHINE_F0, 10);
    expect(whineFreq(1)).toBeCloseTo(WHINE_F1, 10);
    // 严格单调（任意相邻采样都在涨 → 全速度域无音高阶跃平台/跳变）
    for (let i = 1; i < freqs.length; i++) expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
  });

  it('增益 spool=0 严格为 0，且单调不降、上限受控', () => {
    expect(whineGain(0)).toBe(0);
    const gains = SWEEP.map(whineGain);
    expect(isMonotoneNonDecreasing(gains)).toBe(true);
    expect(whineGain(1)).toBeLessThanOrEqual(0.08);
    for (const g of gains) expect(g).toBeGreaterThanOrEqual(0);
  });

  it('失谐差频落在 5–9Hz，叶片通过频率 = 主频 ×2', () => {
    for (const s of SWEEP) {
      const d = whineDetuneHz(s);
      expect(d).toBeGreaterThanOrEqual(5);
      expect(d).toBeLessThanOrEqual(9);
      expect(whineBladeFreq(s)).toBeCloseTo(whineFreq(s) * 2, 10);
    }
  });
});

describe('层 2 · 气流轰鸣 jet roar', () => {
  it('中心频率 800→3500Hz 单调上升', () => {
    const hz = SWEEP.map(roarCenterHz);
    expect(isMonotoneNonDecreasing(hz)).toBe(true);
    expect(roarCenterHz(0)).toBeCloseTo(ROAR_HZ0, 10);
    expect(roarCenterHz(1)).toBeCloseTo(ROAR_HZ1, 10);
  });

  it('增益随 spool 平方上升（低速几乎无，高速推背感）', () => {
    const gains = SWEEP.map(roarGain);
    expect(isMonotoneNonDecreasing(gains)).toBe(true);
    expect(roarGain(0)).toBe(0);
    expect(roarGain(0.5)).toBeCloseTo(roarGain(1) * 0.25, 10);
    expect(roarGain(1)).toBeLessThanOrEqual(0.08);
  });
});

describe('层 3 · 低频机身 rumble（刻意克制）', () => {
  it('频率 44→70Hz 单调上升', () => {
    const hz = SWEEP.map(rumbleFreq);
    expect(isMonotoneNonDecreasing(hz)).toBe(true);
    expect(rumbleFreq(0)).toBeCloseTo(RUMBLE_HZ0, 10);
    expect(rumbleFreq(1)).toBeCloseTo(RUMBLE_HZ1, 10);
  });

  it('增益高次幂：低中速被压到接近静音，仅高速/全加速轻微存在', () => {
    const gains = SWEEP.map(rumbleGain);
    expect(isMonotoneNonDecreasing(gains)).toBe(true);
    expect(rumbleGain(0)).toBe(0);
    expect(rumbleGain(0.5)).toBeLessThan(rumbleGain(1) * 0.2);
    expect(rumbleGain(1)).toBeLessThanOrEqual(0.035);
  });
});

describe('整体链路：spool 序列 → 各层参数（无换挡顿挫 / 无 NaN）', () => {
  it('全速度域扫掠：所有层参数单调不降、无 NaN、无越界', () => {
    let prevWhine = -Infinity;
    let prevRoar = -Infinity;
    let prevRumble = -Infinity;
    for (const s of SWEEP) {
      const w = whineFreq(s);
      const rg = roarGain(s);
      const bg = rumbleGain(s);
      for (const v of [w, whineGain(s), roarCenterHz(s), rg, rumbleFreq(s), bg]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(w).toBeGreaterThanOrEqual(prevWhine);
      expect(rg).toBeGreaterThanOrEqual(prevRoar);
      expect(bg).toBeGreaterThanOrEqual(prevRumble);
      prevWhine = w;
      prevRoar = rg;
      prevRumble = bg;
    }
  });

  it('加速→滑行→制动：spool 先升后连续回落，音高同步降调（不熄火）', () => {
    // 全油门从 0 加速到电子限速
    let spool = 0;
    let speed = 0;
    for (let i = 0; i < 120 * 12; i++) {
      speed = Math.min(VEHICLE.maxSpeedKmh, speed + 30 * DT);
      const target = spoolTarget(speed, true);
      spool = spoolStep(spool, target, DT, target > spool);
    }
    expect(speed).toBeCloseTo(VEHICLE.maxSpeedKmh, 6);
    expect(spool).toBeGreaterThan(0.95);
    const topWhine = whineFreq(spool);

    // 松油门进入滑行（限速/动力退出），spool 平滑回落到滑行档
    let coastTicks = 0;
    let prev = spool;
    while (coastTicks < 120 * 3) {
      const target = spoolTarget(speed, false);
      spool = spoolStep(spool, target, DT, target > spool);
      expect(spool).toBeLessThanOrEqual(prev + 1e-12); // 单调回落，无反弹
      prev = spool;
      coastTicks++;
    }
    expect(spool).toBeLessThan(0.95);
    expect(spool).toBeGreaterThan(0); // 仍在转，不是熄火
    expect(whineFreq(spool)).toBeLessThan(topWhine); // 连续降调

    // 制动到停：spool 收敛到 0，whine 增益归零
    for (let i = 0; i < 120 * 30; i++) {
      speed = Math.max(0, speed - 30 * DT);
      const target = spoolTarget(speed, false);
      spool = spoolStep(spool, target, DT, target > spool);
    }
    expect(speed).toBe(0);
    expect(spool).toBeLessThan(0.01);
    expect(whineGain(spool)).toBeLessThan(0.001);
  });

  it('revBlip 是有限幅度的短促 spool 冲击，不会顶满', () => {
    expect(BLIP_LEVEL).toBeGreaterThan(0);
    expect(BLIP_LEVEL).toBeLessThan(1);
    // 静止时 blip 抬起的 spool 远低于全速 spool，且不会造成音高跳到顶端
    let s = 0;
    for (let i = 0; i < 60; i++) s = spoolStep(s, BLIP_LEVEL, DT, true);
    expect(s).toBeGreaterThan(0.05);
    expect(s).toBeLessThan(BLIP_LEVEL);
    expect(whineFreq(s)).toBeLessThan(WHINE_F1);
  });
});
