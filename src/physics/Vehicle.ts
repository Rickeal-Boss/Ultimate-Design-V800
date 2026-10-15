/**
 * 纵向拟真动力学（纯函数步进器，可单测）。
 * dv/dt = (F_motor×throttle − F_drag − F_roll − F_brake − F_regen) / m
 * 电机模型：恒扭矩(T_max)→恒功率曲线，效率 0.92；电子限速 200km/h。
 */
import { BRAKE, DRIVE, GRAVITY, MS_TO_KMH, VEHICLE } from '../config/physics';

export interface VehicleState {
  /** m/s */
  speed: number;
  /** m（沿赛道累计行驶距离） */
  distance: number;
  /** m/s²（当前纵向加速度） */
  accel: number;
  /** 再生制动功率 kW（HUD 显示用） */
  regenPowerKw: number;
  /** 制动盘温度 0~1.5（>1 过热） */
  brakeTemp: number;
  /** 是否过热衰减 */
  overheat: boolean;
  /** 当前机械制动减速度需求（ABS 判定前），诊断用 */
  mechDecelDemand: number;
}

export interface VehicleInput {
  /** 油门 0~1（BRAKE 段锁定 0） */
  throttle: number;
  /** 刹车滑条 0~1 */
  brake: number;
  /** 动力切断（切入刹车段后 true） */
  powerCut: boolean;
  /** 踏板力 N（BrakeModel 输出） */
  pedalForce: number;
}

export function createVehicleState(): VehicleState {
  return {
    speed: 0,
    distance: 0,
    accel: 0,
    regenPowerKw: 0,
    brakeTemp: 0,
    overheat: false,
    mechDecelDemand: 0
  };
}

const MASS = VEHICLE.totalMassKg;
const TORQUE_TOTAL = VEHICLE.peakTorqueFrontNm + VEHICLE.peakTorqueRearNm;
/** 轮端恒扭矩最大驱动力 N */
const FORCE_TORQUE_MAX =
  (TORQUE_TOTAL * VEHICLE.gearRatio * VEHICLE.driveEfficiency) / VEHICLE.wheelRadiusM;
/** 恒功率段轮端驱动力 N：F = P×η / v */
const POWER_WATT = DRIVE.powerTotalKw * 1000 * VEHICLE.driveEfficiency;
/** 空气阻力系数 0.5×ρ×Cd×A */
const DRAG_HALF = 0.5 * VEHICLE.airDensity * VEHICLE.dragCd * VEHICLE.frontalAreaM2;
const MAX_SPEED_MS = VEHICLE.maxSpeedKmh / MS_TO_KMH;

/** 空气阻力 N */
export function dragForce(speed: number): number {
  return DRAG_HALF * speed * speed;
}

/** 滚动阻力 N */
export function rollForce(): number {
  return VEHICLE.rollResistCrr * MASS * GRAVITY;
}

/** 电机驱动力 N（恒扭矩→恒功率），v≈0 时用微小下限防除零 */
export function motorForce(speed: number, throttle: number): number {
  if (throttle <= 0 || speed >= MAX_SPEED_MS) return 0;
  const v = Math.max(0.5, speed);
  const fPower = POWER_WATT / v;
  return throttle * Math.min(FORCE_TORQUE_MAX, fPower);
}

/**
 * 再生制动减速度 m/s²：b≤0.25 段纯电回收线性至 -0.15g，b>0.25 满回收混入机械制动。
 * 深踩退让：b≥0.85 起回收能力线性降至 75%（混动制动协调逻辑——重刹段让机械踏板力主导，
 * 保证「踩得越深越快」的单调性）。
 */
export function regenDecel(brake: number): number {
  if (brake <= 0) return 0;
  const ratio = Math.min(1, brake / BRAKE.regenSplitRatio);
  let fade = 1;
  if (brake > BRAKE.regenFadeStart) {
    const t = Math.min(
      1,
      (brake - BRAKE.regenFadeStart) / (0.98 - BRAKE.regenFadeStart)
    );
    fade = 1 - t * (1 - BRAKE.regenFadeFloor);
  }
  return BRAKE.regenMaxDecel * ratio * fade;
}

/**
 * 单固定步长推进（dt = 1/120s）。
 * 电子限速在函数内消化：钳位生效时 state.accel 归零（真实车限速处动力主动退出），
 * 避免「速度钉在 200 但 G 表/俯仰/电机音仍呈全力加速」的表现失真。
 */
export function stepVehicle(state: VehicleState, dt: number, input: VehicleInput): void {
  const speed = state.speed;
  let accel: number;
  let regen = 0;
  let mechDecel = 0;

  if (input.powerCut) {
    // 刹车段：动力切断，再生 + 机械制动
    regen = input.brake > 0 ? regenDecel(input.brake) : 0;
    const demand = input.pedalForce * BRAKE.decelPerNewton;
    state.mechDecelDemand = demand;
    // ABS 拟真：机械制动减速度 clamp 至 μg
    mechDecel = Math.min(demand, BRAKE.absMaxDecel);
    // 热衰减：温度按摩擦功（F_mech × v）的时间积分累积——真实热衰减只认摩擦功，
    // 与「是否逼近抓地上限」无关（一次 200→0 满刹就应明显升温）。
    // 标定：brakeTempGain 使一次满刹（≈5.09 MJ）ΔT≈0.6，连续第二把触发 ×0.85。
    // 松滑条/轻踩（mechDecel ≤ 0.5 m/s²）转为缓慢降温，温度不会无限累积。
    if (mechDecel > 0.5) {
      state.brakeTemp = Math.min(
        1.5,
        state.brakeTemp + mechDecel * MASS * speed * dt * BRAKE.brakeTempGain
      );
    } else {
      state.brakeTemp = Math.max(0, state.brakeTemp - BRAKE.brakeTempCoolRate * dt);
    }
    state.overheat = state.brakeTemp > BRAKE.brakeTempThreshold;
    const eff = state.overheat ? BRAKE.brakeTempEfficiency : 1;
    accel = (-regen - mechDecel * eff) - (dragForce(speed) + rollForce()) / MASS;
  } else {
    // 加速段
    state.brakeTemp = Math.max(0, state.brakeTemp - BRAKE.brakeTempCoolRate * dt);
    state.overheat = false;
    const fMotor = motorForce(speed, input.throttle);
    accel = (fMotor - dragForce(speed) - rollForce()) / MASS;
  }

  state.accel = accel;
  // 电子限速：被上限钳住的这一步加速度归零——真实限速是动力主动退出，
  // 而非剩余驱动力被强行抹掉（后者会让 G 表/俯仰/电机音呈现「钉速却全油门」）。
  const nextSpeed = speed + accel * dt;
  if (nextSpeed >= MAX_SPEED_MS) {
    state.speed = MAX_SPEED_MS;
    state.accel = 0;
  } else {
    state.speed = Math.max(0, nextSpeed);
  }
  state.distance += state.speed * dt;
  // 回收功率 kW = m × a_regen × v / 1000（仅刹车段显示）
  state.regenPowerKw =
    input.powerCut && regen > 0 ? (MASS * regen * state.speed) / 1000 : 0;
}
