/**
 * 自由探索模式 · 轻量运动学驾驶器（R29）。
 *
 * 为什么单独建文件、不复用 physics/Vehicle.ts：主线是**纯纵向**步进器（无横向/转向），
 * 且 StateMachine 直接吃它的 distance 触发撞主殿结算。把转向塞进去会污染既有 79 项
 * 回归的契约。这里只做「复用纵向力函数 + 自己积分横向」：
 *   - 纵向力：motorForce / dragForce / rollForce 直接取自 physics/Vehicle.ts（手感同源）
 *   - 制动力：brakeInput × breakForceN × decelPerNewton（= 主线满踏板力口径）
 *   - 横向：自行车模型的**运动学**近似（无侧滑、无轮胎力），只保证转向手感与边界安全
 *
 * 坐标约定（与 three.js 严格对齐）：
 *   heading = 0 时车头朝 −Z；前向量 f = (−sin h, 0, −cos h)。
 *   three.js `rotation.y = h` 作用于 (0,0,−1) 的结果正是 (−sin h, 0, −cos h)。
 *   heading 增大 = 车头向 −X 转 = 玩家视角的左转（面向 −Z、右手系，右 = +X）。
 *
 * 边界（世界坐标，不依赖物理引擎，保证不穿墙不掉桥）：
 *   · 御桥段 z > −365：|x| ≤ 16.0
 *   · 城内段 z ≤ −365：|x| ≤ 14.5
 *   · z 钳位 [−1297, 70]
 *   · 主殿正面 z ≤ −1297.5 且 |x| < 24 → 停车 + 轻微后退弹开（事件 'hall'）
 */
import { BRAKE, MS_TO_KMH, VEHICLE } from '../config/physics';
import { dragForce, motorForce, rollForce } from '../physics/Vehicle';
import { clamp, damp } from '../util/math';
// B6 a11y（R30-D2）：与 Sliders.onKey 共用「交互目标放行」判据（同一定义，
// 避免两处选择器列表漂移）。dom.ts 是无依赖叶子工具，不构成循环依赖。
import { isInteractiveTarget } from '../ui/dom';

/** 计算质量（与 Vehicle.ts 同源：整备 3160 + 载荷 140） */
const MASS = VEHICLE.totalMassKg;

