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
// R126：撞墙「被顶晃动」欠阻尼二阶通道（独立于常态一阶阻尼，只叠加视觉姿态）。
import { FREE_BODY_DAMPING, FREE_BODY_IMPACT_OSC } from '../config/freeBodyFeel';
import { dragForce, motorForce, rollForce } from '../physics/Vehicle';
import { clamp, damp } from '../util/math';
// R102：城内地面实体（角塔基座 / 柱础 / 飞扶壁墩 / 殿台基 / 前脸）2D 占位 + 车 OBB 收紧。
//   纯数值模块（无 three/DOM），只提供 clampToFootprints(x,z,heading)；1D 钳位
//   resolveBounds / corridorCenterHalfWidth / corridorHalfWidth 函数体逐位不动。
import { clampToFootprints, GATE_FLY_Z_MAX } from './cityFootprints';
// B6 a11y（R30-D2）：与 Sliders.onKey 共用「交互目标放行」判据（同一定义，
// 避免两处选择器列表漂移）。dom.ts 是无依赖叶子工具，不构成循环依赖。
import { isInteractiveTarget } from '../ui/dom';

/** 计算质量（与 Vehicle.ts 同源：整备 3160 + 载荷 140） */
const MASS = VEHICLE.totalMassKg;

/** 车半长（physics.ts 真源，勿写死 2.7475）——R119：门带 2D 激活域上界北扩用的车头前伸半长 */
const CAR_HALF_L = VEHICLE.lengthM / 2;

