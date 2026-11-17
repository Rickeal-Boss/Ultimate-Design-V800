/**
 * R92 半程爆胎玩法 · 物理与状态机护栏（新增文件，不改任何既有测试）。
 *
 * 锁住 5 条契约：
 * 1. 触发线 = 可行驶总长正中 648.65m，仅 accel 段触发一次，事件带 distance/speedKmh；
 * 2. `#r92tire=off` 回滚：不触发、无拖阻（仍能到电子限速）；
 * 3. 5200N 拖阻只在加速段、严格 = extraDragN/mass，复用风阻/限速钳位路径；
 * 4. **刹车段零影响**：同一初速下爆胎/未爆胎的刹停距离、峰值力、冗余距离逐位相同；
 * 5. 姿态平稳由 1D 物理结构性保证：本模块不写任何姿态字段（源码级 + 字段级双断言）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MS_TO_KMH, VEHICLE } from '../src/config/physics';
import {
  StateMachine,
  TIRE_BLOW_DISTANCE_M,
  TIRE_BLOW_DRAG_N,
  isTireBlowEnabled,
  type GameEvent
} from '../src/core/StateMachine';
import { createVehicleState, stepVehicle, type VehicleInput } from '../src/physics/Vehicle';

const DT = 1 / 120;
const ACCEL_INPUT: VehicleInput = { throttle: 1, brake: 0, powerCut: false, pedalForce: 0 };
type TireBlowEvent = Extract<GameEvent, { type: 'tire_blow' }>;

/** 运行时 stub hash（isTireBlowEnabled 每步读 window，无需 resetModules） */
function setHash(hash: string): void {
  vi.stubGlobal('window', { location: { hash } });
}
afterEach(() => vi.unstubAllGlobals());

/** 跳过 3s 倒计时，停在 accel 段第一帧之前 */
function enterAccel(sm: StateMachine): void {
  sm.start();
  let guard = 0;
  while (sm.phase === 'countdown' && guard++ < 120 * 10) sm.step(DT, ACCEL_INPUT);
  expect(sm.phase).toBe('accel');
}

function blowEvents(events: GameEvent[]): TireBlowEvent[] {
  return events.filter((e): e is TireBlowEvent => e.type === 'tire_blow');
}

describe('R92 开关与触发线', () => {
  it('浏览器默认开；无头（vitest node pool）恒关；#r92tire=off 兼容复合 hash 与大小写', () => {
    expect(isTireBlowEnabled()).toBe(false); // window 未 stub 的原生无头态
    setHash('');
    expect(isTireBlowEnabled()).toBe(true);
    setHash('#foo=bar&r92tire=off&baz=1');
    expect(isTireBlowEnabled()).toBe(false);
    setHash('#R92TIRE=OFF');
    expect(isTireBlowEnabled()).toBe(false);
    setHash('#r92tire=on');
    expect(isTireBlowEnabled()).toBe(true);
  });

  it('触发线由冻结常量派生 = 648.65m，拖阻 = 5200N', () => {
    expect(TIRE_BLOW_DISTANCE_M).toBeCloseTo(648.65, 10);
    expect(TIRE_BLOW_DRAG_N).toBe(5200);
  });

  it('半程前（距线 ≥20m）不触发、tireBlown 保持 false', () => {
    setHash('');
    const sm = new StateMachine();
    enterAccel(sm);
    const events: GameEvent[] = [];
    let guard = 0;
    while (sm.vehicle.distance < TIRE_BLOW_DISTANCE_M - 20 && guard++ < 120 * 30) {
      events.push(...sm.step(DT, ACCEL_INPUT));
    }
    expect(sm.vehicle.distance).toBeGreaterThan(TIRE_BLOW_DISTANCE_M - 22);
    expect(sm.vehicle.distance).toBeLessThan(TIRE_BLOW_DISTANCE_M);
    expect(blowEvents(events)).toHaveLength(0);
    expect(sm.tireBlown).toBe(false);
  });

  it('跨过半程恰好发一次 tire_blow，带 distance/speedKmh；后续多帧不重发', () => {
    setHash('');
    const sm = new StateMachine();
    enterAccel(sm);
    const events: GameEvent[] = [];
    let guard = 0;
    while (sm.vehicle.distance < TIRE_BLOW_DISTANCE_M + 50 && guard++ < 120 * 60) {
      events.push(...sm.step(DT, ACCEL_INPUT));
    }
    const blows = blowEvents(events);
    expect(blows).toHaveLength(1);
    expect(blows[0].distance).toBeGreaterThanOrEqual(TIRE_BLOW_DISTANCE_M);
    expect(blows[0].distance).toBeLessThan(TIRE_BLOW_DISTANCE_M + 1); // 单帧跨线，不累积
    expect(blows[0].speedKmh).toBeGreaterThan(190);
    expect(sm.tireBlown).toBe(true);

    const more: GameEvent[] = [];
    for (let i = 0; i < 120 * 5; i++) more.push(...sm.step(DT, ACCEL_INPUT));
    expect(blowEvents(more)).toHaveLength(0);
  });

  it('重开一局 / 回菜单复位 tireBlown（下一局可再次触发）', () => {
    setHash('');
    const sm = new StateMachine();
    enterAccel(sm);
    let guard = 0;
    while (!sm.tireBlown && guard++ < 120 * 30) sm.step(DT, ACCEL_INPUT);
    expect(sm.tireBlown).toBe(true);
    sm.start();
    expect(sm.tireBlown).toBe(false);
    expect(sm.vehicle.distance).toBe(0);
    sm.tireBlown = true;
    sm.toMenu();
    expect(sm.tireBlown).toBe(false);
  });
});

