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
 * 边界（世界坐标，不依赖物理引擎，保证不穿墙不掉桥；R98 起列出的是**车心**限）：
 *   · 御桥段：|x| ≤ 12.0 − 车半宽 = 10.997（车缘 12.0 < 桥面 12.6，防坠峡谷）
 *   · 城门带：|x| ≤ 10.0 − 车半宽 = 8.997（车缘 9.0 < 门墩内缘 10.0，防穿门墩）
 *   · 城内块区块心：|x| ≤ 10.0（车缘 11.003 < 柱内缘 11.12）；块角 3m 过渡到可见
 *     角塔大理石基座内缘 14.9（车心限 13.897，车缘恰贴基座不嵌入，R99）
 *   · 城内空档 / 主殿广场：|x| ≤ 15.5 − 车半宽 = 14.497（**车缘贴可见建筑前脸线**，非空气墙）
 *   · z 钳位 [−1297, 70]
 *   · 主殿正面 z ≤ −1297.5 且 |x| < 24 → 停车 + 轻微后退弹开（事件 'hall'）
 */
import { BRAKE, MS_TO_KMH, VEHICLE } from '../config/physics';
// R99：角塔基座内缘真源（INNER.faceHalf / TOWER.hallW），与 VEHICLE.widthM 一起派生块角 / 殿身车心限。
import { INNER, TOWER } from '../render/scene/r28Layout';
// R103 阶段二：拱廊柱列（R30_ARCADE）已下沉到 cityFootprints.ts 的 2D 占位，此处不再 import
//   （castleKit 模块加载无 DOM 副作用，r97_bounds_clearance 在 beforeAll 前已 import 同源）。
// R98：车身回正阻尼抽成独立配置（6/4 → 3.8/3.2），漂移灵魂参数与纵向力不受影响。
import { FREE_BODY_DAMPING } from '../config/freeBodyFeel';
import { dragForce, motorForce, rollForce } from '../physics/Vehicle';
import { clamp, damp } from '../util/math';
// R102：城内地面实体（角塔基座 / 柱础 / 飞扶壁墩 / 殿台基 / 前脸）2D 占位 + 车 OBB 收紧。
//   纯数值模块（无 three/DOM），只提供 clampToFootprints(x,z,heading)；1D 钳位
//   resolveBounds / corridorCenterHalfWidth / corridorHalfWidth 函数体逐位不动。
import { clampToFootprints } from './cityFootprints';
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
  /** 高速最大前轮转角 rad（≈6.9°，≥60 km/h） */
  steerMaxHigh: 0.12,
  /** 转角收窄区间（km/h）：18 → 60 线性 */
  steerLowKmh: 18,
  steerHighKmh: 60,
  /** 转向输入一阶平滑时间常数 s */
  steerTau: 0.10,
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
  /** 视觉侧倾上限 rad（3.5°） */
  rollMaxRad: (3.5 * Math.PI) / 180,
  /** 视觉俯仰上限 rad（2.0°） */
  pitchMaxRad: (2.0 * Math.PI) / 180,
  /** 侧倾灵敏度：横向加速度 4.0 m/s² 时打满 3.5° */
  rollRefMs2: 4.0,
  /** 俯仰灵敏度（与主线 pitchTarget = accel × 0.0045 同系数） */
  pitchPerAccel: 0.0045,
  /** 撞墙时速度的法向衰减系数（1 = 完全吃掉法向分量） */
  wallDecay: 0.9,
  /** 撞墙后保留的最小速度比例（防卡死：擦墙仍能滑行） */
  wallKeepMin: 0.08
} as const;

/* ── R99 · 撞墙瞬态（wall-scuff transient）独立标定 ──────────────────────────
 * 不放进 FREE 灵魂表：撞墙是边界写回的事，与漂移轮胎模型无关；也不碰
 * FREE_BODY_DAMPING（R98 阻尼）。这三个量只驱动「被墙顶一下 → 带惯性滑走」
 * 的一阶收敛与短暂横摆/侧倾冲击。R100：hall 正撞复用同一包络做姿态瞬态，但速度
 * 保持 speed:0（彻底停），不进 side/end 的速度分解路径。 */
/** 朝向 / 漂移态一阶收敛时间常数 s（≈0.36s 走完 95%，不再是单帧硬切） */
export const IMPACT_TAU = 0.12;
/** 法向入射冲量 → 视觉横摆角速度瞬态增益（rad·s/m，小值起始） */
export const IMPACT_YAW_GAIN = 0.02;
/** 法向入射冲量 → 视觉侧倾瞬态增益（rad·s/m，小值起始） */
export const IMPACT_ROLL_GAIN = 0.004;

/* ── R101 Phase2 · 撞墙切向刮擦摩擦（wall scrub）独立标定 ───────────────────
 * 不放进 FREE 灵魂表：刮擦是**撞墙域边界耗散**，与漂移轮胎模型（灵魂 12 参数）无关，
 * 也不碰 FREE_BODY_DAMPING / 摩擦圆（tyreMu/latUse/decelAvail）/ 制动力 / decelPerNewton。
 * 语义：撞上后车身/轮胎与墙持续刮擦是强耗散，按「撞得越狠刮得越狠 + 封顶」给一个
 * 纵向减速度，作用在 step() 纵向力积分之后、电子限速钳位之前（撞墙耗散 ≠ 限速）。
 * 堵死旧机制的漏洞：撞后 heading 收敛到切向平行墙 ⇒ fn→0 ⇒ resolveBounds 恒不判撞、
 * 只剩几何钳位（只钳 x 不动速度）⇒ 边界成「无摩擦导轨」，贴墙含油门能无限蹭滑。
 */
