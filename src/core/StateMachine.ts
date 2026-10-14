/**
 * 游戏会话状态机（原版 ng 类语义移植 + 新滑条交互）。
 * MENU → COUNTDOWN(3,2,1) → ACCEL（油门滑条）→ BRAKE（刹车滑条，油门锁定 0）
 * → STOPPED（成功）/ CRASHED（撞路障 / brake_snap 翻滚）→ Result
 * 物理推进全部委托 physics/ 纯函数。
 */
import { BRAKE, MS_TO_KMH, TRACK, VEHICLE, calcScore } from '../config/physics';
import { createPedalState, forceSnap, resetPedal, stepPedal, PedalState } from '../physics/BrakeModel';
import { createVehicleState, stepVehicle, VehicleState } from '../physics/Vehicle';

export type Phase = 'menu' | 'countdown' | 'accel' | 'brake' | 'stopped' | 'crashed';
export type CrashReason = 'barrier' | 'brake_snap';

export interface Sample {
  t: number;
  speedKmh: number;
  force: number;
  distance: number;
}

export interface RunResult {
  success: boolean;
  reason?: CrashReason;
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

  brakeElapsed = 0;
  v0Kmh = 0;
  peakForce = 0;
  private countdown = 0;
  private lastCountdownTick = 0;
  private brakeStartDistance = 0;
  private earlyHintCooldown = 0;
  private samples: Sample[] = [];
  private sampleTimer = 0;

  get speedKmh(): number {
    return this.vehicle.speed * MS_TO_KMH;
  }

  /** 达到切入刹车段的最低车速 */
  get canBrake(): boolean {
    return this.phase === 'accel' && this.speedKmh >= BRAKE.minSpeedKmh;
  }

  /** 是否已达电子限速稳态（自动切入刹车用，留 0.5% 余量防抖） */
  get atLimiter(): boolean {
    return this.speedKmh >= VEHICLE.maxSpeedKmh * 0.995;
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
    this.samples = [];
    this.sampleTimer = 0;
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
    const snapped = stepPedal(this.pedal, dt, Math.max(0, Math.min(1, input.brake)));
    stepVehicle(this.vehicle, dt, {
      throttle: 0, // 刹车段油门锁定 0
      brake: input.brake,
      powerCut: true,
      pedalForce: this.pedal.pedalForce
    });
    this.brakeElapsed += dt;
    this.peakForce = Math.max(this.peakForce, this.pedal.pedalForce);
    this.sampleTimer += dt;
    if (this.sampleTimer >= SAMPLE_INTERVAL) {
      this.sampleTimer -= SAMPLE_INTERVAL;
      this.recordSample();
    }
    if (snapped) {
      forceSnap(this.pedal);
      this.peakForce = BRAKE.breakForceN;
      this.crash('brake_snap', events);
      return;
    }
    if (!this.checkBarrier(events) && this.vehicle.speed <= BRAKE.stopSpeed) {
      this.vehicle.speed = 0;
      this.phase = 'stopped';
      events.push({ type: 'stopped', result: this.result(true) });
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
    return {
      success,
      reason,
      v0Kmh,
      stopSeconds,
      stopDistance: Math.max(0, this.vehicle.distance - this.brakeStartDistance),
      peakForce: this.peakForce,
      score: success ? calcScore(v0Kmh, stopSeconds) : 0,
      samples: this.samples.slice()
    };
  }
}

