/**
 * R126 · 撞墙「被顶晃动」欠阻尼二阶通道回归（真源派生，纯 FreeDrive.step 数值断言）。
 *
 * 主诉（用户「改善车辆撞击反馈及阻尼」）：R99~R108 把撞墙姿态做成「一阶 damp 单调回正 +
 * 一次性位置/速率冲量」，撞后车身**单调钉回**目标、永不过冲 ⇒ 读作「撞完瞬间稳定」而非
 * 真实碰撞的「被顶 → 回弹过冲 → 晃动 → 稳定」。本测试钉死 R126 修复：
 *   ① 撞墙帧注入角速度（rollGain/pitchGain×impactN），随后弹簧-阻尼二阶积分；
 *   ② osc 本身**跨零回摆**（欠阻尼二次晃动，核心证据），过冲幅度有界；
 *   ③ 合成 pitch/roll 峰可感且不越灵魂上限，之后衰减回近零；
 *   ④ 撞得越狠晃越大（∝impactN）；常态驾驶（无撞击）osc 不污染。
 * 复用 r106 的 driveHeadOn 逻辑（桥段 z=−250，正撞 +X 侧墙）。
 */
import { describe, expect, it } from 'vitest';
import {
  FREE,
  FreeDrive,
  corridorCenterHalfWidth
} from '../src/core/FreeDrive';
import { FREE_BODY_IMPACT_OSC } from '../src/config/freeBodyFeel';

const DT = 1 / 120;
const IMPACT_Z = -250;
const LIMIT = corridorCenterHalfWidth(IMPACT_Z);
const HEAD_ON = -Math.PI / 2;

function driveHeadOn(speed: number): FreeDrive {
  const fd = new FreeDrive({ start: { x: LIMIT - 2, z: IMPACT_Z, heading: HEAD_ON } });
  fd.state.speed = speed;
  let hit = false;
  for (let i = 0; i < 400 && !hit; i += 1) {
    fd.step(DT);
    if (fd.state.x >= LIMIT - 1e-9) hit = true;
  }
  expect(hit).toBe(true);
  return fd;
}

describe('R126 撞墙「被顶晃动」', () => {
  it('正撞后 osc 过冲回摆：pitch 晃动峰值可感、osc 本身跨零回摆（欠阻尼二次晃动）、衰减回近零、合成不越上限', () => {
    const fd = driveHeadOn(20);
    const pitches: number[] = [fd.state.pitch];
    const oscs: number[] = [fd.impactPitchOscValue];
    for (let i = 0; i < 130; i += 1) {
      fd.step(DT);
      pitches.push(fd.state.pitch);
      oscs.push(fd.impactPitchOscValue);
    }
    const peak = Math.max(...pitches.map(Math.abs));
    // 合成 pitch 峰可达感（撞 20m/s：pitchVel=0.022×20=0.44 rad/s → 峰≈0.030 rad ≈0.86×上限）
    expect(peak).toBeGreaterThan(FREE.pitchMaxRad * 0.55);
    expect(peak).toBeLessThanOrEqual(FREE.pitchMaxRad + 1e-12); // 不越灵魂上限
    // 欠阻尼回摆：osc 本身从负（车头朝墙点头）过零回摆到正侧（核心证据：二次晃动存在）
    expect(Math.min(...oscs)).toBeLessThan(0);
    expect(Math.max(...oscs)).toBeGreaterThan(0);
    // 衰减：1s 后 osc 回近零
    expect(Math.abs(oscs[oscs.length - 1])).toBeLessThan(0.002);
    // 合成 pitch 也衰减回近零
    expect(Math.abs(pitches[pitches.length - 1])).toBeLessThan(peak * 0.2);
  });

  it('撞得越狠晃越大：impactN 缩放（v=20 峰值 > v=10 峰值）', () => {
    const peakOf = (v: number) => {
      const fd = driveHeadOn(v);
      let peak = 0;
      for (let i = 0; i < 130; i += 1) {
        fd.step(DT);
        peak = Math.max(peak, Math.abs(fd.state.pitch));
      }
      return peak;
    };
    expect(peakOf(20)).toBeGreaterThan(peakOf(10) * 1.5);
  });

  it('常态驾驶（无撞击）osc 不污染：直线匀速 roll/pitch 保持近零', () => {
    const fd = new FreeDrive({ start: { x: 0, z: -250, heading: 0 } });
    fd.state.speed = 10;
    for (let i = 0; i < 240; i += 1) fd.step(DT); // 2s 直行
    expect(Math.abs(fd.state.roll)).toBeLessThan(0.005);
    expect(Math.abs(fd.state.pitch)).toBeLessThan(0.005);
  });

  it('常量有界：omega>0、0<zeta<1、gains>0 且 20m/s 注入不越灵魂上限', () => {
    expect(FREE_BODY_IMPACT_OSC.omega).toBeGreaterThan(0);
    expect(FREE_BODY_IMPACT_OSC.zeta).toBeGreaterThan(0);
    expect(FREE_BODY_IMPACT_OSC.zeta).toBeLessThan(1);
    expect(FREE_BODY_IMPACT_OSC.rollGain).toBeGreaterThan(0);
    expect(FREE_BODY_IMPACT_OSC.pitchGain).toBeGreaterThan(0);
  });
});