/** 自由探索标定表（集中一处，便于复算） */
export const FREE = {
  /** 最大偏航角速度 rad/s（打满方向盘、速度足够时的稳态值） */
  maxYawRate: 0.9,
  /** 转向效能参考速度 m/s：|v| 达到该值后转向角速度不再随速度增长（转弯半径恒定） */
  refSpeedMs: 5.5,
  /** 低速最大前轮转角 rad（≈35.5°，≤18 km/h） */
  steerMaxLow: 0.62,
  /** 高速最大前轮转角 rad（≈9.2°，≥60 km/h） */
  steerMaxHigh: 0.16,
  /** 转角收窄区间（km/h）：18 → 60 线性 */
  steerLowKmh: 18,
  steerHighKmh: 60,
  /** 转向输入一阶平滑时间常数 s */
  steerTau: 0.15,
  /** 倒车限速 m/s（≈28.8 km/h） */
  reverseMaxMs: 8,
  /** 倒车驱动力占前进驱动力的比例（倒车不需要全扭矩） */
  reverseForceRatio: 0.35,
  /** 手刹减速度 m/s²（低于 ABS 上限，留一点滑移感） */
  handbrakeDecel: 9,
  /* ── R36-P1 手刹漂移仿真（轮胎侧偏 + 摩擦圆；与主线普通制动路径完全隔离）──
   * 模型：动态自行车模型（前后轮侧偏角 → 侧向力 → 横摆力矩 + 侧向速度积分）。
   * 手刹 ⇒ 后轴摩擦圆收紧（rearGrip 一阶衰减）⇒ 后侧向力下降 ⇒ 横摆力矩失衡 ⇒
   * 车尾外滑（β 增长）；反打方向改变前轮侧偏 ⇒ 可维持/调整漂移；松手刹 + 回正
   * ⇒ rearGrip 一阶恢复 ⇒ 侧偏力把 β 拉回 0（恢复抓地）。
   * 纵向减速由摩擦圆自动钳制（侧向占用越高、可用纵向越少）⇒ 漂移减速 < 满刹。
   * 轴距/质心来自 WHEEL_HUB_CENTERS 实测（前后轴 z=±1.715 ⇒ L=3.43、a=b=1.715）。 */
  /** 前轴侧向刚度 N/rad（3.3t SUV 量级） */
  corneringStiffnessFront: 92_000,
  /** 后轴侧向刚度 N/rad */
  corneringStiffnessRear: 88_000,
  /** 偏航惯量 kg·m²（≈1.2·m·a·b） */
  yawInertia: 11_000,
  /** 轮胎摩擦系数（摩擦圆半径 = μ·g） */
  tyreMu: 0.92,
  /** 质心到前轴/后轴距离 m（轴距 3.43 之半） */
  axleFront: 1.715,
  axleRear: 1.715,
  /** 手刹时后轴抓地下限（0.32 = 明确甩尾倾向；恢复路径不受此限） */
  driftGripFloor: 0.32,
  /** 轮胎自回正力矩刚度 N·m/rad（气动拖距项：β 反向拉回车头，松手刹后
   *  大侧滑角态能收敛回直线的关键 —— 没有它「饱和侧偏 + 对称轴距」近似守恒） */
  aligningStiffness: 9_200,
  /** 后轴抓地衰减时间常数 s（拉手刹起滑） */
  gripDecayTau: 0.22,
  /** 后轴抓地恢复时间常数 s（松手刹回正；「恢复抓地时间有限」的口径） */
  gripRecoverTau: 0.45,
  /** 视觉侧倾上限 rad（2.5°） */
  rollMaxRad: (2.5 * Math.PI) / 180,
  /** 视觉俯仰上限 rad（1.2°） */
  pitchMaxRad: (1.2 * Math.PI) / 180,
  /** 侧倾灵敏度：横向加速度 4.5 m/s² 时打满 2.5° */
  rollRefMs2: 4.5,
  /** 俯仰灵敏度（与主线 pitchTarget = accel × 0.0045 同系数） */
  pitchPerAccel: 0.0045,
  /** 撞墙时速度的法向衰减系数（1 = 完全吃掉法向分量） */
  wallDecay: 0.9,
  /** 撞墙后保留的最小速度比例（防卡死：擦墙仍能滑行） */
  wallKeepMin: 0.08
} as const;

/** 场景边界（世界坐标 m） */
export const BOUNDS = {
  /** 御桥段 / 城内段分界 z */
  cityZ: -365,
  /** 御桥段侧向半宽。R29 桥面收窄（16.72 → **12.6**，`r28Layout.VIADUCT.totalHalf`）
   *  ⇒ 边界必须同步收到 12.0，否则自由探索能把车开出桥沿掉进峡谷。 */
  bridgeHalfW: 12.0,
  /** 城内大街侧向半宽（街侧建筑前脸 |x| = 15.5，留 1.0 车宽余量） */
  cityHalfW: 14.5,
  /** z 硬钳位 */
  zMin: -1297,
  zMax: 70,
  /**
   * 主殿正面撞击判定 z（规格值 −1297.5）。
   * ⚠️ 实现判据取 zMin（−1297）而不是这个值：z 被硬钳在 −1297，而 200 km/h 下
   * 单步位移只有 0.463 m < 0.5 m —— 车永远落在 (−1297.5, −1297] 的死区里，
   * 「z ≤ −1297.5」数学上不可达（实测跑满 30 s 全程 0 次 hall 事件）。
   * 故改为「本步试图越过 zMin」即判撞主殿，语义等价且可达。
   */
  hallZ: -1297.5,
  /** 主殿撞击面半宽 */
  hallHalfW: 24,
  /** 撞主殿后后退弹开距离 m */
  hallBounce: 0.8
} as const;

/** 自由探索起点：城门外（城门洞 z = −358.5）以北 28.5 m，车头朝城门 */
export const FREE_START = Object.freeze({ x: 0, z: -330, heading: 0 });

export type FreeDriveEvent =
  /** 撞上主殿正面 */
  | 'hall'
  /** 撞侧向护栏 / 纵向尽头 */
  | 'wall'
  /** 已复位到起点 */
  | 'reset'
  /** 请求退出自由探索（Esc） */
  | 'exit'
  /** 请求切换操作说明卡（H） */
  | 'help';

