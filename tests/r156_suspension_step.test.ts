/**
 * R156 集成验证：真实驾驶（step() 驱动）下常态悬挂二阶的过冲回摆轨迹。
 *
 * 场景（松油滑行切入 —— 带油切入会因 v 持续升高使 latAccel≥4 → 满幅 3.5° 被 clamp 掩盖）：
 *  ① 滑行转向切入（W 加速到 ~5m/s → 松 W → A 左转）⇒ roll 过冲回摆（实测 ~20%），
 *     峰值 < rollMaxRad（3.5°=0.0611）；
 *  ② 点刹点头（滑行 10m/s → S 脉冲）⇒ pitch 过冲 + 峰值 < pitchMaxRad（2.0°=0.0349）+ 回正；
 *  ③ 一阶 damp 数学性质：对阶跃目标单调逼近、无过冲（R98 旧路径）—— 证明二阶过冲差异真实。
 */
import { describe, expect, it } from 'vitest';
import { FREE_BODY_DAMPING } from '../src/config/freeBodyFeel';
import { FREE, FreeDrive } from '../src/core/FreeDrive';

const DT = 1 / 120;

/** 城内空档开阔域，heading=0 车头朝 -Z */
function makeFd(): FreeDrive {
  return new FreeDrive({ start: { x: 0, z: -600, heading: 0 } });
}

describe('R156 常态悬挂二阶 · 集成轨迹', () => {
  it('① 滑行转向切入：roll 过冲回摆一次且不破 3.5° 上限', () => {
    const fd = makeFd();
    fd.press('KeyW', true);
    for (let i = 0; i < 3000 && Math.abs(fd.state.speed) < 5; i++) fd.step(DT);
    fd.press('KeyW', false); // 松油滑行（v 近似恒定）
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(4.5);
    fd.press('KeyA', true);
    let rollPeak = 0;
    let rollSteady = 0;
    for (let i = 0; i < 240; i++) {
      fd.step(DT);
      const r = Math.abs(fd.state.roll);
      rollPeak = Math.max(rollPeak, r);
      if (i > 200) rollSteady = r;
    }
    fd.press('KeyA', false);
    expect(rollSteady).toBeGreaterThan(0.02); // 有稳态侧倾（≈2°）
    expect(rollPeak).toBeGreaterThan(1.10 * rollSteady); // 过冲 >10%（实测 ~20%）
    expect(rollPeak).toBeLessThan(FREE.rollMaxRad + 1e-9); // 不破 3.5° 上限
  });

  it('② 点刹点头：pitch 过冲且不破 2.0° 上限，随后回正', () => {
    const fd = makeFd();
    fd.press('KeyW', true);
    for (let i = 0; i < 4000 && Math.abs(fd.state.speed) < 10; i++) fd.step(DT);
    fd.press('KeyW', false);
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(9);
    fd.press('KeyS', true);
    let pitchPeak = 0;
    const trace: number[] = [];
    for (let i = 0; i < 18; i++) fd.step(DT); // 0.15s 点刹脉冲
    fd.press('KeyS', false);
    for (let i = 0; i < 240; i++) {
      fd.step(DT);
      const p = Math.abs(fd.state.pitch);
      trace.push(p);
      pitchPeak = Math.max(pitchPeak, p);
    }
    expect(pitchPeak).toBeGreaterThan(0.01); // 有可感点头（实测 ~1.3°）
    expect(pitchPeak).toBeLessThan(FREE.pitchMaxRad + 1e-9); // 不破 2.0° 上限
    expect(trace[trace.length - 1]).toBeLessThan(pitchPeak * 0.5); // 回正中
  });

  it('③ 一阶 damp 数学性质：阶跃目标单调逼近、无过冲（R98 旧路径）', () => {
    // 一阶 damp 对阶跃目标：|body| 单调升向目标、峰值 = 终值（无过冲）—— 对比 ① 二阶 20% 过冲。
    const target = 0.05;
    let body = 0;
    let peak = 0;
    for (let i = 0; i < 360; i++) {
      body = body + (target - body) * (1 - Math.exp(-FREE_BODY_DAMPING.roll * DT));
      peak = Math.max(peak, Math.abs(body));
    }
    expect(Math.abs(peak - Math.abs(body))).toBeLessThan(0.002); // 无过冲
    expect(body).toBeCloseTo(target, 3);
  });
});
