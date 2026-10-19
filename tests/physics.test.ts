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
import { THERMAL_BANNER_HINT, thermalBannerText } from '../src/ui/Hud';

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

/** 从 v0 以固定滑条值 b 刹到停（不含断裂路径），返回用时、距离、峰值力、热保护记录 */
function brakeFrom(
  v0ms: number,
  b: number
): {
  t: number;
  dist: number;
  peak: number;
  maxTemp: number;
  locks: { t: number; dist: number; speedKmh: number }[];
} {
  const v = createVehicleState();
  v.speed = v0ms;
  const p = createPedalState();
  const d0 = v.distance;
  const locks: { t: number; dist: number; speedKmh: number }[] = [];
  let t = 0;
  let seen = 0;
  let maxTemp = 0;
  while (t < 60) {
    stepPedal(p, DT, b);
    stepVehicle(v, DT, { throttle: 0, brake: b, powerCut: true, pedalForce: p.pedalForce });
    t += DT;
    maxTemp = Math.max(maxTemp, v.brakeTemp);
    if (v.thermalLocks > seen) {
      seen = v.thermalLocks;
      locks.push({ t, dist: v.distance - d0, speedKmh: v.speed * MS_TO_KMH });
    }
    if (v.speed <= BRAKE.stopSpeed) break;
  }
  return { t, dist: v.distance - d0, peak: p.pedalForce, maxTemp, locks };
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
  it('踩得越深，刹停用时不增（b≤0.92 严格单调；b>0.92 热保护有界，R17 热感知口径）', () => {
    // 机械摩擦圈单调性由机制分离实验（同源仿真屏蔽热效应）背书：干净用时
    // b=0.6→0.97 严格单调（7.133/6.433/5.908/5.642/5.633…5.633s，b≥0.86 饱和平台）。
    // R17 升温减半后 b>0.93 深踩峰值温度越过红区 → 吃 1 次 2s 热保护断力
    // （实测边界：b=0.93 峰值 0.994 不锁 / b=0.94 起锁）。
    // 热保护是 R14 用户指令的独立玩法层：本契约不要求它不存在，而要求它有界——
    // 用时 ≤ 干净基准 + 单次惩罚上界，且恰好锁 1 次、锁在行程后段（>80%）。
    // （b≥0.98 进入踏板过载爬升区：1.77s 断裂走冗余回路，属断裂语义，由冗余组锁定。）
    const sweep = [0.6, 0.7, 0.8, 0.86, 0.92, 0.95, 0.97];
    const runs = sweep.map((b) => ({ b, r: brakeFrom(200 / MS_TO_KMH, b) }));
    // ① 干净区间（b≤0.92，未触发热保护）：用时严格不增（含 P0-1 反转区 b>0.86）
    const cleanZone = runs.filter((x) => x.b <= 0.92);
    for (let i = 1; i < cleanZone.length; i++) {
      expect(cleanZone[i].r.t).toBeLessThanOrEqual(cleanZone[i - 1].r.t + 1e-6);
    }
    // ② 深踩区间（0.92<b<0.98）：热保护有界。干净基准取 b=0.92 的用时
    // （摩擦圈 b≥0.86 已饱和，干净时间持平——机制分离实验实测 5.633s 平台）。
    const cleanBaseline = cleanZone[cleanZone.length - 1].r.t;
    // 单次热保护惩罚上界：锁定期间只剩电回收 regenMaxDecel，干净段总减速 absMaxDecel，
    // 惩罚 ≤ hold×(1 − regen/μg)——锁时车速高于 regen×hold 时取等号，车在锁定期内
    // 停稳时同一上界；再加 10% 容差吸收滚阻/风阻项。
    const penaltyBound =
      BRAKE.thermalHoldSeconds * (1 - BRAKE.regenMaxDecel / BRAKE.absMaxDecel) * 1.1;
    for (const x of runs.filter((x) => x.b > 0.92)) {
      expect(x.r.locks.length).toBe(1); // 恰好 1 次热保护（无贴阈值抖动式反复锁）
      const fraction = x.r.locks[0].dist / x.r.dist;
      expect(fraction).toBeGreaterThan(0.8); // 锁在行程后段
      expect(x.r.t).toBeLessThanOrEqual(cleanBaseline + penaltyBound); // 惩罚有界
    }
    console.info(
      '[R17 全量程扫掠] ' +
        runs
          .map(
            (x) =>
              `b=${x.b}: ${x.r.t.toFixed(3)}s/${x.r.dist.toFixed(1)}m/T=${x.r.maxTemp.toFixed(3)}/锁${x.r.locks.length}` +
              (x.r.locks.length ? `@${((x.r.locks[0].dist / x.r.dist) * 100).toFixed(0)}%` : '')
          )
          .join(' | ')
    );
  });

  it('冒险深踩（b=0.97）不慢于保守踩法（b=0.86）超过一次热保护惩罚（R17 热感知口径）', () => {
    // 摩擦圈总钳制后，0.86 的机械+回收总量已达 μg 的 99.6%，干净用时对更深的 b 持平
    // （机制分离实验：5.633s 平台）。R17 后 b>0.92 深踩额外付出的是 1 次热保护断力，
    // 属 R14 玩法层的有界惩罚而非制动平衡破坏：断言「深踩 − 保守 ≤ 惩罚上界」。
    const deep = brakeFrom(200 / MS_TO_KMH, 0.97);
    const safe = brakeFrom(200 / MS_TO_KMH, 0.86);
    const penaltyBound =
      BRAKE.thermalHoldSeconds * (1 - BRAKE.regenMaxDecel / BRAKE.absMaxDecel) * 1.1;
    expect(deep.t - safe.t).toBeLessThanOrEqual(penaltyBound);
    // 干净区间内（热保护触发边界 b≤0.92）深踩仍严格不慢
    const deepClean = brakeFrom(200 / MS_TO_KMH, 0.92);
    expect(safe.t - deepClean.t).toBeGreaterThan(0);
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

  it('一次 200→0 满刹的摩擦功标定：brakeTempGain × 5.09MJ = 1.2（R17 升温减半）', () => {
    // R17 用户指令「升温减半」：R14 的 ×4 加强（2.4/5.09e6）减半收回为 1.2/5.09e6。
    // 这里锁两件事：
    // ① 单步温升斜率严格是旧常量 0.6 的 2 倍（回归网：谁改回 0.6 或改回 2.4 都会立刻红）；
    // ② 一次满刹的理论 ΔT ≈ 5.09MJ × gain = 1.2，单次满刹不再必然越过阈值 1.0。
    const LEGACY_GAIN = 0.6 / 5.09e6;
    const v = createVehicleState();
    v.speed = 200 / MS_TO_KMH;
    stepVehicle(v, DT, {
      throttle: 0,
      brake: 1,
      powerCut: true,
      pedalForce: BRAKE.breakForceN
    });
    const legacyDelta =
      BRAKE.absMaxDecel * VEHICLE.totalMassKg * (200 / MS_TO_KMH) * DT * LEGACY_GAIN;
    expect(v.brakeTemp / legacyDelta).toBeCloseTo(2, 6);
    expect(BRAKE.brakeTempGain * 5.09e6).toBeCloseTo(1.2, 6);
  });
});

describe('制动盘热保护（R14：红区 2s 断力 + 迟滞重布防）', () => {
  /**
   * 从 200km/h 以滑条 b 刹到停，记录每次热保护触发的时刻/里程/车速。
   * 注意 b=1.0 会在 ~1.77s 踏板断裂（走冗余回路、不计热），不属于本组语义。
   */
  function brakeWithThermal(b: number) {
    const v = createVehicleState();
    v.speed = 200 / MS_TO_KMH;
    const p = createPedalState();
    const d0 = v.distance;
    const locks: { t: number; dist: number; speedKmh: number }[] = [];
    let t = 0;
    let seen = 0;
    let maxTemp = 0;
    while (v.speed > BRAKE.stopSpeed && t < 60) {
      stepPedal(p, DT, b);
      stepVehicle(v, DT, { throttle: 0, brake: b, powerCut: true, pedalForce: p.pedalForce });
      t += DT;
      maxTemp = Math.max(maxTemp, v.brakeTemp);
      if (v.thermalLocks > seen) {
        seen = v.thermalLocks;
        locks.push({ t, dist: v.distance - d0, speedKmh: v.speed * MS_TO_KMH });
      }
    }
    return { t, dist: v.distance - d0, maxTemp, locks, snapped: p.snapped, state: v };
  }

  it('单次 200→0 满刹不再必然越过红区：b≤0.92 零锁定，仅 b=0.97 深踩在 93% 行程处锁一次', () => {
    // R17 升温减半（gain 2.4→1.2）后的新标定（Node 同源仿真实测峰值温度）：
    //   b=0.80 → 0.936 / b=0.90 → 0.972 / b=0.92 → 0.987，均低于红区 1.0 → 零锁定；
    //   仅 b=0.97 深踩（回收被机械挤占、摩擦占比更高）峰值 1.02 越线，
    //   在 93% 行程 / v≈28km/h 处锁一次；冷却 0.5/s×2s 清空盘温，解锁后剩余动能
    //   不足以二次锁定（重新攒到 1.0 需要 4.24MJ 摩擦功）。
    // 回归网：谁把 gain 改回 2.4，b≤0.92 会立刻越线 → 本用例红。
    for (const b of [0.8, 0.9, 0.92]) {
      const r = brakeWithThermal(b);
      expect(r.snapped).toBe(false);
      expect(r.maxTemp).toBeLessThan(BRAKE.brakeTempThreshold);
      expect(r.locks.length).toBe(0);
    }
    const deep = brakeWithThermal(0.97);
    expect(deep.snapped).toBe(false);
    expect(deep.maxTemp).toBeGreaterThanOrEqual(BRAKE.brakeTempThreshold);
    expect(deep.locks.length).toBe(1); // 越线但只锁一次（迟滞 + 解锁后剩余动能不足）
    const fraction = deep.locks[0].dist / deep.dist;
    // 新增益下越线点从 46% 后移到 93%（总摩擦功刚好压在红区边上）
    expect(fraction).toBeGreaterThan(0.85);
    expect(fraction).toBeLessThan(0.97);
    expect(deep.locks[0].speedKmh).toBeGreaterThan(20);
    expect(deep.locks[0].speedKmh).toBeLessThan(40);
  });

  it('触顶锁定：2.0s 内机械制动力严格为 0（踏板力仍在，电回收保留）', () => {
    const v = createVehicleState();
    v.speed = 200 / MS_TO_KMH;
    const p = createPedalState();
    let guard = 0;
    while (v.thermalLocks === 0 && guard++ < 120 * 20) {
      stepPedal(p, DT, 0.97);
      stepVehicle(v, DT, { throttle: 0, brake: 0.97, powerCut: true, pedalForce: p.pedalForce });
    }
    expect(v.thermalHold).toBeCloseTo(BRAKE.thermalHoldSeconds, 9);
    expect(v.thermalLocks).toBe(1);

    let steps = 0;
    while (v.thermalHold > 0 && steps < 600) {
      const prevSpeed = v.speed;
      stepPedal(p, DT, 0.97);
      stepVehicle(v, DT, { throttle: 0, brake: 0.97, powerCut: true, pedalForce: p.pedalForce });
      const resist = (dragForce(prevSpeed) + rollForce()) / VEHICLE.totalMassKg;
      const brakeTotal = -v.accel - resist;
      // 驾驶员明明还踩着（需求照记），但机械制动力被切断：只剩回收 0.15g
      expect(v.mechDecelDemand).toBeGreaterThan(9);
      expect(brakeTotal).toBeCloseTo(BRAKE.regenMaxDecel, 9);
      steps++;
    }
    // 240 步（dt=1/120 → 2.0s）；浮点累减可能多挂一步 1e-16 的尾巴，宽 1 步
    const exact = Math.round(BRAKE.thermalHoldSeconds / DT);
    expect(steps).toBeGreaterThanOrEqual(exact);
    expect(steps).toBeLessThanOrEqual(exact + 1);
    expect(v.regenPowerKw).toBeGreaterThan(0); // 回收未被切断
  });

  it('2.0s 后恢复：制动力回到满值，且不会立即二次锁定', () => {
    const r = brakeWithThermal(0.97);
    // 全程只有 1 次锁：冷却 0.5/s×2s 把盘温清到 0，重新攒到 1.0 需要 4.24MJ
    // （R17 增益减半后翻倍），而解锁后剩余动能不足 → 不会出现「贴阈值抖动式反复锁」。
    expect(r.locks.length).toBe(1);
    // 恢复后仍有足够的机械制动力（不是 0 也不是衰减后的 0.85 值）
    const v = r.state;
    expect(v.thermalHold).toBe(0);
    expect(v.speed).toBeLessThanOrEqual(BRAKE.stopSpeed);
    expect(v.thermalLocks).toBe(1);

    // 白盒：锁定计时归零当步仍断力，下一步机械制动立刻回来（不是衰减后的 0.85 值）
    const v2 = createVehicleState();
    v2.speed = 40;
    v2.brakeTemp = BRAKE.thermalTriggerTemp + 0.2; // 仍过热 → 恢复后走 ×0.85 衰减
    v2.thermalArmed = false; // 不重新布防，避免本步立刻二次锁
    v2.thermalHold = DT;
    const forceIn = {
      throttle: 0,
      brake: 0.97,
      powerCut: true,
      pedalForce: BRAKE.breakForceN
    };
    stepVehicle(v2, DT, forceIn);
    expect(v2.thermalHold).toBe(0); // 最后一步仍被切断
    const prevSpeed = v2.speed;
    stepVehicle(v2, DT, forceIn);
    const resist = (dragForce(prevSpeed) + rollForce()) / VEHICLE.totalMassKg;
    expect(-v2.accel - resist).toBeGreaterThan(
      BRAKE.absMaxDecel * 0.9 * BRAKE.brakeTempEfficiency
    );
  });

  it('迟滞：未重新布防时盘温高于阈值也不触发；降到 rearm 以下才重新布防', () => {
    const v = createVehicleState();
    v.speed = 30;
    // 人为构造「刚刚触发完、盘温仍在阈值上」的边角：armed=false
    v.brakeTemp = BRAKE.thermalTriggerTemp + 0.2;
    v.thermalArmed = false;
    stepVehicle(v, DT, { throttle: 0, brake: 0.97, powerCut: true, pedalForce: BRAKE.breakForceN });
    expect(v.thermalLocks).toBe(0);
    expect(v.thermalHold).toBe(0);

    // 冷却到 rearm 以下 → 重新布防
    let guard = 0;
    while (!v.thermalArmed && guard++ < 120 * 30) {
      stepVehicle(v, DT, { throttle: 0, brake: 0, powerCut: true, pedalForce: 0 });
    }
    expect(v.thermalArmed).toBe(true);
    expect(v.brakeTemp).toBeLessThan(BRAKE.thermalRearmTemp);

    // 再踩满：必须重新越过阈值才触发
    // R17 注：新增益（1.2）下半档热预算减半——从 30m/s 满踩只能攒 +0.34（0.6→0.94），
    // 永远摸不到红区；取 60m/s 满踩热预算 +1.38（0.6→1.98）才能干净地验证「重新越线才触发」。
    v.speed = 60;
    guard = 0;
    while (v.thermalLocks === 0 && guard++ < 120 * 30) {
      stepVehicle(v, DT, { throttle: 0, brake: 0.97, powerCut: true, pedalForce: BRAKE.breakForceN });
    }
    expect(v.thermalLocks).toBe(1);
    expect(v.thermalHold).toBeCloseTo(BRAKE.thermalHoldSeconds, 9);
  });

  it('冗余回路接管时解除热保护（独立液压回路 + heatless，不叠加惩罚）', () => {
    const v = createVehicleState();
    v.speed = 40;
    v.brakeTemp = 1.4;
    v.thermalHold = 1.5;
    v.thermalArmed = false;
    stepVehicle(v, DT, {
      throttle: 0,
      brake: 0,
      powerCut: true,
      pedalForce: 0,
      redundancyDecel: 2.7
    });
    expect(v.thermalHold).toBe(0);
    expect(v.thermalArmed).toBe(true);
    expect(v.brakeTemp).toBeLessThan(1.4); // 不计热
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

describe('HUD 热保护文案（不依赖 DOM 的纯函数）', () => {
  it('倒计时文案 = 「制动盘过热 · 冷却中 N.Ns」，负值归零', () => {
    expect(thermalBannerText(2)).toBe('制动盘过热 · 冷却中 2.0s');
    expect(thermalBannerText(1.24)).toBe('制动盘过热 · 冷却中 1.2s');
    expect(thermalBannerText(-1)).toBe('制动盘过热 · 冷却中 0.0s');
    expect(THERMAL_BANNER_HINT).toContain('踏板暂时无效');
  });
});
