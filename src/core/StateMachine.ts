/**
 * 游戏会话状态机（原版 ng 类语义移植 + 新滑条交互）。
 * MENU → COUNTDOWN(3,2,1) → ACCEL（油门滑条）→ BRAKE（刹车滑条，油门锁定 0）
 * → STOPPED（成功）/ CRASHED（撞路障）→ Result。
 *
 * 踏板断裂不再翻滚（玩法改版 决策①）：踏板脱开后由紧急制动安全冗余以满载 1/4 力度
 * 接管至停车。冗余刹停仍是「失败」（制动系统已失效），但车辆获救 —— 结算档位
 * `brake_pedal_failed`；翻滚演出只保留给撞路障。
 * 物理推进全部委托 physics/ 纯函数。
 */
import { BRAKE, MS_TO_KMH, TRACK, calcScore } from '../config/physics';
import { VEHICLE_PROFILES, type VehicleProfile } from '../config/vehicles';
import {
  createPedalState,
  redundancyDecel,
  resetPedal,
  stepPedal,
  PedalState
} from '../physics/BrakeModel';
import { createVehicleState, stepVehicle, VehicleState } from '../physics/Vehicle';

export type Phase = 'menu' | 'countdown' | 'accel' | 'brake' | 'stopped' | 'crashed';
/**
 * 失败原因。
 * - `barrier`：撞上路障（唯一会触发 cannon 翻滚演出的结局）
 * - `brake_pedal_failed`：踏板断裂、冗余制动把车拖停（判负，但不翻滚）
 */
export type CrashReason = 'barrier' | 'brake_pedal_failed';

export interface Sample {
  t: number;
  speedKmh: number;
  force: number;
  distance: number;
}

export interface RunResult {
  success: boolean;
  reason?: CrashReason;
  /** 是否经历过踏板断裂（冗余制动完成刹停 / 断裂后撞障） */
  degraded: boolean;
  /** 踏板断裂时刻（刹车段计时 s），未断裂为 null */
  snapTime: number | null;
  /** 冗余制动推进的距离 m（断裂点 → 停车点），未断裂为 null */
  redundancyDistance: number | null;
  v0Kmh: number;
  stopSeconds: number;
  stopDistance: number;
  peakForce: number;
  score: number;
  samples: Sample[];
}

export type GameEvent =
  | { type: 'countdown'; value: number }
  | { type: 'start' }
  | { type: 'brake_too_early' }
  | { type: 'brake_start'; v0Kmh: number }
  /** 踏板断裂：不结算失败，由 Game 播放脱落演出并提示冗余接管 */
  | { type: 'pedal_snap'; atSeconds: number; speedKmh: number }
  | { type: 'stopped'; result: RunResult }
  | { type: 'crash'; reason: CrashReason; result: RunResult };

export interface SessionInput {
  throttle: number;
  brake: number;
  /** 刹车意图（滑条>0 或 空格/↓/S 按住） */
  brakePressed: boolean;
}

const COUNTDOWN_SECONDS = 3;
/** 车头初始位置与路障距离基准的偏移（原版 eg=2.7） */
const START_OFFSET_M = 2.7;
/** 采样间隔（原版 tg=0.04） */
const SAMPLE_INTERVAL = 0.04;

export class StateMachine {
  phase: Phase = 'menu';
  vehicle: VehicleState = createVehicleState();
  pedal: PedalState = createPedalState();
  /** 当前档位（默认 V800 —— 不传时全部行为与 R15 之前逐位一致） */
  profile: VehicleProfile = VEHICLE_PROFILES.v800;

  brakeElapsed = 0;
  v0Kmh = 0;
  peakForce = 0;
  /** 踏板断裂点里程 m（冗余制动距离 = 当前里程 − 此值） */
  private snapDistance = 0;
  /** 冗余制动是否已接管（HUD 徽标 / 刹车灯 / 仪表用） */
  get redundancyActive(): boolean {
    return this.pedal.snapped;
  }
  /** 最近一次结算结果（结算面板之外的诊断 / 自动化测试入口） */
  lastResult: RunResult | null = null;
  /** 冗余制动已推进距离 m */
  get redundancyDistance(): number {
    return this.pedal.snapped ? Math.max(0, this.vehicle.distance - this.snapDistance) : 0;
  }
  private countdown = 0;
  private lastCountdownTick = 0;
  private brakeStartDistance = 0;
  private earlyHintCooldown = 0;
  private samples: Sample[] = [];
  private sampleTimer = 0;

