/**
 * R131 · 车辆转向物理回归（横向抓地极限 / 推头根治）。
 * 承接 R130 后续方向 #1「横向抓地极限推头（0.36g 封顶远低于 0.92g）」。
 *
 * 基线（R130 前）诊断：正常运动学路径 yawRateFor **无侧向附着上限**，latAccel=yawRate·v
 * 包络**非单调**——20km/h≈0.31g → 72km/h **0.22g**（凹坑 = 中速推头，比 35km/h 还弱）
 * → 200km/h 0.61g（靠舵角硬给，无抓地上限）。R131 修法：
 *   ① steerMaxHigh 0.12 → 0.48（60km/h 处舵角包络与抓地包络相切 ⇒ 包络单调）；
 *   ② 新增 gripLatFactor=0.80（× tyreMu·g ≈ 0.74g = ESC/稳定限度侧向附着）；
 *   ③ yawRateFor 加抓地钳 |yawRate| ≤ gripLat/max(av, refSpeedMs)（前轮饱和 → 推头）。
 *
 * 判定：包络单调升到 0.74g 后平坦（真车恒定附着）、中速不再推头、高速有界无甩尾。
 * 复用 r129/r130 驾驶约定（fd.press / fd.state.speed 直写 / DT=1/120）。
 */
import { describe, expect, it } from 'vitest';
import { FREE, FreeDrive, steerLimitFor, yawRateFor } from '../src/core/FreeDrive';

const DT = 1 / 120;
const G = 9.81;
/** 可用侧向附着（抓地上限）m/s²：gripLatFactor·tyreMu·g */
const gripLat = FREE.tyreMu * G * FREE.gripLatFactor;

/** 满舵（steerLimitFor(kmh)）下某速度的稳态横向加速度 m/s² */
function latAccelAt(kmh: number): number {
  const ms = kmh / 3.6;
  return Math.abs(yawRateFor(steerLimitFor(kmh), ms)) * ms;
}

describe('R131 ① 抓地钳位纯函数（yawRateFor）', () => {
  it('低速不钳（≤refSpeedMs）：全舵 = 运动学几何目标（低速敏捷不变）', () => {
    // av < refSpeedMs：cap = gripLat/refSpeedMs（常量 ≥ maxYawRate ⇒ 不钳）
    const ms = 3; // 10.8 km/h
    // R157 几何：kin = v·tan(δmax)/L（低速满舵 R=L/tan(δmax)=4.8m）
    const kin = (ms * Math.tan(FREE.steerMaxLow)) / (FREE.axleFront + FREE.axleRear);
    expect(yawRateFor(FREE.steerMaxLow, ms)).toBeCloseTo(kin, 9);
    // cap 确不钳：cap ≥ maxYawRate ≥ kin
    expect(gripLat / FREE.refSpeedMs).toBeGreaterThanOrEqual(FREE.maxYawRate);
  });

  it('高速抓地钳：latAccel ≡ gripLat（附着上限，平坦），且与舵角无关（推头）', () => {
    const ms = 100 / 3.6; // 100 km/h
    const capYaw = gripLat / ms;
    // 满舵与更大舵角（超抓地点）同横摆率 = 前轮饱和 → 推头（更打舵不增横摆）
    expect(yawRateFor(steerLimitFor(100), ms)).toBeCloseTo(capYaw, 9);
    expect(yawRateFor(0.60, ms)).toBeCloseTo(yawRateFor(steerLimitFor(100), ms), 9);
    // R157 几何：高速 kin=v·tan(δ)/L 随 v 线性增 ⇒ 小舵角(0.10)已超抓地（0.813>cap 0.26）
    //   = 真实物理（高速任何打舵都很快超抓地 → 前轮饱和推头），latAccel 仍恰 = gripLat。
    const small = 0.10;
    expect(yawRateFor(small, ms)).toBeCloseTo(capYaw, 9);
    expect(Math.abs(yawRateFor(small, ms))).toBeLessThanOrEqual(capYaw);
    // latAccel 恰为抓地上限（平坦）
    expect(Math.abs(yawRateFor(steerLimitFor(100), ms) * ms - gripLat)).toBeLessThan(1e-9);
  });

  it('包络单调（根治中速凹坑）：latAccel(满舵) 随速非降，60km/h 后平坦', () => {
    const kmhs = [20, 35, 50, 60, 100, 200];
    const accels = kmhs.map(latAccelAt);
    // 严格升到抓地上限（无 72km/h 0.22g 凹坑——修复前 accels[3] < accels[1]）
    for (let i = 1; i < accels.length; i += 1) {
      expect(accels[i]).toBeGreaterThanOrEqual(accels[i - 1] - 1e-9);
    }
    // 中速不再推头：72km/h（=20m/s）满舵 latAccel ≥ 0.4g（修复前 ≈0.22g）
    expect(latAccelAt(72)).toBeGreaterThan(0.4 * G);
    // 上限封顶：全部 ≤ gripLat（无甩尾）
    for (const a of accels) expect(a).toBeLessThanOrEqual(gripLat + 1e-9);
  });

  it('关键安全性质：|yawRate| ≤ maxYawRate 恒成立（低速 cap 不超灵魂限幅）', () => {
    for (const kmh of [10, 20, 40, 72, 120, 200]) {
      for (const steer of [-0.62, -0.3, 0, 0.3, 0.62]) {
        expect(Math.abs(yawRateFor(steer, kmh / 3.6))).toBeLessThanOrEqual(FREE.maxYawRate + 1e-9);
      }
    }
    // 无甩尾：任何舵角/速度 latAccel ≤ gripLat
    for (const kmh of [30, 80, 160]) {
      const ms = kmh / 3.6;
      for (const steer of [-0.62, -0.48, 0.48, 0.62]) {
        expect(Math.abs(yawRateFor(steer, ms)) * ms).toBeLessThanOrEqual(gripLat + 1e-9);
      }
    }
  });
});

