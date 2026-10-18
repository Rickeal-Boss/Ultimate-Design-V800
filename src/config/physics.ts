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
 *   语义不变：满踏板力 1612N → 机械减速度严格 = 抓地上限 1.1g（10.791 m/s²）
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
/** ABS/抓地极限减速度 m/s²（μ1.10×g）——满踏板力语义上严格等于此值 */
const ABS_MAX_DECEL = 1.1 * GRAVITY;

export const BRAKE = {
  /** 达到此车速才允许切入刹车段（原版语义不变） */
  minSpeedKmh: 100,
  breakForceN: 1612,
  rampBase: 200,
  rampGrowth: 400,
  releaseRate: 900,
  /**
   * N → m/s² 换算：满踏板力 1612N 严格等于抓地上限 1.1g（10.791 m/s²）。
   * 审查修复（B-4）：原写 10.8/1612 与 absMaxDecel 差 0.08%，满力会被 ABS
   * 钳掉一丝；现与 absMaxDecel 同源（ABS_MAX_DECEL/1612），语义完全对齐。
   */
  decelPerNewton: ABS_MAX_DECEL / 1612,
  /** 判停速度 m/s */
  stopSpeed: 0.08,
  /** 再生制动：刹车滑条 b≤0.25 段纯电回收，线性至 -0.15g */
  regenSplitRatio: 0.25,
  regenMaxDecel: 0.15 * GRAVITY,
  /**
   * ABS/抓地极限：μ1.10 与满踏板力 10.8 m/s² 语义对齐。
   * 审查修复（P0-1 制动平衡反转）：原 μ0.95 低于满力对应 1.10g，
   * 导致 b>0.862 后减速不再增长却持续升温——「踩得越狠反而越慢」。
   * 现在钳制只代表真实抓地上限，深踩始终更快。
   * 2026-10-17 摩擦圆改版：钳制改为「机械优先 + 回收按抓地余量削减」
   * （见 Vehicle.stepVehicle），原 regenFadeStart/Floor 固定退让曲线已删——
   * 它在总钳制下反而使 0.92→0.97 深踩变慢，与「踩深不更慢」契约冲突。
   */
  absMu: 1.1,
  absMaxDecel: ABS_MAX_DECEL,
  /**
   * 热衰减（审查修复 A-5/G-2，改为摩擦功物理）：
   * 温度按 F_mech × v 的时间积分累积，与「是否超过抓地上限 93%」无关——
   * 原 onset 门槛 + 0.063/s 速率上限使系统永不可触发（8s 满踩只攒 ~0.5）。
   *
   * 2026-10-18 R14 用户指令「升温加强到 4 倍」：0.6 → **2.4** / 5.09e6。
   * 标定：一次 200→0 满刹摩擦功 ≈10.79×3300×143 ≈ 5.09 MJ → ΔT ≈ 2.4
   * （旧 0.6 时单车满刹根本摸不到阈值，热保护形同虚设）。
   * 因此单次满刹必然越过红区：实测 **46% 行程 / 2.2~2.4s / v≈133km/h**
   * （纯摩擦功口径的估算是 42%，差额是回收+风阻分走约 22% 动能）
   * → 触发 2s 热保护切断，见 thermalHoldSeconds。
   */
  brakeTempGain: 2.4 / 5.09e6,
  brakeTempThreshold: 1.0,
  brakeTempEfficiency: 0.85,
  brakeTempCoolRate: 0.5,
  /**
   * 热保护（R14 用户指令）：制动盘到红区 → 机械制动力被切断 N 秒，
   * 期间踏板力不产生任何机械制动（回收保留，见 Vehicle.stepVehicle 注释）。
   * 2s 后恢复；必须重新越过 thermalTriggerTemp 才会再次触发（thermalRearmTemp 迟滞），
   * 不允许「贴着阈值抖动式反复锁」。
   */
  thermalHoldSeconds: 2,
  /** 触发温度（红区）。默认与 brakeTempThreshold 同值：越过即切断 + 衰减 */
  thermalTriggerTemp: 1.0,
  /**
   * 重新布防温度：锁定期内摩擦功归零、盘温按 brakeTempCoolRate 下降，
   * 降到 0.6 以下才允许下一次触发。取值越低 → 两次锁之间需要更多摩擦功，
   * 锁定次数更少、惩罚更轻（标定见 docs/wip-play-r14.md）。
   */
  thermalRearmTemp: 0.6
} as const;

/**
 * 紧急制动安全冗余（踏板断裂后接管）——玩法改版（2026-10-15 锁定规格 决策①）。
 *
 * 断裂语义：踏板脱开 → 驾驶员踩空（pedalForce 归零）→ 冗余回路以满载 1/4 力度
 * 建压介入，车辆继续行驶直至停稳。**不再翻滚、不再 crash**，翻滚演出只留给撞路障。
 * 结算语义：冗余刹停 = success=false / reason='brake_pedal_failed' / 计分 0
 * （制动系统已失效，属「侥幸逃生」而非成功刹停；本机最佳成绩不因此被污染）。
 *
 * 实测（Node 同源物理仿真，见 tests/redundancy.test.ts）：
 * 200 km/h 切入满踩 1.77s 断裂（断点 163 km/h）→ 纯机械 1/4 需 ≈17.4s / ≈442m。
 */
export const REDUNDANCY = {
  /** 冗余制动力 = 满载踏板力 × 此比例（0.25 → 403 N → 2.70 m/s² ≈ 0.275g） */
  forceRatio: 0.25,
  /** 建压时间 s：断裂后从 0 平滑升到目标制动力，避免制动力阶跃 */
  rampSeconds: 0.35,
  /**
   * 冗余回路是否叠加电回收。
   * 电机回收不依赖踏板机械连接，物理上冗余启动时应一并工作；但叠加后总制动力
   * 约为满载的 34% 而非 25%，惩罚偏轻。默认 false（严格对齐「满载 1/4」）。
   */
  includeRegen: false,
  /** 冗余为独立回路：默认不累积制动盘热量（不因「被救」再叠加一层热衰减惩罚） */
  heatless: true,
  /** 断裂后车内视角停留时长 s（看踏板脱落特写），之后交还常规机位 */
  cabinHoldSeconds: 2
} as const;

/**
 * 赛道参数。
 * `barrierDistance` 由 2600m 收紧为 **1300m**（2026-10-15 玩法改版，Node 同源仿真标定）：
 * 2600m 下「断裂 → 冗余制动」最远也只走 1107m，撞障结局数学上不可达 —— 锁定规格
 * 决策① 想要的「结局随断裂时刻变化」张力是空的。1300m 实测余量表：
 *
 * | 场景 | 停车点 | 距路障余量 |
 * |---|---|---|
 * | 正常刹停 b=0.97（限速自动切入） | 834 m | 466 m ✅ |
 * | 满踩断裂 → 冗余制动拖停 | 1107 m | 193 m ✅（惊险停住 = 「侥幸逃生」） |
 * | 断裂前额外巡航 300 m 再切入 | — | ❌ 撞障（1297 m 处） |
 * | 完全不刹车 | — | ❌ 撞障 |
 *
 * 即：正常打法安全、踩断后惊险获救、刻意贴近路障晚切才翻滚 —— 三档结局全部可达。
 */
export const TRACK = {
  barrierDistance: 1300,
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