  constructor(profile: VehicleProfile = VEHICLE_PROFILES.v800) {
    this.profile = profile;
  }

  /** 切档位（选车后重建会话前调用；不复位行驶状态） */
  configure(profile: VehicleProfile = VEHICLE_PROFILES.v800): void {
    this.profile = profile;
  }

  get speedKmh(): number {
    return this.vehicle.speed * MS_TO_KMH;
  }

  /** 达到切入刹车段的最低车速 */
  get canBrake(): boolean {
    return this.phase === 'accel' && this.speedKmh >= BRAKE.minSpeedKmh;
  }

  /** 是否已达电子限速稳态（自动切入刹车用，留 0.5% 余量防抖） */
  get atLimiter(): boolean {
    return this.speedKmh >= this.profile.maxSpeedKmh * 0.995;
  }

  get distanceToBarrier(): number {
    return TRACK.barrierDistance - START_OFFSET_M - this.vehicle.distance;
  }

  get brakeSamples(): Sample[] {
    return this.samples;
  }

  /** 估算得分预览（刹车段实时显示） */
  get scorePreview(): number {
    return this.brakeElapsed > 0.15 ? calcScore(this.v0Kmh, this.brakeElapsed) : 0;
  }

  start(): GameEvent[] {
    this.vehicle = createVehicleState();
    resetPedal(this.pedal);
    this.brakeElapsed = 0;
    this.v0Kmh = 0;
    this.peakForce = 0;
    this.snapDistance = 0;
    this.samples = [];
    this.sampleTimer = 0;
    this.lastResult = null;
    this.countdown = COUNTDOWN_SECONDS;
    this.lastCountdownTick = 4;
    this.phase = 'countdown';
    return [];
  }

  toMenu(): void {
    this.vehicle = createVehicleState();
    resetPedal(this.pedal);
    this.phase = 'menu';
  }

  /** 固定步长推进（dt = 1/120s），返回事件列表由 Game 分发 */
  step(dt: number, input: SessionInput): GameEvent[] {
    const events: GameEvent[] = [];
    this.earlyHintCooldown = Math.max(0, this.earlyHintCooldown - dt);
    switch (this.phase) {
      case 'countdown': {
        this.countdown -= dt;
        const tick = Math.ceil(this.countdown);
        if (tick < this.lastCountdownTick && tick > 0) {
          this.lastCountdownTick = tick;
          events.push({ type: 'countdown', value: tick });
        }
        if (this.countdown <= 0) {
          this.phase = 'accel';
          events.push({ type: 'start' });
        }
        break;
      }
      case 'accel': {
        if (input.brakePressed) {
          if (this.canBrake) {
            this.phase = 'brake';
            this.v0Kmh = this.speedKmh;
            this.brakeStartDistance = this.vehicle.distance;
            this.recordSample();
            events.push({ type: 'brake_start', v0Kmh: this.v0Kmh });
            this.stepBraking(dt, input, events);
            break;
          }
          if (this.earlyHintCooldown === 0) {
            this.earlyHintCooldown = 1.2;
            events.push({ type: 'brake_too_early' });
          }
        }
        if (this.phase === 'accel') {
          stepVehicle(this.vehicle, dt, {
            throttle: input.throttle,
            brake: 0,
            powerCut: false,
            pedalForce: 0
          });
          this.checkBarrier(events);
        }
        break;
      }
      case 'brake':
        this.stepBraking(dt, input, events);
        break;
      case 'menu':
      case 'stopped':
      case 'crashed':
        break;
    }
    return events;
  }