/** 刮擦减速度对撞墙法向入射强度的系数（scrub = impactN × WALL_SCRUB_DECEL） */
export const WALL_SCRUB_DECEL = 0.8;
/** 刮擦减速度封顶 m/s²（>1.2g，真车撞墙刮擦量级；带油门净加速 ≈6.08 压不住） */
export const WALL_SCRUB_DECEL_MAX = 12.0;
/** 贴墙接触判定的位置容差 m（|x|≥halfW−ε / |z| 触 zMin/zMax，ε 取 0.05 防浮点抖动） */
export const WALL_SCRUB_CONTACT_EPS = 0.05;
/**
 * R102 脱困门控的速度阈值 m/s（≈5.4 km/h）。贴墙 + 低速（|v|<此值）+ 玩家主动操作
 * （油门/刹车 + 转向）时，scrub 钉速（封顶 12 > 净加速 6.11 > 倒车 2.08）+ yawRateFor
 * 的转向因子∝|v|→0 会让车头彻底失去转向权限，玩家无法转头脱困（HUD 显示 D + 速度 0）。
 * 此窗口恢复最小转向权限让车头转离墙。低速口径与漂移退出阈值 1.5 m/s 对齐。
 * 仍归撞墙域边界常量，不入 FREE 灵魂表（与 scrub 同源，不碰灵魂 12 参数）。
 */
export const WALL_SCRUB_RELEASE_MS = 1.5;
/**
 * R102 离墙滞后带 m：已贴墙态改用此更宽松阈值维持 sideTouch=true，防止
 * corridorCenterHalfWidth(z) 段间跳变导致误清零。最大段间跳变 = 桥 10.997 →
 * 隧道 8.997 → 块心 10.0 = 1.003 m 差 + 柱位 10.117 多出 0.117 m ⇒ 1.2 > 1.114 覆盖。
 */
export const WALL_SCRUB_RELEASE_EPS = 1.2;
/**
 * R102 latch 持续远离帧闸门：latch 已贴墙态只在**连续**超过此帧数都超出 RELEASE_EPS 带
 * 才真正清 latch。覆盖隧道→城内过渡时经过块角区（halfW 瞬时 13.897，gap ≈4.7 m）的瞬态，
 * 块角区通过 ≈40 帧(0.33s)，取 60 帧(0.5s)保证不被瞬态清 latch。120 fps 口径。
 */
export const WALL_SCRUB_LATCH_FAR_FRAMES = 60;