describe('R92 回滚：#r92tire=off', () => {
  it('不触发、无拖阻：跨过半程后仍能加速到电子限速', () => {
    setHash('#r92tire=off');
    const sm = new StateMachine();
    enterAccel(sm);
    const events: GameEvent[] = [];
    let guard = 0;
    while (sm.vehicle.distance < TIRE_BLOW_DISTANCE_M + 100 && guard++ < 120 * 60) {
      events.push(...sm.step(DT, ACCEL_INPUT));
    }
    expect(blowEvents(events)).toHaveLength(0);
    expect(sm.tireBlown).toBe(false);
    // 有 5200N 拖阻时功率平衡极速 179.8km/h，永远到不了 199km/h 门槛
    expect(sm.atLimiter).toBe(true);
  });
});

describe('R92 加速段拖阻', () => {
  it('同一车辆态下加速度精确下降 extraDragN/mass，速度/里程同步变小', () => {
    const clean = createVehicleState();
    const blown = createVehicleState();
    clean.speed = blown.speed = 140 / MS_TO_KMH;
    stepVehicle(clean, DT, ACCEL_INPUT);
    stepVehicle(blown, DT, { ...ACCEL_INPUT, extraDragN: TIRE_BLOW_DRAG_N });
    expect(blown.accel).toBeCloseTo(
      clean.accel - TIRE_BLOW_DRAG_N / VEHICLE.totalMassKg,
      12
    );
    expect(blown.speed).toBeLessThan(clean.speed);
    expect(blown.distance).toBeLessThan(clean.distance);
  });

  it('StateMachine 层：爆胎前与无爆胎逐位一致，爆胎后同输入明显更慢', () => {
    setHash('');
    const on = new StateMachine();
    enterAccel(on);
    let guard = 0;
    let frames = 0;
    while (!on.tireBlown && guard++ < 120 * 30) {
      on.step(DT, ACCEL_INPUT);
      frames++;
    }
    expect(on.tireBlown).toBe(true);

    setHash('#r92tire=off');
    const off = new StateMachine();
    enterAccel(off);
    for (let i = 0; i < frames; i++) off.step(DT, ACCEL_INPUT);
    expect(on.vehicle.speed).toBeCloseTo(off.vehicle.speed, 12); // 触发前无差异
    // on 的 tireBlown 已置位：拖阻读布尔位而非 hash，此后无需再切 hash
    for (let i = 0; i < 120 * 2; i++) {
      on.step(DT, ACCEL_INPUT);
      off.step(DT, ACCEL_INPUT);
    }
    expect(on.vehicle.speed).toBeLessThan(off.vehicle.speed);
    expect(off.atLimiter).toBe(true);
    expect(on.atLimiter).toBe(false);
  });
});

