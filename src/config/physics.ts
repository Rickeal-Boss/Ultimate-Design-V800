/**
 * 全部物理常量 · 具名导出
 *
 * 数值来源：
 * - 整备质量 3160kg：尊界V800 工信部申报 3120/3160/3190kg 取中值（公开申报资料）
 * - 游戏载荷 +140kg（乘员/油液）→ 计算质量 3300kg
 * - 尺寸 5495×2006×1850mm、轴距 3430mm：官方公开参数
 * - 双电机 390kW（前 160 + 后 230）：官方公开参数
 * - 轮胎 255/55 R19 → 半径 0.382m（255×0.55×2/1000 + 19×0.0254/2）
 * - Cd 0.32 为 MPV 假设值；滚阻 Crr 0.010 为常规铺装路经验值
 * - 制动力学参数（breakForceN/rampBase/rampGrowth/releaseRate/decelPerNewton）
 *   沿用原版逆向基准（reverse/reverse-game-logic.beautified.js 第 925-959 行 Pd 配置），
 *   语义不变：满踏板力 1612N → 机械减速度 10.8 m/s² ≈ 1.1g
 */

export const MS_TO_KMH = 3.6;
export const GRAVITY = 9.81;

/** 尊界V800 车辆参数（程序化示意复刻，非工程级精度） */
export const VEHICLE = {
  curbMassKg: 3160,
  payloadKg: 140,
  totalMassKg: 3300,
  lengthM: 5.495,
  widthM: 2.006,
  heightM: 1.85,
  wheelbaseM: 3.43,
  /** 轮胎 255/55 R19 */
  wheelRadiusM: 0.382,
  /** 电子限速 200km/h（替换原版 260） */
  maxSpeedKmh: 200,
  /** 传动效率 */
  driveEfficiency: 0.92,
  /** 单速减速器速比（程序化示意值，用于电扭矩→轮端力换算） */
  gearRatio: 11.5,
  /** 双电机峰值扭矩示意值（前/后，Nm）——恒扭矩段 */
  peakTorqueFrontNm: 310,
  peakTorqueRearNm: 430,
  /** 空气阻力：Cd×A×ρ */
  dragCd: 0.32,
  frontalAreaM2: 3.4,
  airDensity: 1.225,
  /** 滚动阻力系数 */
  rollResistCrr: 0.01
} as const;

/** 双电机 390kW（前160+后230），恒扭矩→恒功率曲线，效率 0.92 */
export const DRIVE = {
  powerTotalKw: 390,
  motorFrontKw: 160,
  motorRearKw: 230
} as const;

/**
 * 制动模型。
 * 断裂机制沿用原版：b≥0.98 过载爬升 (rampBase + 2×rampGrowth×holdTime)，
 * 达 breakForceN → brake_snap；松开时以 releaseRate 向目标值松弛。
 */
export const BRAKE = {
  /** 达到此车速才允许切入刹车段（原版语义不变） */
  minSpeedKmh: 100,
  breakForceN: 1612,
  rampBase: 200,
  rampGrowth: 400,
  releaseRate: 900,
  /** N → m/s² 换算：满力 1612N → 10.8 m/s² ≈ 1.1g（原版语义不变） */
  decelPerNewton: 10.8 / 1612,
  /** 判停速度 m/s */
  stopSpeed: 0.08,
  /** 再生制动：刹车滑条 b≤0.25 段纯电回收，线性至 -0.15g */
  regenSplitRatio: 0.25,
  regenMaxDecel: 0.15 * GRAVITY,
  /** ABS 拟真：干地 μ0.95，机械制动减速度上限 μg = 9.31 m/s² */
  absMu: 0.95,
  absMaxDecel: 0.95 * GRAVITY,
  /** 热衰减：连续全力刹车累积 brakeTemp，>1 时制动效率 ×0.85 */
  brakeTempThreshold: 1.0,
  brakeTempGain: 0.9,
  brakeTempEfficiency: 0.85,
  brakeTempCoolRate: 0.25
} as const;

/** 赛道参数（原版语义不变） */
export const TRACK = {
  barrierDistance: 2600,
  roadWidth: 14,
  laneWidth: 3.6
} as const;

/** 撞车节奏（原版数值不变） */
export const CRASH = {
  slowMoScale: 0.28,
  slowMoSeconds: 1.6,
  resultDelaySeconds: 5.5
} as const;

/** 计分（原版公式不变）：score = round(v0² / t)，v0 单位 km/h，t 单位 s */
export function calcScore(v0Kmh: number, stopSeconds: number): number {
  return stopSeconds <= 0 ? 0 : Math.round((v0Kmh * v0Kmh) / stopSeconds);
}
