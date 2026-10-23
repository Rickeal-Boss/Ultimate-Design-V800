/**
 * R15-4 双车档位回归：R7「踏板永不断裂 + 制动盘升温 ×100 + 过热策略不变」。
 *
 * 锁的是**档位契约**（不是数值快照）：
 *  - V800：b=1.0 过载爬升 1.77s 断裂 → 冗余接管（既有语义逐位不变）
 *  - R7  ：踏板力钳在 breakForceN 不再断裂；热阈值/冷却/重布防/2s 断力全部沿用，
 *          只是升温倍率 ×100（R17 基座减半后由 ×50 补偿上调，有效升温不变）——
 *          因此摩擦制动变成「只能点一下」的稀缺资源，
 *          主力减速必须靠电回收（b≤0.25 段，机械项为 0 不产热）。
 */
import { describe, expect, it } from 'vitest';
import { BRAKE, MS_TO_KMH, TRACK, VEHICLE } from '../src/config/physics';
import { VEHICLE_PROFILES } from '../src/config/vehicles';
import { createPedalState, stepPedal } from '../src/physics/BrakeModel';
import { createVehicleState, stepVehicle } from '../src/physics/Vehicle';
import { StateMachine } from '../src/core/StateMachine';

const DT = 1 / 120;
const R7 = VEHICLE_PROFILES.r7;
const V800 = VEHICLE_PROFILES.v800;

describe('档位元数据', () => {
  it('V800 可断裂 / 升温 ×0.75（R29 B1）；R7 不可断裂 / 升温 ×100，热参数两者一致', () => {
    // R29（外部审查 B1）：V800 升温倍率 1 → 0.75 —— ×1 下单把 200→0 深刹会越过红区、
    // 吃一次 2s 热切断，使 b=0.95/0.97 比 b=0.90 慢 30%（破坏制动单调性）。
    // 0.75 下单把满停 ΔT 峰值 0.767 < 红区 1.0，详见 tests/thermalMonotonic.test.ts。
    expect(V800.brakeBreakable).toBe(true);
    expect(V800.brakeTempGainScale).toBe(0.75);
    expect(R7.brakeBreakable).toBe(false);
    expect(R7.brakeTempGainScale).toBe(100);
    // 过热策略共用同一份常量（阈值/冷却/重布防/断力时长不随车型变化）
    expect(BRAKE.thermalTriggerTemp).toBe(1.0);
    expect(BRAKE.thermalRearmTemp).toBe(0.6);
    expect(BRAKE.thermalHoldSeconds).toBe(2);
  });
});

describe('踏板断裂开关', () => {
  it('R7 满踩 5s 不断裂，踏板力钳在 1612N', () => {
    const p = createPedalState();
    let snapped = false;
    for (let i = 0; i < 120 * 5; i++) {
      if (stepPedal(p, DT, 1, i * DT, R7.brakeBreakable)) snapped = true;
    }
    expect(snapped).toBe(false);
    expect(p.snapped).toBe(false);
    expect(p.pedalForce).toBeCloseTo(BRAKE.breakForceN, 3);
  });

  it('V800 满踩仍在 1.77s 断裂（既有契约不回退）', () => {
    const p = createPedalState();
    let snapAt = 0;
    for (let i = 0; i < 120 * 5; i++) {
      const t = i * DT;
      if (stepPedal(p, DT, 1, t, V800.brakeBreakable)) {
        snapAt = t + DT;
        break;
      }
    }
    expect(snapAt).toBeGreaterThan(1.74);
    expect(snapAt).toBeLessThan(1.80);
  });
});