export interface FreeDriveState {
  /** 偏航角 rad（0 = 车头朝 −Z） */
  heading: number;
  /** 有符号纵向速度 m/s（+ 前进 / − 倒车） */
  speed: number;
  /** 世界 x */
  x: number;
  /** 世界 z */
  z: number;
  /** 前轮转角 rad（平滑后，视觉用；左转为正） */
  steer: number;
  /** 视觉侧倾 rad（rotation.z） */
  roll: number;
  /** 视觉俯仰 rad（rotation.x，抬头为正） */
  pitch: number;
  /** 本步纵向加速度 m/s² */
  accel: number;
  /** 本步偏航角速度 rad/s */
  yawRate: number;
  /** 本步油门 0/1 */
  throttle: number;
  /** 本步刹车 0/1（停稳后此键转为倒车） */
  brake: number;
  /** 本步手刹 */
  handbrake: boolean;
  /** 累计里程 m */
  odometer: number;
  /** R36-P1 车身侧滑角 rad（速度方向 − heading；漂移时增长，恢复抓地回 0） */
  beta: number;
  /** R36-P1 后轴抓地系数 0..1（手刹收紧 → 恢复；摩擦圆按此缩放） */
  rearGrip: number;
}

export interface FreeDriveOptions {
  /** 电子限速 km/h（默认读 config/physics 的 200） */
  maxSpeedKmh?: number;
  /** 起始位姿（默认 FREE_START） */
  start?: { x: number; z: number; heading: number };
}

export type BoundKind = 'none' | 'side' | 'end' | 'hall';

export interface BoundResult {
  x: number;
  z: number;
  heading: number;
  speed: number;
  kind: BoundKind;
}

/** 纯函数：车头前向量（heading = 0 → (0,0,−1)） */
export function forwardOf(heading: number): { x: number; z: number } {
  return { x: -Math.sin(heading), z: -Math.cos(heading) };
}

/** 纯函数：由前向量反解 heading（forwardOf 的逆） */
export function headingOf(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

/** 纯函数：当前 z 处的侧向可行驶半宽 */
export function corridorHalfWidth(z: number): number {
  return z > BOUNDS.cityZ ? BOUNDS.bridgeHalfW : BOUNDS.cityHalfW;
}

/**
 * 纯函数：速度相关的最大前轮转角（高速收窄，避免高速打死翻车感）。
 * 18 km/h 以下 = steerMaxLow；60 km/h 以上 = steerMaxHigh；中间线性。
 */
export function steerLimitFor(speedKmh: number): number {
  const t = clamp(
    (speedKmh - FREE.steerLowKmh) / (FREE.steerHighKmh - FREE.steerLowKmh),
    0,
    1
  );
  return FREE.steerMaxLow + (FREE.steerMaxHigh - FREE.steerMaxLow) * t;
}

/**
 * 纯函数：偏航角速度。低速转向减弱（|v|/refSpeed 线性），倒车时方向反向。
 */
export function yawRateFor(steer: number, speedMs: number): number {
  const av = Math.abs(speedMs);
  const factor = clamp(av / FREE.refSpeedMs, 0, 1);
  const dir = speedMs > 0 ? 1 : speedMs < 0 ? -1 : 0;
  return steer * FREE.maxYawRate * factor * dir;
}

/**
 * 纯函数（R37-D 抽出具单测）：轮胎自回正力矩产生的**横摆角加速度** rad/s²。
 *
 * ⚠️ 符号口径 —— 这是「松手刹零油门一直绕圈」bug 的根因，改动前先读这里：
 *   beta = atan2(vy, |vx|)，且代码里「速度方向 = heading + beta」。
 *   自回正的目的是把**车头**拉回速度方向（减小 |β|），所以横摆角加速度必须与 β
 *   **同号**：β>0（速度方向偏在车头左侧）⇒ 正横摆把车头往左追上去；β<0 ⇒ 负横摆。
 *   写成 −K·β 就是一枚「放大 β」的正反馈：它与轮胎横摆阻尼平衡出一个**非零**稳态
 *   横摆率 ⇒ 松手刹后车持续绕圈；同时 latUse = |yawDyn·v| 被这个非零横摆率顶到
 *   ≥ μ·g，摩擦圆把纵向可用附着吃光 ⇒ 手刹/制动完全不减速，绕圈更停不下来。
 *
 * 幅值：低速线性淡出（|v|/8，与旧实现 Math.min(1, ax/8) 逐位一致），
 * 避免停车时残余横摆抖动。数值本身不决定恢复**速率**（恢复主要由轮胎侧偏力 +
 * rearGrip 一阶回升完成），只决定是否存在非零稳态 —— 实测 K 从 9.2k 拉到 45k，
 * 收敛时间 2.12s → 1.76s，量级不敏感，故保持 R36 标定值不动。
 */
export function aligningYawAccel(beta: number, speedMs: number): number {
  return (FREE.aligningStiffness * beta * Math.min(1, Math.abs(speedMs) / 8)) / FREE.yawInertia;
}

/** 角度归一到 (−π, π] */
function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
}