describe('R92 核心契约：刹车段零影响（逐位相同）', () => {
  it('stepVehicle 刹车分支完全不读 extraDragN（含热衰减与冗余回路）', () => {
    const mk = (speedKmh: number, brakeTemp: number) => {
      const v = createVehicleState();
      v.speed = speedKmh / MS_TO_KMH;
      v.brakeTemp = brakeTemp;
      return v;
    };
    const pairs: Array<[ReturnType<typeof mk>, VehicleInput]> = [
      [mk(180, 0.3), { throttle: 0, brake: 0.97, powerCut: true, pedalForce: 1200 }],
      [mk(160, 0), { throttle: 0, brake: 0, powerCut: true, pedalForce: 0, redundancyDecel: 2.7 }]
    ];
    for (const [clean, input] of pairs) {
      const blown = { ...clean };
      for (let i = 0; i < 120 * 8; i++) {
        stepVehicle(clean, DT, input);
        stepVehicle(blown, DT, { ...input, extraDragN: TIRE_BLOW_DRAG_N });
        expect(blown).toEqual(clean);
      }
    }
  });

  it('整局刹停：同一初速下距离/时间/峰值力/采样/冗余距离逐位相同', () => {
    setHash('');
    const run = (blown: boolean) => {
      const sm = new StateMachine();
      enterAccel(sm);
      // 注入完全相同的初速/里程/盘温，隔离加速段轨迹差异
      sm.vehicle.speed = 200 / MS_TO_KMH;
      sm.vehicle.distance = 700;
      sm.vehicle.brakeTemp = 0.3;
      sm.tireBlown = blown;
      const events: GameEvent[] = [];
      let guard = 0;
      while (sm.phase !== 'stopped' && sm.phase !== 'crashed' && guard++ < 120 * 60) {
        events.push(...sm.step(DT, { throttle: 0, brake: 1, brakePressed: true }));
      }
      return { sm, events, result: sm.lastResult! };
    };
    const clean = run(false);
    const blown = run(true);
    expect(clean.sm.phase).toBe('stopped');
    expect(blown.sm.phase).toBe('stopped');
    expect(blown.sm.vehicle).toEqual(clean.sm.vehicle);
    expect(blown.result).toEqual(clean.result);
    expect(blowEvents(blown.events)).toHaveLength(0); // 手动置位不重发事件
  });

  it('源码级：stepBraking 调用块不含 extraDragN；accel 分支才传', () => {
    const src = readFileSync(new URL('../src/core/StateMachine.ts', import.meta.url), 'utf8');
    const brakeBlock = src.slice(
      src.indexOf('private stepBraking'),
      src.indexOf('private recordSample')
    );
    expect(brakeBlock).not.toContain('extraDragN');
    const accelBlock = src.slice(src.indexOf("case 'accel'"), src.indexOf("case 'brake'"));
    expect(accelBlock).toContain('extraDragN: this.tireBlown ? TIRE_BLOW_DRAG_N : 0');
    const vehicleSrc = readFileSync(new URL('../src/physics/Vehicle.ts', import.meta.url), 'utf8');
    const powerCutBlock = vehicleSrc.slice(
      vehicleSrc.indexOf('if (input.powerCut)'),
      vehicleSrc.indexOf('// 加速段')
    );
    expect(powerCutBlock).not.toContain('extraDrag');
  });
});

describe('R92 姿态平稳（结构性保证）', () => {
  it('物理与状态机源码无横向姿态写入；运行时状态无 roll/pitch/yaw 字段', () => {
    for (const rel of ['../src/core/StateMachine.ts', '../src/physics/Vehicle.ts']) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(src).not.toMatch(/\brotation\s*\.\s*[yz]\b/i);
      expect(src).not.toMatch(/\b(roll|pitch|yaw|tilt|quaternion)\b/i);
    }
    setHash('');
    const sm = new StateMachine();
    enterAccel(sm);
    let guard = 0;
    while (!sm.tireBlown && guard++ < 120 * 30) sm.step(DT, ACCEL_INPUT);
    for (let i = 0; i < 120; i++) sm.step(DT, ACCEL_INPUT);
    const postureKeys = (o: object): string[] =>
      Object.keys(o).filter((k) => /rot|roll|pitch|yaw|tilt|quat/i.test(k));
    expect(postureKeys(sm.vehicle)).toEqual([]);
    expect(postureKeys(sm)).toEqual([]);
    expect(sm.tireBlown).toBe(true);
  });
});

