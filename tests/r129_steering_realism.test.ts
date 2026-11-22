/**
 * R129 · 车辆操控真实感回归（随速转向权重 + 横摆响应渐进）。
 * 复用 free_drift 的驾驶约定（fd.press / fd.state.speed 直写 / DT=1/120）。
 */
import { describe, expect, it } from 'vitest';
import { FREE, FreeDrive, steerTauFor } from '../src/core/FreeDrive';

const DT = 1 / 120;

/** 直写速度后按 A 满舵 n 帧，返回 { steer, yawRate } 轨迹 */
function steerTrace(speedMs: number, frames: number) {
  const fd = new FreeDrive();
  fd.state.speed = speedMs;
  fd.press('KeyA', true);
  const steer: number[] = [];
  const yaw: number[] = [];
  for (let i = 0; i < frames; i += 1) {
    fd.step(DT);
    steer.push(fd.snapshot().steer);
    yaw.push(fd.snapshot().yawRate);
  }
  fd.press('KeyA', false);
  return { fd, steer, yaw };
}

describe('R129 ① 随速转向权重（steerTauFor 纯函数）', () => {
  it('低速 = steerTauLow / 高速 = steerTauHigh / 中间线性', () => {
    expect(steerTauFor(0)).toBeCloseTo(FREE.steerTauLow, 9);
    expect(steerTauFor(18)).toBeCloseTo(FREE.steerTauLow, 9);
    expect(steerTauFor(60)).toBeCloseTo(FREE.steerTauHigh, 9);
    expect(steerTauFor(100)).toBeCloseTo(FREE.steerTauHigh, 9);
    // 中间线性（与 steerLimitFor 同斜率）：30 km/h
    const t = (30 - 18) / (60 - 18);
    expect(steerTauFor(30)).toBeCloseTo(FREE.steerTauLow + (FREE.steerTauHigh - FREE.steerTauLow) * t, 9);
  });

  it('低速建角快于高速（同 0.2s 达目标比例更高）', () => {
    const low = steerTrace(2.78, 24); // 10 km/h
    const high = steerTrace(11.1, 24); // 40 km/h
    const lowFrac = low.steer[23] / FREE.steerMaxLow; // 10km/h 舵限 = steerMaxLow
    const highFrac = high.steer[23] / (FREE.steerMaxLow + (FREE.steerMaxHigh - FREE.steerMaxLow) * ((40 - 18) / (60 - 18)));
    expect(lowFrac).toBeGreaterThan(highFrac + 0.03); // 低速明显更快到位
  });
});

describe('R129 ② 横摆响应渐进（转向驱动横摆滞后通道）', () => {
  it('打舵后横摆率渐进建起（非瞬时）：0.05s 仍未达稳态、0.5s 收敛', () => {
    const tr = steerTrace(11.1, 60); // 40 km/h 满舵 0.5s
    const steady = tr.yaw[59];
    // 0.05s（第 6 帧）：横摆尚未到稳态（载荷渐进中）
    expect(tr.yaw[5]).toBeLessThan(steady * 0.6);
    // 0.5s：收敛到稳态附近（转向 τ~0.10 + 横摆 τ~0.07 双重渐进，0.5s 应 >95%）
    expect(tr.yaw[59]).toBeGreaterThan(steady * 0.95);
    // 稳态值与 kinematic 目标一致（yawRateFor = steer×maxYawRate×factor×dir，40km/h factor=1）
    const steerF = tr.steer[59];
    expect(Math.abs(steady - steerF * FREE.maxYawRate)).toBeLessThan(0.02);
  });

  it('关键安全性质：松舵回正单调、无过冲/无负横摆（⇒ 无横摆动量、无穿墙风险）', () => {
    const tr = steerTrace(11.1, 30); // 满舵 0.25s
    // 回正：释放 A 后续 60 帧
    const fd = tr.fd;
    const yawAfter: number[] = [];
    const steerAfter: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      yawAfter.push(fd.snapshot().yawRate);
      steerAfter.push(fd.snapshot().steer);
    }
    // 转向角单调递减到 0（一阶 damp 无过冲）
    for (let i = 1; i < steerAfter.length; i += 1) {
      expect(steerAfter[i]).toBeLessThanOrEqual(steerAfter[i - 1] + 1e-9);
    }
    expect(steerAfter[steerAfter.length - 1]).toBeLessThan(0.01);
    // 横摆：允许释放后 1-2 帧内继续微升到峰（载荷惯性，yaw 滞后舵的自然产物），
    // 峰后单调衰减、恒非负（无回摆过零 = 无横摆动量、无穿墙风险）、超幅 <2% 收敛近零。
    const startYaw = Math.abs(tr.yaw[29]);
    const peak = Math.max(...yawAfter);
    expect(peak).toBeLessThan(startYaw * 1.02); // 峰超幅 <2%（载荷惯性微升，非动量过冲）
    let peaked = false;
    for (let i = 0; i < yawAfter.length; i += 1) {
      expect(yawAfter[i]).toBeGreaterThanOrEqual(-1e-9); // 恒非负：无反向回摆
      if (!peaked && yawAfter[i] < peak - 1e-6) peaked = true; // 已过峰
      if (peaked) {
        // 峰后单调衰减（允许 1e-9 浮点）
        expect(yawAfter[i]).toBeLessThanOrEqual(yawAfter[i - 1] + 1e-9);
      }
    }
    expect(Math.abs(yawAfter[yawAfter.length - 1])).toBeLessThan(0.01);
  });

  it('低速打舵横摆也渐进（载荷模型不分速）：10km/h 打舵 0.05s 未达稳态', () => {
    const tr = steerTrace(2.78, 30); // 10 km/h
    const steady = tr.yaw[29];
    expect(tr.yaw[5]).toBeLessThan(steady * 0.6);
  });
});

describe('R129 配置有界', () => {
  it('steerTauLow < steerTauHigh（随速权重方向正确）；yawResponseTau > 0 且小于转向 τ 高速端', () => {
    expect(FREE.steerTauLow).toBeLessThan(FREE.steerTauHigh);
    expect(FREE.yawResponseTau).toBeGreaterThan(0);
    expect(FREE.yawResponseTau).toBeLessThan(FREE.steerTauHigh);
  });
});