/** 场景边界（世界坐标 m） */
export const BOUNDS = {
  /** 御桥段 / 城门带分界 z（= 城门脸，GATE.z+GATE.depth/2=−351.5，castleKit makePaving 同源） */
  gateFrontZ: -351.5,
  /** 城门带 / 城内大街分界 z（= INNER.zNear=−365.5，r28Layout 同源） */
  gateBackZ: -365.5,
  /** 城内大街 / 主殿广场分界 z（= INNER.zFar=−1285.5，r28Layout 同源） */
  plazaZ: -1285.5,
  /**
   * 御桥段侧向半宽。R29 桥面收窄（16.72 → **12.6**，`r28Layout.VIADUCT.totalHalf`）
   *  ⇒ 边界必须同步收到 12.0，否则自由探索能把车开出桥沿掉进峡谷。
   */
  bridgeHalfW: 12.0,
  /** 城门洞半宽（贴隧道地面外缘 10；门墩 x≥10，防穿门墩） */
  tunnelHalfW: 10.0,
  /**
   * 城内建筑块半宽（多边角）：R97 由 10.5 收到 **10.0**。
   * R96 的 10.5 只钳车心、未扣车半宽（VEHICLE.widthM/2 = 1.003）：车缘 10.5+1.003
   * = 11.503 > 拱廊柱内缘 11.12 ⇒ 嵌入 0.383m（R96 注释「微擦」语义写反）。
   * 新值车缘 10.0+1.003 = 11.003 < 11.12，留 0.117m 净空。
   * 柱内缘口径：faceHalf15.5 − arcade.width3.5 − translate1.0 − colR0.3 + 柱心外偏0.12
   * = 11.12（castleKit R30_ARCADE:307 / :3433 + castleDetail corridorRun:1410）。
   */
  arcadeHalfW: 10.0,
  /**
   * 城内空档半宽（多边角）：开放到**可见建筑前脸线**（15.5），车能开进建筑间隔，
   * 不被无形空气墙挡住；上限即建筑线，车不会驶出场景 / 绕到建筑背后。
   * ⚠ 15.5 是「建筑线」而非「可穿行空气墙」——保留兜底边界，勿误删。
   */
  cityOpenHalfW: 15.5,
  /** 主殿广场半宽（与空档同宽，广场两侧到可见建筑前脸线，非空气墙） */
  plazaHalfW: 15.5,
  /** 兼容口径：原城内段半宽（保留，部分注释/旧档引用；新逻辑走 arcade/cityOpen） */
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

/**
 * 城内大街 keep=10 街区的 z 区间（块心 zc = zNear − 23 − 46k，块长 46，zc±23）。
 * ⚠ **单一真源约束**：与 castleKit `cityBlockIndices(20, R91_CITY_KEEP_BLOCKS=10)` 的
 * ks=[0,1,2,3,6,8,11,14,16,19] 同步；改 keep 必须同步此表（r95_city_blocks 测试钉 ks，
 * corridor 护栏钉块区间，双保险）。
 * 区间覆盖：御桥→[−365.5,−411.5]…，空档（无街区）自动落 15.5（开放）。
 */
/** R102 起导出：cityFootprints 由同一份块区间派生 2D 占位，避免两处 keep 块漂移。 */
export const CITY_BLOCK_Z: ReadonlyArray<readonly [number, number]> = [
  [-411.5, -365.5],
  [-457.5, -411.5],
  [-503.5, -457.5],
  [-549.5, -503.5],
  [-687.5, -641.5],
  [-779.5, -733.5],
  [-917.5, -871.5],
  [-1055.5, -1009.5],
  [-1147.5, -1101.5],
  [-1285.5, -1239.5]
];

/** 块边界线性过渡半宽 m（多边角：块中心 10.0 → 块边界 15.5 连续渐变，防突变撞墙） */
const EDGE_TRANSITION = 3;

/**
 * R99 多边形角：可见实体「街区角塔大理石基座」内缘（非抽象面线 15.5）。
 *
 * 真源（castleKit.ts，只读）：
 *   - :330 `R30_CORNER = { h:31, w:8, d:5 }`（w=8 = ctw）
 *   - :3381 `box('marble', ctw+1.2, 1.0, ctd+1.2, cx=ctw/2, …)`，put() 按 side·faceHalf 镜像
 *     ⇒ 世界内缘 = INNER.faceHalf + (ctw/2 − (ctw+1.2)/2) = INNER.faceHalf − 1.2/2 = 14.9
 *     （ctw 相消 ⇒ 只依赖基座裙外扩 1.2；R30_CORNER 为 castleKit 私有常量不可 import，
 *       按真源几何等价化简，禁止写死 14.9 / 13.897。）
 */
const CITY_CORNER_MARBLE_SKIRT = 1.2; // castleKit.ts:3381 基座裙相对塔身的单侧外扩
const CITY_CORNER_BASE_INNER = INNER.faceHalf - CITY_CORNER_MARBLE_SKIRT / 2; // 14.9 可见基座内缘
/** 角点车心限 = 可见基座内缘 − 车半宽 = 14.9 − 1.003 = 13.897（车缘恰贴基座不嵌入） */
const CITY_CORNER_CAR_CENTER = CITY_CORNER_BASE_INNER - VEHICLE.widthM / 2;

/* ── R103 · 阶段二「看不见空隙不挡」──────────────────────────────────────────
 * 用户铁律：看得见实体贴着挡、看不见空隙不挡。R100 把块心段保守钳在 10.0（车缘 11.003），
 * 但柱间/墩间的真空隙最近可见实体是建筑前脸 15.5 ⇒ 约 4.5 m 无形空气墙（probe §3.2 A1）。
 *
 * 架构裁决（主理人）：1D「走廊半宽」标量**无法表达「可停在其外侧的周期突出物」**。
 * 柱列 11.12 / 飞扶壁墩 11.35 是周期物，车可合法停在「柱与前脸之间」的空隙（车心到 14.497）；
 * 若沿用 1D 窄带钳到 10.117/10.347，则贴前脸行驶的车一进柱位 z 带就被 `|x|>halfW → x=halfW`
 * 瞬移 4.4 m 进路内（穿模）。故：
 *   - 1D 块心只保留**连续墙**包络（车几何上不可外越）：殿身大理石带 15.0 → 13.997；
 *     其余建筑前脸 15.5 → 14.497。
 *   - 周期突出物（柱 11.12 / 连墙墩 11.35 / 角塔墩 11.35）全部下沉到 step() 的
 *     2D clampToFootprints，按车 OBB 是否**真相交**来钳（只收紧不放宽、无瞬移）。
 * 角塔大理石基座裙 14.9 是**连续墙**（绕角塔一周），仍留 1D（13.897）。
 */

/** 殿前大理石带内缘 = faceHalf − 带半宽 0.5 = 15.0（castleKit.ts:3156 box(0.5,…,−0.25) ⇒ 世界 |x|∈[15.0,15.5]） */
const CITY_HALL_MARBLE_INNER = INNER.faceHalf - 0.5; // 15.0
/** 殿身车心限 = 大理石带内缘 − 车半宽 = 15.0 − 1.003 = 13.997（车缘恰贴大理石带） */
const CITY_HALL_CAR_CENTER = CITY_HALL_MARBLE_INNER - VEHICLE.widthM / 2;
/** 殿身 |z−块心| 包络 = hallW/2 + 大理石带 z 半外扩 0.6（与 cityFootprints 殿前大理石带 z 覆盖同源） */
const CITY_HALL_ZR_EXTENT = TOWER.hallW / 2 + 0.6; // 6.25 + 0.6 = 6.85

/* ── R100 · 边界精度贴可见实体（柱列周期 / 空档角塔带）──────────────────────
 * 用户澄清：不补街沿、不加兜底墙；只让挡车边界精确贴合可见实体。全部常量由真源
 * import 派生（R30_ARCADE / INNER / VEHICLE），禁写死 10.117 / 11.12 / 8.8 / 1.303 / 2.6。
 */
/* R103 阶段二：拱廊柱列（内缘 11.12 / 节距 8.8 / 柱数）已下沉到 cityFootprints.ts 的 2D
 * 占位（arcadeCol），1D 走廊不再按柱位收窄 ⇒ FreeDrive 不再需要这组常量（避免未用告警）。 */
/** 角塔进深 castleKit.ts:330 `R30_CORNER.d=5`（私有常量，真源不可 import） */
const CITY_CORNER_D = 5;
/**
 * 角塔基座伸进空档的 z 覆盖带 = (d + 裙)/2 − 0.5 =
 *   (R30_CORNER.d + CITY_CORNER_MARBLE_SKIRT)/2 − 块端内偏0.5 = (5+1.2)/2 − 0.5 = 2.6
 * （ctd+1.2 基座裙半宽 3.1；角塔中心块端内偏 0.5 ⇒ castleKit.ts:3461 `blockLen/2 − 0.5`）
 */
const CITY_CORNER_Z_REACH = (CITY_CORNER_D + CITY_CORNER_MARBLE_SKIRT) / 2 - 0.5;
/** 覆盖带外端的线性过渡消抖宽度（报告 §2.3 遗留项 3，产品标定 0.4m） */
const CITY_CORNER_Z_FADE = 0.4;
/** 纯函数：当前 z 处的侧向可行驶半宽（R96 多边角，随建筑轮廓分段） */
export function corridorHalfWidth(z: number): number {
  if (z >= BOUNDS.gateFrontZ) return BOUNDS.bridgeHalfW; // 御桥段：贴桥沿 12.0（防坠峡谷）
  if (z >= BOUNDS.gateBackZ) return BOUNDS.tunnelHalfW; // 城门带：贴隧道地面外缘 10.0（防穿门墩）
  if (z <= BOUNDS.plazaZ) return BOUNDS.plazaHalfW; // 主殿广场：15.5
  // 城内大街：块区窄（贴拱廊柱列）/ 空档宽（建筑前脸线开放），块边界线性过渡
  for (const [zmin, zmax] of CITY_BLOCK_Z) {
    if (z >= zmin && z <= zmax) {
      const dc = Math.min(z - zmin, zmax - z); // 到最近块边界的距离
      if (dc >= EDGE_TRANSITION) return BOUNDS.arcadeHalfW; // 块中心：10.0（贴柱列，车缘 11.003 留净空）
      const t = dc / EDGE_TRANSITION; // 0=块边界 → 1=过渡完成
      // 块边界处 = 空档宽 15.5（连续），向块中心线性收到 10.0（多边角斜边）
      return BOUNDS.arcadeHalfW + (BOUNDS.cityOpenHalfW - BOUNDS.arcadeHalfW) * (1 - t);
    }
  }
  return BOUNDS.cityOpenHalfW; // 空档：开放到建筑前脸线 15.5（免空气墙）
}

/**
 * R98 纯函数：当前 z 处的**车心**可行驶半宽 =「车缘不越可见面线」的钳位值。
 *
 * 为什么要另起函数、而不改 corridorHalfWidth：后者返回的是**可见面线**半宽，
 * CameraRig（相机钳位）与 r97_bounds_clearance 测试都依赖它逐位不变。
 *
 * 分段口径（与 corridorHalfWidth 的分段顺序严格镜像）：
 *   - 城内块区（CITY_BLOCK_Z 区间）：块心 dc≥3 保持 R97 车心限 10.0（车缘 11.003 < 柱内缘
 *     11.12，不再扣车半宽）；块角 3m 过渡（dc<3）由 R99 改为从「可见角塔大理石基座内缘
 *     14.9 − 车半宽 = 13.897」线性收到 10.0 —— 车缘 dc=0 时恰贴基座 14.9（修复前 16.503
 *     嵌入 1.6m），dc≥3 时仍 11.003 保持 R97 净空。corridorHalfWidth 本身逐位不动。
 *   - 其它段（御桥 / 城门洞 / 城内空档 / 主殿广场）：corridorHalfWidth 返回的仍是
 *     可见面线（桥面保守内缩 12.0 / 门墩内缘 10.0 / 建筑前脸线 15.5 / 广场 15.5），
 *     R97 直接拿它当车心限 ⇒ 车缘越面线穿模。此处扣掉车半宽 VEHICLE.widthM/2 (=1.003)，
 *     使车缘 ≤ 可见面线。
 */
export function corridorCenterHalfWidth(z: number): number {
  if (z >= BOUNDS.gateFrontZ) return corridorHalfWidth(z) - VEHICLE.widthM / 2; // 御桥
  if (z >= BOUNDS.gateBackZ) return corridorHalfWidth(z) - VEHICLE.widthM / 2; // 城门带
  if (z <= BOUNDS.plazaZ) return corridorHalfWidth(z) - VEHICLE.widthM / 2; // 主殿广场
  for (const [zmin, zmax] of CITY_BLOCK_Z) {
    if (z >= zmin && z <= zmax) {
      const dc = Math.min(z - zmin, zmax - z); // 到最近块边界的距离
      const zc = (zmin + zmax) / 2;
      const zr = Math.abs(z - zc); // 到块心的距离
      // R103 阶段二：块心 1D 只保留连续墙包络（殿身大理石带 13.997 / 建筑前脸 14.497）。
      // 周期突出物（柱列 / 飞扶壁墩）下沉到 2D，消除柱间/墩间空气墙且无瞬移（见上方 R103 注释）。
      const envelope = zr <= CITY_HALL_ZR_EXTENT ? CITY_HALL_CAR_CENTER : BOUNDS.cityOpenHalfW - VEHICLE.widthM / 2;
      if (dc < EDGE_TRANSITION) {
        // R99 块角：角塔大理石基座（连续墙）14.9 → 13.897 突出于前脸，随 dc 线性淡出到
        // 建筑包络（dc=3 处与块心包络连续）。角塔飞扶壁外墩 11.35 是突出物 → 2D 兜底。
        const t = dc / EDGE_TRANSITION; // 0=块角 → 1=柱列段
        return CITY_CORNER_CAR_CENTER + (envelope - CITY_CORNER_CAR_CENTER) * t;
      }
      return envelope;
    }
  }
  // R100 ② 空档角塔带贴实体：z 落在块边界外侧 0~2.6m（角塔基座伸进空档覆盖带）时车心限
  // 收到 13.897（车缘 14.9 贴基座），其余空档保持 14.497；覆盖带外端 0.4m 线性过渡消抖。
  const openCenter = corridorHalfWidth(z) - VEHICLE.widthM / 2; // 14.497 开放基线
  for (const [zmin, zmax] of CITY_BLOCK_Z) {
    // 块下边界外侧（z < zmin）：越靠近 zmin 越深；块上边界外侧（z > zmax）镜像。
    const outside = z < zmin ? zmin - z : z > zmax ? z - zmax : Infinity;
    if (outside > CITY_CORNER_Z_REACH + CITY_CORNER_Z_FADE) continue;
    if (outside <= CITY_CORNER_Z_REACH) return CITY_CORNER_CAR_CENTER; // 13.897 贴基座
    // 外端 0.4m 线性过渡：13.897 → 14.497（放宽方向，非穿模）
    const t = (outside - CITY_CORNER_Z_REACH) / CITY_CORNER_Z_FADE;
    return CITY_CORNER_CAR_CENTER + (openCenter - CITY_CORNER_CAR_CENTER) * t;
  }
  return openCenter; // 其余空档：建筑前脸线扣车半宽 14.497
}

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
  /** R99：法向入射冲量强度 |v|·fn [m/s]，side/end 撞击时 >0；
   *  R100：hall 正撞带 |v|（无 fn 分解，heading 原样、speed 仍 0） */
  impactN?: number;
  /** R99：朝向一阶收敛的终值（沿墙切向，slideHeading 求终值），仅 side/end 撞击时给出 */
  targetHeading?: number;
}