describe('R92 数值口径（真实 StateMachine / stepVehicle 实测，供交接文档引用）', () => {
  it('限速切入里程、半程爆胎车速、5200N 拖阻功率平衡极速', () => {
    // ① 无爆胎：0 → atLimiter 的切入里程（真实 StateMachine）
    setHash('#r92tire=off');
    const clean = new StateMachine();
    enterAccel(clean);
    let guard = 0;
    while (!clean.atLimiter && guard++ < 120 * 60) clean.step(DT, ACCEL_INPUT);
    const cutInM = clean.vehicle.distance;
    const cutInKmh = clean.speedKmh;

    // ② 爆胎开启：跨半程那一帧事件携带的车速（真实 StateMachine）
    setHash('');
    const blown = new StateMachine();
    enterAccel(blown);
    guard = 0;
    let blow: TireBlowEvent | null = null;
    while (!blow && guard++ < 120 * 60) {
      const found = blowEvents(blown.step(DT, ACCEL_INPUT));
      if (found.length) blow = found[0];
    }
    expect(blow).not.toBeNull();
    const blowM = blow!.distance;
    const blowKmh = blow!.speedKmh;

    // ③ 功率平衡极速：用真实 stepVehicle 的 accel 输出二分求零（不靠近似公式）
    const accelAt = (speed: number): number => {
      const v = createVehicleState();
      v.speed = speed;
      stepVehicle(v, DT, { ...ACCEL_INPUT, extraDragN: TIRE_BLOW_DRAG_N });
      return v.accel;
    };
    let lo = 30;
    let hi = 60;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (accelAt(mid) > 0) lo = mid;
      else hi = mid;
    }
    const balanceKmh = ((lo + hi) / 2) * MS_TO_KMH;

    console.info(
      `[R92] 限速切入 ${cutInM.toFixed(2)}m @ ${cutInKmh.toFixed(2)}km/h | ` +
        `半程爆胎 ${blowM.toFixed(3)}m @ ${blowKmh.toFixed(2)}km/h | ` +
        `拖阻平衡极速 ${balanceKmh.toFixed(2)}km/h`
    );
    expect(cutInM).toBeGreaterThan(650);
    expect(cutInM).toBeLessThan(675);
    expect(cutInKmh).toBeGreaterThan(198.9);
    expect(cutInKmh).toBeLessThan(199.2); // atLimiter 199 门槛 + 单帧过冲
    expect(blowM).toBeGreaterThanOrEqual(TIRE_BLOW_DISTANCE_M);
    expect(blowM).toBeLessThan(TIRE_BLOW_DISTANCE_M + 1); // 单帧跨线过冲 ≤0.46m
    expect(blowKmh).toBeGreaterThan(195);
    expect(blowKmh).toBeLessThan(200);
    expect(balanceKmh).toBeGreaterThan(178);
    expect(balanceKmh).toBeLessThan(182);
  });
});

/**
 * R94-P3：爆胎触发**相位无关**（原只在 `case 'accel'` 内调用）。
 *
 * 时序实测（真实 StateMachine，DT=1/120s，本文件末尾「数值口径」describe 有 console.info）：
 * - 爆胎开：满油门**永远到不了** atLimiter（199km/h 门槛）——5200N 拖阻把平衡极速压到
 *   179.76km/h，随后一路 188km/h 慢爬到 1297.36m 撞主殿（`crashed`）。爆胎在 accel 段
 *   648.665m @197.97km/h 触发，事件总数 1。
 * - 爆胎关：加速到 atLimiter 的切入里程 **661.53m @199.03km/h**；此时满踏板起刹，
 *   刹停 **1090.79m**，爆胎在 **brake 段 661.993m @198.96km/h** 触发（修复前永不可达）。
 * - 更早切刹：在 640.89m @197.32km/h 切刹 ⇒ 爆胎 **649.082m @196.07km/h（brake 段）**。
 * ⇒ 玩家在 648.65m 之前切刹车（正常打法：~450m 起刹）时，跨线那一帧 phase 已是 'brake'。
 */
