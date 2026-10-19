/**
 * 纵向拟真动力学（纯函数步进器，可单测）。
 * dv/dt = (F_motor×throttle − F_drag − F_roll − F_brake − F_regen) / m
 * 电机模型：恒扭矩(T_max)→恒功率曲线，效率 0.92；电子限速 200km/h。
 */
import { BRAKE, DRIVE, GRAVITY, MS_TO_KMH, REDUNDANCY, VEHICLE } from '../config/physics';
import type { VehicleProfile } from '../config/vehicles';

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
  /** 热保护剩余锁定秒数（>0 = 机械制动力被切断，踏板踩了也无效） */
  thermalHold: number;
  /** 热保护累计触发次数，诊断/测试用 */
  thermalLocks: number;
  /** 迟滞布防位：true = 可触发；触发后置 false，盘温降到 thermalRearmTemp 以下才复位 */
  thermalArmed: boolean;
}

export interface VehicleInput {
  /** 油门 0~1（BRAKE 段锁定 0） */
  throttle: number;
  /** 刹车滑条 0~1（踏板断裂后上层传 0：驾驶员踩空） */
  brake: number;
  /** 动力切断（切入刹车段后 true） */
  powerCut: boolean;
  /** 踏板力 N（BrakeModel 输出；断裂后为 0） */
  pedalForce: number;
  /**
   * 踏板断裂后由安全冗余回路提供的减速度 m/s²（0 = 未启用）。
   * 由上层用 redundancyDecel(pedalState) 计算后传入，保持 Vehicle 为纯函数
   * （不依赖 BrakeModel，便于无头单测）。
   */
  redundancyDecel?: number;
}