/** 纯函数：车头前向量（heading = 0 → (0,0,−1)） */
export function forwardOf(heading: number): { x: number; z: number } {
  return { x: -Math.sin(heading), z: -Math.cos(heading) };
}

/** 纯函数：由前向量反解 heading（forwardOf 的逆） */
export function headingOf(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
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
 * R99 纯函数：撞墙朝向一阶收敛（单步只走全差距的 dt/tau 比例）。
 *
 * 用 wrapAngle 取最短角差，避免 heading 跨越 ±π 时绕远路 / 跳变；
 * alpha 钳到 [0,1]，大 dt 也不会越过目标（越界即「过冲」，不是真车响应）。
 * 对比硬切版本：原 slideHeading 一帧转完 Δh=0.2rad ⇒ 等效 ≈24rad/s；
 * 这里 dt=1/120,tau=0.12 ⇒ 单帧只转 0.0139rad ⇒ ≈1.6rad/s（maxYawRate 量级）。
 */
export function impactHeadingStep(
  h: number,
  targetH: number,
  tau: number,
  dt: number
): number {
  const d = wrapAngle(targetH - h);
  const alpha = tau > 0 ? clamp(dt / tau, 0, 1) : 1;
  return wrapAngle(h + d * alpha);
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
      kind: 'hall',
      // R100：带出正撞法向强度供 step 注入 wallImpact 包络（复用 R99 一阶瞬态）。
      // 不设 targetHeading ⇒ heading 原样、不二次撞击；speed 仍 0 ⇒ 一次性彻底停契约不变。
      impactN: Math.abs(speed)
    };
  }

  let kind: BoundKind = 'none';
  let h = heading;
  let v = speed;
  // R99：几何钳位仍瞬时（防穿墙），但朝向/速度不再在一步内硬切；
  // 这两项交给 FreeDrive.step() 经 IMPACT_TAU 一阶展开（hall 只注入 impactN 包络，速度仍 0）。
  let impactN = 0;
  let targetHeading: number | undefined;

  // ② 纵向两端（zMin 南端 / zMax 北端）
  if (z < BOUNDS.zMin || z > BOUNDS.zMax) {
    const nz = z < BOUNDS.zMin ? -1 : 1;
    z = z < BOUNDS.zMin ? BOUNDS.zMin : BOUNDS.zMax;
    const f = forwardOf(h);
    const fn = f.z * nz;
    if (fn > 0) {
      impactN = Math.abs(v) * fn; // 法向入射强度 [m/s]
      // 法向吸收 + 切向保留的矢量分解（替代原「整体乘系数」的一帧骤降）
      const fnComp = v * fn * (1 - FREE.wallDecay); // 法向分量被吸收 90%
      const ftComp = v * Math.sqrt(Math.max(0, 1 - fn * fn)); // 切向分量保留
      v = Math.sign(v) * Math.hypot(fnComp, ftComp);
      targetHeading = slideHeading(f.x, f.z, 0, nz); // 终值仍用现成纯函数
      kind = 'end';
    }
  }

  // ③ 侧向护栏（R98：块区保持 R97 车心限；其它段按可见面线扣车半宽，车缘不越面线）
  const halfW = corridorCenterHalfWidth(z);
  if (Math.abs(x) > halfW) {
    const nx = x >= 0 ? 1 : -1;
    x = nx * halfW;
    const f = forwardOf(h);
    const fn = f.x * nx;
    if (fn > 0) {
      impactN = Math.abs(v) * fn;
      const fnComp = v * fn * (1 - FREE.wallDecay);
      const ftComp = v * Math.sqrt(Math.max(0, 1 - fn * fn));
      v = Math.sign(v) * Math.hypot(fnComp, ftComp);
      targetHeading = slideHeading(f.x, f.z, nx, 0);
      kind = 'side';
    }
  }

  // h 原样带回（不再一帧硬掰）；朝向收敛由 step() 的 impactHeadingStep 完成。
  return { x, z, heading: h, speed: v, kind, impactN, targetHeading };
}

