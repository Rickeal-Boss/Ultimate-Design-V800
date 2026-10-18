/**
 * 物理与玩法状态机的回归测试（锁「设计契约」而非数值快照）。
 *
 * 一旦有人调整 BRAKE / VEHICLE / TRACK 常量破坏了下列性质，测试会立刻失败。
 * 运行：npm test
 */
import { describe, expect, it } from 'vitest';
import { BRAKE, MS_TO_KMH, TRACK, VEHICLE, calcScore } from '../src/config/physics';
import { createPedalState, resetPedal, stepPedal } from '../src/physics/BrakeModel';
import { createVehicleState, dragForce, regenDecel, rollForce, stepVehicle } from '../src/physics/Vehicle';
import { StateMachine } from '../src/core/StateMachine';

const DT = 1 / 120;

/** 全油门加速到电子限速，返回耗时与行驶距离 */
function accelerateToLimiter(): { t: number; dist: number } {
  const v = createVehicleState();
  let t = 0;
  while (t < 60 && v.speed * MS_TO_KMH < VEHICLE.maxSpeedKmh * 0.995) {
    stepVehicle(v, DT, { throttle: 1, brake: 0, powerCut: false, pedalForce: 0 });
    t += DT;
  }
  return { t, dist: v.distance };
}

/** 从 v0 以固定滑条值 b 刹到停（不含断裂路径），返回用时、距离、峰值力 */
function brakeFrom(v0ms: number, b: number): { t: number; dist: number; peak: number } {
  const v = createVehicleState();
  v.speed = v0ms;
  const p = createPedalState();
  const d0 = v.distance;
  let t = 0;
  while (t < 60) {
    stepPedal(p, DT, b);
    stepVehicle(v, DT, { throttle: 0, brake: b, powerCut: true, pedalForce: p.pedalForce });
    t += DT;
    if (v.speed <= BRAKE.stopSpeed) break;
  }
  return { t, dist: v.distance - d0, peak: p.pedalForce };
}