describe('R94 护栏：刹车段触发（相位无关化）', () => {
  const BRAKE_INPUT = { throttle: 0, brake: 1, brakePressed: true };

  /** 跳过倒计时到 accel */
  const toAccel = (sm: StateMachine): void => {
    sm.start();
    let guard = 0;
    while (sm.phase === 'countdown' && guard++ < 120 * 10) sm.step(DT, ACCEL_INPUT);
    expect(sm.phase).toBe('accel');
  };

  /**
   * 构造「跨线那一帧 phase 已是 brake」的时序：
   * 爆胎关 → 满油门加速到 <648.65m（全程不触发）→ 开爆胎并满踏板切刹（同一帧后 phase='brake'）
   * ⇒ 此后跨过 648.65m 时 only brake 段在跑 ⇒ 爆胎必在 brake 段发。
   * 注：爆胎开时加速段本身就会在 648.665m 触发，故无法用「爆胎开+先加速」构造 brake 段触发；
   * 此构造隔离了 accel 段触发，专测 brake 段路径。
   */
  const brakeBeforeLine = (): StateMachine => {
    setHash('#r92tire=off');
    const sm = new StateMachine();
    toAccel(sm);
    let guard = 0;
    while (sm.vehicle.distance < TIRE_BLOW_DISTANCE_M - 8 && guard++ < 120 * 60)
      sm.step(DT, ACCEL_INPUT);
    expect(sm.phase).toBe('accel');
    expect(sm.vehicle.distance).toBeLessThan(TIRE_BLOW_DISTANCE_M);
    expect(sm.tireBlown).toBe(false); // 爆胎关 ⇒ accel 段不触发
    // 开爆胎 + 满踏板切刹车（车速 ~197km/h ≥ minSpeedKmh 100 ⇒ 立即切相位）
    setHash('');
    guard = 0;
    while (sm.phase === 'accel' && guard++ < 120 * 5) sm.step(DT, BRAKE_INPUT);
    expect(sm.phase).toBe('brake');
    return sm;
  };

  it('phase=brake 时里程跨过 648.65m ⇒ 恰好发一次 tire_blow', () => {
    const sm = brakeBeforeLine();
    let blows: TireBlowEvent[] = [];
    let frames = 0;
    for (let i = 0; i < 120 && blows.length === 0; i++) {
      blows = blowEvents(sm.step(DT, BRAKE_INPUT));
      frames++;
    }
    expect(blows).toHaveLength(1);
    expect(sm.phase).toBe('brake'); // 触发帧仍在刹车段（不是 accel）——修复前的死区
    expect(blows[0].distance).toBeGreaterThanOrEqual(TIRE_BLOW_DISTANCE_M);
    // 切刹点 ≤640.65m，单帧跨线过冲 ≤0.5m ⇒ 触发点必在 649.2m 内
    expect(blows[0].distance).toBeLessThan(TIRE_BLOW_DISTANCE_M + 0.6);
    expect(blows[0].speedKmh).toBeGreaterThan(100); // 仍在有效刹停车速
    expect(frames).toBeLessThanOrEqual(20); // 距线 ≤8m ⇒ ≤0.17s 内必触发
    expect(sm.tireBlown).toBe(true);
  });

  it('刹车段触发只置布尔位：extraDragN 恒不进入 stepBraking ⇒ 整局 vehicle/lastResult 逐位零影响', () => {
    setHash('');
    const run = (armBlow: boolean) => {
      const sm = new StateMachine();
      toAccel(sm);
      // 同一初速/里程/盘温，直接切入 brake 段（mileage 恰在爆胎线之后）
      sm.vehicle.speed = 200 / MS_TO_KMH;
      sm.vehicle.distance = TIRE_BLOW_DISTANCE_M + 0.4;
      sm.vehicle.brakeTemp = 0.3;
      sm.phase = 'brake';
      sm.v0Kmh = 200;
      sm.brakeStartDistance = TIRE_BLOW_DISTANCE_M + 0.4;
      if (armBlow) sm.tireBlown = true; // 刹车段触发只置布尔位，不改物理
      const events: GameEvent[] = [];
      let guard = 0;
      while (sm.phase !== 'stopped' && sm.phase !== 'crashed' && guard++ < 120 * 60) {
        events.push(...sm.step(DT, BRAKE_INPUT));
      }
      return { sm, events, result: sm.lastResult! };
    };
    const clean = run(false);
    const blown = run(true);
    expect(clean.sm.phase).toBe('stopped');
    expect(blown.sm.phase).toBe('stopped');
    expect(blown.sm.vehicle).toEqual(clean.sm.vehicle);
    expect(blown.result).toEqual(clean.result);
    // 已置位 ⇒ 不得重发
    expect(blowEvents(blown.events)).toHaveLength(0);
  });

  it('每局仅一次：刹车段触发后继续跑 5s 不重发', () => {
    const sm = brakeBeforeLine();
    // 触发爆胎
    const during: GameEvent[] = [];
    let guard = 0;
    while (!sm.tireBlown && guard++ < 120 * 10) during.push(...sm.step(DT, BRAKE_INPUT));
    expect(sm.tireBlown).toBe(true);
    expect(blowEvents(during)).toHaveLength(1);
    // 触发后继续跑 5s（可能刹停）：不得重发
    const more: GameEvent[] = [];
    for (let i = 0; i < 120 * 5; i++) more.push(...sm.step(DT, BRAKE_INPUT));
    expect(blowEvents(more)).toHaveLength(0);
  });

  it('countdown/menu/stopped/crashed 段不触发（即使里程 ≥ 648.65m）', () => {
    setHash('');
    // countdown：里程已越线，仍不得发事件
    {
      const sm = new StateMachine();
      sm.start();
      sm.vehicle.distance = TIRE_BLOW_DISTANCE_M + 40;
      sm.vehicle.speed = 100 / MS_TO_KMH;
      const events = sm.step(DT, ACCEL_INPUT);
      expect(sm.phase).toBe('countdown');
      expect(blowEvents(events)).toHaveLength(0);
      expect(sm.tireBlown).toBe(false);
    }
    // menu：里程越线 + 满速也不触发
    {
      const sm = new StateMachine();
      sm.vehicle.distance = TIRE_BLOW_DISTANCE_M + 40;
      sm.vehicle.speed = 200 / MS_TO_KMH;
      const events = sm.step(DT, ACCEL_INPUT);
      expect(sm.phase).toBe('menu');
      expect(blowEvents(events)).toHaveLength(0);
      expect(sm.tireBlown).toBe(false);
    }
    // stopped / crashed：置位与否均不再发事件
    {
      for (const preset of [false, true]) {
        const sm = new StateMachine();
        sm.vehicle.distance = TIRE_BLOW_DISTANCE_M + 40;
        sm.vehicle.speed = 0;
        sm.tireBlown = preset;
        for (const ph of ['stopped', 'crashed'] as const) {
          sm.phase = ph;
          const events = sm.step(DT, { throttle: 0, brake: 0, brakePressed: false });
          expect(blowEvents(events), `${ph} 段不得触发`).toHaveLength(0);
        }
      }
    }
  });

  it('正常一局（爆胎开）：满油门到撞主殿，爆胎在 accel 段触发一次（回归既有玩法）', () => {
    setHash('');
    const sm = new StateMachine();
    toAccel(sm);
    const all: GameEvent[] = [];
    let guard = 0;
    let phaseAtBlow: string | null = null;
    while (
      sm.phase !== 'stopped' &&
      sm.phase !== 'crashed' &&
      guard++ < 120 * 120
    ) {
      const ev = sm.step(DT, ACCEL_INPUT);
      all.push(...ev);
      const found = blowEvents(ev);
      if (found.length) phaseAtBlow = sm.phase;
    }
    const blows = blowEvents(all);
    console.info(
      `[R94] 爆胎开正常一局：触发 ${blows[0]?.distance.toFixed(3)}m @ ` +
        `${blows[0]?.speedKmh.toFixed(2)}km/h | 相位=${phaseAtBlow ?? 'n/a'} | ` +
        `终局=${sm.phase} @ ${sm.vehicle.distance.toFixed(2)}m | 事件数=${blows.length}`
    );
    expect(blows).toHaveLength(1);
    expect(sm.phase).toBe('crashed'); // 拖阻下永远刹不到停，撞主殿
    expect(sm.tireBlown).toBe(true);
  });
});

