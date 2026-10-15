/**
 * 紧急制动安全冗余（踏板断裂后接管）契约测试。
 *
 * 玩法语义（2026-10-15 锁定规格 决策①）：断裂从「整车翻滚 = 立即失败」改为
 * 「踏板脱开 + 冗余回路以 1/4 满载力度接管，车辆继续行驶直至停下」。
 * 结算语义：**冗余刹停 = 判负**（制动系统已失效，「侥幸逃生」≠ 成功刹停），
 * 计分 0、不写入本机最佳；翻滚演出只保留给撞路障。
 *
 * 这些用例锁住四件事：
 * 1. 断裂不再翻滚（无 crash 事件），但必须真的更慢（惩罚真实存在）；
 * 2. 冗余力度严格是满载的 1/4（不能偷偷变强或变弱）；
 * 3. 冗余制动不过热、不依赖踏板输入（踏板已断，驾驶员踩空）；
 * 4. 撞路障失败路径未被破坏。
 */
import { describe, expect, it } from 'vitest';
import { BRAKE, GRAVITY, MS_TO_KMH, REDUNDANCY, VEHICLE } from '../src/config/physics';
import {
  createPedalState,
  redundancyDecel,
  resetPedal,
  stepPedal
} from '../src/physics/BrakeModel';
import { createVehicleState, stepVehicle } from '../src/physics/Vehicle';
import { StateMachine } from '../src/core/StateMachine';

const DT = 1 / 120;
/** 满载踏板力对应的减速度（= absMaxDecel，见 physics.ts 同源常量） */
const FULL_DECEL = BRAKE.breakForceN * BRAKE.decelPerNewton;
/** 冗余满压制动力 */
const REDUN_DECEL = FULL_DECEL * REDUNDANCY.forceRatio;

/** 把踏板踩到断裂 */
function snapPedal() {
  const p = createPedalState();
  let guard = 0;
  while (!stepPedal(p, DT, 1) && guard++ < 120 * 30) {
    /* 踩满直到断裂 */
  }
  return p;
}

describe('冗余力度严格等于满载 1/4', () => {
  it('建压完成后减速度 = 满载 × forceRatio', () => {
    const p = snapPedal();
    for (let i = 0; i < 120; i++) stepPedal(p, DT, 1);
    expect(p.redundancy).toBe(1);
    expect(redundancyDecel(p)).toBeCloseTo(REDUN_DECEL, 6);
  });

  it('1/4 力度换算为约 2.70 m/s²（约 0.275g）', () => {
    const p = snapPedal();
    for (let i = 0; i < 120; i++) stepPedal(p, DT, 1);
    const d = redundancyDecel(p);
    expect(d).toBeGreaterThan(2.6);
    expect(d).toBeLessThan(2.8);
    expect(d / GRAVITY).toBeGreaterThan(0.26);
    expect(d / GRAVITY).toBeLessThan(0.29);
  });

  it('建压是渐进的，不是断裂瞬间就满力', () => {
    const p = snapPedal();
    expect(p.redundancy).toBe(0);
    stepPedal(p, DT, 1);
    expect(redundancyDecel(p)).toBeLessThan(REDUN_DECEL * 0.5);
    const steps = Math.ceil(REDUNDANCY.rampSeconds / DT);
    for (let i = 0; i < steps; i++) stepPedal(p, DT, 1);
    expect(p.redundancy).toBe(1);
  });

  it('未断裂时冗余不生效', () => {
    const p = createPedalState();
    for (let i = 0; i < 120 * 5; i++) stepPedal(p, DT, 0.97);
    expect(p.snapped).toBe(false);
    expect(redundancyDecel(p)).toBe(0);
  });
});