describe('纵向动力学', () => {
  it('电子限速被钳制在 200 km/h', () => {
    const v = createVehicleState();
    for (let i = 0; i < 120 * 60; i++) {
      stepVehicle(v, DT, { throttle: 1, brake: 0, powerCut: false, pedalForce: 0 });
    }
    expect(v.speed * MS_TO_KMH).toBeLessThanOrEqual(VEHICLE.maxSpeedKmh);
    expect(v.speed * MS_TO_KMH).toBeGreaterThan(VEHICLE.maxSpeedKmh * 0.9);
  });

  it('限速处动力保持：满油门到限速后持续满油门 5s，速度恒 200、accel>0、距离持续增长', () => {
    const v = createVehicleState();
    // 先全油门到限速（钳位生效：speed 钉在 MAX_SPEED_MS）
    let t = 0;
    while (t < 60 && v.speed < VEHICLE.maxSpeedKmh / MS_TO_KMH - 1e-9) {
      stepVehicle(v, DT, { throttle: 1, brake: 0, powerCut: false, pedalForce: 0 });
      t += DT;
    }
    expect(t).toBeLessThan(60);
    // 持续满油门 5s：速度钉在 200、动力不断（accel>0）、里程持续增长
    let lastDist = v.distance;
    for (let i = 0; i < 120 * 5; i++) {
      stepVehicle(v, DT, { throttle: 1, brake: 0, powerCut: false, pedalForce: 0 });
      expect(v.speed * MS_TO_KMH).toBeCloseTo(VEHICLE.maxSpeedKmh, 6);
      expect(v.accel).toBeGreaterThan(0); // 动力保持，不被限速归零
      expect(v.distance).toBeGreaterThan(lastDist); // 持续行驶
      lastDist = v.distance;
    }
    // 5s 内持续前进量合理（≈200km/h × 5s ≈ 277m）
    expect(v.distance).toBeGreaterThan((VEHICLE.maxSpeedKmh / MS_TO_KMH) * 5 * 0.99);
  });

  it('限速处松油门：速度单调下降、不超 200（限速钳制不影响滑行语义）', () => {
    const v = createVehicleState();
    let t = 0;
    while (t < 60 && v.speed * MS_TO_KMH < VEHICLE.maxSpeedKmh * 0.995) {
      stepVehicle(v, DT, { throttle: 1, brake: 0, powerCut: false, pedalForce: 0 });
      t += DT;
    }
    // 松油门后滑行：速度永不超 200 且单调不增
    let last = v.speed;
    for (let i = 0; i < 120 * 5; i++) {
      stepVehicle(v, DT, { throttle: 0, brake: 0, powerCut: false, pedalForce: 0 });
      expect(v.speed * MS_TO_KMH).toBeLessThanOrEqual(VEHICLE.maxSpeedKmh + 1e-9);
      expect(v.speed).toBeLessThanOrEqual(last + 1e-9);
      last = v.speed;
    }
  });

  it('0-100km/h 落在 3~8s（3300kg / 390kW 的合理区间）', () => {
    const v = createVehicleState();
    let t = 0;
    while (t < 60 && v.speed * MS_TO_KMH < 100) {
      stepVehicle(v, DT, { throttle: 1, brake: 0, powerCut: false, pedalForce: 0 });
      t += DT;
    }
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(8);
  });

  it('松油门滑行单调减速、不倒退（滚阻 0.01g + 风阻，30m/s 滑行 60s 降到 ~17）', () => {
    const v = createVehicleState();
    v.speed = 30;
    let last = v.speed;
    for (let i = 0; i < 120 * 60; i++) {
      stepVehicle(v, DT, { throttle: 0, brake: 0, powerCut: false, pedalForce: 0 });
      expect(v.speed).toBeGreaterThanOrEqual(0); // 永不倒退
      expect(v.speed).toBeLessThanOrEqual(last + 1e-9); // 单调减速
      last = v.speed;
    }
    expect(v.speed).toBeLessThan(20);
    expect(v.speed).toBeGreaterThan(14);
  });
});

describe('踏板力与断裂机制', () => {
  it('满程保持会在 1.5~2.0s 内达到断裂力并置位 snapped', () => {
    const p = createPedalState();
    let t = 0;
    while (!stepPedal(p, DT, 1) && t < 10) t += DT;
    expect(p.snapped).toBe(true);
    expect(t).toBeGreaterThan(1.5);
    expect(t).toBeLessThan(2.0);
  });

  it('未到 0.98 的踩法不会断裂', () => {
    const p = createPedalState();
    for (let i = 0; i < 120 * 10; i++) stepPedal(p, DT, 0.97);
    expect(p.snapped).toBe(false);
    expect(p.pedalForce).toBeCloseTo(0.97 * BRAKE.breakForceN, 0);
  });

  it('松开后踏板力向目标值回落', () => {
    const p = createPedalState();
    for (let i = 0; i < 60; i++) stepPedal(p, DT, 0.9);
    const high = p.pedalForce;
    for (let i = 0; i < 120; i++) stepPedal(p, DT, 0.2);
    expect(p.pedalForce).toBeLessThan(high);
    expect(p.pedalForce).toBeCloseTo(0.2 * BRAKE.breakForceN, 0);
  });

  it('resetPedal 清空断裂状态', () => {
    const p = createPedalState();
    while (!stepPedal(p, DT, 1)) {
      /* 踩到断裂 */
    }
    resetPedal(p);
    expect(p.snapped).toBe(false);
    expect(p.pedalForce).toBe(0);
  });
});