export class FreeDrive {
  readonly state: FreeDriveState;
  /** 事件出口（Game 统一处理 toast / 音效 / 震屏） */
  onEvent: ((e: FreeDriveEvent) => void) | null = null;

  /* ── R65 · 照片模式（控相机不控车）──────────────────────────────
   * 用户需求：自由探索加「照片模式」——控场景相机自由移动，而不是控制车辆。
   * 实现：photoMode=true 时 step() 把驾驶输入（油门/刹车/转向/手刹）全部短路归零，
   *   车辆从当前速度经阻力+「跨零急停」在一个物理步内停死并保持静止；相机链路
   *   （CameraRig / wireFreeLook / HUD 视角按钮）完全不受影响 ⇒ 相机可自由环视。
   * 这是最小侵入接入点：不碰挑战链路、不碰相机、不碰运动学积分公式，
   *   关掉 photoMode 立刻恢复完整驾驶（逐位回 R64 路径）。
   * 键盘监听保持 attach（Esc 结束 / H 帮助 / R 复位仍可用），仅驾驶键被 step 忽略。 */
  photoMode = false;

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
  /** R99 撞墙瞬态包络 [m/s]：撞击时置为法向入射峰值，随后指数衰减，驱动横摆/侧倾余韵 */
  private wallImpact = 0;
  /**
   * R101 撞墙刮擦维持的撞击强度 [m/s]：撞墙时置为 impactN 峰值，**只要仍贴墙就维持**
   * （不随 heading 转到切向而衰减），离墙即清零。用持久量而非现算 |v|·fn：撞后 heading
   * 收敛到平行墙后 fn→0，若现算会让刮擦退化回零摩擦蹭滑。供给 step() 算 scrub 减速度。
   */
  private wallScrubN = 0;
  /** R102 只读观测口：供测试纯数值断言「贴墙期间 scrub 不被段间跳变误清零」（不暴露写权限） */
  get scrubN(): number {
    return this.wallScrubN;
  }
  /**
   * R102 贴墙滞后锁存：撞墙帧 sideTouch=true 时置 true；|x| 掉到 halfWnow−RELEASE_EPS
   * 以下才回 false。防止 corridorCenterHalfWidth 随 z 段间跳变（桥 10.997 → 隧道 8.997 →
   * 块心 10.0 / 柱位 10.117）时 halfWnow 瞬时变大导致接触判定闪断、wallScrubN 被误清零。
   */
  private wallSideTouchLatch = false;
  /** R102 连续超出 RELEASE_EPS 带的帧计数：超过 WALL_SCRUB_LATCH_FAR_FRAMES 才清 latch */
  private wallSideTouchFarFrames = 0;

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
    this.wallImpact = 0;
    this.wallScrubN = 0;
    this.wallSideTouchLatch = false;
    this.wallSideTouchFarFrames = 0;
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
    this.wallImpact = 0;
    this.wallScrubN = 0;
    this.wallSideTouchLatch = false;
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
    this.wallImpact = 0;
    this.wallScrubN = 0;
    this.wallSideTouchLatch = false;
    this.wallSideTouchFarFrames = 0;
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
    // R65 照片模式：驾驶输入全部短路（车急停静止），相机链路不受影响。
    // 置 speed=0 而非仅清输入 ⇒ 一个物理步内停死（不靠阻力滑行），构图期间车纹丝不动。
    // steer/handbrake/throttle/brake 全清 ⇒ HUD 踏板/挡位/转向读数同步归零，观感一致。
    if (this.photoMode) {
      s.throttle = 0;
      s.brake = 0;
      s.handbrake = false;
      s.steer = 0;
      s.accel = 0;
      s.speed = 0;
      s.yawRate = 0;
      this.yawDyn = 0;
      this.vy = 0;
      s.beta = 0;
      this.wallImpact = 0;
    this.wallScrubN = 0;
    this.wallSideTouchLatch = false;
    this.wallSideTouchFarFrames = 0;
      return;
    }
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