describe('踏板断裂后的状态语义', () => {
  it('断裂后踏板力归零（驾驶员踩空），不再保持 breakForceN', () => {
    const p = snapPedal();
    expect(p.pedalForce).toBe(0);
    expect(p.snapped).toBe(true);
    expect(p.snapTime).not.toBeNull();
  });

  it('断裂事件只派发一次（已断裂后重复 step 不再返回 true）', () => {
    const p = createPedalState();
    let count = 0;
    for (let i = 0; i < 120 * 5; i++) if (stepPedal(p, DT, 1)) count++;
    expect(count).toBe(1);
  });

  it('断裂后无论滑条怎么踩，踏板力都保持 0', () => {
    const p = snapPedal();
    for (let i = 0; i < 120; i++) stepPedal(p, DT, 1);
    expect(p.pedalForce).toBe(0);
    for (let i = 0; i < 120; i++) stepPedal(p, DT, 0.3);
    expect(p.pedalForce).toBe(0);
  });

  it('resetPedal 能完全复位（重开一局）', () => {
    const p = snapPedal();
    resetPedal(p);
    expect(p.snapped).toBe(false);
    expect(p.pedalForce).toBe(0);
    expect(p.snapTime).toBeNull();
    expect(p.redundancy).toBe(0);
  });
});

describe('冗余制动的物理表现', () => {
  it('断裂后车辆持续减速直至停车（不会卡住或倒退）', () => {
    const v = createVehicleState();
    v.speed = 200 / MS_TO_KMH;
    const p = snapPedal();
    let t = 0;
    let last = v.speed;
    while (v.speed > BRAKE.stopSpeed && t < 60) {
      stepPedal(p, DT, 1);
      stepVehicle(v, DT, {
        throttle: 0,
        brake: 0, // 踏板已断：驾驶员踩空
        powerCut: true,
        pedalForce: p.pedalForce,
        redundancyDecel: redundancyDecel(p)
      });
      expect(v.speed).toBeLessThanOrEqual(last + 1e-9); // 单调减速
      last = v.speed;
      t += DT;
    }
    expect(v.speed).toBeLessThanOrEqual(BRAKE.stopSpeed);
    expect(t).toBeGreaterThan(10); // 1/4 力度下必然很慢
  });

  it('冗余制动不会让制动盘过热（heatless：不为已判负的局再叠加惩罚）', () => {
    const v = createVehicleState();
    v.speed = 200 / MS_TO_KMH;
    const p = snapPedal();
    for (let i = 0; i < 120 * 20; i++) {
      stepPedal(p, DT, 1);
      stepVehicle(v, DT, {
        throttle: 0,
        brake: 0,
        powerCut: true,
        pedalForce: p.pedalForce,
        redundancyDecel: redundancyDecel(p)
      });
    }
    expect(v.brakeTemp).toBeLessThan(BRAKE.brakeTempThreshold);
    expect(v.overheat).toBe(false);
  });

  it('冗余制动力与踏板输入无关（踩满滑条不会加快）', () => {
    const run = (slider: number): number => {
      const v = createVehicleState();
      v.speed = 160 / MS_TO_KMH;
      const p = snapPedal();
      let t = 0;
      while (v.speed > BRAKE.stopSpeed && t < 60) {
        stepPedal(p, DT, slider);
        stepVehicle(v, DT, {
          throttle: 0,
          brake: p.snapped ? 0 : slider,
          powerCut: true,
          pedalForce: p.pedalForce,
          redundancyDecel: redundancyDecel(p)
        });
        t += DT;
      }
      return t;
    };
    expect(run(1)).toBeCloseTo(run(0), 3);
  });
});

