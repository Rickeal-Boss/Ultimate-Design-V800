/**
 * R100 Phase3 · 撞墙瞬态注入硬 clamp 回归（物理侧，不与 hall/bounds 侧抢文件）。
 *
 * 背景：R99 `wallImpact` 注入 `s.roll += IMPACT_ROLL_GAIN·impactN·(dt/tau)` 原本无硬上限，
 * 发生在下游 `clamp(rollTarget, ±rollMaxRad)` 之前 —— 灵魂上限只约束 target 不约束 state
 * 注入量，roll 峰随 |v| 线性涨：55 m/s 撞墙/撞殿实测 ≈0.108 rad，超 3.5° 上限约 77%。
 * 车身瞬间歪 6.2° 再弹回不是真车观感。本测试钉死修复后的契约：
 *   ① 高速 side 55 m/s / hall 55 m/s：|roll| ≤ rollMaxRad、|yawRate| ≤ maxYawRate；
 *   ② 瞬态仍非零且持续数帧（保留「被顶一下」体感），之后指数衰减回近零；
 *   ③ 低速撞击（25 m/s，clamp 不绑定）瞬态行为逐位不变（回归零风险）。
 */
import { describe, expect, it } from 'vitest';
import { BOUNDS, FREE, FreeDrive, corridorCenterHalfWidth } from '../src/core/FreeDrive';

const DT = 1 / 120;
const SIDE_Z = -250; // 桥段，limits 恒定，避开块角过渡区
const SIDE_LIMIT = corridorCenterHalfWidth(SIDE_Z);
const HIGH_SPEED = 55; // ≈198 km/h，全油门可达的真实入射量级

interface Trace {
  roll: number[];
  yaw: number[];
  hits: number;
}

/** 通用采样：撞到目标事件后逐帧记录 |roll| / |yawRate|。 */
function traceAfterHit(
  start: { x: number; z: number; heading: number },
  speed: number,
  event: 'wall' | 'hall',
  frames = 300
): Trace {
  const fd = new FreeDrive({ start });
  fd.state.speed = speed;
  let hits = 0;
  fd.onEvent = (e) => {
    if (e === event) hits += 1;
  };
  const roll: number[] = [];
  const yaw: number[] = [];
  for (let i = 0; i < frames; i += 1) {
    fd.step(DT);
    if (hits > 0) {
      roll.push(Math.abs(fd.state.roll));
      yaw.push(Math.abs(fd.state.yawRate));
    }
  }
  return { roll, yaw, hits };
}

/** side 正撞 +X 侧墙：heading=−π/2 ⇒ forward.x=−sin(−π/2)=+1，起点贴墙内侧。 */
const sideTrace = (speed: number): Trace =>
  traceAfterHit({ x: SIDE_LIMIT - 2, z: SIDE_Z, heading: -Math.PI / 2 }, speed, 'wall');

/** hall 正撞主殿：heading=0 ⇒ forward.z=−cos(0)=−1，起点在 zMin 内侧 8m。 */
const hallTrace = (speed: number): Trace =>
  traceAfterHit({ x: 0, z: BOUNDS.zMin + 8, heading: 0 }, speed, 'hall');

const peak = (a: number[]): number => Math.max(0, ...a);
const countAbove = (a: number[], eps: number): number => a.filter((v) => v > eps).length;