    /* ---- R101 Phase2 / R102 离墙滞后：撞墙切向刮擦接触判定 ----
     * 用**当前位姿**（上一帧 resolveBounds 已把车心钳到墙）做几何接触判定，不依赖
     * heading 法向 fn：撞后 heading 收敛到切向平行墙 ⇒ fn→0，若现算 |v|·fn 会让刮擦
     * 退化回零摩擦蹭滑。仍贴墙（side：|x|≥halfW−ε；end：|z| 触 zMin/zMax）就维持
     * wallScrubN 供下方刮擦；一旦离墙即清零（刮擦只在接触期间发生）。
     *
     * R102 离墙滞后：corridorCenterHalfWidth(z) 随 z 段间跳变（桥 10.997 → 隧道 8.997 →
     * 块心 10.0 → 柱位 10.117 → 空档角塔 13.897），车贴上一段墙 x 不变而 halfWnow 变大时
     * |x| < halfWnow−0.05 ⇒ 旧判定闪断、wallScrubN 被误清零。改用双阈值滞后 + 持续远离闸门：
     * 1. 已贴墙态（latch=true）用 RELEASE_EPS(1.2) 维持接触，未贴墙态用 CONTACT_EPS(0.05) 进入；
     * 2. latch 只在**连续** WALL_SCRUB_LATCH_FAR_FRAMES(60=0.5s) 帧都超出 RELEASE_EPS 带
     *    才真正清 latch——覆盖隧道→城内过渡时经过块角区（gap 瞬时≈4.7 m）的瞬态。 */
    const halfWnow = corridorCenterHalfWidth(s.z);
    const absX = Math.abs(s.x);
    const sideTouchRaw = absX >= halfWnow - WALL_SCRUB_CONTACT_EPS;
    if (sideTouchRaw) {
      this.wallSideTouchLatch = true;
      this.wallSideTouchFarFrames = 0;
    } else if (this.wallSideTouchLatch) {
      if (absX >= halfWnow - WALL_SCRUB_RELEASE_EPS) {
        this.wallSideTouchFarFrames = 0; // 仍在滞后带内，重置远离计数
      } else {
        this.wallSideTouchFarFrames++;
        if (this.wallSideTouchFarFrames > WALL_SCRUB_LATCH_FAR_FRAMES) {
          this.wallSideTouchLatch = false;
        }
      }
    }
    const sideTouch = this.wallSideTouchLatch;
    const endTouch =
      s.z <= BOUNDS.zMin + WALL_SCRUB_CONTACT_EPS || s.z >= BOUNDS.zMax - WALL_SCRUB_CONTACT_EPS;
    if (sideTouch || endTouch) {
      // 仍与墙接触：维持撞击强度（由下方 impacting 块按 impactN 峰值刷新）
    } else {
      this.wallScrubN = 0; // 已离墙：刮擦结束
    }
    // 刮擦减速度：撞得越狠刮得越狠 + 封顶（撞墙域边界耗散，与轮胎摩擦圆独立）
    const wallScrub = Math.min(this.wallScrubN * WALL_SCRUB_DECEL, WALL_SCRUB_DECEL_MAX);

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
    // R101 撞墙刮擦耗散：作用在电子限速钳位**之前**，语义是「撞墙耗散」非「限速」。
    // 沿运动反方向减 scrub·dt，钳到不反向（沿用下方 :866 口径），油门压不住（12 > 净加速6.08）。
    // ⚠ 主动漂移态（手刹/大侧偏/大动态横摆）不加刮擦：此时轮胎摩擦圆已饱和主导减速，
    //   再叠墙体刮擦=双重惩罚且会干扰漂移模型回归（R37-D 自回正漂移蹭墙场景）。
    //   R101 目标场景（撞后切向滑行）非漂移态 ⇒ 不受此门控影响。
    if (wallScrub > 0 && dir !== 0 && !driftActive) {
      vNext -= dir * wallScrub * dt;
      if (vNext * dir <= 0) vNext = 0;
    }
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
      // ---- R102 贴墙低速脱困：恢复最小转向权限 ----
      // 死锁闭环：wallScrubN 贴墙期间以 Math.max 记峰、永不衰减（封顶 12 m/s²），
      // 12 > 前进净加速 6.11 > 倒车 2.08 ⇒ scrub 单帧把 vNext 钳回 0（速度 0）；
      // 速度 0 时 yawRateFor 的转向因子 clamp(|v|/refSpeedMs,0,1)∝|v|→0 ⇒ 车头无转向
      // 权限，玩家无法转头脱困（HUD 显示 D + 速度 0）。scrub 作用方向 dir=sign(v) 是标量、
      // 不往坑里压，真正困住车的是 scrub 钉速 + 转向权限归零。
      // 门控：贴墙(wallScrub>0) + 低速(av<WALL_SCRUB_RELEASE_MS) + 玩家主动操作
      // (转向 + 油门/刹车) ⇒ 给一记与驾驶方向同号的最小横摆率（0.35·maxYawRate≈18°/s），
      // 让车头转离墙 ⇒ f.x 指向路内 ⇒ 前移使 |x| 掉到 halfW−ε ⇒ sideTouch=false
      // ⇒ wallScrubN 清零 ⇒ 彻底脱困。仅低速窗口生效，不改 scrub 公式/几何/摩擦圆。
      if (
        wallScrub > 0 &&
        steerIn !== 0 &&
        (throttle > 0 || brakeIn > 0) &&
        av < WALL_SCRUB_RELEASE_MS
      ) {
        yawRate = steerIn * FREE.maxYawRate * 0.35 * (vAvg >= 0 ? 1 : -1);
      }
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

