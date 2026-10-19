/**
 * 车辆档位（vehicle profile）—— R15-4 双车玩法。
 *
 * 设计口径：**档位只描述「差异」，不复制「公共」**。
 * 所有热参数（brakeTempThreshold 1.0 / brakeTempCoolRate 0.5 / thermalRearmTemp 0.6 /
 * thermalHoldSeconds 2）与制动力学参数（breakForceN 1612 / decelPerNewton =
 * ABS_MAX_DECEL/1612 / absMaxDecel = 1.1g）对两车完全共用，见 config/physics.ts。
 * profile 里只有两项会真正改变物理：
 *   - `brakeBreakable`     → BrakeModel.stepPedal 第五参（false：踏板钳在 breakForceN，不断）
 *   - `brakeTempGainScale` → Vehicle.stepVehicle 第四参（制动盘升温倍率）
 *
 * ⚠️ 未接线项（需主理人确认后再动）：`massKg` / `maxSpeedKmh` / 三围目前是**元数据 +
 * 限速判据**，尚未接入纵向动力学：stepVehicle 仍用 config/physics.ts 的 VEHICLE 常量
 * （3300kg / 200km/h）。原因：质量一旦参数化，热积分（mech×M×v×gain）、转动惯量标定、
 * 现有 66 项回归的全部数值锚都要重标 —— 属独立变更，不在本轮白名单语义内。
 * StateMachine.atLimiter 已按 maxSpeedKmh（来源也是 profile.maxSpeedKmh）。
 */
export type VehicleId = 'v800' | 'r7';

/** 单个内饰机位（**装配局部坐标**，与 CameraRig MODES 的 local 偏移同口径） */
export interface InteriorViewPose {
  /** 眼点 [x, y, z] */
  eye: [number, number, number];
  /** 注视点 [x, y, z] */
  target: [number, number, number];
}

/**
 * 车模装配层注入的三个内饰视角。
 * 由 `CarLike.interiorViews?`（V800Adapter 侧的可选字段）提供；未注入时 CameraRig
 * 退回内置 cabin 偏移。放在这里而不是 model/ 层，是为了让运行时（Game/CameraRig）
 * 不依赖尚未合并的 model 改动。
 */
export type InteriorViews = Record<'driver' | 'passenger' | 'rear', InteriorViewPose>;

export interface VehicleProfile {
  id: VehicleId;
  /** 菜单/结算展示名 */
  name: string;
  /** 菜单副标题（一句话定位） */
  subtitle: string;
  /** 踏板是否可能机械断裂（V800 true / R7 false） */
  brakeBreakable: boolean;
  /** 制动盘升温倍率（相对 BRAKE.brakeTempGain；V800 = 1 / R7 = 100） */
  brakeTempGainScale: number;
  massKg: number;
  maxSpeedKmh: number;
  lengthM: number;
  widthM: number;
  heightM: number;
  /** 首发车型默认视距/机位微调（可选；未设则 1） */
  cameraScale?: number;
}

export const VEHICLE_PROFILES: Record<VehicleId, VehicleProfile> = {
  v800: {
    id: 'v800',
    name: '尊界V800',
    subtitle: '行政旗舰 MPV · 390kW 双电机 · 计算质量 3300kg',
    brakeBreakable: true,
    brakeTempGainScale: 1,
    massKg: 3300,
    maxSpeedKmh: 200,
    lengthM: 5.495,
    widthM: 2.006,
    heightM: 1.85,
    cameraScale: 1
  },
  r7: {
    id: 'r7',
    name: '智界R7',
    subtitle: '轿跑 SUV · 2300kg · 极速 200km/h',
    brakeBreakable: false,
    // R7 档位的核心：**踏板永不断裂**，代价是制动盘升温 ×100 —— 满踩约 0.46s 就顶到红区
    // （冷却 0.5/s ⇒ 每次红区要 ~2s 才重新布防），必须改打脉冲点刹。
    // R17 基座减半（BRAKE.brakeTempGain 2.4→1.2）后倍率 50→100 补偿：
    // 有效升温 100×1.2 = 50×2.4 与改前逐位一致，R7 既有手感标定不变。
    brakeTempGainScale: 100,
    massKg: 2300,
    maxSpeedKmh: 200,
    lengthM: 4.956,
    widthM: 1.981,
    heightM: 1.634,
    cameraScale: 1
  }
};

export const VEHICLE_IDS = Object.keys(VEHICLE_PROFILES) as VehicleId[];

/** localStorage 键（URL hash 优先级更高，便于 QA 直达 R7：#vehicle=r7） */
const STORAGE_KEY = 'v800.vehicle';

function isVehicleId(v: string | null | undefined): v is VehicleId {
  return v === 'v800' || v === 'r7';
}

function readHash(): VehicleId | null {
  if (typeof window === 'undefined') return null;
  const m = /(?:^|[#&])vehicle=([a-z0-9]+)/i.exec(window.location.hash);
  const raw = m?.[1]?.toLowerCase();
  return isVehicleId(raw) ? raw : null;
}

function readStorage(): VehicleId | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isVehicleId(raw) ? raw : null;
  } catch {
    // Safari 无痕/禁用存储：静默降级到默认值，不允许让选车逻辑把主流程搞崩
    return null;
  }
}

/** 当前生效车型：URL `#vehicle=r7` > localStorage 'v800.vehicle' > 'v800' */
export function resolveVehicleId(): VehicleId {
  return readHash() ?? readStorage() ?? 'v800';
}

export function getVehicleProfile(id: VehicleId = resolveVehicleId()): VehicleProfile {
  return VEHICLE_PROFILES[id] ?? VEHICLE_PROFILES.v800;
}

/** 写入选择（调用方随后 location.reload() 重建装配态） */
export function setActiveVehicle(id: VehicleId): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* 存储不可用时忽略：本次会话仍以 URL hash / 默认值运行 */
  }
}