describe('R94 数值口径：刹车段触发里程/车速（真实 StateMachine，供交接文档引用）', () => {
  it('爆胎关→加速到 atLimiter→爆胎开→满踏板起刹：触发里程/车速/刹停里程', () => {
    setHash('#r92tire=off');
    const sm = new StateMachine();
    toAccelHelper(sm);
    let guard = 0;
    while (!sm.atLimiter && guard++ < 120 * 60) sm.step(DT, ACCEL_INPUT);
    expect(sm.atLimiter).toBe(true);
    const cutInM = sm.vehicle.distance;
    const cutInKmh = sm.speedKmh;
    // 切入刹车段后开回滚开关：此后 brake 段跨 648.65m ⇒ 爆胎在 brake 段触发
    setHash('');
    const BRAKE_INPUT = { throttle: 0, brake: 1, brakePressed: true };
    let blow: TireBlowEvent | null = null;
    let phaseAtBlow: string | null = null;
    guard = 0;
    while (guard++ < 120 * 120) {
      const ev = sm.step(DT, BRAKE_INPUT);
      const found = blowEvents(ev);
      if (found.length && !blow) {
        blow = found[0];
        phaseAtBlow = sm.phase;
      }
      if (sm.phase === 'stopped' || sm.phase === 'crashed') break;
    }
    expect(blow).not.toBeNull();
    const blowM = blow!.distance;
    const blowKmh = blow!.speedKmh;
    const stopM = sm.vehicle.distance;
    console.info(
      `[R94] 限速切入 ${cutInM.toFixed(2)}m @ ${cutInKmh.toFixed(2)}km/h | ` +
        `刹车段爆胎触发 ${blowM.toFixed(3)}m @ ${blowKmh.toFixed(2)}km/h | ` +
        `触发时相位=${phaseAtBlow ?? 'n/a'} | 刹停里程 ${stopM.toFixed(2)}m | 终局=${sm.phase}`
    );
    // 刹车段触发 ⇒ 车速必低于电子限速
    expect(blowKmh).toBeLessThan(199);
    expect(blowKmh).toBeGreaterThan(190);
    expect(blowM).toBeGreaterThanOrEqual(TIRE_BLOW_DISTANCE_M);
    expect(blowM).toBeLessThan(700); // 刹停前即触发（非跨到主殿）
    expect(phaseAtBlow).toBe('brake');
    expect(sm.phase).toBe('stopped');
  });

  it('更早切刹（640m 处）：触发里程/车速实测', () => {
    setHash('');
    const sm = new StateMachine();
    toAccelHelper(sm);
    let guard = 0;
    while (sm.vehicle.distance < TIRE_BLOW_DISTANCE_M - 8 && guard++ < 120 * 60)
      sm.step(DT, ACCEL_INPUT);
    const cutM = sm.vehicle.distance;
    const cutKmh = sm.speedKmh;
    const BRAKE_INPUT = { throttle: 0, brake: 1, brakePressed: true };
    guard = 0;
    while (sm.phase === 'accel' && guard++ < 120 * 5) sm.step(DT, BRAKE_INPUT);
    expect(sm.phase).toBe('brake');
    let blow: TireBlowEvent | null = null;
    let phaseAtBlow: string | null = null;
    guard = 0;
    while (guard++ < 120 * 120) {
      const ev = sm.step(DT, BRAKE_INPUT);
      const found = blowEvents(ev);
      if (found.length && !blow) {
        blow = found[0];
        phaseAtBlow = sm.phase;
      }
      if (sm.phase === 'stopped' || sm.phase === 'crashed') break;
    }
    expect(blow).not.toBeNull();
    console.info(
      `[R94] 早切刹 ${cutM.toFixed(2)}m @ ${cutKmh.toFixed(2)}km/h | ` +
        `刹车段爆胎触发 ${blow!.distance.toFixed(3)}m @ ${blow!.speedKmh.toFixed(2)}km/h | ` +
        `相位=${phaseAtBlow ?? 'n/a'} | 刹停 ${sm.vehicle.distance.toFixed(2)}m | ${sm.phase}`
    );
    expect(blow!.distance).toBeGreaterThanOrEqual(TIRE_BLOW_DISTANCE_M);
    expect(blow!.distance).toBeLessThan(TIRE_BLOW_DISTANCE_M + 1);
    expect(blow!.speedKmh).toBeGreaterThan(190);
    expect(phaseAtBlow).toBe('brake');
    expect(sm.phase).toBe('stopped');
  });
});

/** R94 数值口径块用：跳过倒计时到 accel */
function toAccelHelper(sm: StateMachine): void {
  sm.start();
  let guard = 0;
  while (sm.phase === 'countdown' && guard++ < 120 * 10) sm.step(DT, ACCEL_INPUT);
}