function expectBoundedTransient(t: Trace, label: string): void {
  expect(t.hits, `${label}: 撞击事件发生`).toBeGreaterThan(0);
  const peakRoll = peak(t.roll);
  const peakYaw = peak(t.yaw);
  // ① 硬上限：注入后紧跟 clamp，state 不得越过灵魂包络（修复前 0.108 必红）
  expect(peakRoll, `${label}: |roll| 峰 ≤ rollMaxRad`).toBeLessThanOrEqual(FREE.rollMaxRad + 1e-12);
  expect(peakYaw, `${label}: |yawRate| 峰 ≤ maxYawRate`).toBeLessThanOrEqual(FREE.maxYawRate + 1e-12);
  // ② 瞬态没被 clamp 抹平：幅度足够可见（接近上限），且持续数帧、之后衰减
  expect(peakRoll, `${label}: roll 瞬态仍可见`).toBeGreaterThan(FREE.rollMaxRad * 0.5);
  expect(peakYaw, `${label}: yawRate 瞬态仍可见`).toBeGreaterThan(0.01);
  expect(countAbove(t.roll, 1e-3), `${label}: roll 瞬态持续数帧`).toBeGreaterThanOrEqual(5);
  expect(countAbove(t.yaw, 1e-4), `${label}: yaw 瞬态持续数帧`).toBeGreaterThanOrEqual(5);
  expect(t.roll[t.roll.length - 1], `${label}: roll 衰减回近零`).toBeLessThan(peakRoll * 0.1);
  expect(t.yaw[t.yaw.length - 1], `${label}: yaw 衰减回近零`).toBeLessThan(peakYaw * 0.1);
}

describe('R100 Phase3 ① 高速 side 55 m/s 撞击：注入后硬 clamp 生效', () => {
  it('side 55 m/s：|roll| ≤ 3.5°、|yawRate| ≤ maxYawRate，瞬态非零并衰减', () => {
    expectBoundedTransient(sideTrace(HIGH_SPEED), 'side@55');
  });
});

describe('R100 Phase3 ② 高速 hall 55 m/s 撞击：注入后硬 clamp 生效', () => {
  it('hall 55 m/s：|roll| ≤ 3.5°、|yawRate| ≤ maxYawRate，瞬态非零并衰减', () => {
    expectBoundedTransient(hallTrace(HIGH_SPEED), 'hall@55');
  });
});

describe('R100 Phase3 ③ 低速撞击瞬态行为不变（clamp 不绑定）', () => {
  it('hall 25 m/s：roll 峰仍由 dynamics 决定、远低于上限，瞬态可见且衰减', () => {
    const t = hallTrace(25);
    expect(t.hits).toBeGreaterThan(0);
    const peakRoll = peak(t.roll);
    // 低速下注入从未触顶 ⇒ clamp 是 no-op，行为与修复前逐位一致（≈0.0491 rad）
    expect(peakRoll).toBeGreaterThan(0.04);
    expect(peakRoll).toBeLessThan(FREE.rollMaxRad * 0.9);
    expect(peak(t.yaw)).toBeGreaterThan(0.01);
    expect(countAbove(t.roll, 1e-3)).toBeGreaterThanOrEqual(5);
    expect(t.roll[t.roll.length - 1]).toBeLessThan(peakRoll * 0.1);
  });

  it('clamp 只收上界不制造符号偏置：hall 反向（+X 墙镜像）侧倾仍在包络内且非零', () => {
    // 从 −X 侧斜撞墙，注入符号相反；clamp 应对称生效（±rollMaxRad）
    const fd = new FreeDrive({ start: { x: -SIDE_LIMIT + 2, z: SIDE_Z, heading: Math.PI / 2 } });
    fd.state.speed = HIGH_SPEED;
    let wallHits = 0;
    fd.onEvent = (e) => {
      if (e === 'wall') wallHits += 1;
    };
    let minRoll = 0;
    let maxRoll = 0;
    for (let i = 0; i < 300; i += 1) {
      fd.step(DT);
      if (wallHits > 0) {
        minRoll = Math.min(minRoll, fd.state.roll);
        maxRoll = Math.max(maxRoll, fd.state.roll);
      }
    }
    expect(wallHits).toBeGreaterThan(0);
    expect(Math.abs(minRoll)).toBeLessThanOrEqual(FREE.rollMaxRad + 1e-12);
    expect(Math.abs(maxRoll)).toBeLessThanOrEqual(FREE.rollMaxRad + 1e-12);
  });
});