describe('制动平衡性（核心契约）', () => {
  it('踩得越深，刹停用时不增（消除「踩深反而更慢」）', () => {
    const times = [0.6, 0.7, 0.8, 0.86, 0.92, 0.97].map((b) => brakeFrom(200 / MS_TO_KMH, b).t);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1] + 1e-6);
    }
  });

  it('冒险深踩（b=0.97）不慢于保守踩法（b=0.86），且严格不增（摩擦圆改版口径）', () => {
    // 摩擦圆总钳制后，0.86 的机械+回收总量已达 μg 的 99.6%——
    // 深踩的边际收益物理上必然趋零；契约退守为「深踩绝不更慢」（单调性由上一条锁死）。
    const deep = brakeFrom(200 / MS_TO_KMH, 0.97).t;
    const safe = brakeFrom(200 / MS_TO_KMH, 0.86).t;
    expect(safe - deep).toBeGreaterThan(0);
  });

  it('满踏板力的机械减速度严格等于 ABS 上限（同源常量，B-4 修复）', () => {
    expect(BRAKE.breakForceN * BRAKE.decelPerNewton).toBeCloseTo(BRAKE.absMaxDecel, 10);
    expect(BRAKE.absMaxDecel).toBeCloseTo(BRAKE.absMu * 9.81, 10);
  });

  it('摩擦圆：全程「机械+回收」总减速 ≤ μg（2026-10-17 摩擦圆总钳制回归）', () => {
    // 全滑条域扫掠：从 state.accel 里剥掉风阻/滚阻（二者不经轮胎摩擦圆），
    // 剩下的制动系总减速（mech+regen）任何时刻都不得突破抓地上限。
    // 注意口径：accel 用的是「步进前」速度算风阻，复算阻力必须同口径（用 prevSpeed），
    // 否则每步混入 ~0.0017 的测量伪影（2026-10-17 实测教训）。
    for (const b of [0.1, 0.25, 0.5, 0.7, 0.85, 0.9, 0.97, 1.0]) {
      const v = createVehicleState();
      v.speed = 200 / MS_TO_KMH;
      const p = createPedalState();
      let peakTotal = 0;
      for (let t = 0; t < 30 && v.speed > BRAKE.stopSpeed; t += DT) {
        stepPedal(p, DT, b);
        const prevSpeed = v.speed;
        stepVehicle(v, DT, { throttle: 0, brake: b, powerCut: true, pedalForce: p.pedalForce });
        const resist = (dragForce(prevSpeed) + rollForce()) / VEHICLE.totalMassKg;
        const brakeTotal = -v.accel - resist;
        if (brakeTotal > peakTotal) peakTotal = brakeTotal;
      }
      expect(peakTotal).toBeLessThanOrEqual(BRAKE.absMaxDecel + 1e-6);
      // 满踩时钳制应当贴住上限（摩擦圆是主动约束，不是松约束；
      // 踏板建压 ~1.6s 后总减速必然到达 μg，只允许风阻复算口径的浮点噪声）
      if (b === 1.0) {
        expect(peakTotal).toBeGreaterThanOrEqual(BRAKE.absMaxDecel - 1e-6);
      }
    }
  });

  it('电回收请求在 b=0.25 达满值（摩擦圆改版后 fade 曲线已删）', () => {
    expect(regenDecel(0.25)).toBeCloseTo(BRAKE.regenMaxDecel, 6);
    expect(regenDecel(0.98)).toBeCloseTo(BRAKE.regenMaxDecel, 6);
    expect(regenDecel(0)).toBe(0);
  });

  it('深踩段回收按抓地余量退让（机械优先协调，HUD 回收功率随之回落）', () => {
    // 取踏板建压完成后的稳态样本（~2s）：b=0.86 机械需求 9.28 < μg，回收全额 1.47；
    // b=0.97 机械 10.47，回收被削到 μg−mech=0.324（b=1.0 会触发踏板断裂，
    // 断裂后 pedalForce=0、回收回归全额——那是冗余回路语义，不属于本契约）
    const regenAt = (b: number): number => {
      const v = createVehicleState();
      v.speed = 150 / MS_TO_KMH;
      const p = createPedalState();
      for (let t = 0; t < 2; t += DT) {
        stepPedal(p, DT, b);
        stepVehicle(v, DT, { throttle: 0, brake: b, powerCut: true, pedalForce: p.pedalForce });
      }
      // regenPowerKw = m × a_regen × v / 1000 → a_regen 反解
      return (v.regenPowerKw * 1000) / (VEHICLE.totalMassKg * v.speed);
    };
    expect(regenAt(0.86)).toBeCloseTo(BRAKE.regenMaxDecel, 3);
    expect(regenAt(0.97)).toBeGreaterThan(0.2);
    expect(regenAt(0.97)).toBeLessThan(0.45);
  });

  it('一次 200→0 满刹的制动温升 < 过热阈值（不惩罚正确的满刹操作）', () => {
    const v = createVehicleState();
    v.speed = 200 / MS_TO_KMH;
    const p = createPedalState();
    let t = 0;
    while (v.speed > BRAKE.stopSpeed && t < 30) {
      stepPedal(p, DT, 0.97);
      stepVehicle(v, DT, { throttle: 0, brake: 0.97, powerCut: true, pedalForce: p.pedalForce });
      t += DT;
    }
    expect(v.brakeTemp).toBeGreaterThan(0.3); // 确实在升温（摩擦功模型生效）
    expect(v.brakeTemp).toBeLessThan(BRAKE.brakeTempThreshold);
    expect(v.overheat).toBe(false);
  });
});