describe('完整会话：断裂 = 判负但不翻滚', () => {
  /** 全油门到限速自动切入，然后按 brake 值刹到底 */
  const run = (brake: number, extraCruiseM = 0) => {
    const sm = new StateMachine();
    sm.start();
    let guard = 0;
    let cruise = 0;
    const seen: string[] = [];
    while (sm.phase !== 'crashed' && sm.phase !== 'stopped' && guard++ < 120 * 500) {
      let pressed = false;
      if (sm.phase === 'accel' && sm.atLimiter) {
        cruise += sm.vehicle.speed * DT;
        if (cruise >= extraCruiseM) pressed = true;
      }
      const events = sm.step(DT, {
        throttle: sm.phase === 'accel' ? 1 : 0,
        brake: sm.phase === 'brake' ? brake : 0,
        brakePressed: pressed || sm.phase === 'brake'
      });
      for (const e of events) seen.push(e.type);
    }
    return { sm, seen, result: sm.lastResult! };
  };

  it('断裂会话：无 crash 事件，走 stopped 且标记判负', () => {
    const { sm, result, seen } = run(1);
    expect(seen).toContain('pedal_snap');
    expect(seen).toContain('stopped');
    expect(seen).not.toContain('crash');
    expect(sm.phase).toBe('stopped');
    expect(result.success).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('brake_pedal_failed');
    expect(result.score).toBe(0);
    expect(result.snapTime!).toBeGreaterThan(1.5);
    expect(result.redundancyDistance!).toBeGreaterThan(0);
  });

  it('未断裂会话：success=true、degraded=false、无冗余距离', () => {
    const { result, seen } = run(0.97);
    expect(seen).not.toContain('pedal_snap');
    expect(result.success).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.redundancyDistance).toBeNull();
    expect(result.score).toBeGreaterThan(0);
  });

  it('断裂的惩罚真实存在：用时 >2.5×、距离 >2.5×（得分直接归零）', () => {
    const snapped = run(1).result;
    const clean = run(0.97).result;
    expect(snapped.stopSeconds).toBeGreaterThan(clean.stopSeconds * 2.5);
    expect(snapped.stopDistance).toBeGreaterThan(clean.stopDistance * 2.5);
    expect(snapped.score).toBe(0);
    expect(clean.score).toBeGreaterThan(6000);
  });

  it('断裂后仍能在路障前停住（常规切入不会必然撞车）', () => {
    const { sm, result } = run(1);
    expect(sm.phase).toBe('stopped');
    expect(result.reason).toBe('brake_pedal_failed');
  });

  it('刻意贴近路障晚切（额外巡航 300m）→ 撞障翻滚结局可达', () => {
    const { sm, result, seen } = run(1, 300);
    expect(seen).toContain('crash');
    expect(sm.phase).toBe('crashed');
    expect(result.reason).toBe('barrier');
    expect(result.degraded).toBe(true);
  });

  it('完全不刹车仍会撞路障（失败路径未被破坏）', () => {
    const sm = new StateMachine();
    sm.start();
    let guard = 0;
    while (sm.phase !== 'crashed' && sm.phase !== 'stopped' && guard++ < 120 * 500) {
      sm.step(DT, {
        throttle: sm.phase === 'accel' ? 1 : 0,
        brake: 0,
        brakePressed: sm.atLimiter
      });
    }
    expect(sm.phase).toBe('crashed');
    expect(sm.lastResult!.success).toBe(false);
    expect(sm.lastResult!.score).toBe(0);
  });

  it('冗余制动期间的峰值踏板力记录为断裂力', () => {
    const { result } = run(1);
    expect(result.peakForce).toBe(BRAKE.breakForceN);
  });
});

describe('参数自洽性', () => {
  it('冗余力度显著低于 ABS 上限（不会出现抓地饱和）', () => {
    expect(REDUN_DECEL).toBeLessThan(BRAKE.absMaxDecel * 0.4);
  });

  it('冗余力度足以克服行驶阻力（能真正刹停）', () => {
    const v = VEHICLE.maxSpeedKmh / MS_TO_KMH;
    const resist =
      (0.5 * VEHICLE.airDensity * VEHICLE.dragCd * VEHICLE.frontalAreaM2 * v * v +
        VEHICLE.rollResistCrr * VEHICLE.totalMassKg * GRAVITY) /
      VEHICLE.totalMassKg;
    expect(REDUN_DECEL + resist).toBeGreaterThan(2);
  });

  it('建压时间在合理区间（既有缓冲又不拖沓）', () => {
    expect(REDUNDANCY.rampSeconds).toBeGreaterThan(0.1);
    expect(REDUNDANCY.rampSeconds).toBeLessThan(1);
  });
});