/**
 * 纯函数：把外法向分量从前向量里剔除 → 沿墙滑行的新朝向。
 * @param n 单位外法向（指向墙外）
 */
function slideHeading(fx: number, fz: number, nx: number, nz: number): number {
  const along = fx * nx + fz * nz; // 朝墙外的分量（>0 = 正在撞向墙）
  let dx = fx - along * nx;
  let dz = fz - along * nz;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) {
    // 正撞（前向量几乎与法向平行）：没有可用的切向分量，
    // 直接把车头掰到墙面切向（保留原纵向符号，不足时取 +Z），避免车贴墙卡死。
    if (Math.abs(nx) > 0.5) {
      dx = 0;
      dz = fz >= 0 ? 1 : -1;
    } else {
      dx = fx >= 0 ? 1 : -1;
      dz = 0;
    }
  } else {
    dx /= len;
    dz /= len;
  }
  return headingOf(dx, dz);
}

/**
 * 纯函数：边界求解（可单测）。输入「已积分但未约束」的位姿与速度，
 * 输出约束后的位姿/速度与碰撞类型。撞墙做**法向速度衰减 + 沿墙滑行**，不卡死。
 */
export function resolveBounds(
  x: number,
  z: number,
  heading: number,
  speed: number
): BoundResult {
  // ① 主殿正面（静态碰撞墙，halfW 24）：停车 + 轻微后退弹开
  // 判据用 zMin 而非 hallZ（−1297.5），理由见 BOUNDS.hallZ 注释：后者在死区里不可达。
  if (z <= BOUNDS.zMin && Math.abs(x) < BOUNDS.hallHalfW) {
    return {
      x,
      z: BOUNDS.zMin + BOUNDS.hallBounce,
      heading,
      speed: 0,
      kind: 'hall'
    };
  }

  let kind: BoundKind = 'none';
  let h = heading;
  let v = speed;

  // ② 纵向两端（zMin 南端 / zMax 北端）
  if (z < BOUNDS.zMin || z > BOUNDS.zMax) {
    const nz = z < BOUNDS.zMin ? -1 : 1;
    z = z < BOUNDS.zMin ? BOUNDS.zMin : BOUNDS.zMax;
    const f = forwardOf(h);
    const fn = f.z * nz;
    if (fn > 0) {
      h = slideHeading(f.x, f.z, 0, nz);
      v *= clamp(1 - FREE.wallDecay * fn, FREE.wallKeepMin, 1);
      kind = 'end';
    }
  }

  // ③ 侧向护栏（御桥段 / 城内段半宽不同）
  const halfW = corridorHalfWidth(z);
  if (Math.abs(x) > halfW) {
    const nx = x >= 0 ? 1 : -1;
    x = nx * halfW;
    const f = forwardOf(h);
    const fn = f.x * nx;
    if (fn > 0) {
      h = slideHeading(f.x, f.z, nx, 0);
      v *= clamp(1 - FREE.wallDecay * fn, FREE.wallKeepMin, 1);
      kind = 'side';
    }
  }

  return { x, z, heading: h, speed: v, kind };
}

export class FreeDrive {
  readonly state: FreeDriveState;
  /** 事件出口（Game 统一处理 toast / 音效 / 震屏） */
  onEvent: ((e: FreeDriveEvent) => void) | null = null;