    /* ---- R102 城内 2D 占位收紧（车长 bbox vs 台阶/基座/柱础，只收紧不放宽）----
     * resolveBounds 是「车心点 vs 1D h(z)」，车长 5.495 / 车宽 2.006 的 OBB 从未参与判断：
     * 车斜插 θ=30° 时车角 dx=2.243 m，块角 14.9 m 基座内缘处车角嵌基座 1.24 m、柱位
     * 11.12 m 处嵌柱 1.12 m，车尾 bbox（zc±2.75）合法待在钳位线外侧与 6.2 m 深台阶相交
     * ⇒「存在的建筑又穿模 / 车尾卡台阶缝隙」。clampToFootprints 把 OBB 4 角点的 x 伸展
     * dx(θ) = 半长|sinθ| + 半宽|cosθ| 与 z 覆盖重叠的城内占位盒取最紧界 |x| ≤ xInner − dx。
     * 只在城内域（z ∈ [plazaZ, gateBackZ]）激活 —— 桥段 / 城门带 / 主殿广场沿用 1D 钳位，
     * z=−250 桥段测试全程零触发，既有 r97/r98/r99/r100 护栏不破（resolveBounds 函数体未改）。 */
    if (nz <= BOUNDS.gateBackZ && nz >= BOUNDS.plazaZ && !driftActive) {
      // R103 阶段二：块心 1D 已放宽到前脸 14.497 / 殿身 13.997，周期物（柱 11.12 / 连墙墩 /
      // 角塔墩 11.35）全部下沉到本 2D 层。整层仍 **!driftActive 门控**（含位置钳）——实测若
      // 漂移态也做位置钳，漂移车滑到前脸（现可达 14.497）会被钉在墙面、heading 不收敛 ⇒
      // β 永不塌缩、rearGrip 不复原（free_drift 恢复段 β 卡 0.27 / grip 不回 1）。漂移是瞬态，
      // 出漂移后 2D 立即恢复；漂移中短暂穿越柱/墩窗口极短且玩家主动（R102 同款取舍）。
      const fp = clampToFootprints(s.x, s.z, s.heading);
      if (fp.hit) {
        s.x = fp.x; // 只收紧 x：z 不动（占位盒 x 对称，z 方向无 2D 修正量）
        {
          const nxSide = fp.nx;
          const fSide = forwardOf(s.heading);
          const fnSide = fSide.x * nxSide;
          // 法向入射强度复用 1D side 同口径 |v|·fn；若 1D 已撞出更大 impactN 则保留较大者
          const fpImpact = fnSide > 0 ? Math.abs(s.speed) * fnSide : 0;
          if (fpImpact > (r.impactN ?? 0)) r.impactN = fpImpact;
          // 仅在 1D 没给 targetHeading 时才补：避免覆盖 resolveBounds 已定的滑行方向
          if (r.targetHeading === undefined) {
            r.targetHeading = slideHeading(fSide.x, fSide.z, nxSide, 0);
          }
          if (r.kind === 'none') r.kind = 'side'; // 沿用 wall 事件 / 刮擦 / 朝向收敛链路
        }
      }
    }
    // 速度按 IMPACT_TAU 一阶收敛到「法向吸收 + 切向保留」的目标值（1D / 2D 撞击共用）。
    // 一阶而非一帧硬切的理由见 resolveBounds 注释：fn 大时单帧减速度可达数十 g。
    const impacting =
      r.impactN !== undefined && r.impactN > 0 && r.targetHeading !== undefined;
    s.speed = impacting ? damp(s.speed, r.speed, 1 / IMPACT_TAU, dt) : r.speed;
    // R100 hall 瞬态（复用 R99 wallImpact 包络，不照搬 side 的速度分解）：
    //   speed 仍取 r.speed=0 ⇒ 正撞彻底停、不二次撞击、z 弹开 0.8m 不变；
    //   s.accel 保留归零（pitch 走 FREE_BODY_DAMPING.pitch 一阶，不产生俯仰硬切）；
    //   impactN 注入包络 ⇒ 下方衰减段给 yawRate/roll 一记短暂「被顶一下」冲击；
    //   beta/yawDyn 按 IMPACT_TAU 逐帧收敛 ⇒ 消除 speed<1.5 退出漂移层时的单帧横跳。
    if (r.kind === 'hall') {
      s.accel = 0;
      this.wallImpact = Math.max(this.wallImpact, r.impactN ?? 0);
      s.beta = damp(s.beta, 0, 1 / IMPACT_TAU, dt);
      this.yawDyn = damp(this.yawDyn, 0, 1 / IMPACT_TAU, dt);
    }

