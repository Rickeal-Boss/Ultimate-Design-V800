/**
 * R29 · T1 回归：制动单调性不因「热保护切断」而破坏（外部审查 B1）。
 *
 * 背景（改前实测，tools/r29_thermal_sweep.ts，200 km/h 单把刹停）：
 *   b=0.90 → 5.633s / 170.9m / 峰值T 0.972 / 0 次切断
 *   b=0.95 → 7.350s / 176.3m / 峰值T 1.000 / 1 次切断（96% 行程处）
 *   b=0.97 → 7.350s / 181.4m / 峰值T 1.000 / 1 次切断（93% 行程处）
 * 深踩反而慢 30%（t(0.97)/t(0.90) = 1.3047），与「踩得越深刹得越快」契约冲突。
 *
 * 修复：V800 档 `brakeTempGainScale` 1 → **0.75**（单把满停 ΔT 0.9 < 红区 1.0）。
 * R7 档保持 ×100 不动（本文件同时锁「R7 热行为逐位不变」）。
 */
import { describe, expect, it } from 'vitest';
import { BRAKE, MS_TO_KMH, VEHICLE } from '../src/config/physics';
import { VEHICLE_PROFILES } from '../src/config/vehicles';
import { createPedalState, redundancyDecel, stepPedal } from '../src/physics/BrakeModel';
import { createVehicleState, stepVehicle } from '../src/physics/Vehicle';
import type { VehicleProfile } from '../src/config/vehicles';

const DT = 1 / 120;
const V800 = VEHICLE_PROFILES.v800;
const R7 = VEHICLE_PROFILES.r7;

/** 全量程扫掠采样点（审查口径 + 浅踩端点） */
const SWEEP = [0.5, 0.7, 0.85, 0.9, 0.95, 0.97];

/** 单把刹停仿真：200 km/h → 停稳（profile 决定升温倍率） */
function brakeRun(b: number, profile?: VehicleProfile) {
  const v = createVehicleState();
  v.speed = VEHICLE.maxSpeedKmh / MS_TO_KMH;
  const p = createPedalState();
  const d0 = v.distance;
  let t = 0;
  let maxTemp = 0;
  let guard = 0;
  while (v.speed > BRAKE.stopSpeed && guard++ < 120 * 120) {
    stepPedal(p, DT, b, t, profile?.brakeBreakable ?? true);
    stepVehicle(
      v,
      DT,
      {
        throttle: 0,
        brake: b,
        powerCut: true,
        pedalForce: p.pedalForce,
        redundancyDecel: redundancyDecel(p)
      },
      profile
    );
    t += DT;
    maxTemp = Math.max(maxTemp, v.brakeTemp);
  }
  return { b, t, dist: v.distance - d0, maxTemp, locks: v.thermalLocks, snapped: p.snapped };
}

const rows = SWEEP.map((b) => brakeRun(b, V800));

describe('制动单调性（R29 · 外部审查 B1）', () => {
  it('stopTime(b) 在 [0.5, 0.97] 单调不增（允许 ≤0.5% 数值抖动）', () => {
    // 参数化：相邻采样点逐一断言，失败时直接指认断点
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      expect(
        cur.t,
        `b ${prev.b} → ${cur.b} 用时增加：${prev.t.toFixed(3)}s → ${cur.t.toFixed(3)}s ` +
          `（热切断 ${prev.locks}→${cur.locks}）`
      ).toBeLessThanOrEqual(prev.t * 1.005);
    }
  });

  it('b=0.97 的用时不超过 b=0.90 的 1.02 倍（审查硬指标）', () => {
    const r90 = rows.find((r) => r.b === 0.9)!;
    const r97 = rows.find((r) => r.b === 0.97)!;
    expect(r97.t / r90.t).toBeLessThanOrEqual(1.02);
  });

  it('单把刹停不再触发热切断：全量程 locks = 0 且峰值盘温 < 红区', () => {
    // 0.75 倍率下 200→0 满刹 ΔT 峰值 0.767（< 触发温度 1.0），
    // 「踩得越深越容易吃 2s 断力」的现象被整体移除。
    for (const r of rows) {
      expect(r.locks, `b=${r.b} 触发了 ${r.locks} 次热切断`).toBe(0);
      expect(r.maxTemp).toBeLessThan(BRAKE.thermalTriggerTemp);
    }
    // 峰值温度对 b 单调不减（热感知仍在，只是不再越线）
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].maxTemp).toBeGreaterThan(rows[i - 1].maxTemp);
    }
  });

  it('V800 升温倍率常量 = 0.75（回归网：谁改回 1 上面三条立刻红）', () => {
    expect(V800.brakeTempGainScale).toBe(0.75);
    // 单把满停 ΔT 标定：0.75 × 1.2 = 0.9 < 1.0
    expect(V800.brakeTempGainScale * BRAKE.brakeTempGain * 5.09e6).toBeCloseTo(0.9, 6);
  });

  it('b≥0.98 踏板过载断裂语义未变（1.77s 断裂 → 冗余 1/4 接管）', () => {
    const r = brakeRun(1.0, V800);
    expect(r.snapped).toBe(true);
    expect(r.t).toBeGreaterThan(15); // 冗余 1/4 力度，拖停耗时远长于正常刹停
    expect(r.dist).toBeLessThan(1200);
  });

  it('R7 档热行为逐位不变（×100，未受本轮改动波及）', () => {
    expect(R7.brakeTempGainScale).toBe(100);
    // 绝对值锚：200 km/h 满踩 3 步（25ms，未封顶窗口）的温升 ≈0.69
    const probe = (profile: VehicleProfile): number => {
      const v = createVehicleState();
      v.speed = VEHICLE.maxSpeedKmh / MS_TO_KMH;
      for (let i = 0; i < 3; i++) {
        stepVehicle(
          v,
          DT,
          {
            throttle: 0,
            brake: 0.6,
            powerCut: true,
            pedalForce: 0.6 * BRAKE.breakForceN
          },
          profile
        );
      }
      return v.brakeTemp;
    };
    const base1 = probe({ ...V800, brakeTempGainScale: 1 }); // ×1 基线
    expect(probe(R7) / base1).toBeCloseTo(100, 1); // R7 绝对升温 = 基线 ×100
    expect(probe(V800) / base1).toBeCloseTo(0.75, 6); // V800 = 基线 ×0.75
    // R7 仍然一踩就进红区并反复切断（热玩法是 R7 的核心特征，不许退化）
    const r7 = brakeRun(0.97, R7);
    expect(r7.locks).toBeGreaterThan(0);
    expect(r7.maxTemp).toBeGreaterThanOrEqual(BRAKE.thermalTriggerTemp);
  });

  it('[诊断] 打印 V800 全量程扫掠表', () => {
    console.info(
      '[R29 V800 扫掠] ' +
        rows
          .map(
            (r) =>
              `b=${r.b}: ${r.t.toFixed(3)}s/${r.dist.toFixed(1)}m/T=${r.maxTemp.toFixed(3)}/锁${r.locks}`
          )
          .join(' | ')
    );
    const r90 = rows.find((r) => r.b === 0.9)!;
    const r97 = rows.find((r) => r.b === 0.97)!;
    console.info(`[R29] t(0.97)/t(0.90) = ${(r97.t / r90.t).toFixed(4)}`);
    expect(rows.length).toBe(SWEEP.length);
  });
});
