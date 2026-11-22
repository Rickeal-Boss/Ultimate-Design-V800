/**
 * R130 · 车辆操控真实感回归（caster 自回正不对称：松舵回正快于打舵建角）。
 * 复用 r129 驾驶约定（fd.press / fd.state.speed 直写 / DT=1/120）。
 */
import { describe, expect, it } from 'vitest';
import { FREE, FreeDrive, steerTauFor } from '../src/core/FreeDrive';

const DT = 1 / 120;

/** 直写速度后按 A 满舵 buildFrames → 释放回正 releaseFrames，返回轨迹 */
function driveAndRelease(speedMs: number, buildFrames: number, releaseFrames: number) {
  const fd = new FreeDrive();
  fd.state.speed = speedMs;
  fd.press('KeyA', true);
  const buildSteer: number[] = [];
  for (let i = 0; i < buildFrames; i += 1) {
    fd.step(DT);
    buildSteer.push(fd.snapshot().steer);
  }
  fd.press('KeyA', false);
  const retSteer: number[] = [];
  for (let i = 0; i < releaseFrames; i += 1) {
    fd.step(DT);
    retSteer.push(fd.snapshot().steer);
  }
  return { fd, buildSteer, retSteer };
}

describe('R130 ① caster 自回正纯函数（steerTauFor returning 参）', () => {
  it('回正 τ = 建角 τ × steerReturnRatio（全速域），且 <1（回正更快）', () => {
    expect(FREE.steerReturnRatio).toBeGreaterThan(0);
    expect(FREE.steerReturnRatio).toBeLessThan(1);
    for (const kmh of [0, 18, 30, 40, 60, 100]) {
      expect(steerTauFor(kmh, true)).toBeCloseTo(steerTauFor(kmh, false) * FREE.steerReturnRatio, 12);
      expect(steerTauFor(kmh, true)).toBeLessThan(steerTauFor(kmh, false));
    }
    // 默认（1 参）逐位不变 = 建角路径
    expect(steerTauFor(40, false)).toBeCloseTo(steerTauFor(40), 12);
  });
});

describe('R130 ② 回正快于建角（轨迹实证）', () => {
  it('40km/h：松舵 90% 回正帧数 < 打舵 90% 建角帧数', () => {
    const speed = 11.1; // 40 km/h
    const full = FREE.steerMaxLow + (FREE.steerMaxHigh - FREE.steerMaxLow) * ((40 - 18) / (60 - 18));
    const tr = driveAndRelease(speed, 60, 60);
    // 建角：找首帧达 90% 目标
    let build90 = -1;
    for (let i = 0; i < tr.buildSteer.length; i += 1) {
      if (Math.abs(tr.buildSteer[i]) >= full * 0.9) { build90 = i; break; }
    }
    const peak = Math.abs(tr.buildSteer[tr.buildSteer.length - 1]); // 满舵末帧 ≈ full
    // 回正：找首帧衰减到峰 10%（= 90% 回正）
    let ret90 = -1;
    for (let i = 0; i < tr.retSteer.length; i += 1) {
      if (Math.abs(tr.retSteer[i]) <= peak * 0.1) { ret90 = i; break; }
    }
    expect(build90).toBeGreaterThan(0);
    expect(ret90).toBeGreaterThan(0);
    expect(ret90).toBeLessThan(build90); // 回正更快（caster 自回正）
    // 数值验证：回正帧数 ≈ 建角帧数 × ratio（一阶阻尼 90% 时间 ∝ τ）
    const tauBuild = steerTauFor(40, false);
    const tauRet = steerTauFor(40, true);
    const expectRet = Math.round(build90 * (tauRet / tauBuild));
    expect(Math.abs(ret90 - expectRet)).toBeLessThanOrEqual(3); // 允许离散帧误差
  });
});

describe('R130 ③ 关键安全性质（回正加速不破坏单调/无过冲）', () => {
  it('松舵后转向角单调递减到近零、无过冲/无负', () => {
    const tr = driveAndRelease(11.1, 30, 90);
    for (let i = 1; i < tr.retSteer.length; i += 1) {
      expect(tr.retSteer[i]).toBeLessThanOrEqual(tr.retSteer[i - 1] + 1e-9);
    }
    expect(tr.retSteer[tr.retSteer.length - 1]).toBeGreaterThanOrEqual(0);
    expect(tr.retSteer[tr.retSteer.length - 1]).toBeLessThan(0.005);
  });

  it('反向满舵（counter-steer）不被误判为回正：过零时间符合建角 τ（非回正 τ）', () => {
    const speed = 11.1; // 40 km/h
    const fd = new FreeDrive();
    fd.state.speed = speed;
    fd.press('KeyA', true);
    for (let i = 0; i < 60; i += 1) fd.step(DT); // 满舵 0.5s → 近 +full
    fd.press('KeyA', false);
    fd.press('KeyD', true); // 反向满舵 → target=-full
    let zeroFrame = -1;
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      if (zeroFrame < 0 && fd.snapshot().steer <= 0) { zeroFrame = i; break; }
    }
    expect(zeroFrame).toBeGreaterThan(0);
    const tZero = zeroFrame * DT;
    const tauBase = steerTauFor(40, false);
    const tBase = tauBase * Math.log(2); // 一阶 damp +full→-full 过零 = τ·ln2
    const tRet = tauBase * FREE.steerReturnRatio * Math.log(2);
    // 过零应贴建角 τ（±1.5 帧），明确区分回正 τ（tRet 更早）
    expect(Math.abs(tZero - tBase)).toBeLessThanOrEqual(1.5 * DT);
    expect(tZero).toBeGreaterThan(tRet + 1.5 * DT);
  });
});

describe('R130 ④ 速度依赖继承', () => {
  it('回正 τ 仍随速（高速回正慢于低速回正）', () => {
    expect(steerTauFor(60, true)).toBeGreaterThan(steerTauFor(10, true));
    // 轨迹：10km/h 回正比 40km/h 回正更快到位（90% 帧数更少）
    const low = driveAndRelease(2.78, 30, 60);
    const high = driveAndRelease(11.1, 30, 60);
    const peakLow = Math.abs(low.buildSteer[low.buildSteer.length - 1]);
    const peakHigh = Math.abs(high.buildSteer[high.buildSteer.length - 1]);
    const ret90Low = low.retSteer.findIndex((s) => Math.abs(s) <= peakLow * 0.1);
    const ret90High = high.retSteer.findIndex((s) => Math.abs(s) <= peakHigh * 0.1);
    expect(ret90Low).toBeGreaterThan(0);
    expect(ret90High).toBeGreaterThan(0);
    expect(ret90Low).toBeLessThan(ret90High);
  });
});