describe('会话状态机', () => {
  it('完整流程：倒计时 → 加速 → 刹车 → 刹停成功，得分与公式一致', () => {
    const sm = new StateMachine();
    sm.start();
    let guard = 0;
    const seen: string[] = [];
    while (sm.phase !== 'stopped' && sm.phase !== 'crashed' && guard++ < 120 * 500) {
      const events = sm.step(DT, {
        throttle: sm.phase === 'accel' ? 1 : 0,
        brake: sm.phase === 'brake' ? 0.9 : 0,
        brakePressed: sm.atLimiter || sm.phase === 'brake'
      });
      for (const e of events) seen.push(e.type);
    }
    expect(seen).toContain('countdown');
    expect(seen).toContain('start');
    expect(seen).toContain('brake_start');
    expect(sm.phase).toBe('stopped');
    const r = sm.lastResult!;
    expect(r.success).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.score).toBe(calcScore(r.v0Kmh, r.stopSeconds));
    expect(r.v0Kmh).toBeGreaterThan(190);
    expect(r.samples.length).toBeGreaterThan(50);
  });

  it('低于 100km/h 踩刹车不进入刹车段，只给出提示', () => {
    const sm = new StateMachine();
    sm.start();
    let guard = 0;
    let hinted = false;
    while (sm.phase !== 'accel' && guard++ < 120 * 10) sm.step(DT, { throttle: 0, brake: 0, brakePressed: false });
    while (sm.speedKmh < 100 && guard++ < 120 * 30) {
      const events = sm.step(DT, { throttle: 1, brake: 0, brakePressed: true });
      if (events.some((e) => e.type === 'brake_too_early')) hinted = true;
    }
    expect(hinted).toBe(true);
    expect(sm.phase).toBe('accel');
  });
});

describe('赛道与计分', () => {
  it('score = v0² / t，且用时为 0 时返回 0', () => {
    expect(calcScore(200, 5)).toBe(8000);
    expect(calcScore(200, 0)).toBe(0);
  });

  it('加速到限速的行程 + 满刹距离 < 路障距离（开局不会即撞）', () => {
    const { dist: accelDist } = accelerateToLimiter();
    const { dist: brakeDist } = brakeFrom(200 / MS_TO_KMH, 0.97);
    expect(accelDist + brakeDist).toBeLessThan(TRACK.barrierDistance);
    // 且留有余量（≥300m），保证正常打法安全
    expect(TRACK.barrierDistance - accelDist - brakeDist).toBeGreaterThan(300);
  });
});