  private readonly maxSpeedMs: number;
  private readonly start: { x: number; z: number; heading: number };
  private readonly keys = new Set<string>();
  private abort: AbortController | null = null;
  /** 事件去抖（防止贴墙/贴主殿时 toast 与撞击音每帧刷屏） */
  private hallCd = 0;
  private wallCd = 0;
  /** R36-P1 漂移动力学状态：体轴侧向速度 m/s / 动态偏航角速度 rad/s */
  private vy = 0;
  private yawDyn = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
      case 'KeyS':
      case 'ArrowDown':
      case 'KeyA':
      case 'ArrowLeft':
      case 'KeyD':
      case 'ArrowRight':
      case 'Space':
        this.keys.add(e.code);
        // B6 a11y（R30-D2）：聚焦控件（结束探索/视角按钮等）时放行 Space 的
        // 默认行为 = 激活控件，与挑战模式 Sliders.onKey 同口径；仅对非交互
        // 目标吞默认行为（防页面滚动）。keys.add 照常执行（手刹输入不丢），
        // preventDefault 不阻其他监听器。
        if (!isInteractiveTarget(e.target)) e.preventDefault();
        break;
      case 'KeyR':
        if (!e.repeat) this.reset();
        break;
      case 'KeyH':
        if (!e.repeat) this.emit('help');
        break;
      case 'Escape':
        if (!e.repeat) this.emit('exit');
        break;
      default:
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  /** 失焦（切标签/切窗口）必须清空按键，否则回来时车会「自己踩着油门」 */
  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  constructor(options: FreeDriveOptions = {}) {
    this.maxSpeedMs = (options.maxSpeedKmh ?? VEHICLE.maxSpeedKmh) / MS_TO_KMH;
    this.start = options.start ?? { x: FREE_START.x, z: FREE_START.z, heading: FREE_START.heading };
    this.state = {
      heading: this.start.heading,
      speed: 0,
      x: this.start.x,
      z: this.start.z,
      steer: 0,
      roll: 0,
      pitch: 0,
      accel: 0,
      yawRate: 0,
      throttle: 0,
      brake: 0,
      handbrake: false,
      odometer: 0,
      beta: 0,
      rearGrip: 1
    };
    this.vy = 0;
    this.yawDyn = 0;
  }

  get active(): boolean {
    return this.abort !== null;
  }

  /** 绑定键盘监听（一次性 AbortController，与 Sliders / wireFreeLook 同模式） */
  attach(): void {
    if (this.abort) return;
    const ac = new AbortController();
    this.abort = ac;
    const opts = { signal: ac.signal } as const;
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('keyup', this.onKeyUp, opts);
    window.addEventListener('blur', this.onBlur, opts);
  }

  /** 解绑键盘监听（退出模式 / Game.dispose 必调） */
  detach(): void {
    this.abort?.abort();
    this.abort = null;
    this.keys.clear();
  }