describe('R131 ② 轨迹实证（FreeDrive 高速满舵不超抓地上限）', () => {
  it('100km/h 满舵：稳态 latAccel ≤ gripLat 且 > 0.4g（抓地上限约束生效、中速推头已愈）', () => {
    const fd = new FreeDrive({ start: { x: 0, z: -600, heading: 0 } });
    fd.state.speed = 100 / 3.6;
    fd.press('KeyW', true);
    fd.press('KeyA', true);
    for (let i = 0; i < 120; i += 1) fd.step(DT); // 1s 收敛
    const s = fd.snapshot();
    const lat = Math.abs(s.yawRate) * Math.abs(s.speed);
    // 2% 容差：抓地钳按步均速 vAvg 计算（路径曲率 = yawRate·vAvg 恰 ≤ gripLat），
    // 此处用步末速 vNext 测量，加速段 vNext>vAvg 引入有界基差（≤1.2%，见 per-frame 2%）。
    expect(lat).toBeLessThanOrEqual(gripLat * 1.02); // 不超抓地上限（无甩尾）
    expect(lat).toBeGreaterThan(0.4 * G); // 修复前 100km/h 仅 ≈0.31g
    // 全程不超抓地上限（允许 damp 跟踪瞬态 2% 容差）
    const fd2 = new FreeDrive({ start: { x: 0, z: -600, heading: 0 } });
    fd2.state.speed = 100 / 3.6;
    fd2.press('KeyW', true);
    fd2.press('KeyA', true);
    for (let i = 0; i < 120; i += 1) {
      fd2.step(DT);
      const s2 = fd2.snapshot();
      expect(Math.abs(s2.yawRate) * Math.abs(s2.speed)).toBeLessThanOrEqual(gripLat * 1.02);
    }
  });

  it('72km/h 满舵：稳态 latAccel > 0.4g（基线 0.22g 凹坑已愈，中速不再推头）', () => {
    const fd = new FreeDrive({ start: { x: 0, z: -600, heading: 0 } });
    fd.state.speed = 72 / 3.6;
    fd.press('KeyW', true);
    fd.press('KeyA', true);
    for (let i = 0; i < 120; i += 1) fd.step(DT);
    const s = fd.snapshot();
    const lat = Math.abs(s.yawRate) * Math.abs(s.speed);
    expect(lat).toBeGreaterThan(0.4 * G);
    expect(lat).toBeLessThanOrEqual(gripLat * 1.02); // 同 100km/h 口径（vNext 测量基差容差）
  });
});

describe('R131 ③ 配置有界', () => {
  it('gripLatFactor ∈ (0,1)（留稳定裕度）；steerMaxHigh 从基线 0.12 抬起；gripLat < μ·g', () => {
    expect(FREE.gripLatFactor).toBeGreaterThan(0);
    expect(FREE.gripLatFactor).toBeLessThan(1);
    expect(FREE.steerMaxHigh).toBeGreaterThan(0.12); // 修复前基线
    expect(FREE.steerMaxHigh).toBeLessThan(FREE.steerMaxLow);
    expect(gripLat).toBeLessThan(FREE.tyreMu * G); // 附着限 < 轮胎 μ（稳定裕度）
  });
});