/** 自由探索标定表（集中一处，便于复算） */
export const FREE = {
  /** 最大偏航角速度 rad/s（打满方向盘、速度足够时的稳态值） */
  maxYawRate: 0.9,
  /** 转向效能参考速度 m/s：|v| 达到该值后转向角速度不再随速度增长（转弯半径恒定） */
  refSpeedMs: 5.5,
  /** 低速最大前轮转角 rad（≈35.5°，≤18 km/h） */
  steerMaxLow: 0.62,
  /**
   * 高速最大前轮转角 rad（≈27.5°，≥60 km/h）。
   * R131：0.12 → **0.48** —— 根治正常路径横向抓地「推头」。
   *   旧 0.12 使 latAccel=yawRate·v 包络**非单调**：20km/h≈0.31g → 72km/h **0.22g**（凹坑，
   *   高速反而比中速弱）→ 200km/h 0.61g（靠舵角硬给，无抓地上限）。0.48 让舵角包络
   *   在 60km/h 处与抓地包络（gripLatFactor·tyreMu·g）**相切** ⇒ 包络单调升到 0.74g 后
   *   平坦（真车恒定附着），中速不再推头、高速有界（配合 yawRateFor 抓地钳）。
   */
  steerMaxHigh: 0.48,
  /**
   * R131 正常路径横向抓地上限系数（× tyreMu·g = 可用侧向附着 m/s²）。
   *   · 0.80 = 稳定控制/悬架极限对轮胎附着 μ·g 的利用率（重型行政 SUV 干地 ESC 限幅量级，
   *     μ=0.92 ⇒ ≈0.74g），低于 1.0 留稳定裕度 ⇒ 高速不甩尾（只推头）。
   *   · 只作用于**正常运动学路径**的 yawRateFor 钳位；漂移模型（摩擦圆 decelAvail）独立，
   *     本常数不碰其灵魂值（tyreMu 未动）。
   */
  gripLatFactor: 0.80,
  /** 转角收窄区间（km/h）：18 → 60 线性 */
  steerLowKmh: 18,
  steerHighKmh: 60,
  /** 转向输入一阶平滑时间常数 s（低速 ≤ steerLowKmh = 轻快；高速 ≥ steerHighKmh = 沉稳；
   *  中间随 steerLimitFor 同斜率线性插值，见 steerTauFor）——R129 随速转向权重 */
  steerTauLow: 0.07,
  steerTauHigh: 0.14,
  /** R130 caster 自回正：回正方向 τ 相对建角 τ 的比率（<1 = 回正更快）。
   *  真实 caster 前束/主销内倾产生自回正力矩，松舵/向心回正快于手动打舵；
   *  回正加速随速继承（高速回正仍比低速慢，保持沉稳）。0.7 ⇒ 30km/h 回正 90% ≈0.15s vs 建角 ≈0.21s。 */
  steerReturnRatio: 0.7,
  /** 横摆响应一阶滞后 s（轮胎侧偏力载荷渐进：打舵后横摆率按此 τ 建起，非瞬时 kinematic）
   *  ——R129 ② 转向驱动横摆载荷渐进，撞墙横摆冲量（R104）与贴墙脱困（0.35 直写）不经此通道 */
  yawResponseTau: 0.07,
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
// R126：旧「法向入射冲量 → 视觉侧倾瞬态增益」（IMPACT_ROLL_GAIN=0.004，每帧速率项、
//   单调回正无过冲）已由 FREE_BODY_IMPACT_OSC 欠阻尼晃动通道取代 —— 撞墙帧注入角速度、
//   二阶积分过冲回摆，读作「被顶晃一下」而非单调钉回。

/* ── R104 · 撞墙「顿挫感」通道（impact feel）独立标定 ─────────────────────
 * 不放进 FREE 灵魂表，也不改任何既有常量（IMPACT_TAU / IMPACT_YAW_GAIN /
 * IMPACT_ROLL_GAIN / wallDecay / WALL_SCRUB_* / 摩擦圆 / 灵魂 12 全部零改）。
 * R99~R101 把撞墙从单帧硬切改成了一阶收敛，但速度与 heading **共用 τ=0.12 平行收敛**：
 * 速度收敛目标 r.speed 依赖随收敛递减的 fn ⇒ 目标漂移 ⇒ 正撞 20m/s 只掉 ~43% 且摊在
 * 0.2s 里，撞墙瞬间看不到速度骤降；yaw 注入是「每帧速率项」且下一帧被 yawRateFor 覆盖
 * ⇒「被顶一下」不可见。本通道只做两件事（探测报告 §4 推荐组合 ③+④）：
 *   ③ 放慢 heading 收敛（独立 τ）⇒ 车头多指向墙一会儿 ⇒ fn 停留更大 ⇒ 撞后几帧持续
 *      刮擦减速（顿挫），而速度仍走 IMPACT_TAU 一阶（R99 防硬切成果保留）。
 *   ④ 把 yaw 注入从「每帧速率项」改为「一次性短冲量」⇒ 撞墙帧记 wallKick，在
 *      WALL_IMPACT_KICK_MS 窗口内分摊加到 yawRate，冲量放完即止（不再被每帧覆盖）。
 */
/**
 * R104 撞墙朝向收敛时间常数 s（**独立于 IMPACT_TAU**，只用于 step() 的 impactHeadingStep）。
 * heading 慢于速度收敛 ⇒ 车头多指向墙 ⇒ fn=f·n 停留更大 ⇒ 撞后几帧持续刮擦减速（顿挫）。
 * 速度仍用 IMPACT_TAU=0.12 一阶收敛（防单帧硬切）。撞墙域边界常量，不入灵魂表。
 */
export const WALL_IMPACT_HEADING_TAU = 0.22;
/**
 * R104 撞墙横摆冲量窗口 s：撞墙帧一次性记 wallKick 峰值，在此窗口内按
 * wallKick·(dt/WALL_IMPACT_KICK_MS) 每帧分摊加到 yawRate，窗口走完冲量即放完（不再累加）。
 */
export const WALL_IMPACT_KICK_MS = 0.15;
/** R104 撞墙横摆冲量峰值上限 rad/s（真源 / 产品标定：min(wallImpact, 此值) 记为 wallKick） */
export const WALL_IMPACT_KICK_MAX = 1.2;

/* ── R106 · 撞墙「顿挫」硬化（impact crash feel）──────────────────────────
 * 背景（用户四次反馈「撞击硬切（变成滑动）依旧需要改进」）：R99~R105 把撞墙做成
 * 「法向吸收 + IMPACT_TAU 一阶收敛 + 独立 heading τ + yaw/roll 包络」，结果是撞墙
 * **读作「滑」而不是「撞」**——接触首帧速度只掉 ~6%（仅 IMPACT_TAU 一阶那一档），
 * 没有真实碰撞的「顿挫」。本通道补两件 R99 以来一直缺的事，且**不退回 R99 之前的
 * 单帧速度归零瞬移**：
 *   ① 接触首帧的**有界法向速度骤降**：撞墙帧一次性再扣掉「入射法向分量」的固定比例
 *      （WALL_IMPACT_SPEED_KICK_RATIO），使正撞首帧速度可见地掉一截（≈44%，从 ~6% 提到
 *      可感的顿挫），随后仍走 IMPACT_TAU 一阶收敛到「法向吸收+切向保留」的目标。
 *      红线保证：扣减幅度**有界**（只动法向入射分量的一个比例、且 ≤ 该分量本身），
 *      单帧**绝不归零**（切向分量完整保留 + 法向只扣一个比例），也**不瞬移位置**
 *      （resolveBounds 几何钳位体零改）。
 *   ② 俯仰「点头」冲量：撞墙帧一次性记 WALL_IMPACT_PITCH_KICK 峰值（有符号、朝墙面
 *      点头），在 WALL_IMPACT_PITCH_KICK_MS 窗口内分摊注入 s.pitch，与 R104 yaw 冲量同
 *      「一次性短冲量」机制，补齐「车身被顶」的俯仰维度（横摆/侧倾走既有 R104/R99 通道）。
 *   ③ 斜撞刮擦（fn 小）通过 speedKick 的 fn 加权 + 既有 wall scrub 自然获得「刮擦减速」感：
 *      fn 越小扣得越少、scrub 越弱 ⇒ 刮擦而非硬撞；fn 越大扣得越多 ⇒ 顿挫而非纯滑。
 * 锁定边界：IMPACT_TAU / wallDecay / 灵魂 12 / 摩擦圆 / FREE_BODY_DAMPING / scrub 三常量 /
 * hall「一次停」契约 / 几何 / resolveBounds 函数体 全部**零改**。 */
/**
 * R106 撞墙首帧法向速度骤降比例（0..1）：撞墙帧一次性再扣掉「入射法向速度分量
 * |v|·fn」的此比例（随后仍走 IMPACT_TAU 一阶收敛）。
 * R108：0.4 → **0.7** —— 用户多次反馈「撞击硬切（变成滑动）依旧需改进」⇒ 0.4 仍读作滑。
 *   提到 0.7 ⇒ 正撞首帧速度掉到 ~30%（一次性硬顿挫，撞墙读作一次真实硬碰撞/硬切感，
 *   而非融化成滑行）。仍有界、**不瞬移**：只动法向入射分量的一个比例、切向分量完整保留
 *   ⇒ 单帧绝不归零（正撞仍留 ~30% 速度、车仍在滑行非原地瞬移）、位置由 resolveBounds
 *   几何钳位处理（零改）⇒ R99 防瞬移底线（不归零/不瞬移）保留，只是首帧更狠。
 *   代价：首帧掉速 >50%（R99「不腰斩」原阈值）—— 这是**用户显式要求更硬撞击**的设计变更，
 *   相关撞击测试已按新手感重钉（见 r106_impact_crash / r99 / r101 / r104 重钉）。
 * 撞墙域边界常量，不入灵魂表。
 */
export const WALL_IMPACT_SPEED_KICK_RATIO = 0.7;
// R126：旧「俯仰点头一次性位置冲量」（WALL_IMPACT_PITCH_KICK_MS=0.12 /
//   WALL_IMPACT_PITCH_KICK_MAX=0.03，注入 s.pitch 后一阶单调回正）已由
//   FREE_BODY_IMPACT_OSC 欠阻尼晃动通道取代 —— 撞墙帧注入 pitch 角速度（负=车头朝墙点头）、
//   二阶积分过冲回摆，读作「车身被顶晃一下」而非单调钉回。

/* ── R105 · 漂移态 2D 防穿模（位置钳 + 朝向贴墙收敛，不注入撞击/速度/刮擦）──────
 * 不放进 FREE 灵魂表，也不改任何既有常量（IMPACT_TAU / WALL_IMPACT_HEADING_TAU /
 * WALL_SCRUB_* / WALL_IMPACT_* / 摩擦圆 / 灵魂 12 全部零改）。
 * 背景：漂移态 2D 占位曾被 `!driftActive` 门控整体关闭 ⇒ 车漂移时能穿进建筑底部
 *   3.5~5.6 m（buttressBase 内缘 11.35 / cornerBase 14.9 / frontWall 15.5 全被穿），
 *   是全量几何扫确认的最大穿模源。但 R103/R104 关掉它的原因不是「位置钳」本身，
 *   而是「位置钳 + 撞击/速度/heading 注入」：漂移车滑到前脸被钉在墙面 + fn 持续触发
 *   wall-impact ⇒ β 被外力阻尼、永不塌缩、rearGrip 不复原（free_drift β 卡 0.27）。
 * 改法：漂移态 2D 只做「位置钳（s.x=fp.x）+ heading 朝墙面切向一阶收敛」，**不注入
 *   impactN / 不 damp speed / 不加 scrub / 不触发 wallImpact·wallKick**（这些是 β 半衰
 *   回归的元凶）。heading 收敛用独立的更缓 τ，让车头不再一直戳向墙 ⇒ 轮胎自回正 +
 *   rearGrip 恢复能自然把 β 塌缩，而非靠撞墙外力。 */
/**
 * R105 漂移态 2D 接触的朝向收敛时间常数 s（**独立于 WALL_IMPACT_HEADING_TAU**，更缓）。
 * 漂移中贴建筑占位时只把车头朝墙面切向徐徐掰正（不注撞击/速度/刮擦），τ 取大一点
 * 让收敛足够温和 —— 既防车头持续戳墙，又不干扰漂移模型自身的 β 塌缩节奏。
 * 撞墙域边界常量，不入灵魂表。
 */
export const WALL_IMPACT_DRIFT_HEADING_TAU = 0.3;
/**
 * R105 漂移态 2D 接触的 β / 动态横摆回收速率 1/s（比 heading 收敛更快，独立标定）。
 * 补上「2D 提前拦下 ⇒ 车到不了前脸 1D 墙 ⇒ 失去撞墙塌 β」的缺口：贴墙期间持续把 β /
 * yawDyn 往回收，保证 free_drift 恢复段 β 在阈值内塌缩（不卡死）。仅作用在 2D 接触帧，
 * 不注入 impactN / 不 damp speed / 不加 scrub / 不碰 rearGrip（自主恢复）。
 * 撞墙域边界常量，不入灵魂表。
 */
export const WALL_IMPACT_DRIFT_BETA_RATE = 9.0;

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
 * R109 低速脱困：scrub 随车速线性渐入的基准速度 m/s。
 * 死锁根因（用户录屏 15s HUD=0 + 探针 836/1364 采样点卡死）：scrub 是**全向标量**、
 * `wallScrubN` 以 Math.max 记峰永不衰减 ⇒ 贴墙后 scrub 恒 = 封顶 12 m/s² > 油门净加速
 * 6.08 ⇒ 每帧 `vNext -= dir*scrub*dt` 把速度钳回 0（v 恒 0.052）、位移趋近 0 ⇒
 * 「卡住不能动」；R102 脱困只放开转向权限（yawRate），不改速度 ⇒ 车原地转圈。
 * 物理本质：墙的静摩擦只阻止「压向墙」，不阻止「沿墙/离开墙」⇒ 低速时全向 scrub
 * 是**过度惩罚**。修法：scrub × clamp(|v|/FADE_SPEED, 0, 1) 随速度线性渐入——
 * 高速(≥FADE_SPEED)完整刮停（R101 撞墙刮停契约保留，蹭滑仍被刮停）；低速(→0)渐出
 * ⇒ 油门净加速 6.08 能推动 ⇒ 平衡点 ∝ FADE_SPEED（FADE=4 时 ≈2.03 m/s 口径、实测
 * 1.509；持续给油可沿墙走、能转向脱困）。不改 scrubN/几何/摩擦圆，只加一个速度系数。
 *
 * R150 柔化低速蹭墙（用户拍板，R142 §0-B）：渐入基准 4.0→10.0，贴墙 W 稳态
 * 1.509→≈3.776 m/s（探针 10s 末速 3.776，柔化目标 3-4 中位）；高速 v>10 clamp=1 不变
 * （R101 蹭滑/R106 斜擦契约保留，0.2s 后 8.344≈8.5）。低速不再龟速蹭墙——稳态落
 * 3-4.5 可走带，原「≤3.0 低速带」判据随契约演进作废。
 *
 * R151 继续柔化低速蹭墙（用户指令，R150 之后）：渐入基准 10.0→11.0，贴墙 W 稳态
 * ≈3.776→≈4.154 m/s（探针 v_ss=0.3776×FADE）。物理边界：FADE≈12.1（稳态≈4.5）——
 * 超过则贴墙低速常规转向达 R102 特殊门控 0.315 量级，结构失效；R101① 刮停契约
 * （8s/140m）不构成约束（FADE=20 仍 6.01s/34.6m）。
 */
export const WALL_SCRUB_FADE_SPEED = 11.0;
/**
 * R109 撞墙刮擦强度下限 m/s²（scrubN = max(impactN, FLOOR)）。
 * 极斜擦（>60°）时 impactN=|v|·fn 随 fn→0 塌缩（84° 掠擦 impactN≈2）⇒ scrubN 小 ⇒
 * 刮擦弱 ⇒ 车 1s 内仍 14.4 m/s、沿墙滑 32m（用户「硬切变滑动」主体）。给一个下限保证
 * **任何撞墙**至少产生可感的持续刮擦减速。hall 正撞不进 scrub 链路（无 targetHeading），
 * 不受影响。
 */
export const WALL_SCRUB_FLOOR = 8.0;
/**
 * R109 撞墙首帧「总速度粘滞」比例：与 R108 的法向 kick（∝fn）正交的另一记扣减。
 * R108 的 kick 只扣 0.7×impactN=|v|·fn 的法向分量 ⇒ 极斜擦 fn 小几乎不扣（84° 掠擦
 * 首帧只掉 9.7%）⇒ 读作「顺墙滑」。本常数对**总速度**乘 (1−RATIO)，与入射角无关，
 * 保证任何撞墙首帧都有可感知的顿挫（正撞 80% 掉速 + 掠擦 40% 掉速）。仍在
 * !wallSpeedKickFired 闩内一次性扣减，不归零（保留 ~60%），位置仍由几何钳位（不瞬移）。
 */
export const WALL_IMPACT_STUN_RATIO = 0.35;
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
/**
 * R121 离墙滞后带内「几何已离墙 + 低速」时 scrub 记峰渐出速率 1/s。
 * RELEASE_EPS(1.2) 滞后带在稳定段过宽（车 x≈13.1 距墙 0.897m 仍被判贴墙）⇒ 骑墩斜切
 * 20/24 组合 v 锁存 0.37~2.08 极限环。本常数只在 latch 未释放但几何已离墙（sideTouchRaw=
 * false）且低速（av<WALL_SCRUB_RELEASE_MS）时把 wallScrubN 渐出（damp 一阶），scrub 解除、
 * 油门可推动脱离 latch 带。非 WALL_SCRUB_* 常量值改动（新常量，值 4.0 与 R109 同级速率）。
 */
export const WALL_SCRUB_LATCH_DECAY_RATE = 4.0;
/**
 * R110 城内 2D 接触每帧最大横向收敛步长 m。
 * 旧版一帧写死 s.x=fp.x（可单帧钳位最大 6.34 m ⇒ 玩家读作「空气墙/瞬移/穿模弹开」）。
 * 本常量把位置修正摊到多帧：120Hz 下 0.30 m/帧 = 36 m/s 横向收敛率，单帧不瞬移、
 * 高速撞击 2~3 帧内贴合、不卡柱侧（收敛目标= clampToFootprints 目标 x，只收紧不放宽）。
 * 命中判定（fp.hit/kind）仍每帧成立 ⇒ 下方 impact/heading/scrub 链路照常触发。
 */
export const WALL_2D_MAX_LATERAL_STEP = 0.30;
/**
 * R110 掠擦「接触期连续切向摩擦」系数（× wallScrubN ⇒ 减速度 m/s²）。
 * 斜擦/掠擦时法向分量 fn→0 ⇒ impactN=|v|·fn≈0 ⇒ IMPACT_TAU 一阶几乎不扣速（r.speed≈v，
 * 切向 100% 保留）；WALL_SCRUB_FLOOR 对轻擦给的刮擦也偏弱 ⇒ 84° 掠擦 1s 仍滑 ~5 m/s
 * （用户连续诉求「撞击时车辆自动滑开建筑材料」）。
 * 本常量给贴墙接触期补一档**减速度 = FRICTION × wallScrubN**：模拟墙面对切向的真实摩擦。
 *   · 量纲/模型与既有 wallScrub 同口径（都 ∝ latched wallScrubN，非 ∝ 当前速度）——这是关键：
 *     若用固定速率 damp（∝ 当前速度）会让轻擦（接触期车速高）比硬擦扣得**更多**，违反 r106⑤
 *     「越正撞击越狠」单调性；用 ∝ wallScrubN 则轻擦/硬擦（都 floor 到 8）得同额摩擦，硬擦仍
 *     靠更大的 speedKick（∝ fn）净减速更多 ⇒ 单调性保留。
 *   · 只在接触期作用（wallScrubN>0 即仍贴墙；离墙锁存清零立即停止）；
 *   · 恒定减速度钳到不反向 ⇒ 绝不归零、不瞬停（r101③「非瞬停、渐进减速」契约保留）；
 *   · 门控 !driftActive 与 wallScrub 同口径：漂移态轮胎摩擦圆已主导减速，不再叠墙体惩罚。
 * 值 0.25 ⇒ 轻擦（wallScrubN=8 下限）得 2.0 m/s²：84° 掠擦 1s 内把切向残速压到 ~3 m/s 带
 * （r101③ 实测 5.09 → 目标 2.5~3.5），r101① 200km/h 斜擦只加快刮停（更快 <0.1、滑更短，
 * 上界 140m 仍满足）、r102 脱困平衡点仍在油门可挣脱带宽（净加速 6.08 − 摩擦 2.0 仍为正）。
 */
export const WALL_TANGENT_FRICTION = 0.25;
/**
 * R144 倒车脱困：贴墙主动倒车（S + 已倒车）时墙 scrub 的比例系数（<1 = 渐出）。
 * 物理语义（R109 头注已明示）：墙静摩擦只阻止「压向墙」，不阻止「背离墙/退出」——
 * 玩家主动倒车即「背离墙退出」意图，若 scrub 仍按 R101 全向钉速，御桥段纯 1D 边界
 * 实测 10s 位移 0.01m（车原地自转不出墙，R144 探针）。本系数让倒车时 scrub 降到
 * R144_REVERSE_SCRUB_FADE 比例（倒车净加速 2.08 可推动，平衡点 ≈2.2 m/s 背墙退出），
 * 前进（W）不受影响（R142② 蹭墙平衡保留）。值域 (0,1]；撞墙域边界常量，不入灵魂表。
 */
export const R144_REVERSE_SCRUB_FADE = 0.3;

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

/** R120：门墩塔基实体北界（= GATE.z + (GATE.depth+1.2)/2 = −350.9，cityFootprints GATE_PIER_Z_MAX
 * 同源）。由 BOUNDS 派生（BOUNDS 由 GATE 派生：gateFrontZ = GATE.z + depth/2）⇒ 免 import
 * cityFootprints 的 const 成 TDZ 环（cityFootprints 已 import FreeDrive 的 CITY_BLOCK_Z）。
 * 用途：2D 激活域上界须覆盖到「车头前缘触塔基北界」——车心 nz ≤ GATE_PIER_Z_MAX + CAR_HALF_L。
 *   R119 用 gateFrontZ + CAR_HALF_L（−348.7525）比塔基北界 + CAR_HALF_L（−348.1525）窄 0.6m：
 *   车心 nz ∈ (−348.7525, −348.1525] 时车头已入塔基北 0.6m 条带但 2D 门控关闭 ⇒ 车头切塔基
 *   0.3~0.6m 无碰撞反馈（probe-D 缺口 1；实测 ⑧ 场景末态车心 −348.4784 处 SAT 残余 0.1987m）。 */
const GATE_PIER_Z_MAX =
  (BOUNDS.gateBackZ + BOUNDS.gateFrontZ) / 2 + (BOUNDS.gateFrontZ - BOUNDS.gateBackZ + 1.2) / 2;

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

/**
 * R127 撞墙/撞主殿事件（去抖后派发）：携带撞击强度供视觉反馈缩放。
 * strength ∈ [0,1]，由 impactN（m/s 法向入射强度）经 FREE_IMPACT_STRENGTH_N_REF 归一化，
 * 与 crashWorld CrashImpact.strength（0~1）同一口径 ⇒ Game 侧 `gain × strength` 与撞车一致。
 */
export interface FreeDriveImpactEvent {
  kind: 'wall' | 'hall';
  /** 撞击强度 0~1（0 = 掠擦无感，1 = 正面满幅） */
  strength: number;
}

/**
 * R127 撞击强度归一化基准 [m/s]：法向入射强度达到此值即满幅（strength=1）。
 * 真源标定：R99/R106 撞墙被顶可感标定 20m/s ≈ 0.8 幅、25m/s（90km/h）满幅封顶；
 * 低速蹭墙（<8m/s）≈ 0.3 幅以下近乎无感，掠擦（fn→0 ⇒ impactN→0）归零 ⇒
 * 「撞得越狠抖越大、擦过去不抖」口径，与 R109 刮擦强度衰减一致。
 */
export const FREE_IMPACT_STRENGTH_N_REF = 25;

/**
 * R127/R128 撞击强度归一化（单一真源）：法向/纵向入射强度 [m/s] → 强度 [0,1]。
 * clamp 到 [0, REF] 再除 REF ⇒ 0→0、REF→1、超 REF 封顶 1、负值归 0。
 * 供 FreeDrive 去抖派发（wall/hall 事件）与挑战撞主殿（crash 演出）共用，
 * 保证「撞得越狠反馈越大」在所有撞击通道同一口径。
 */
export function freeImpactStrength(n: number): number {
  return clamp(n, 0, FREE_IMPACT_STRENGTH_N_REF) / FREE_IMPACT_STRENGTH_N_REF;
}

export type FreeDriveEvent =
  /** 撞墙/撞主殿（带撞击强度，kind 判别 wall/hall） */
  | FreeDriveImpactEvent
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
 * R131：高速端 0.12 → 0.48（与 yawRateFor 的抓地钳联动——高速「打死」不再靠收窄舵角
 * 防翻车，而是由横向抓地上限（gripLatFactor·tyreMu·g）在 yawRateFor 处钳横摆率：
 * 前轮饱和 → 推头而非甩尾，更接近真实转向物理）。
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
 * R129/R130 纯函数：速度相关的转向输入平滑时间常数（随速转向权重）。
 * ≤ steerLowKmh = steerTauLow（轻快）；≥ steerHighKmh = steerTauHigh（沉稳）；中间与
 * steerLimitFor 同斜率线性插值。⚠ 只改转向角轨迹的建角/回正速率（s.steer 一阶阻尼），
 * 不改转向目标（steerTarget）、稳态横摆（yawRateFor）与横摆上限（maxYawRate）——单调、无过冲。
 * R130：`returning=true`（松舵/向心回正，|target|<|steer|）时叠加 caster 自回正比率
 * `FREE.steerReturnRatio`（<1 ⇒ 回正更快）；默认为建角路径（1 参调用逐位不变）。
 */
export function steerTauFor(speedKmh: number, returning = false): number {
  const t = clamp(
    (speedKmh - FREE.steerLowKmh) / (FREE.steerHighKmh - FREE.steerLowKmh),
    0,
    1
  );
  const base = FREE.steerTauLow + (FREE.steerTauHigh - FREE.steerTauLow) * t;
  return returning ? base * FREE.steerReturnRatio : base;
}

/**
 * 纯函数：偏航角速度。低速转向减弱（|v|/refSpeed 线性），倒车时方向反向。
 * R131：横向抓地极限钳位 —— 正常运动学路径此前**无侧向附着上限**（latAccel=yawRate·v
 * 可随舵角无限增大，包络非单调：72km/h 仅 0.22g 推头、200km/h 靠舵角硬给 0.61g）。
 * 加抓地钳 `|yawRate| ≤ gripLat / max(av, refSpeedMs)`（gripLat = gripLatFactor·tyreMu·g）：
 *   · av < refSpeedMs：cap = gripLat/refSpeedMs（常量 ≥ maxYawRate ⇒ 不钳，低速全舵敏捷不变）；
 *   · av ≥ refSpeedMs：cap = gripLat/av ⇒ latAccel ≡ gripLat（附着上限，平坦）——超过即前轮
 *     侧偏饱和 ⇒ 更打舵不再增大横摆率（车头比速度方向转得慢、向外推 = 推头/understeer），
 *     单调、有界、无甩尾（gripLatFactor=0.80 < 1 留稳定裕度）。漂移模型（yawDyn）不经此通道。
 */
export function yawRateFor(steer: number, speedMs: number): number {
  const av = Math.abs(speedMs);
  const factor = clamp(av / FREE.refSpeedMs, 0, 1);
  const dir = speedMs > 0 ? 1 : speedMs < 0 ? -1 : 0;
  const kin = steer * FREE.maxYawRate * factor * dir;
  const gripLat = FREE.tyreMu * 9.81 * FREE.gripLatFactor;
  const cap = gripLat / Math.max(av, FREE.refSpeedMs);
  return clamp(kin, -cap, cap);
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
  /** R129 ② 转向驱动横摆响应一阶滞后状态 rad/s：打舵后按 yawResponseTau 建起（轮胎载荷
   *  渐进），非瞬时 kinematic。撞墙横摆冲量（R104，积分后注入 s.yawRate）与贴墙脱困
   *  （0.35 直写）不经此通道；漂移态用 yawDyn，此通道在漂移态同步跟随（无缝退出）。 */
  private steerYawRate = 0;
  /** R99 撞墙瞬态包络 [m/s]：撞击时置为法向入射峰值，随后指数衰减，驱动横摆/侧倾余韵 */
  private wallImpact = 0;
  /**
   * R101 撞墙刮擦维持的撞击强度 [m/s]：撞墙时置为 impactN 峰值，**只要仍贴墙就维持**
   * （不随 heading 转到切向而衰减），离墙即清零。用持久量而非现算 |v|·fn：撞后 heading
   * 收敛到平行墙后 fn→0，若现算会让刮擦退化回零摩擦蹭滑。供给 step() 算 scrub 减速度。
   */
  private wallScrubN = 0;
  /**
   * R104 撞墙横摆冲量峰值 [rad/s]：撞墙帧一次性记 min(wallImpact, WALL_IMPACT_KICK_MAX)，
   * 在 WALL_IMPACT_KICK_MS 窗口内分摊加到 yawRate。区别于旧的「每帧速率项」（下一帧被
   * yawRateFor 整体覆盖 ⇒ 一帧脉冲不可见），冲量在窗口内稳定注入 ⇒ 可见的「被顶一下」。
   */
  private wallKick = 0;
  /** R104 撞墙横摆冲量剩余窗口 [s]：>0 时每帧分摊 wallKick·(dt/WALL_IMPACT_KICK_MS)，放完即止 */
  private wallKickRemain = 0;
  /**
   * R104 本次贴墙接触是否已放过冲量：贴墙期间 impacting 每帧成立，若不闩住 ⇒ 窗口耗尽后
   * 立刻被重新装填 ⇒ 冲量退化回「持续横摆」。闩住后一次接触只放一记，离墙复位再撞才放下一记。
   */
  private wallKickFired = false;
  /**
   * R106 本次贴墙接触是否已放过「首帧法向速度骤降」：与 wallKickFired 同理闩住，贴墙期间
   * impacting 每帧成立，若不闩住 ⇒ 速度骤降退化回「持续强减速」而非一次性「顿挫」。
   * 一次接触只扣一记，离墙复位（wallScrubN 清零处同点复位）再撞才扣下一记。
   */
  private wallSpeedKickFired = false;
  /**
   * R126 常态视觉姿态内部状态（一阶 damp 目标，R98 契约零改）：侧倾/俯仰 rad。
   *  与撞击晃动（impact*Osc）分离 —— 常态一阶回正不被晃动侵蚀，晃动回摆不被常态阻尼抵消。
   */
  private rollBody = 0;
  private pitchBody = 0;
  /**
   * R126 撞墙「被顶晃动」欠阻尼二阶状态：侧倾位移 rad / 角速度 rad/s。
   *  撞墙帧一次性注入角速度（rollGain×impactN），随后弹簧-阻尼二阶积分，过冲回摆一次再稳定。
   */
  private impactRollOsc = 0;
  private impactRollOscVel = 0;
  /** R126 撞墙「被顶晃动」欠阻尼二阶状态：俯仰位移 rad / 角速度 rad/s（负 = 车头朝墙点头） */
  private impactPitchOsc = 0;
  private impactPitchOscVel = 0;
  /** R102 只读观测口：供测试纯数值断言「贴墙期间 scrub 不被段间跳变误清零」（不暴露写权限） */
  get scrubN(): number {
    return this.wallScrubN;
  }
  /** R126 只读观测口：撞墙「被顶晃动」俯仰位移 rad（供测试断言 osc 本身过零回摆，不暴露写权限） */
  get impactPitchOscValue(): number {
    return this.impactPitchOsc;
  }
  /** R126 只读观测口：撞墙「被顶晃动」侧倾位移 rad（供测试断言 osc 本身过零回摆） */
  get impactRollOscValue(): number {
    return this.impactRollOsc;
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
    this.steerYawRate = 0;
    this.wallImpact = 0;
    this.wallScrubN = 0;
    this.wallKick = 0;
    this.wallKickRemain = 0;
    this.wallKickFired = false;
    this.wallSpeedKickFired = false;
    this.rollBody = 0;
    this.pitchBody = 0;
    this.impactRollOsc = 0;
    this.impactRollOscVel = 0;
    this.impactPitchOsc = 0;
    this.impactPitchOscVel = 0;
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
    this.steerYawRate = 0;
    this.wallImpact = 0;
    this.wallScrubN = 0;
    this.wallKick = 0;
    this.wallKickRemain = 0;
    this.wallKickFired = false;
    this.wallSpeedKickFired = false;
    this.rollBody = 0;
    this.pitchBody = 0;
    this.impactRollOsc = 0;
    this.impactRollOscVel = 0;
    this.impactPitchOsc = 0;
    this.impactPitchOscVel = 0;
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
    this.steerYawRate = 0;
    this.wallImpact = 0;
    this.wallScrubN = 0;
    this.wallKick = 0;
    this.wallKickRemain = 0;
    this.wallKickFired = false;
    this.wallSpeedKickFired = false;
    this.rollBody = 0;
    this.pitchBody = 0;
    this.impactRollOsc = 0;
    this.impactRollOscVel = 0;
    this.impactPitchOsc = 0;
    this.impactPitchOscVel = 0;
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
    this.wallKick = 0;
    this.wallKickRemain = 0;
    this.wallKickFired = false;
    this.wallSpeedKickFired = false;
    this.rollBody = 0;
    this.pitchBody = 0;
    this.impactRollOsc = 0;
    this.impactRollOscVel = 0;
    this.impactPitchOsc = 0;
    this.impactPitchOscVel = 0;
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

    // ---- 转向输入一阶平滑（随速 τ：低速轻快/高速沉稳）+ 高速转角收窄 ----
    const speedKmh = Math.abs(s.speed) * MS_TO_KMH;
    const steerTarget = steerIn * steerLimitFor(speedKmh);
    // R130 caster 自回正：仅正常（非漂移）路径——|目标| < |当前| 即松舵/向心回正方向，
    // 用更快 τ（自回正力矩）；反向满舵（counter-steer）|目标| ≥ |当前| 走建角 τ 不误加速。
    // ⚠ 漂移恢复期（R37-D 契约）drift 模型自对齐动力学主导：回正加速会提前撤掉转向阻尼项、
    //   让残余横摆重饱和到限幅（0.898→0.900 单次微瞬态）破坏单调恢复契约 ⇒ 漂移态用建角 τ。
    //   判定用上一帧 beta/yawDyn（转向阻尼点在 driftActive 之前，一帧滞后可接受）。
    const driftLike =
      Math.abs(s.speed) >= 1.5 &&
      (s.handbrake || Math.abs(s.beta) > 0.002 || Math.abs(this.yawDyn) > 0.02);
    const steerReturning = !driftLike && Math.abs(steerTarget) < Math.abs(s.steer);
    s.steer = damp(s.steer, steerTarget, 1 / steerTauFor(speedKmh, steerReturning), dt);

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
      // R121：latch 未释放（sideTouch=true）但几何上已离墙（sideTouchRaw=false）且低速 ⇒
      //   scrub 记峰渐出。根因：RELEASE_EPS(1.2) 离墙滞后带在稳定段过宽（车 x≈13.1 距墙
      //   0.897m 仍被判贴墙，见 latch 带 [12.797,13.947]）⇒ wallScrubN 永不释放、v 锁存
      //   0.37~2.08 极限环（骑墩斜切 20/24 组合）。WALL_SCRUB_RELEASE_MS(1.5) 是既有低速
      //   脱困阈值（L1199 同口径）⇒ 低速 + 几何离墙时渐出记峰，scrub 解除、油门可推动。
      //   撞墙场景（sideTouchRaw=true）不触发（维持原 R101/R109 刮擦契约）。
      if (sideTouch && !sideTouchRaw && av < WALL_SCRUB_RELEASE_MS) {
        this.wallScrubN = damp(this.wallScrubN, 0, WALL_SCRUB_LATCH_DECAY_RATE, dt);
      }
    } else {
      this.wallScrubN = 0; // 已离墙：刮擦结束
      this.wallKickFired = false; // 已离墙：复位横摆冲量闩，下次撞墙再放一记
      this.wallSpeedKickFired = false; // 已离墙：复位首帧速度骤降闩，下次撞墙再扣一记
      // R126：撞墙「被顶晃动」（osc）是**姿态余韵**，独立于本次接触 —— 离墙后仍按二阶
      //   自然衰减回零（ζ=0.5 ⇒ ~0.8s 内衰减），**不在此硬清**（否则 hall「一次停」离墙
      //   下一帧就把刚注入的晃动抹掉，读作无晃动）。reset() 才全清。
    }
    // 刮擦减速度：撞得越狠刮得越狠 + 封顶（撞墙域边界耗散，与轮胎摩擦圆独立）
    // R109 低速脱困：× clamp(|v|/FADE_SPEED,0,1) 随速度线性渐入 —— 高速完整刮停
    // （R101 蹭滑契约保留），低速渐出（油门 6.08 能推动，平衡点 ≈2.03 m/s 可走可转向）。
    const wallScrub =
      Math.min(this.wallScrubN * WALL_SCRUB_DECEL, WALL_SCRUB_DECEL_MAX) *
      clamp(av / WALL_SCRUB_FADE_SPEED, 0, 1);

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
    // R144 倒车脱困：贴墙主动倒车（S + 已倒车 vNext<0）时墙 scrub 渐出（见 R144_REVERSE_SCRUB_FADE
    // 头注）。前进（W）不受影响（R142② 蹭墙平衡保留）；倒车净加速 2.08 可推动，背墙退出不卡死。
    const reverseScrubFade = brakeIn > 0 && vNext < 0 ? R144_REVERSE_SCRUB_FADE : 1;
    // R101 撞墙刮擦耗散：作用在电子限速钳位**之前**，语义是「撞墙耗散」非「限速」。
    // 沿运动反方向减 scrub·dt，钳到不反向（沿用下方 :866 口径），油门压不住（12 > 净加速6.08）。
    // ⚠ 主动漂移态（手刹/大侧偏/大动态横摆）不加刮擦：此时轮胎摩擦圆已饱和主导减速，
    //   再叠墙体刮擦=双重惩罚且会干扰漂移模型回归（R37-D 自回正漂移蹭墙场景）。
    //   R101 目标场景（撞后切向滑行）非漂移态 ⇒ 不受此门控影响。
    if (wallScrub > 0 && dir !== 0 && !driftActive) {
      vNext -= dir * wallScrub * reverseScrubFade * dt;
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
      // R129 ②：漂移态同步转向横摆滞后通道 ⇒ 松手刹退出漂移时 steerYawRate 从 yawDyn
      // 续起，横摆率连续（旧式 kinematic yawRateFor 与 yawDyn=0 之间的阶跃在漂移退出残留）。
      this.steerYawRate = this.yawDyn;
      moveHeading = s.heading + s.beta; // 速度方向 = 航向 + 侧滑角（车尾外滑的运动学产物）
    } else {
      this.vy = 0;
      this.yawDyn = 0;
      s.beta = 0;
      // R129 ② 横摆响应一阶滞后：轮胎侧偏力载荷渐进，打舵后横摆率按 yawResponseTau 建起
      //（非瞬时 kinematic——旧式点舵后航向瞬时锁定、无「载荷渐进」；回正也按此 τ 平滑，
      //  一次一阶无过冲 ⇒ 无横摆动量、无穿墙风险）。只作用于转向驱动横摆：
      //  撞墙横摆冲量（R104，下方积分后注入 s.yawRate）与贴墙脱困（下方 0.35 直写）不经此通道。
      this.steerYawRate = damp(
        this.steerYawRate,
        yawRateFor(s.steer, vAvg !== 0 ? vAvg : v),
        1 / FREE.yawResponseTau,
        dt
      );
      yawRate = this.steerYawRate;
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
      // R144 倒车脱困：倒车（brakeIn>0 且 vAvg<0）时**不受 av<RELEASE_MS 低速门控限制**——
      //   倒车净加速（2.08）弱，scrub 渐出后倒车速度会过 RELEASE_MS(1.5) 阈值，若门控只在低速
      //   给转向权限，速度一过 1.5 车就停止转向、沿墙滑行回不了「车尾背离墙」朝向 ⇒ 御桥段 1D
      //   边界 10s 位移 0.01m 原地自转（R144 探针）。放宽倒车门控让车在倒车全程保持 18°/s 脱困
      //   横摆，转到「车尾朝路内」后倒车自然清墙（前进门控不变，R142② 蹭墙平衡保留）。
      const reverseEscaping = brakeIn > 0 && vAvg < 0;
      if (
        wallScrub > 0 &&
        steerIn !== 0 &&
        (throttle > 0 || brakeIn > 0) &&
        (av < WALL_SCRUB_RELEASE_MS || reverseEscaping)
      ) {
        yawRate = steerIn * FREE.maxYawRate * 0.35 * (vAvg >= 0 ? 1 : -1);
        // R129 ②：脱困直写旁路横摆滞后 ⇒ 同步滞后状态，避免脱困结束瞬间横摆回跳。
        this.steerYawRate = yawRate;
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
     * 只在城内域 + 广场域 + 城门带（z ∈ [zMin, gateFrontZ]）激活 —— R118 城门带改用 2D 门墩
     * 钳位（配合 Fix 1 门墩 footprint，7 帧收敛替代 1 帧 2m/4.9m 瞬时）；桥段（z>gateFrontZ）仍 1D，
     * z=−250 桥段测试全程零触发，既有 r97/r98/r99/r100 护栏不破（resolveBounds 函数体未改）。
     * R105：下界从 plazaZ 扩到 zMin —— 主殿前排飞扶壁内墩落到广场 z≈-1294.3（< plazaZ=-1285.5，
     * 原激活带之外）却无 2D 兜底 ⇒ 车广场 1D 车缘≈16.5 直穿内墩基座（内缘 10.425）最多 ~3m。
     * 扩到 zMin 后该域内仅此一条 footprint（buildCityFootprints 广场段只建飞扶壁内墩）⇒ 不引入
     * 别处假钳位。
     * R119：门带 2D 激活域上界北扩 CAR_HALF_L（gateFrontZ → gateFrontZ + CAR_HALF_L）——原判据
     * 只看车心 nz ≤ gateFrontZ，南向车头前缘（nz − CAR_HALF_L）已伸过 −351.5、车心仍在桥段
     * （nz ∈ (−351.5, −351.5+CAR_HALF_L]）时 2D 未激活，而 1D 桥限（10.997）不挡门墩内缘 10
     * ⇒ 车 OBB 前角穿门墩 0.9~2.45m（入口穿模）。上界北扩 CAR_HALF_L 后车头一入墩 z 带
     * （车心 ≤ gateFrontZ + CAR_HALF_L）2D 门墩钳位即接管，替代 1D 桥限漏洞；北侧无门墩实体，
     * 扩带只引入「车头探入门带即被门墩 OBB 收紧」的接管，不改变城内/广场 2D 语义。
     * R110 连续收敛 / R115-R116 x·z 步长动态化 / R105 漂移分流均逐位不变。
     * R120：上界再北扩到 GATE_PIER_Z_MAX + CAR_HALF_L（−348.1525，塔基实体北界 + 半长）——
     *   R119 的 gateFrontZ + CAR_HALF_L（−348.7525）未同步塔基实体北界（GATE_PIER_Z_MAX=−350.9
     *   比门脸 gateFrontZ=−351.5 北伸 0.6m）：车心 nz ∈ (−348.7525, −348.1525] 时车头前缘已入
     *   塔基北 0.6m 条带但 2D 门控关闭 ⇒ 车头切塔基 0.3~0.6m 且无碰撞反馈（probe-D 缺口 1，
     *   实测 ⑧ 场景末态车心 −348.4784 处 SAT 残余 0.1987m）。北扩后车头一触塔基北界 2D 门墩
     *   钳位即接管（SAT 判交覆盖车头入塔基）；桥段（z>gateFrontZ）北侧无其它 footprint，
     *   扩带只引入「车头探入塔基即被 gatePier 收紧」的接管，不改变城内/广场 2D 语义。 */
    /* R138：激活域上界再北扩覆盖**门楼飞扶壁墩**（z∈[−347.75,−344.95]，御桥段）——
     *   R120 的 GATE_PIER_Z_MAX+CAR_HALF_L（−348.1525）只盖门墩塔基（北界 −350.9），
     *   漏掉门楼前脸步道的飞扶壁双墩（z 上界 −344.95 > 塔基北界）：御桥段 1D 限车心
     *   10.997（车缘 12.0 贴桥沿）不挡外墩（|x|∈[10.2,12.4]），车贴桥沿经过穿外墩最多
     *   1.8m（R125 defer「桥段 2D 红线」）。上界取 max(塔基北界, 墩带北界)+CAR_HALF_L
     *   = −344.95+2.7475 = −342.2025，车头一探墩带 2D 钳位即接管；墩带北侧（z>−344.95）
     *   无其它 footprint，扩带只引入「车头探入门楼飞扶壁墩即被收紧」的接管，不改
     *   城内/广场 2D 语义（桥段正常通行 x 中线不碰墩）。 */
    if (nz <= Math.max(GATE_PIER_Z_MAX, GATE_FLY_Z_MAX) + CAR_HALF_L && nz >= BOUNDS.zMin) {
      // R105：去掉外层 !driftActive 门控 —— 漂移态**也做位置钳**（s.x=fp.x），堵死漂移穿模。
      //   旧版整层被 !driftActive 关闭 ⇒ 漂移车能穿进建筑底部 3.5~5.6 m（全量几何扫最大穿模源）。
      //   R103 关掉它的真因是「位置钳 + 撞击/速度/heading 注入」会让 β 永不塌缩，而非位置钳本身；
      //   故此处按 driftActive 分流：漂移态只做位置钳 + 朝向贴墙收敛，不碰撞击/速度/刮擦链路。
      const fp = clampToFootprints(s.x, s.z, s.heading);
      let mainClampDelta = 0;
      if (fp.hit) {
        // R110 连续收敛：不再一帧写死 s.x=fp.x（曾单帧钳位 6.34 m = 空气墙/瞬移）。
        // 每帧最多朝目标 x 走 WALL_2D_MAX_LATERAL_STEP，命中判定/impact 链路不受影响。
        // R115：x 步长上限动态化 —— 车已穿模（fp.xPen>0，车 OBB x 越界占位盒内缘）时单帧推回
        //   xPen（恰让车角贴盒内缘），消除收敛瞬态（车角嵌墩 0.3~1.32m 多帧）；未穿模
        //   （xPen≤0.30）时保持 WALL_2D_MAX_LATERAL_STEP 平滑（无瞬移）。R111 修 SAT 后
        //   clamp 触发 = 真接触，推回 = 消除真穿模（非空气墙）。
        // R148-Phase2：持续压入 x 平滑（对称下方 z 平滑）—— 玩家主动转向（steerIn≠0）+ 行驶中
        //   （|speed|>1）+ **双轴深嵌**（xPen>0.30 且 zPen>0.35：W+A 切角飞扶壁墩实测 xPen=0.403
        //   /zPen=1.091，zOv≥xPenRaw ⇒ arcadeCol xPenSmooth=false ⇒ 单帧 x-yank 0.386m 残留）⇒
        //   平滑推回 WALL_2D_MAX_LATERAL_STEP（0.30）。双轴判据排除 r105 漂移（z 纵深远嵌
        //   zOv≫xPen、x 浅 xPen≤0.30）⇒ 漂移单帧消除保留。门墩 h=90° 过洞 x 钳主导但 z 浅
        //   （zPen≤0.35）⇒ 不触发，R119 ② 单帧过洞保留。不转向/低速/单轴浅嵌逐位不变。
        const maxStepX =
          steerIn !== 0 && Math.abs(s.speed) > 1.0 && fp.xPen > WALL_2D_MAX_LATERAL_STEP && fp.zPen > 0.35
            ? WALL_2D_MAX_LATERAL_STEP
            : Math.max(WALL_2D_MAX_LATERAL_STEP, fp.xPen);
        const dxClamp = clamp(fp.x - s.x, -maxStepX, maxStepX);
        // R113：z 钳（车头先入占位带时 MTV 最小穿透轴 = 世界 z，x 单向钳无法解决）。
        //   与 x 钳同一步长上限（0.30 m/帧 ⇒ 无 z 瞬移）；只收紧（fp.z 是带外缘，钳向它收敛）。
        //   drift 态同样钳 z（位置钳不分层，堵死漂移态沿 z 穿占位带）。
        // R116：z 步长上限动态化（对称 R115 xPen）——车已穿模（fp.zPen>0，车心到 z 钳目标 >0.30）
        //   时单帧推回 zPen（让 z 轴相切，消 z/局部轴穿透收敛瞬态，R116 实测 0.398m 单帧残留）；
        //   未穿模（zPen≤0.30）时保持 WALL_2D_MAX_LATERAL_STEP 平滑（无瞬移）。
        // R148-Phase2：持续压入 z 平滑 —— 玩家**主动转向**（steerIn≠0）**且仍在行驶**（|speed|
        //   > 1.0，车头仍压向 footprint）时车 OBB 沿 z **未平滑深嵌**（fp.zPen>0.35，即
        //   cityFootprints zPenSmooth 判据 `xPenRaw>zPenRaw` 反向 ⇒ 不平滑 ⇒ R148 残留单帧
        //   0.4~1.55m 持续锯齿极限环，W+A 切角拱廊柱/飞扶壁墩实测 zPen=0.37~0.55）⇒ 平滑推回
        //   WALL_2D_MAX_LATERAL_STEP（0.30，与 R120 arcadeCol x 特判同额）。**fp.zPen≤0.35 no-op**
        //   ：cityFootprints 已平滑到 0.35（zPenSmooth=true，如主殿台基楔入帧 zPen=0.35）或天然浅
        //   ⇒ 本式不改变轨迹 ⇒ 不触发「gatePier 陡角 x 深嵌（|sinH|>0.5、xPenSmooth=false）」
        //   的 1.6m x-yank 回归（主殿台基 W+A 0.350→1.592 根因）。**速度门**：|speed|≤1（车已
        //   被钉停/楔入角，v≈0）不设限 —— 楔入需整额推回清除（否则车留嵌 footprint、撞击链再
        //   注入新振荡）。不转向时深嵌多为瞬态（传送伪影 z=-1285.5 zPen=0.731 / 高速扫入）⇒ 保留
        //   R116 单帧清除。只限 z：x 已有 R120 arcadeCol 0.30 特判 / gatePier xPen≤0.30，且门墩
        //   h=90° 过洞是 x 钳主导（z 小），限 z 不破 R119 ② 单帧过洞。R116 逐位语义：未穿模仍
        //   0.30、不转向/低速/浅嵌逐位不变。
        const maxStepZ =
          steerIn !== 0 && fp.zPen > 0.35 && Math.abs(s.speed) > 1.0
            ? WALL_2D_MAX_LATERAL_STEP
            : Math.max(WALL_2D_MAX_LATERAL_STEP, fp.zPen);
        const dzClamp = clamp(fp.z - s.z, -maxStepZ, maxStepZ);
        // R148-Phase2 向量上限：持续压入（转向+行驶中，0.4<|speed|<12 排除楔入 v≈0 与高速过洞）
        //   时单帧推回**向量** ≤ X_Z_PEN_SMOOTH_CAP(0.35) —— 单轴各 0.30 的斜向推回
        //   hypot(0.30,0.30)=0.42 > 0.35 读作空气墙（r148_verify 残留 0.35~0.40，v=0.56~0.82
        //   慢转斜压）。0.4 低门：楔入角 v≈0.01~0.16 需整额推回清除（不设向量限）；12 高门：
        //   门墩 h=90° 高速过洞保留单帧消除（R119 ②）。不转向/低速/高速逐位不变。
        const persistentPress =
          steerIn !== 0 && Math.abs(s.speed) > 0.4 && Math.abs(s.speed) < 12;
        const vecMag = Math.hypot(dxClamp, dzClamp);
        if (persistentPress && vecMag > 0.35 && vecMag > 1e-9) {
          const k = 0.35 / vecMag;
          mainClampDelta = dxClamp * k;
          s.x += mainClampDelta;
          s.z += dzClamp * k;
        } else {
          mainClampDelta = dxClamp;
          s.x += dxClamp;
          s.z += dzClamp;
        }
        if (driftActive) {
          /* R105 漂移态：位置钳 + 朝向贴墙收敛 + β/横摆回收，**不注入撞击/速度/刮擦**。
           * 2D 把车在建筑占位（柱 11.12 / 墩 11.35 / 基座 14.9）提前拦下后，车到不了前脸 1D 墙，
           * 失去原本「撞前脸墙 → wall-impact 吸法向速度 + 塌 β」的机制 ⇒ 若只做 heading 收敛，
           * 车会贴占位持续滑行、β 卡死、heading 绕圈（实测 β 卡 -0.5 / recoveredAt=-1）。
           * 故贴墙时把 β / 动态横摆往回收（等价于 baseline 在前脸墙做的塌 β），让车头贴合速度方向、
           * 轮胎自回正接管。关键红线：不改 r.impactN / r.targetHeading / r.kind ⇒ 下方 impacting 块
           * （wallImpact·wallScrubN·wallKick·速度 IMPACT_TAU damp·scrub）不被 2D 触发 —— 这些是
           * R103/R104 β 半衰 + rearGrip 不复原回归的元凶。rearGrip 走 gripRecoverTau 自主恢复，不受影响。
           * 收敛 / 回收都用独立的更缓 WALL_IMPACT_DRIFT_HEADING_TAU（温和，不干扰漂移模型自身节奏）。 */
          const fDrift = forwardOf(s.heading);
          const targetH = slideHeading(fDrift.x, fDrift.z, fp.nx, 0);
          s.heading = impactHeadingStep(
            s.heading,
            targetH,
            WALL_IMPACT_DRIFT_HEADING_TAU,
            dt
          );
          // β / 动态横摆回收用比 heading 收敛更快的速率：贴墙期间持续把侧滑角往回拉，
          // 补上「2D 提前拦下 ⇒ 到不了前脸墙 ⇒ 失去撞墙塌 β」的缺口，保证 free_drift
          // 恢复段 β 在阈值内塌缩（不卡死）。仍不碰 impactN / speed / scrub / rearGrip。
          s.beta = damp(s.beta, 0, WALL_IMPACT_DRIFT_BETA_RATE, dt);
          this.yawDyn = damp(this.yawDyn, 0, WALL_IMPACT_DRIFT_BETA_RATE, dt);
          // heading 收敛改变了车 OBB 的 x 伸展 dx(θ) ⇒ 用收敛后的 heading 重钳一次位置，
          // 否则会出现「钳位时按旧 heading 不重叠、收敛后按新 heading 又重叠」的单帧穿模瞬态。
          // R110：第二次钳位与主钳位共用同一 0.30 m/帧预算 —— 若两钳各放 0.30 会单帧合计
          // 0.60 m（+漂移运动），被 r105 的 maxXStep 护栏抓到。用剩余预算重钳，总钳位 ≤ 0.30。
          const fpRe = clampToFootprints(s.x, s.z, s.heading);
          if (fpRe.hit) {
            // R120：reBudget 不为负 —— 主钳位因 X_Z_PEN_SMOOTH_CAP=0.35 限幅可走满 0.35（>0.30），
            //   reBudget = 0.30 − 0.35 = −0.05 ⇒ clamp(v,0.05,−0.05) 恒等于 −0.05 ⇒ 二次钳固定
            //   −x 位移 0.05m/帧（drift+入域类深嵌组合，probe-C 边缘副作用）。max(0,…) 让预算
            //   耗尽时二次钳零位移（不反向推回），语义正确（总钳位已 ≥0.30 预算）。
            const reBudget = Math.max(0, WALL_2D_MAX_LATERAL_STEP - Math.abs(mainClampDelta));
            s.x += clamp(fpRe.x - s.x, -reBudget, reBudget);
            // R113：drift 态同样钳 z（共用剩余预算，总钳位 ≤ 0.30 m/帧）。
            s.z += clamp(fpRe.z - s.z, -reBudget, reBudget);
          }
        } else {
          // 非漂移态：原撞击 / heading / scrub 链路照旧（逐位不变）。
          // R110 法向符号修：fp.nx 指向路内（x≥0 时 −1），与 resolveBounds :705 的 nx=x>=0?1:-1
          // （指向墙外/墙面）符号相反 ⇒ 旧 fnSide=fSide.x·fp.nx 恒 ≤0 ⇒ 2D 接触从不扣速 = 滑开。
          // 取 -fp.nx 与 1D 同约定 ⇒ 朝墙走 fnSide>0 ⇒ 真撞击进 impactN / slideHeading 法向也对了。
          // R113：绑定接触法向扩展 —— z-钳触发（MTV min 轴 = z，车头沿 z 撞占位带）时用 z 法向
          //   （nzSide=-fp.nz），否则沿用 x 法向。避免「车头直撞柱 fSide.x=0 ⇒ fnSide=0 从不扣速」：
          //   车头撞柱带（如 arcadeCol 柱列）时 fSide.z 显著 ⇒ 沿 z 法向入射进 impactN ⇒ 车减速。
          const nxSide = -fp.nx;
          const nzSide = -fp.nz;
          const fSide = forwardOf(s.heading);
          // R147 倒车入柱扣速：fnSide 含**实际运动方向**符号 —— 倒车（s.speed<0）时运动方向 =
          //   -forwardOf，旧式 fnSide=fSide·n 恒 ≤0 ⇒ 倒车入柱 fpImpact=0 不扣速 ⇒ 车速恒 -8 +
          //   每 14 帧 clamp 单帧推回 0.87m 锯齿极限环（R146 定罪「开阔街心反向振荡」）。乘
          //   dirSign=sign(s.speed) 使倒车入柱 fnSide>0 ⇒ impactN 扣速 + 下方 wallScrubN 装填
          //   ⇒ 车减速平滑停柱前；前进（s.speed≥0）dirSign=+1 ⇒ 逐位不变（R110/R113 语义保留）。
          const dirSign = s.speed < 0 ? -1 : 1;
          const fnSide = (fp.nz !== 0 ? fSide.z * nzSide : fSide.x * nxSide) * dirSign;
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
    // R110 掠擦接触期连续切向摩擦：贴墙（wallScrubN>0，离墙即清零）期间施加减速度
    // FRICTION×wallScrubN，模拟墙面对切向的真实摩擦，压住「撞击后车沿墙自动滑开」残速
    // （84° 掠擦 1s 仍滑 ~5 m/s）。模型 ∝ wallScrubN（非 ∝ 当前速度）⇒ 轻擦/硬擦同额摩擦，
    // r106⑤「越正撞击越狠」单调性靠 speedKick（∝ fn）保留。门控 !driftActive 同 wallScrub；
    // 钳到不反向 ⇒ 不归零/不瞬停；仅接触期作用。
    // R120：切向摩擦加**速度渐出**（clamp(|v|/WALL_SCRUB_FADE_SPEED)，与 wallScrub L1080 同口径）
    //   ——WALL_TANGENT_FRICTION×wallScrubN 原为恒定 5.4 m/s² 不随速度衰减，低速时几乎抵消油门
    //   净加速（6.08），把「斜切骑墩侧撞」车钉死在 0.24~1.45 m/s 永久卡死（R109 修过、R110 引入
    //   WALL_TANGENT_FRICTION 后以更低平衡速度复发，实测 1200 帧 v 恒 0.238 不恢复）。渐出后低速
    //   摩擦归零、油门能推动车，平衡点回到 ~2 m/s（R109 口径）；高速（掠擦 14.4 m/s）FADE=1
    //   不受影响（R110 掠擦语义保留）。WALL_TANGENT_FRICTION 值（0.25）与 WALL_SCRUB_FADE_SPEED
    //   值（4.0）均未动，只改本表达式（非 WALL_SCRUB_* 常量值）。 */
    if (this.wallScrubN > 0 && !driftActive) {
      // R144：切向摩擦同 × reverseScrubFade（倒车时渐出，与主 scrub 同口径，见 R144 头注）。
      const tangentDecel =
        WALL_TANGENT_FRICTION * this.wallScrubN * clamp(Math.abs(s.speed) / WALL_SCRUB_FADE_SPEED, 0, 1) * reverseScrubFade;
      const sign = Math.sign(s.speed) || 1;
      const reduced = Math.abs(s.speed) - tangentDecel * dt;
      s.speed = sign * Math.max(0, reduced);
    }
    // R106 ① 撞墙首帧「顿挫」：在 IMPACT_TAU 一阶那一档之外，撞墙帧一次性再扣掉「入射
    // 法向分量 r.impactN=|v|·fn」的固定比例（WALL_IMPACT_SPEED_KICK_RATIO），使正撞首帧
    // 速度从 ~6% 掉速提到 ~44%——撞墙读作一次真实碰撞而非融化成滑行。有界且不瞬移：
    //   · 只扣 r.impactN（入射法向分量，resolveBounds 在分解前捕获）的一个比例；
    //   · 切向分量完整保留、法向只扣一个比例（0.4）⇒ 单帧绝不归零（正撞仍留 ~60% 速度）；
    //   · 位置由 resolveBounds 几何钳位处理（零改）⇒ 不瞬移（R99 防瞬移底线保留）。
    //   · 后续帧仍走上方 IMPACT_TAU 一阶收敛到「法向吸收+切向保留」目标（不变）。
    // 与 wallKickFired 同理用 wallSpeedKickFired 闩住：贴墙期间 impacting 每帧成立，若不闩
    // ⇒ 退化成「持续强减速」而非一次性顿挫。一次接触只扣一记，离墙复位再撞才扣下一记。
    // hall 正撞不进此路径（无 targetHeading ⇒ impacting=false）⇒ hall「一次停」契约不变。
    if (impacting && !this.wallSpeedKickFired) {
      const kickLoss = WALL_IMPACT_SPEED_KICK_RATIO * r.impactN!;
      const sign = Math.sign(s.speed) || 1;
      // R109 ②：再乘 (1−WALL_IMPACT_STUN_RATIO) —— 与入射角正交的一记总速度粘滞，
      // 保证极斜擦（fn→0、R108 kick 几乎不扣）也有可感知的撞墙顿挫。仍不归零。
      const mag = Math.max(0, Math.abs(s.speed) - kickLoss) * (1 - WALL_IMPACT_STUN_RATIO);
      s.speed = sign * mag;
      this.wallSpeedKickFired = true;
    }
    // R100 hall 瞬态（复用 R99 wallImpact 包络，不照搬 side 的速度分解）：
    //   speed 仍取 r.speed=0 ⇒ 正撞彻底停、不二次撞击、z 弹开 0.8m 不变；
    //   s.accel 保留归零（pitch 走 FREE_BODY_DAMPING.pitch 一阶，不产生俯仰硬切）；
    //   impactN 注入包络 ⇒ 下方衰减段给 yawRate/roll 一记短暂「被顶一下」冲击；
    //   beta/yawDyn 按 IMPACT_TAU 逐帧收敛 ⇒ 消除 speed<1.5 退出漂移层时的单帧横跳。
    if (r.kind === 'hall') {
      s.accel = 0;
      this.wallImpact = Math.max(this.wallImpact, r.impactN ?? 0);
      // R104 ④：hall 正撞同样记横摆冲量（与 side/end 同通道），保留「被顶一下」的可见瞬态；
      // 速度仍 r.speed=0 彻底停、heading 原样、无 targetHeading ⇒ hall 契约不变。
      this.wallKick = Math.min(this.wallImpact, WALL_IMPACT_KICK_MAX);
      this.wallKickRemain = WALL_IMPACT_KICK_MS;
      // R126：hall 正撞同样注入「被顶晃动」角速度（与 side/end 同通道），保留「被顶一下」
      // 的可见俯仰/侧倾瞬态；速度仍 r.speed=0 彻底停、heading 原样、无 targetHeading ⇒ hall 契约不变。
      this.impactRollOscVel += FREE_BODY_IMPACT_OSC.rollGain * (r.impactN ?? 0);
      this.impactPitchOscVel += -FREE_BODY_IMPACT_OSC.pitchGain * (r.impactN ?? 0);
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
      this.wallScrubN = Math.max(this.wallScrubN, r.impactN!, WALL_SCRUB_FLOOR);
      // R104 ④：撞墙帧记横摆冲量峰值（min(wallImpact, 上限)），在下方窗口内分摊注入，
      // 取代旧的「每帧速率项」（被下一帧 yawRateFor 覆盖 ⇒ 一帧脉冲不可见）。
      // ⚠ 窗口只在「本次贴墙接触尚未放过冲量」时装填：贴墙期间 impacting 每帧成立，若每帧
      //   重置 remain ⇒ 窗口永不耗尽 ⇒ 冲量退化回「持续横摆」而非一次性「顶一下」。用
      //   wallKickFired 闩住 ⇒ 一次接触只放一记，离墙复位（见下方 wallScrubN 清零处）再撞才放。
      this.wallKick = Math.max(this.wallKick, Math.min(this.wallImpact, WALL_IMPACT_KICK_MAX));
      if (!this.wallKickFired) {
        this.wallKickRemain = WALL_IMPACT_KICK_MS;
        this.wallKickFired = true;
        // R126 ② 撞墙「被顶晃动」欠阻尼冲量（与横摆冲量同闩、同一次性机制）：撞墙帧一次性
        // 注入角速度（impactN 加权；pitch 负 = 车头朝墙面点头），下方二阶积分过冲回摆一次。
        // 取代 R106 俯仰位置冲量与 R99 roll 速率项（二者单调回正、无过冲）。幅值有界：
        // 由 rollGain/pitchGain×impactN 给出，注入后紧跟 ±rollMaxRad/±pitchMaxRad clamp。
        // 闩在 !wallKickFired 内 ⇒ 一次接触只放一记，不会每帧重置退化成「持续顶晃」。
        this.impactRollOscVel += FREE_BODY_IMPACT_OSC.rollGain * r.impactN!;
        this.impactPitchOscVel += -FREE_BODY_IMPACT_OSC.pitchGain * r.impactN!;
      }
      // R104 ③：朝向一阶收敛改用更慢的 WALL_IMPACT_HEADING_TAU（独立于速度用的 IMPACT_TAU）——
      // 车头多指向墙一会儿 ⇒ fn=f·n 停留更大 ⇒ 撞后几帧持续刮擦减速（顿挫感）；
      // 角度差走最短弧（避免 ±π wrap 跳变），不再一帧硬掰到墙面切向。速度仍走 IMPACT_TAU。
      s.heading = impactHeadingStep(s.heading, r.targetHeading!, WALL_IMPACT_HEADING_TAU, dt);
      // 同步漂移态：擦碰把侧滑角 / 动态横摆往回收 —— 消除「旧 beta 把速度方向偏走」
      // 与「速度骤降退出漂移层把状态硬清零」两处次生硬切。
      s.beta = damp(s.beta, 0, 1 / IMPACT_TAU, dt);
      this.yawDyn = damp(this.yawDyn, 0, 1 / IMPACT_TAU, dt);
    }
    // 包络指数衰减：撞击结束后仍有短暂「被顶一下、带惯性回正」余韵。
    this.wallImpact = damp(this.wallImpact, 0, 1 / IMPACT_TAU, dt);
    if (this.wallImpact < 1e-4) this.wallImpact = 0;
    // R126：旧 roll 每帧速率项注入（s.roll += IMPACT_ROLL_GAIN·wallImpact·dt/τ，单调回正无
    //   过冲）已由「被顶晃动」欠阻尼通道取代 —— 撞墙帧注入角速度、二阶积分过冲回摆（见下方）。
    // R104 ④ 撞墙横摆冲量：撞墙帧记 wallKick 峰值，在 WALL_IMPACT_KICK_MS 窗口内每帧分摊
    // wallKick·(dt/WALL_IMPACT_KICK_MS) 加到 yawRate，窗口走完即放完（不再每帧累加 / 被覆盖）。
    // ⇒ 撞墙瞬间有一记稳定、可见的「被顶一下」横摆，而非旧的一帧脉冲。
    if (this.wallKickRemain > 0 && this.wallKick > 0) {
      const kickDt = Math.min(dt, this.wallKickRemain);
      s.yawRate += this.wallKick * (kickDt / WALL_IMPACT_KICK_MS);
      this.wallKickRemain = Math.max(0, this.wallKickRemain - dt);
      if (this.wallKickRemain <= 0) this.wallKick = 0; // 冲量放完即止
      // 冲量注入后紧跟 clamp，state 不得越过灵魂横摆上限（与 roll 同口径）。
      s.yawRate = clamp(s.yawRate, -FREE.maxYawRate, FREE.maxYawRate);
    }

    // ---- 视觉姿态（侧倾 × 俯仰）----
    // 常态一阶阻尼（R98 契约零改）：转向/加减速的侧倾/俯仰目标，独立内部状态 rollBody/pitchBody。
    const latAccel = yawRate * vAvg;
    const rollTarget = clamp(
      (-latAccel * FREE.rollMaxRad) / FREE.rollRefMs2,
      -FREE.rollMaxRad,
      FREE.rollMaxRad
    );
    this.rollBody = damp(this.rollBody, rollTarget, FREE_BODY_DAMPING.roll, dt);
    const pitchTarget = clamp(s.accel * FREE.pitchPerAccel, -FREE.pitchMaxRad, FREE.pitchMaxRad);
    this.pitchBody = damp(this.pitchBody, pitchTarget, FREE_BODY_DAMPING.pitch, dt);
    // R126 撞墙「被顶晃动」欠阻尼二阶：撞墙帧注入角速度（impactRollOscVel / impactPitchOscVel），
    //   此处按弹簧-阻尼（FREE_BODY_IMPACT_OSC）积分，过冲回摆一次再稳定。独立于常态一阶
    //   （osc 不被 rollBody damp 侵蚀、回摆不被常态阻尼抵消），只叠加在最终视觉姿态上。
    //   注入放在姿态积分之前 ⇒ 撞墙帧起就按二阶被顶，清晰可见。紧跟 ±灵魂上限 clamp。
    const osc = FREE_BODY_IMPACT_OSC;
    const rollOscAcc = osc.omega * osc.omega * -this.impactRollOsc - 2 * osc.zeta * osc.omega * this.impactRollOscVel;
    this.impactRollOscVel += rollOscAcc * dt;
    this.impactRollOsc += this.impactRollOscVel * dt;
    const pitchOscAcc = osc.omega * osc.omega * -this.impactPitchOsc - 2 * osc.zeta * osc.omega * this.impactPitchOscVel;
    this.impactPitchOscVel += pitchOscAcc * dt;
    this.impactPitchOsc += this.impactPitchOscVel * dt;
    s.roll = clamp(this.rollBody + this.impactRollOsc, -FREE.rollMaxRad, FREE.rollMaxRad);
    s.pitch = clamp(this.pitchBody + this.impactPitchOsc, -FREE.pitchMaxRad, FREE.pitchMaxRad);
    s.odometer += Math.abs(vAvg) * dt;

    // ---- 事件去抖 ----
    this.hallCd = Math.max(0, this.hallCd - dt);
    this.wallCd = Math.max(0, this.wallCd - dt);
    // R127 撞击事件携带归一化强度（0~1）：impactN 为当帧法向入射强度 [m/s]
    //（hall=|speed|、wall=|v|·fn，掠擦 fn→0 自然归零）。归一化与 crashWorld 同口径
    //（freeImpactStrength 单一真源，挑战撞主殿 crash 演出也复用），
    //   Game 侧 `gain × strength` 缩放松放 —— 撞得越狠抖越大、擦过去不抖。
    if (r.kind === 'hall') {
      if (this.hallCd === 0) {
        this.hallCd = 1.6;
        this.emit({ kind: 'hall', strength: freeImpactStrength(r.impactN ?? 0) });
      }
    } else if (r.kind !== 'none' && this.wallCd === 0) {
      this.wallCd = 0.5;
      this.emit({ kind: 'wall', strength: freeImpactStrength(r.impactN ?? 0) });
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