  /** QA / 自动化测试用：直接置位某个按键 */
  press(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  /** 复位到起点（R 键 / 退出前复位） */
  reset(): void {
    const s = this.state;
    s.heading = this.start.heading;
    s.speed = 0;
    s.x = this.start.x;
    s.z = this.start.z;
    s.steer = 0;
    s.roll = 0;
    s.pitch = 0;
    s.accel = 0;
    s.yawRate = 0;
    s.odometer = 0;
    s.beta = 0;
    s.rearGrip = 1;
    this.vy = 0;
    this.yawDyn = 0;
    this.keys.clear();
    this.emit('reset');
  }

  /** QA / 截图用：直接摆位姿 */
  teleport(x: number, z: number, heading: number): void {
    const s = this.state;
    s.x = x;
    s.z = z;
    s.heading = wrapAngle(heading);
    s.speed = 0;
    s.steer = 0;
    s.roll = 0;
    s.pitch = 0;
    s.beta = 0;
    s.rearGrip = 1;
    this.vy = 0;
    this.yawDyn = 0;
  }

  /** 给 QA 探针的只读快照 */
  snapshot(): FreeDriveState & { speedKmh: number } {
    return { ...this.state, speedKmh: Math.abs(this.state.speed) * MS_TO_KMH };
  }

  /**
   * 固定步长推进（dt = 1/120 s，与主线物理同频）。
   * 顺序：输入 → 转向平滑 → 纵向力积分 → 限速/防抖 → 位移 → 边界 → 视觉姿态。
   */
  step(dt: number): void {
    const s = this.state;
    const throttle = this.has('KeyW', 'ArrowUp') ? 1 : 0;
    const brakeIn = this.has('KeyS', 'ArrowDown') ? 1 : 0;
    const handbrake = this.has('Space');
    const steerIn = (this.has('KeyA', 'ArrowLeft') ? 1 : 0) + (this.has('KeyD', 'ArrowRight') ? -1 : 0);
    s.throttle = throttle;
    s.brake = brakeIn;
    s.handbrake = handbrake;

    // ---- 转向输入一阶平滑（τ 0.15s）+ 高速转角收窄 ----
    const speedKmh = Math.abs(s.speed) * MS_TO_KMH;
    const steerTarget = steerIn * steerLimitFor(speedKmh);
    s.steer = damp(s.steer, steerTarget, 1 / FREE.steerTau, dt);

    // ---- 纵向力（复用主线力函数）----
    const v = s.speed;
    const av = Math.abs(v);
    const dir = v > 0 ? 1 : v < 0 ? -1 : 0;

    /* ---- R36-P1 后轴抓地一阶动力学（手刹收紧 / 松开恢复）----
     * rearGrip ∈ [driftGripFloor, 1]；它同时缩放后轴侧向力与后轴摩擦圆。 */
    const gripTarget = handbrake ? FREE.driftGripFloor : 1;
    const gripTau = handbrake ? FREE.gripDecayTau : FREE.gripRecoverTau;
    s.rearGrip = damp(s.rearGrip, gripTarget, 1 / gripTau, dt);

    /* ---- R36-P1 漂移动力学（动态自行车模型；激活滞回）----
     * 激活条件：手刹 / 侧滑角 / 动态偏航未归零；|v|<1.5 m/s 退回运动学（低速保护）。
     * 停用时状态清零 ⇒ 正常驾驶路径与 R29 运动学逐位一致（回归零风险）。 */
    const driftActive =
      av >= 1.5 && (handbrake || Math.abs(s.beta) > 0.002 || Math.abs(this.yawDyn) > 0.02);

    // 摩擦圆：侧向占用越高、可用纵向越少 ⇒ 漂移减速天然 < 直线刹车
    const muG = FREE.tyreMu * 9.81;
    const latUse = driftActive ? Math.abs(this.yawDyn * v) : 0;
    const decelAvail = Math.sqrt(Math.max(0, muG * muG - latUse * latUse));

    let force = 0;
    if (handbrake) {
      // 手刹制动（摩擦圆钳制）；漂移中给油仍有效 —— 真实漂移靠油门维持车速/姿态
      force = -dir * Math.min(FREE.handbrakeDecel, decelAvail) * MASS;
      if (throttle > 0) force += motorForce(av, throttle);
    } else if (throttle > 0) {
      force = motorForce(av, throttle);
    } else if (brakeIn > 0) {
      // 前进中 → 机械制动（满输入 = 主线满踏板力口径 = ABS 抓地上限）；
      // 已停稳 → 同一枚键转为倒车（倒拖扭矩取前进驱动力的一定比例）。
      force =
        v > BRAKE.stopSpeed
          ? -brakeIn * BRAKE.breakForceN * BRAKE.decelPerNewton * MASS
          : -FREE.reverseForceRatio * motorForce(av, 1);
    }
    // 阻力恒反向于运动（用步进前速度，避免 0.0017/步 的伪影）
    force -= dir * (dragForce(av) + rollForce());

    let vNext = v + (force / MASS) * dt;
    // 电子限速：只钳速度、不动 accel（与主线同契约——油门照常有劲）
    if (vNext > this.maxSpeedMs) vNext = this.maxSpeedMs;
    if (vNext < -FREE.reverseMaxMs) vNext = -FREE.reverseMaxMs;
    // 滑行时阻力不得把车推过零点（否则会在 0 附近抖动）
    if (throttle === 0 && brakeIn === 0 && !handbrake && dir !== 0 && vNext * dir <= 0) vNext = 0;
    // 制动不得一步跨过零点：先停稳，下一步才进倒车
    if (brakeIn > 0 && v > 0 && vNext < 0) vNext = 0;

    s.accel = dt > 0 ? (vNext - v) / dt : 0;
    s.speed = vNext;

    // ---- 位移（梯形积分，用步进前后的平均速度）----
    const vAvg = 0.5 * (v + vNext);
    let yawRate: number;
    let moveHeading: number;
    if (driftActive) {
      /* 轮胎侧偏角（体轴；vx 用步进前速度符号保持一致） */
      const vx = v === 0 ? 1e-3 : v;
      const ax = Math.abs(vx);
      const aF = FREE.axleFront;
      const aR = FREE.axleRear;
      const alphaF = s.steer - Math.atan2(this.vy + aF * this.yawDyn, ax);
      const alphaR = -Math.atan2(this.vy - aR * this.yawDyn, ax);
      // 侧向力（线性侧偏 + 摩擦圆钳制；后轴圆随 rearGrip 收紧）
      const maxF = FREE.tyreMu * 9.81 * MASS * 0.5;
      const fyf = clamp(FREE.corneringStiffnessFront * alphaF, -maxF, maxF);
      const fyr = clamp(
        FREE.corneringStiffnessRear * alphaR * s.rearGrip,
        -maxF * s.rearGrip,
        maxF * s.rearGrip
      );
      // 横摆 + 侧向速度积分（前轴产生横摆、后轴反向；β 自回正力矩拉回车头）
      // R37-D：符号口径见 aligningYawAccel() 头注（必须为 +K·β，曾因 −K·β 绕圈）
      const alignAccel = aligningYawAccel(s.beta, ax);
      this.yawDyn += ((aF * fyf - aR * fyr) / FREE.yawInertia) * dt + alignAccel * dt;
      this.vy += ((fyf + fyr) / MASS - vx * this.yawDyn) * dt;
      // 防散：beta / yaw 限幅（数值护栏，不改动力学符号）
      this.vy = clamp(this.vy, -Math.abs(vx), Math.abs(vx));
      this.yawDyn = clamp(this.yawDyn, -FREE.maxYawRate, FREE.maxYawRate);
      s.beta = Math.atan2(this.vy, ax);
      yawRate = this.yawDyn;
      moveHeading = s.heading + s.beta; // 速度方向 = 航向 + 侧滑角（车尾外滑的运动学产物）
    } else {
      this.vy = 0;
      this.yawDyn = 0;
      s.beta = 0;
      yawRate = yawRateFor(s.steer, vAvg !== 0 ? vAvg : v);
      moveHeading = s.heading;
    }
    const f = forwardOf(moveHeading);
    let nx = s.x + f.x * vAvg * dt;
    let nz = s.z + f.z * vAvg * dt;

    // ---- 偏航（漂移层用动态偏航；正常路径用既有运动学）----
    s.yawRate = yawRate;
    s.heading = wrapAngle(s.heading + yawRate * dt);

    // ---- 边界 ----
    const r = resolveBounds(nx, nz, s.heading, s.speed);
    s.x = r.x;
    s.z = r.z;
    s.heading = r.heading;
    s.speed = r.speed;
    if (r.kind === 'hall') s.accel = 0;

    // ---- 视觉姿态（侧倾 × 俯仰，都做平滑，避免阶跃）----
    const latAccel = yawRate * vAvg;
    const rollTarget = clamp(
      (-latAccel * FREE.rollMaxRad) / FREE.rollRefMs2,
      -FREE.rollMaxRad,
      FREE.rollMaxRad
    );
    s.roll = damp(s.roll, rollTarget, 6, dt);
    const pitchTarget = clamp(s.accel * FREE.pitchPerAccel, -FREE.pitchMaxRad, FREE.pitchMaxRad);
    s.pitch = damp(s.pitch, pitchTarget, 4, dt);
    s.odometer += Math.abs(vAvg) * dt;

    // ---- 事件去抖 ----
    this.hallCd = Math.max(0, this.hallCd - dt);
    this.wallCd = Math.max(0, this.wallCd - dt);
    if (r.kind === 'hall') {
      if (this.hallCd === 0) {
        this.hallCd = 1.6;
        this.emit('hall');
      }
    } else if (r.kind !== 'none' && this.wallCd === 0) {
      this.wallCd = 0.5;
      this.emit('wall');
    }
  }

  private has(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  private emit(e: FreeDriveEvent): void {
    this.onEvent?.(e);
  }
}