    // ---- R99 撞墙瞬态：几何已瞬时钳位，运动学在此按 IMPACT_TAU 一阶展开 ----
    // side/end 撞击带 impactN + targetHeading；hall 只在上面注入 impactN 包络、
    // 不进此块（无 targetHeading ⇒ heading 原样，速度不渐变）。
    if (impacting) {
      this.wallImpact = Math.max(this.wallImpact, r.impactN!); // 峰值：连续擦碰刷新
      // R101：撞墙强度供刮擦维持（hall 不进此块 ⇒ 正撞彻底停、无刮擦，契约不变）。
      // 下一帧起只要仍贴墙，step() 就按此强度持续刮擦，堵死平行墙零摩擦蹭滑。
      this.wallScrubN = Math.max(this.wallScrubN, r.impactN!);
      // 朝向一阶收敛（角度差走最短弧，避免 ±π wrap 跳变），不再一帧硬掰到墙面切向。
      s.heading = impactHeadingStep(s.heading, r.targetHeading!, IMPACT_TAU, dt);
      // 同步漂移态：擦碰把侧滑角 / 动态横摆往回收 —— 消除「旧 beta 把速度方向偏走」
      // 与「速度骤降退出漂移层把状态硬清零」两处次生硬切。
      s.beta = damp(s.beta, 0, 1 / IMPACT_TAU, dt);
      this.yawDyn = damp(this.yawDyn, 0, 1 / IMPACT_TAU, dt);
    }
    // 包络指数衰减：撞击结束后仍有短暂「被顶一下、带惯性回正」余韵。
    this.wallImpact = damp(this.wallImpact, 0, 1 / IMPACT_TAU, dt);
    if (this.wallImpact < 1e-4) this.wallImpact = 0;
    if (this.wallImpact > 0) {
      s.yawRate += IMPACT_YAW_GAIN * this.wallImpact * (dt / IMPACT_TAU);
      s.roll += IMPACT_ROLL_GAIN * this.wallImpact * (dt / IMPACT_TAU);
      // R100 Phase3：注入发生在下游 clamp(rollTarget) 之前，灵魂上限只约束 target
      // 不约束 state 注入量 ⇒ 高速撞击 roll 峰随 |v| 线性涨（55m/s 达 0.109rad，超 3.5° 约 79%）。
      // 紧跟注入做硬 clamp：保留「被顶一下」体感，只是幅度收进真车合理包络。
      s.roll = clamp(s.roll, -FREE.rollMaxRad, FREE.rollMaxRad);
      s.yawRate = clamp(s.yawRate, -FREE.maxYawRate, FREE.maxYawRate);
    }

    // ---- 视觉姿态（侧倾 × 俯仰，都做平滑，避免阶跃）----
    const latAccel = yawRate * vAvg;
    const rollTarget = clamp(
      (-latAccel * FREE.rollMaxRad) / FREE.rollRefMs2,
      -FREE.rollMaxRad,
      FREE.rollMaxRad
    );
    s.roll = damp(s.roll, rollTarget, FREE_BODY_DAMPING.roll, dt);
    const pitchTarget = clamp(s.accel * FREE.pitchPerAccel, -FREE.pitchMaxRad, FREE.pitchMaxRad);
    s.pitch = damp(s.pitch, pitchTarget, FREE_BODY_DAMPING.pitch, dt);
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
