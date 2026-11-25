/**
 * R156 常态悬挂二阶（FREE_BODY_SUSPENSION / stepSuspension）。
 *
 * 契约（与实现注释一致）：
 *  ① 目标突变（转向切入/刹车点头）⇒ 簧上质量过冲回摆一次（ζ=0.45 ⇒ 超调 ~20%），再收敛；
 *  ② 目标恒定 ⇒ 稳态 body=target（幅值标定逐位不变）；
 *  ③ ζ≥0.4 ⇒ 无持续振荡（速度长程衰减到 0）；
 *  ④ 时间尺度与 R98 一阶量级对齐（90% 收敛 < 1s），防回正观感突变；
 *  ⑤ 常量冻结 + 值域红线（ω=8.5 / ζ=0.45）。
 */
import { describe, expect, it } from 'vitest';
import { FREE_BODY_SUSPENSION } from '../src/config/freeBodyFeel';
import { stepSuspension } from '../src/core/FreeDrive';

const DT = 1 / 120;

/** 从 (body,vel)=(0,0) 起对恒定目标 target 积分，返回逐帧轨迹 */
function simulate(target: number, seconds: number, omega = FREE_BODY_SUSPENSION.omega, zeta = FREE_BODY_SUSPENSION.zeta) {
  let body = 0;
  let vel = 0;
  const trace: number[] = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    [body, vel] = stepSuspension(body, vel, target, omega, zeta, DT);
    trace.push(body);
  }
  return { trace, body, vel };
}

describe('R156 常态悬挂二阶', () => {
  it('① 阶跃目标：过冲回摆一次（超调 >10%）后收敛到目标', () => {
    const target = 0.05; // 约 2.9° 侧倾量级
    const { trace, body, vel } = simulate(target, 3);
    const peak = Math.max(...trace);
    const overshoot = (peak - target) / target;
    expect(overshoot).toBeGreaterThan(0.10); // 一次清晰回摆
    expect(overshoot).toBeLessThan(0.35); // 不失控（ζ=0.45 ⇒ ~20%）
    expect(body).toBeCloseTo(target, 3); // 收敛
    expect(Math.abs(vel)).toBeLessThan(1e-3); // 静止
  });

  it('② 目标恒定：稳态 = 目标（幅值标定不变）', () => {
    const target = 0.03;
    const { body } = simulate(target, 5);
    expect(body).toBeCloseTo(target, 4);
  });

  it('③ ζ≥0.4：无持续振荡（长程速度衰减）', () => {
    // 从初速扰动起（等价撞墙后残留速度），ζ=0.45 应阻尼收敛无极限环
    let body = 0;
    let vel = 0.5; // 初始角速度扰动 rad/s
    for (let i = 0; i < 600; i++) {
      [body, vel] = stepSuspension(body, vel, 0, FREE_BODY_SUSPENSION.omega, FREE_BODY_SUSPENSION.zeta, DT);
    }
    expect(Math.abs(body)).toBeLessThan(1e-3);
    expect(Math.abs(vel)).toBeLessThan(1e-3);
  });

  it('④ 时间尺度与 R98 一阶量级对齐（90% 收敛 < 1s）', () => {
    // 90% 收敛时间：|body−target| 降到 0.1·target 的首帧时间
    const target = 0.05;
    let body = 0;
    let vel = 0;
    let t90 = -1;
    const steps = Math.round(1.5 / DT);
    for (let i = 0; i < steps; i++) {
      [body, vel] = stepSuspension(body, vel, target, FREE_BODY_SUSPENSION.omega, FREE_BODY_SUSPENSION.zeta, DT);
      if (t90 < 0 && Math.abs(body - target) < 0.1 * target) t90 = (i + 1) * DT;
    }
    expect(t90).toBeGreaterThan(0);
    expect(t90).toBeLessThan(1.0);
  });

  it('⑤ 常量冻结 + 值域红线（ω=8.5 / ζ=0.45）', () => {
    expect(Object.isFrozen(FREE_BODY_SUSPENSION)).toBe(true);
    expect(FREE_BODY_SUSPENSION.omega).toBeCloseTo(8.5, 5);
    expect(FREE_BODY_SUSPENSION.zeta).toBeCloseTo(0.45, 5);
  });
});