describe('制动盘升温倍率', () => {
  /**
   * 同一段输入（b=0.6，从 200km/h 起步 3 步 = 25ms）下两档的温升比。
   * 窗口必须**短于进红区的时间**：`brakeTemp` 上限 1.5，R7 在 ×100 下约 4 步进红区、
   * ~6 步封顶，取长窗口会把「封顶值 / 未封顶值」当成倍率（实测会读成 20.4×）。
   * R17：基座 gain 减半（2.4→1.2）、倍率 ×50→×100 补偿，R7 有效升温逐位不变，
   * 故本窗口的绝对温升与改前相同（3 步 ≈0.69，远低于封顶）。
   */
  const run = (profile: typeof V800): number => {
    const v = createVehicleState();
    v.speed = VEHICLE.maxSpeedKmh / MS_TO_KMH;
    for (let i = 0; i < 3; i++) {
      stepVehicle(v, DT, { throttle: 0, brake: 0.6, powerCut: true, pedalForce: 0.6 * BRAKE.breakForceN }, profile);
    }
    return v.brakeTemp;
  };

  it('升温倍率锚在 ×1 基线上：V800 = 0.75×，R7 = 100×（R29 B1 后不再互为 100 倍）', () => {
    // R29 之前本用例断言「R7 / V800 = 100」；V800 降到 0.75 后该比值变成 133.3，
    // 比值口径不再表达「R7 相对 BRAKE.brakeTempGain 的绝对倍率」。
    // 改为**对 ×1 基线取比值**：既锁住 R7 的绝对升温（100×，热玩法不受本轮改动波及），
    // 也锁住 V800 的新标定（0.75×）。
    const base1 = run({ ...V800, brakeTempGainScale: 1 }); // ×1 基线（BRAKE.brakeTempGain 原值）
    const v800 = run(V800);
    const hot = run(R7);
    expect(base1).toBeGreaterThan(0);
    expect(hot).toBeLessThan(1.5); // 确认没封顶，倍率口径成立
    expect(hot / base1).toBeCloseTo(100, 1); // R7 绝对升温倍率不变
    expect(v800 / base1).toBeCloseTo(0.75, 6); // V800 新标定
  });

  it('R7 满踩在一帧级时间内就进红区并触发 2s 热保护', () => {
    const v = createVehicleState();
    v.speed = VEHICLE.maxSpeedKmh / MS_TO_KMH;
    for (let i = 0; i < 30; i++) {
      stepVehicle(v, DT, { throttle: 0, brake: 1, powerCut: true, pedalForce: BRAKE.breakForceN }, R7);
    }
    expect(v.thermalLocks).toBeGreaterThanOrEqual(1);
    expect(v.brakeTemp).toBeGreaterThanOrEqual(BRAKE.thermalTriggerTemp);
  });
});

describe('R7 打法的可玩性（电回收为主）', () => {
  it('100 km/h 切入、轻踩（b=0.25）在路障前停住；热保护按 50× 节奏反复介入', () => {
    const sm = new StateMachine(R7);
    sm.start();
    // 倒计时
    for (let i = 0; i < 120 * 4; i++) sm.step(DT, { throttle: 0, brake: 0, brakePressed: false });
    expect(sm.phase).toBe('accel');
    // 加速到 100 km/h 以上
    let guard = 0;
    while (sm.phase === 'accel' && !sm.canBrake && guard++ < 120 * 30) {
      sm.step(DT, { throttle: 1, brake: 0, brakePressed: false });
    }
    expect(sm.canBrake).toBe(true);
    // 切入刹车段（b=0.25 = 纯回收区间）
    sm.step(DT, { throttle: 0, brake: 0.25, brakePressed: true });
    expect(sm.phase).toBe('brake');
    guard = 0;
    while ((sm.phase === 'brake') && guard++ < 120 * 120) {
      sm.step(DT, { throttle: 0, brake: 0.25, brakePressed: true });
    }
    const res = sm.lastResult;
    expect(sm.phase).toBe('stopped');
    expect(res).not.toBeNull();
    expect(res!.degraded).toBe(false);
    expect(res!.success).toBe(true);
    expect(res!.stopDistance).toBeLessThan(TRACK.barrierDistance);
    // ×100 升温下**任何**带机械制动的刹车都会进红区（轻踩 0.25 也只要 ~0.09s），
    // 因此「热保护反复介入」正是 R7 的核心玩法特征，不是失败。
    expect(sm.vehicle.thermalLocks).toBeGreaterThan(0);
    console.info(
      `[R7] 纯回收刹停 v0=${res!.v0Kmh.toFixed(1)}km/h t=${res!.stopSeconds.toFixed(2)}s ` +
        `d=${res!.stopDistance.toFixed(0)}m 热保护 ${sm.vehicle.thermalLocks} 次 score=${res!.score}`
    );
  });

  it('满踩全程：不断裂、不判负，但热保护反复切断机械力（摩擦刹车是稀缺资源）', () => {
    const sm = new StateMachine(R7);
    sm.start();
    for (let i = 0; i < 120 * 4; i++) sm.step(DT, { throttle: 0, brake: 0, brakePressed: false });
    while (sm.phase === 'accel' && !sm.canBrake) {
      sm.step(DT, { throttle: 1, brake: 0, brakePressed: false });
    }
    sm.step(DT, { throttle: 0, brake: 1, brakePressed: true });
    let guard = 0;
    while ((sm.phase === 'brake' || sm.phase === 'accel') && guard++ < 120 * 300) {
      sm.step(DT, { throttle: 0, brake: 1, brakePressed: true });
    }
    expect(sm.pedal.snapped).toBe(false);
    expect(sm.vehicle.thermalLocks).toBeGreaterThan(0);
    // 结局只会是撞障或停住，绝不会是「断裂判负」
    if (sm.lastResult) {
      expect(sm.lastResult.reason).not.toBe('brake_pedal_failed');
      expect(sm.lastResult.degraded).toBe(false);
    }
  });
});