  private stepBraking(dt: number, input: SessionInput, events: GameEvent[]): void {
    // 踏板断裂后驾驶员踩空：刹车输入失效，制动力全部来自冗余回路。
    // R7 档位（brakeBreakable=false）永远不会 snapped ⇒ driverBrake 恒为输入值，
    // stepPedal 也不会返回 true ⇒ 不派发 pedal_snap、结算 degraded 恒为 false。
    const driverBrake = this.pedal.snapped ? 0 : Math.max(0, Math.min(1, input.brake));
    const justSnapped = stepPedal(
      this.pedal,
      dt,
      driverBrake,
      this.brakeElapsed,
      this.profile.brakeBreakable
    );
    stepVehicle(
      this.vehicle,
      dt,
      {
        throttle: 0, // 刹车段油门锁定 0
        brake: driverBrake,
        powerCut: true,
        pedalForce: this.pedal.pedalForce,
        redundancyDecel: redundancyDecel(this.pedal)
      },
      this.profile
    );
    this.brakeElapsed += dt;
    // 峰值力在断裂瞬间达到 breakForceN（此后踏板力归零，故断裂后须显式取满值）
    this.peakForce = Math.max(
      this.peakForce,
      this.pedal.snapped ? BRAKE.breakForceN : this.pedal.pedalForce
    );
    if (justSnapped) {
      this.snapDistance = this.vehicle.distance;
      this.peakForce = BRAKE.breakForceN;
      events.push({
        type: 'pedal_snap',
        atSeconds: this.brakeElapsed,
        speedKmh: this.speedKmh
      });
    }
    this.sampleTimer += dt;
    if (this.sampleTimer >= SAMPLE_INTERVAL) {
      this.sampleTimer -= SAMPLE_INTERVAL;
      this.recordSample();
    }
    // 断裂不再直接失败：车辆继续行驶、由冗余制动接管，直至停下或撞路障
    if (!this.checkBarrier(events) && this.vehicle.speed <= BRAKE.stopSpeed) {
      this.vehicle.speed = 0;
      this.phase = 'stopped';
      events.push({
        type: 'stopped',
        result: this.result(!this.pedal.snapped, this.pedal.snapped ? 'brake_pedal_failed' : undefined)
      });
    }
  }

  private recordSample(): void {
    this.samples.push({
      t: this.brakeElapsed,
      speedKmh: this.speedKmh,
      force: Math.min(this.pedal.pedalForce, BRAKE.breakForceN),
      distance: this.vehicle.distance - this.brakeStartDistance
    });
  }

  private checkBarrier(events: GameEvent[]): boolean {
    if (this.distanceToBarrier > 0) return false;
    this.crash('barrier', events);
    return true;
  }

  private crash(reason: CrashReason, events: GameEvent[]): void {
    this.phase = 'crashed';
    events.push({ type: 'crash', reason, result: this.result(false, reason) });
  }

  private result(success: boolean, reason?: CrashReason): RunResult {
    if (this.v0Kmh > 0) this.recordSample();
    const stopSeconds = Math.round(this.brakeElapsed * 1000) / 1000;
    const v0Kmh = Math.round(this.v0Kmh * 10) / 10;
    // R7（brakeBreakable=false）踏板永不断裂 ⇒ snapped 恒 false ⇒ degraded 恒 false，
    // 结算永远走成功分支；V800 语义不变。
    const degraded = this.pedal.snapped;
    this.lastResult = {
      success,
      reason,
      degraded,
      snapTime: this.pedal.snapTime,
      redundancyDistance: degraded ? this.redundancyDistance : null,
      v0Kmh,
      stopSeconds,
      stopDistance: Math.max(0, this.vehicle.distance - this.brakeStartDistance),
      peakForce: this.peakForce,
      // 冗余刹停计 0 分（决策①：制动系统已失效，不算成功刹停；本机最佳不被污染）。
      // 惩罚不靠新系数：刹停时间被拉长 3 倍以上，公式本身已足够体现。
      score: success ? calcScore(v0Kmh, stopSeconds) : 0,
      samples: this.samples.slice()
    };
    return this.lastResult;
  }
}