export function createVehicleState(): VehicleState {
  return {
    speed: 0,
    distance: 0,
    accel: 0,
    regenPowerKw: 0,
    brakeTemp: 0,
    overheat: false,
    mechDecelDemand: 0,
    thermalHold: 0,
    thermalLocks: 0,
    thermalArmed: true
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
  // 不做 speed >= MAX 早退：电子限速只钳速度、动力保持（见 stepVehicle 钳位分支），
  // 限速处油门仍有劲（G 表/俯仰/电机音持续），只是速度被钉住。
  if (throttle <= 0) return 0;
  const v = Math.max(0.5, speed);
  const fPower = POWER_WATT / v;
  return throttle * Math.min(FORCE_TORQUE_MAX, fPower);
}

/**
 * 再生制动「请求值」m/s²：b≤0.25 段纯电回收线性至 -0.15g，b>0.25 满回收混入机械制动。
 * 注意（2026-10-17 摩擦圆改版）：这里只是回收请求，实际叠加量由 stepVehicle 按
 * 抓地余量二次削减（机械优先的制动协调）——回收退让从「固定 75% 下限曲线」改为
 * 「抓地优先的动态削减」，表现语义更真实：踩得越深、机械占比越高、回收越少。
 * 原 fade 曲线（0.85→0.98→75%）在总钳制下会让 0.92→0.97 深踩反而慢 0.017s
 * （建压段浅踩回收更高），与「踩得越深刹停不增时」契约冲突，已删。
 */
export function regenDecel(brake: number): number {
  if (brake <= 0) return 0;
  const ratio = Math.min(1, brake / BRAKE.regenSplitRatio);
  return BRAKE.regenMaxDecel * ratio;
}

/**
 * 单固定步长推进（dt = 1/120s）。
 * 电子限速只钳速度、动力保持（2026-10-18 玩法改版）：被钳住时 speed 钉在 200 km/h，
 * state.accel 保留计算值——油门继续有劲、G 表/俯仰/电机音持续，
 * 表现为「速度被电子限速钉住」而非「动力主动退出」。
 *
 * 第四参 `profile`（R15-4 双车玩法档位）：只取 `brakeTempGainScale` 作为制动盘升温
 * 倍率；**不传时行为与 R15 之前逐位一致**（既有 66 项回归不得改断言）。
 * 质量/极速仍读 VEHICLE 常量——见 config/vehicles.ts 顶部「未接线项」说明。
 */
export function stepVehicle(
  state: VehicleState,
  dt: number,
  input: VehicleInput,
  profile?: Pick<VehicleProfile, 'brakeTempGainScale'>
): void {
  const gainScale = profile?.brakeTempGainScale ?? 1;
  const speed = state.speed;
  let accel: number;
  let regen = 0;
  let mechDecel = 0;

  if (input.powerCut) {
    // 刹车段：动力切断，再生 + 机械制动。
    // 踏板断裂后由冗余回路提供全部制动力（regen 是否叠加由 REDUNDANCY.includeRegen 决定）。
    // 制动协调（2026-10-17 摩擦圆改版，外部审查两轮 P1）：机械优先——
    //   mech = min(demand, μg)，回收请求按抓地余量削减：regen = min(regenReq, μg − mech)。
    //   ① 摩擦圆精确成立：任意时刻 mech+regen ≤ μg（旧实现只钳机械项，深踩 11.6~11.9 违规）；
    //   ② 「踩得越深刹停用时不增」精确成立：总减速 = min(demand+regenReq, μg)，
    //      对 demand 处处单调不减，且与 b 的分配方式无关；
    //      R14 热保护加入后：时间口径仍严格不增（b=0.86~0.97 停在同一次 2s 断力上），
    //      距离口径在 0.86 以上是平台（深踩锁得更早 → 2s 滑行时车速更高，+0.5%）；
    //   ③ 回收退让仍然可见：深踩段 HUD 回收功率随机械占比上升而回落（b=1.0 时归零）。
    const redundant = Math.max(0, input.redundancyDecel ?? 0);
    // ---- 热保护计时（R14）----
    // 冗余为独立液压回路（heatless），接管瞬间解除热保护锁——否则「已被判负的局」
    // 会再叠一层无意义的 2s 断力。锁定期间照常倒计时，归零当步即恢复制动。
    if (redundant > 0) {
      state.thermalHold = 0;
      state.thermalArmed = true;
    }
    // 先判定本步是否受锁（保证 thermalHoldSeconds/dt = 240 步被切断），再倒计时
    const thermalLocked = state.thermalHold > 0 && redundant <= 0;
    if (thermalLocked) {
      state.thermalHold = Math.max(0, state.thermalHold - dt);
    }
    const regenRequest = redundant > 0
      ? (REDUNDANCY.includeRegen ? regenDecel(input.brake) : 0)
      : input.brake > 0
        ? regenDecel(input.brake)
        : 0;
    const demand = redundant > 0 ? redundant : input.pedalForce * BRAKE.decelPerNewton;
    state.mechDecelDemand = demand;
    // ABS 拟真：机械制动减速度 clamp 至 μg（冗余 2.70 m/s² 远低于上限，不触发钳制）
    // 热保护切断只作用于机械制动：踏板力仍在（demand 照记，HUD 可显示「踩了但没力」），
    // 电回收保留（电机侧制动，不产生摩擦热）——1.47 m/s² 让车不至于完全失控，
    // 也不会让玩家用「踩空两秒」把车直接送进路障。
    mechDecel = thermalLocked ? 0 : Math.min(demand, BRAKE.absMaxDecel);
    regen = Math.min(regenRequest, Math.max(0, BRAKE.absMaxDecel - mechDecel));
    // 热衰减：温度按摩擦功（F_mech × v）的时间积分累积——真实热衰减只认摩擦功，
    // 与「是否逼近抓地上限」无关（一次 200→0 满刹就应明显升温）。
    // 标定（R17 升温减半）：brakeTempGain = 1.2/5.09e6 → 单次满刹的理论 ΔT≈1.2
    // （摩擦功口径；实测 ≈0.50，因为回收/风阻分走约 22% 动能、踏板建压段再分摊），
    // V800 单次 200→0 满刹不再进红区；连续满刹 / R7（×100 倍率）才会触发切断。
    // 冗余回路为独立液压回路且力度仅 1/4，默认不计热（heatless），
    // 避免「已被判负」的局再叠加一层热衰减惩罚。
    // 松滑条/轻踩（mechDecel ≤ 0.5 m/s²）与热保护锁定期转为降温。
    const heating = mechDecel > 0.5 && !(redundant > 0 && REDUNDANCY.heatless);
    if (heating) {
      state.brakeTemp = Math.min(
        1.5,
        state.brakeTemp + mechDecel * MASS * speed * dt * BRAKE.brakeTempGain * gainScale
      );
    } else {
      state.brakeTemp = Math.max(0, state.brakeTemp - BRAKE.brakeTempCoolRate * dt);
    }
    // 热保护触发 / 迟滞重布防（集中在纯函数里，可单测）。
    // 触发条件用「>=」：单步温升可能一次跨过阈值，等号侧留给标定表取整。
    if (redundant <= 0) {
      if (state.thermalArmed && state.brakeTemp >= BRAKE.thermalTriggerTemp) {
        state.thermalHold = BRAKE.thermalHoldSeconds;
        state.thermalArmed = false;
        state.thermalLocks += 1;
      } else if (!state.thermalArmed && state.brakeTemp < BRAKE.thermalRearmTemp) {
        state.thermalArmed = true;
      }
    }
    state.overheat = state.brakeTemp > BRAKE.brakeTempThreshold;
    const eff = state.overheat ? BRAKE.brakeTempEfficiency : 1;
    accel = (-regen - mechDecel * eff) - (dragForce(speed) + rollForce()) / MASS;
  } else {
    // 加速段
    state.brakeTemp = Math.max(0, state.brakeTemp - BRAKE.brakeTempCoolRate * dt);
    state.overheat = false;
    state.thermalHold = 0;
    if (state.brakeTemp < BRAKE.thermalRearmTemp) state.thermalArmed = true;
    const fMotor = motorForce(speed, input.throttle);
    accel = (fMotor - dragForce(speed) - rollForce()) / MASS;
  }

  state.accel = accel;
  // 电子限速：只钳速度、不动 accel——油门下的驱动力照常输出（G 表/俯仰/电机音
  // 持续），速度被电子限速钉在 200 km/h。松油门/滑行不受影响。
  const nextSpeed = speed + accel * dt;
  if (nextSpeed >= MAX_SPEED_MS) {
    state.speed = MAX_SPEED_MS;
  } else {
    state.speed = Math.max(0, nextSpeed);
  }
  state.distance += state.speed * dt;
  // 回收功率 kW = m × a_regen × v / 1000（仅刹车段显示）
  state.regenPowerKw =
    input.powerCut && regen > 0 ? (MASS * regen * state.speed) / 1000 : 0;
}
