/**
 * 智界 R7（Luxeed R7）工厂 → 游戏运行时适配器。
 *
 * 把 img2threejs 生成的 `createLuxeedR7Model` 包装成 Car 兼容接口（CarLike）：
 * root / body / wheels / 灯光联动 / 动态仪表 / 方向盘。
 *
 * 车头朝向：游戏前进方向 -Z，工厂车头 +Z → `body.rotation.y = R7_BASE_YAW = π`，
 * root 不转（root 是物理/位姿中枢，body 只负责朝向基准）。
 *
 * 与 V800Adapter 的关系：只 `import type` 复用 CarLike / WheelPivot 两个类型契约，
 * 不引入任何 V800 运行时代码（两辆车必须是可独立加载/卸载的隔离单元）。
 * 材质 ID 语义族沿用 V800（paint-* / glass-* / lamp-* / leather-* / screen-ui / chrome /
 * carpet / bronze-*），因此贴图与灯光契约可以复用同一套理解。
 */
import * as THREE from 'three';
import type { CarLike, WheelPivot } from './V800Adapter';
import { createLuxeedR7Model, type ProceduralModelRuntime } from './createR7Model';
import { batchMergeStatic, UV_CONTENT_MATERIAL_IDS } from './batchMerge';
import { applyReferenceTextures } from './refTextures';
import { mountLicensePlate } from './plateTexture';
// R44 外观 GLB 资产化：外部壳装载 + 程序化外观隐藏 + fx 轮位同步。
// R37-C 的 5 色落色路径退役：R7 程序化车漆固定工厂墨绿（外部壳失败时的回退基线）。
import {
  buildShadowProxies,
  loadExternalShell,
  mountExternalWheel,
  mountExternalBrake,
  shadowProxyEnabled,
  wheelOffsetsWorldXZ,
  // R51-B1-a / B3：开关真源在 ExternalShell.ts（config/** 属 Phase 2-A 冻结，禁放）
  R51_LAMP_ON,
  R51_TAIL_EI_MAX,
  R51_TAIL_ON,
  // R64：4 个 setter 幂等 early-return（开关真源同在 ExternalShell.ts）
  R64_LAMP_DIRTY_ON,
  type ExternalShellHandle
} from './external/ExternalShell';
import { loadInteriorSteering } from './external/InteriorSteering';
import { setFxWheelOffsets } from '../fx';
import { DEFAULT_VARIANT } from '../config/vehiclePaint';
// R68 P0-3 修正 C 双路径：别名接入新增导出函数，原 createR7FrontDetails() 逐字保留
// （r33_car_details.test.ts 仍直调原函数），:572 调用点一字未改。
import { createR7FrontDetailsR68 as createR7FrontDetails } from './parts/r7FrontDetails';
// R65：R7 轮拱内衬（此前 R7 无衬板，舱内座椅从轮辐条间隙看穿）。共享 V800 的衬板件。
import { createWheelArchLiner, WHEEL_ARCH_LINER_MATERIAL_ID } from './parts/wheelArchLiner';
import { WHEEL_HUB_CENTERS } from './parts/wheelHub';
import { carTextureSizeFor, type QualityTier } from '../config/quality';
import { damp } from '../util/math';

export type { CarLike, WheelPivot };

/**
 * W1 · 幂等可见性状态表的每帧输入（Game 汇总后传给 `applyVisibility`）。
 *
 * Game 只拥有 `interior`（由 `rig.mode` 派生）；其余门控（exteriorShellReady /
 * inRearZone / steerNearCam / roofCull）依赖适配器私有句柄（shellHandle / body 局部系 /
 * 高精盘世界距离），Game 拿不到 ⇒ 由适配器在 applyVisibility 内自算（updateSteeringGate
 * 已在 apply 前刷新 cameraInRearZone / steerNearCam）。核心铁律是「每帧全量重算 + 无条件
 * 覆盖」，故 state 只需携带 Game 独有的那一维。
 */
export interface CarVisibilityState {
  /** 是否车内机位（cabinDriver / cabinPassenger / cabinRear） */
  interior: boolean;
}

/** 车头朝向基准偏航（工厂 +Z → 世界 -Z）。root 不转，只转 body。 */
export const R7_BASE_YAW = Math.PI;

/**
 * R50-B：R27 内饰抬升后 R7 座舱机位眼点校准（`.qa/r49/PHASE2C_SPEC.md`）。
 *
 * 病根：R27 把 dash-upper / steering 等 11 件内饰抬升后，`driver.eye.y = 1.285`
 * 低于 dash-upper 顶面（0.962 + R27_INTERIOR_LIFT）⇒ 从眼点向前看的射线先命中
 * 仪表台 ⇒ cabinDriver 上半幅「可见车外」像素 2.3%（V800 同机位 17.0%）。
 *
 * R50-B 两步修（A/B 定罪见 `.qa/r50/glassab/`）：
 * ① 眼点 1.285→1.40→**回调 1.29**（A/B 证明眼点非主因：固定 eye1.29 三态里
 *    隐藏玻璃无效 1.85%、整壳隐藏 23.86% ⇒ 真凶是 R47 DoubleSide 让车顶内壁遮挡）；
 *    抬升量 LIFT 0.14。eye 1.29 ≥ dash-upper 顶 1.102，安全余量 0.188m（≥0.02）。
 * ② 车顶内壁剔除（真修，见 R50_ROOF_CLIP_WORLD_Y）：cabin 态把 world y>1.40 的
 *    车顶区三角从 index 退化化，消除对前向风挡视线的遮挡，同时保住 R47 外模包裹。
 * passenger 同步对齐（rear 不动：后排无台面遮挡问题）。
 *
 * 硬约束：眼点 y ≤ 1.44（顶棚下沿 R7_HEAD_LINER_Y，否则穿顶）。
 * 回滚：`#r49r7eye=off` ⇒ 逐位回 R49 前（eye 1.285 / target 1.020 / LIFT 0.26）；
 *       `#r50roof=off` ⇒ 关闭车顶剔除（回 R47 base 态，A/B 用）。
 */
/** 顶棚下沿装配 y（spec 实测）；眼点硬上限 */
export const R7_HEAD_LINER_Y = 1.44;
/** dash-upper 顶面装配 y（未抬升前的 spec 原值，R49 探针实测 0.962） */
export const R7_DASH_UPPER_TOP_BASE = 0.962;
/** 眼点须高于 dash-upper 顶面至少 0.02m（工单护栏） */
export const R7_EYE_CLEAR_MARGIN = 0.02;

/* ── R71 · 车内主驾/后排视角三修（穿模紫面 / 看不见座椅·A 柱 / 白平板车顶）────────
 * 用户真机截图（image#20-24）：cabinRear 后排视角 ① 前景一块带锯齿边缘的紫色大面挡住
 * 大半视野；② 头顶整片白色平板；③ 看不见座椅和 A/B 柱。
 * 根因（`.qa` 逐项定罪，见各修法落点）：
 *   ① = dash-upper（上仪表台 leather-plum 紫灰大面，1.78m 横贯、y0.955~1.122）不在
 *       任何 cabin 隐藏名单（CABIN_HIDE_RE 只收 dash-lower），从 rear 眼点(0,1.42,-1.30)
 *       看正好横在视线走廊 ⇒ 加入隐藏（主驾前视在它上沿之上，不受影响）。
 *   ② = seat-rear-*（米白后排长凳）被 CABIN_HIDE_RE 的 `seat-` 前缀误藏；apillar-inner
 *       被 R24 的 A 柱内衬遮挡策略（cabinOccluderMats）整批隐藏 ⇒ 二者只对 cabinRear
 *       机位豁免（主驾/副驾维持原隐藏，避免前排座椅/门侧亮板近场穿模）。
 *   ③ = 程序化 headliner（米白 suede-ivory，y1.44~1.573）cabinRear 眼点 y1.42 正在其下
 *       ⇒ 整屏头顶米白平板；外部壳车顶 cabinRear 未享受 R50 剔顶（原只在 cabinDriver 调）。
 * 机位判断：适配器拿不到 rig.mode，但 Game 每帧先调 updateSteeringGate(camera) 再做
 *   遮挡切换（Game.syncInteriorOcclusion），故在 updateSteeringGate 里把相机世界坐标
 *   转到 body 局部系、按 z 判定「后排区」，逐帧 re-assert 可见性覆盖（.visible 覆盖
 *   Game 材质级隐藏，后者只认 material.visible）。
 * 回滚：`#r71dashhide=off` ① / `#r71r7rear=off` ② / `#r71r7roof=off` ③ 逐位回原状。 */
/** `#r71dashhide=off` ⇒ 不把 dash-upper 纳入 cabin 隐藏（回 R70 前） */
const R71_DASH_HIDE: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r71dashhide=off/i.test(window.location.hash);
/** `#r71r7rear=off` ⇒ 关闭 cabinRear 对 seat-rear / apillar-inner 的可见性豁免 */
const R71_REAR_VIEW: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r71r7rear=off/i.test(window.location.hash);
/** `#r71r7roof=off` ⇒ 关闭 cabinRear 剔顶 + headliner 隐藏（回 R70 前） */
const R71_REAR_ROOF: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r71r7roof=off/i.test(window.location.hash);
/** cabinRear 眼点装配局部 z（车厢后部中央，R69 重标） */
const R7_REAR_EYE_LOCAL_Z = -1.30;
/** 第一排座椅装配局部 z（前排 H 点）——后排区判定下界（去前排留余量） */
const R7_FRONT_SEAT_LOCAL_Z = 0.18;
/** body 局部 z < 此值 ⇒ 相机在后排区（cabinRear）。取 rear 眼点与前排 H 点中点。 */
const R7_REAR_ZONE_LOCAL_Z =
  (R7_REAR_EYE_LOCAL_Z + R7_FRONT_SEAT_LOCAL_Z) / 2; // ≈ -0.56
/** cabinRear 剔顶阈值（world y）——眼点 1.42 之上全剔（车顶 + 风挡上梁 header），
 *  消除头顶白平板；比 cabinDriver 的 R50_ROOF_CLIP_WORLD_Y(1.30) 更高（后排不保 hood）。 */
const R7_REAR_ROOF_CLIP_WORLD_Y = 1.42;

/* ── R72 止血 · 已回退 R72 的「cabinDriver 主驾座椅/A柱豁免」──────────────────
 * R72 曾让主驾机位看得见 seat-driver + apillar-inner：用「driverSeatMat 独占克隆
 * (cabinHidable:false) + applyRearViewOverrides 扩 driver 分支 + cameraInDriverZone
 * 逐帧 re-assert」。真机回归：全车贴图失效 + 车辆上半部消失 + 座椅只在主驾出现且
 * 只一个 + 仪表盘消失。根因 = 与 rearSeatMat / cabinOccluderMats / Game 材质级隐藏
 * **多套系统交叉写同一属性**（见《致主理人_车内视角穿帮结构性结论》§3.2：62.6% mesh
 * 可见性由 ≥2 套系统写入顺序决定），触发状态机雪崩。
 * 裁决：按该文档「别再往可见性开关层叠加补丁」——回退整套 driverSeat 机制，seat-driver
 *   回归 R71 稳定态（由 cabinOccluderMats 材质级隐藏管理）。主驾座椅可见性留待文档
 *   W1（幂等状态表）/ W2（削几何）根治，不再用独占克隆打补丁。`#r71r7driver` 钩子废除。 */

/** R50-B：R7 眼点校准开关（`#r49r7eye=off` 逐位回 R49 前）。 */
const R49R7EYE_FIX: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r49r7eye=off/i.test(window.location.hash);

/** R27 内饰抬升量：R49 前 0.26，R50-B 校准后 0.14（与眼点同源对齐） */
export const R27_INTERIOR_LIFT = R49R7EYE_FIX ? 0.14 : 0.26;

/**
 * R69 任务#4：把 cabinRear 机位重标为「看主驾座椅 + A/B 柱」视角。
 * 用户反馈 cabin 看不见座椅和 AB 柱：原 rear 眼点 (0,1.23,-0.7) 朝前下只看仪表台，
 * 座椅（眼点后下）/ B 柱（正后）/ A 柱（被 cabin 遮挡策略隐藏）全不可见。
 * 重标后眼点移到车厢后部中央 (0,1.42,-1.30)、加大前向俯角看 (0.12,0.62,0.35)
 * ⇒ 主驾座椅背/坐垫在下幅、A/B 柱两侧入画。
 * 回滚：`#r69r7seat=off` ⇒ 逐位回 R68 原 rear（眼 1.230/-0.700，target 1.030/1.300）。
 * ⚠ 只动 cabinRear 审查机位，不碰 cabinDriver（它承担「可见车外%」指标）与其遮挡策略。
 */
const R69R7SEAT_VIEW: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r69r7seat=off/i.test(window.location.hash);

/**
 * R50：cabin 态「车顶内壁剔除」阈值（world y）。
 *
 * 病根（主理人 A/B 实测 `.qa/r50/glassab/`，eye/target 已固定为扫描最优 c01）：
 * R47 的 `r47CabinFix` 为治「车内看外模材质消失」把 bodyMesh.material.side 改
 * DoubleSide，**副作用**是车顶 / A 柱内壁从车内被渲染，车顶横在眼点上方挡死前向
 * 风挡视线 ⇒ cabinDriver 上半幅可见车外仅 **1.85%**（门 ≥12%）。三态 A/B 定罪：
 *   base(DoubleSide)         1.85%  FAIL
 *   #r44glass=off（隐藏玻璃）  1.85%  FAIL  ⇒ 非玻璃
 *   #r47cabin=off（整壳隐藏） 23.86%  PASS  ⇒ 就是 bodyMesh 内壁
 *
 * 修法（方案1，几何精准剔除）：cabin 态 bodyMesh 仍 DoubleSide 保住 R47 的外模包裹
 * 观感（引擎盖 / 翼子板 / 门板 / A 柱下段仍可见），但把**车顶区三角（顶点最大 world y
 * > 本阈值）从 index 退化化**（三索引置 0 ⇒ 零面积 ⇒ GPU 不光栅化），消除对前向
 * 风挡视线的遮挡；外部机位恢复完整 index（逐位不变）。
 * 阈值来历（tools/r50_roof_probe.mjs 探针 + glassab 四态 A/B 实测，scale=4.323）：
 *   y>1.40 只剔车顶 ⇒ 10.31%（车顶内壁已清，但**风挡上梁 header 仍在**，图中横一条
 *   暗带挡住中上幅，见 ab_ab_base.png）；须再压到眼点附近把 header 也剔掉 ⇒
 *   `#r50roofclip=` 可调阈值供 A/B 扫描，默认 1.30（= 眼点，保住 hood / 仪表台）。
 * 回滚：`#r50roof=off` ⇒ 不剔除（回 R47 base 态 1.85%，车顶内壁重新遮挡，A/B 对照）。
 */
export const R50_ROOF_CLIP_WORLD_Y: number = (() => {
  if (typeof window === 'undefined') return 1.30;
  // `#r50roofclip=<y>` 供 A/B 扫描阈值（1.30 默认 / 1.40 只剔车顶 / 1.22 更狠）
  const m = window.location.hash.match(/(?:^|[#&])r50roofclip=([\d.]+)/i);
  return m ? Number(m[1]) : 1.30;
})();

/**
 * 三处内饰机位（装配局部坐标 = spec 坐标：+Z 车头、+Y 上、+X 车侧左）。
 * Game 用它驱动 CameraRig；数值来自实测坐姿：
 *   前排 H 点 (|x|0.36, y0.60, z0.18)，眼点在 H 点上方 0.62m；
 *   后排坐垫面 y0.59、靠背在 z-1.02，眼点取 (0, 1.21, -1.05)。
 * 注意：这里给的是**装配局部**坐标，未含 body.rotation.y=π —— CameraRig 需要
 * 先把机位挂到 body 的局部空间（或用 body.localToWorld）再取世界坐标。
 *
 * R50-B：driver/passenger 眼点 +target.y 抬到 R27 抬升后量级；rear 不动。
 */
export const R7_INTERIOR_VIEWS = {
  driver: {
    eye: R49R7EYE_FIX
      ? ([0.300, 1.290, -0.090] as [number, number, number])
      : ([0.300, 1.285, -0.090] as [number, number, number]),
    target: R49R7EYE_FIX
      ? ([0.150, 1.160, 1.950] as [number, number, number])
      : ([0.150, 1.020, 1.950] as [number, number, number]),
  },
  passenger: {
    eye: R49R7EYE_FIX
      ? ([-0.300, 1.290, -0.090] as [number, number, number])
      : ([-0.300, 1.285, -0.090] as [number, number, number]),
    target: R49R7EYE_FIX
      ? ([-0.140, 1.160, 1.750] as [number, number, number])
      : ([-0.140, 1.020, 1.750] as [number, number, number]),
  },
  rear: {
    eye: R69R7SEAT_VIEW
      ? // R69 任务#4：把 cabinRear 重标为「看主驾座椅 + A/B 柱」机位。原 rear（眼 1.23/-0.7
        //   朝前下）只看仪表台 ⇒ 用户「看不见座椅和 AB 柱」。新眼点移到车厢后部中央、抬高、
        //   加大前向俯角 ⇒ 主驾座椅背/坐垫在下幅、A 柱(左)/B 柱(右)在两侧入画。
        //   `#r69r7seat=off` ⇒ 逐位回 R68 原 rear（眼 1.230/-0.700）。
        ([0.0, 1.42, -1.30] as [number, number, number])
      : ([0.0, 1.230, -0.700] as [number, number, number]),
    target: R69R7SEAT_VIEW
      ? ([0.12, 0.62, 0.35] as [number, number, number])
      : ([0.0, 1.030, 1.300] as [number, number, number]),
  },
} as const;

/** 车轮半径（m）—— 255/45 R21 实测 0.383，spinWheels 的弧长→角度换算分母 */
const WHEEL_RADIUS = 0.383;
/**
 * 视觉轮速系数。20 辐轮面的旋转对称周期是 18°，走样（频闪/倒转错觉）的奈奎斯特
 * 阈值是每帧 < π/20 ≈ 0.157 rad；取 0.9 安全系数 → 0.1414 rad/帧（与 V800 同源常数）。
 * 真实轮速在 200km/h 时是 145 rad/s，任何实时渲染都必然走样，这里选"看着不倒转"。
 */
const MAX_WHEEL_STEP_PER_FRAME = (Math.PI / 20) * 0.9;
/** 视觉轮速放大（与 V800 同口径，保证两辆车手感一致） */
const MS_TO_RPM_SCALE = 2.6;

/** 仪表重绘最小间隔（s）→ 15Hz 上限，避免每帧 Canvas 重绘 + 纹理上传 */
const GAUGE_MIN_INTERVAL = 1 / 15;

/* ── R71 · 高精度方向盘极近距门控（根治主驾相机黑帧，与 V800Adapter 同构）──────
 * 根因：52k-tri 高精盘挂 body 下随俯仰/侧倾，cabin 相机只随偏航（近平面见 CameraRig
 *   CABIN_NEAR，R71 已由 0.05 提到 0.1 提升近区深度精度）⇒ 盘面扫过近平面 ⇒ 整帧闪烁/黑帧。
 * 门控：相机过近显示程序化盘、过远恢复高精盘（滞回）。阈值已收紧到盘半径+余量，
 *   正常主驾眼点距盘 ≈0.55m 恒显示高精盘，仅相机真正贴脸(<盘缘)才兜底切低模。
 * 回滚钩子：`#r71steergate=off` ⇒ 关闭距离门控，恒显示高精盘。 */
/** 相机到高精盘距离 < NEAR ⇒ 切程序化盘。R71 收紧：盘半径(0.225)+余量 ≈0.25，
 *   主驾 0.55m 恒高精盘，消除上一轮 0.32 阈值在主驾视角附近穿阈值的高模↔低模跳变。 */
const STEER_GATE_NEAR_M = 0.25;
/** 相机到高精盘距离 > FAR ⇒ 恢复高精盘（0.05m 滞回带防近阈值处抖动） */
const STEER_GATE_FAR_M = 0.3;
/** `#r71steergate=off` ⇒ 恒显示高精盘（模块顶层求值一次，每帧只读布尔） */
const R71_STEER_GATE: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r71steergate=off/i.test(window.location.hash);
/** R71：距离门控每帧复用的临时向量（避免每帧 new 的 GC 抖动） */
const STEER_GATE_TMP_VEC = new THREE.Vector3();
const STEER_GATE_TMP_VEC_B = new THREE.Vector3();

/** 灯光/热量的基准与幅度 */
const BRAKE_BASE_INTENSITY = 0.55;
const BRAKE_FADE_K = 18;
const SNAP_GAIN = 9;
const HEAD_BASE_INTENSITY = 1.9;
/* R48：灯组过曝修复开关（`#r48tone=off` 逐位回滚 R47 公式）。
 * 模块顶层求值一次，update() 每帧只读布尔，零正则热路径开销。 */
const R48_LAMP_TONE: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r48tone=off/i.test(window.location.hash);
const HEAD_DIM_INTENSITY = 0.18;
const CALIPER_HEAT_HEX = 0x8c1114;

/**
 * N-5（复审 P3，R33 首次尝试）：R7 尾灯常亮待机档（brakeLevel 口径）。
 * 双车静态约定统一前：V800 构造即 brakeTarget = TAIL_BASE(2.5) 常亮待机（preview
 * 车尾特写红≈1759），R7  brakeTarget = 0（静态 emissive = 2.0×0.55 = 1.1，特写红≈0/27）
 * —— 只污染 preview/QA 静态截图基线（游戏内 Game 构造时 setBrakeLights(1.6) 两车都覆盖）。
 * 统一口径「都常亮待机」：由 V800 待机读数 2.5 反解 R7 的 brakeLevel 初值：
 *   2.5 = brakeBaseIntensity(2.0) × (BRAKE_BASE_INTENSITY(0.55) + brakeLevel)
 *   ⇒ brakeLevel = 2.5 / 2.0 − 0.55 = 0.7
 * 静态 emissiveIntensity = 2.0 × (0.55 + 0.7) = 2.5，与 V800 同读数；行驶中
 * setBrakeLights(1.6) 覆盖后 damp 收敛到 2.0×(0.55+1.6)=4.3，与旧行为逐位一致。
 */
const R7_TAIL_STANDBY_LEVEL = 0.7;

/** 需要隐藏的 macro 容器占位几何（只隐藏它们**自身**的 mesh，不动子树） */
const CONTAINER_MESH_IDS = ['root', 'cabin-interior'] as const;
/** R29（O1）阴影 caster 白名单：R7 车体壳只有一支 paint-green，其余同 V800 判据 */
const SHADOW_CASTER_MATERIAL_IDS = new Set<string>(['paint-green']);

/** 合批时必须保护的动态件（另有内置 /^wheel-/ 等模式兜底） */
const DYNAMIC_EXCLUDE_IDS = [
  'steering',
  'cluster-screen',
  'center-screen',
  'rear-screen',
  'lettering-luxeed',
  'badge-l',
  'badge-r',
  'front-plate',
  'steering-badge',
  'pedal-brake',
  'pedal-accel',
] as const;

const TEXTURE_SLOTS = [
  'map',
  'roughnessMap',
  'normalMap',
  'aoMap',
  'emissiveMap',
  'bumpMap',
  'displacementMap',
  'alphaMap',
] as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * R50：按 world-y 阈值把 bodyMesh 的「车顶区」三角形从 index 退化化，用于 cabin 态
 * 消除车顶内壁对前向风挡视线的遮挡（病根 / 阈值来历见 R50_ROOF_CLIP_WORLD_Y 注）。
 *
 * 纯函数（只读 geometry，返回新数组，无副作用）⇒ 可单测。
 * - 分类判据：三角形三顶点的最大 world y（= local y × scale）> roofWorldY ⇒ 车顶 / 上框。
 * - `culled`：车顶三角三索引置 0（退化零面积 ⇒ GPU 不光栅化），其余照抄 ⇒ cabin 态用。
 * - `full`：原 index 逐位副本 ⇒ 外部机位恢复用（外部视角逐位不变）。
 * - bodyMesh 与 4 轮**各自独立 geometry**（轮不在 bodyMesh.geometry 上）⇒ 剔除不连带轮；
 *   也不新建材质实例（沿用共享 paint 材质）⇒ 无变体重涂 / 轮耦合风险。
 * - 非 Uint32 index 或无 index/position ⇒ 返回 null（调用方跳过，等同关闭剔除）。
 *   body 526,457 顶点 > 65535 ⇒ GLB 必为 Uint32 index（882,300 tri × 3）。
 */
export function buildRoofCulledIndex(
  geometry: THREE.BufferGeometry,
  scale: number,
  roofWorldY: number,
): { full: Uint32Array; culled: Uint32Array; roofTris: number; totalTris: number } | null {
  const index = geometry.getIndex();
  if (!index || !(index.array instanceof Uint32Array)) return null;
  const pos = geometry.getAttribute('position');
  if (!pos) return null;
  const src = index.array;
  const totalTris = Math.floor(src.length / 3);
  const roofLocal = roofWorldY / scale;
  const full = new Uint32Array(src); // 副本（外部机位）
  const culled = new Uint32Array(src); // 副本（cabin 剔除）
  let roofTris = 0;
  for (let t = 0; t < totalTris; t++) {
    const i0 = src[t * 3];
    const i1 = src[t * 3 + 1];
    const i2 = src[t * 3 + 2];
    // BufferAttribute.getY 对普通 / 交错 attribute 都成立
    const maxY = Math.max(pos.getY(i0), pos.getY(i1), pos.getY(i2));
    if (maxY > roofLocal) {
      culled[t * 3] = 0;
      culled[t * 3 + 1] = 0;
      culled[t * 3 + 2] = 0;
      roofTris++;
    }
  }
  return { full, culled, roofTris, totalTris };
}

/**
 * N-5（R34 实锤修复）：R7 尾灯 **静态**目标发光强度。
 *
 * 病根（node shim .qa/r34car `matof r7 lamp-red` 实锤 —— 两条光束不是同一个材质实例）：
 *   batch/lamp-red · ei=1.2 emis=#ffffff map=Y · y[1.07,1.13] z[2.26,2.51] ← 贯穿尾灯带
 *   batch/lamp-red · ei=2.0 emis=#e03040 map=n · y[0.25,1.20] z[2.47,2.50] ← 后保反光条
 * 即 refTextures 的 `tail-lamp` 规则给「贯穿尾灯带」**克隆并改写了夺冠载体材质**
 * （emissiveWhite ⇒ emissive 转白 + 挂灯纹贴图），而适配器 `matById.get('lamp-red')`
 * 只持有**遍历首见的那一个**实例 ⇒ 最显眼的那条灯带可能压根不在联动链里；更根本的是
 * 刹车联动只在 `update()` 里写，**构造完成时一次都没写过** ⇒ fresh/preview 静态截图
 * 读到工厂原始值（旧口径 2.0×0.55），而 V800 同期读出 1761 ⇒ 双车静态不一致。
 *
 * 修复分两步（都在本文件，不动工厂 / refTextures）：
 *   ① 构造期就调用一次 applyTailLevel()，让静态读数 = 目标待机值；
 *   ② 把「所有仍被尾灯 mesh 实际引用的 lamp-red 实例」都纳入联动（含 refTexture 克隆），
 *      统一写**同一绝对值**，杜绝实例漂移。
 *
 * 目标值来历：由 V800 静态读数 2.5 反解（与下方 R7_TAIL_STANDBY_LEVEL 同源）：
 *   静态 = TAIL_STANDBY = 2.5；行驶中 setBrakeLights(1.6) 收敛后
 *   = 2.5 × (0.55+1.6)/(0.55+0.7) = 4.3（与旧 R7 行为逐位一致）。
 */
const R7_TAIL_STANDBY_EI = 2.6; // R36-V6：2.5→2.6（尾灯签名弱，与 V800 TAIL_BASE 同步抬基座）

// ------------------------------------------------------------------ Canvas 贴图

type Ctx2D = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

const LETTER_FONT = (size: number): string => `600 ${size}px "Helvetica Neue", Arial, sans-serif`;

/** LUXEED 宽字距尾部字标（仅文字性引用，非官方标识） */
function drawLuxeed(ctx: Ctx2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#C9CED6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = LETTER_FONT(Math.round(h * 0.62));
  const letters = 'LUXEED';
  const step = w / (letters.length + 0.6);
  const start = (w - step * (letters.length - 1)) / 2;
  for (let i = 0; i < letters.length; i += 1) {
    ctx.fillText(letters[i], start + i * step, h * 0.52);
  }
}

/** 尾部两侧小铭牌（奇瑞汽车 / 智界R7） */
function drawBadge(ctx: Ctx2D, w: number, h: number, text: string): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#C9CED6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = LETTER_FONT(Math.round(h * 0.66));
  ctx.fillText(text, w / 2, h * 0.54);
}

/** 前牌照板（智界 R7） */
function drawPlate(ctx: Ctx2D, w: number, h: number): void {
  ctx.fillStyle = '#12151A';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#2A2F36';
  ctx.lineWidth = Math.max(1, w * 0.006);
  ctx.strokeRect(w * 0.02, h * 0.06, w * 0.96, h * 0.88);
  ctx.fillStyle = '#F2F4F6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = LETTER_FONT(Math.round(h * 0.52));
  ctx.fillText('智界 R7', w / 2, h * 0.54);
}

/** 15.6" 中控屏 UI：参考图那张"水天一色"壁纸 + 底部 dock */
function drawCenterScreen(ctx: Ctx2D, w: number, h: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#E8EDF4');
  sky.addColorStop(1, '#C9D6E6');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const water = ctx.createLinearGradient(0, h * 0.58, 0, h);
  water.addColorStop(0, '#8FA6C4');
  water.addColorStop(1, '#0F1620');
  ctx.fillStyle = water;
  ctx.fillRect(0, h * 0.58, w, h * 0.42);
  // 远山
  ctx.fillStyle = 'rgba(60, 78, 104, 0.55)';
  ctx.beginPath();
  ctx.moveTo(w * 0.12, h * 0.58);
  ctx.lineTo(w * 0.34, h * 0.40);
  ctx.lineTo(w * 0.52, h * 0.58);
  ctx.closePath();
  ctx.fill();
  // 顶部状态条
  ctx.fillStyle = 'rgba(16, 20, 26, 0.55)';
  ctx.fillRect(0, 0, w, h * 0.075);
  ctx.fillStyle = '#E9EEF4';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = LETTER_FONT(Math.round(h * 0.036));
  ctx.fillText('24.5°C', w * 0.03, h * 0.038);
  ctx.textAlign = 'right';
  ctx.fillText('4G  ▮▮▮  22:14', w * 0.97, h * 0.038);
  // 底部 dock
  ctx.fillStyle = 'rgba(12, 16, 22, 0.82)';
  ctx.fillRect(0, h * 0.855, w, h * 0.145);
  const icons = 6;
  const pad = w * 0.06;
  const size = (w - pad * 2) / icons;
  for (let i = 0; i < icons; i += 1) {
    const x = pad + size * i + size * 0.5;
    ctx.fillStyle = i === 0 ? '#F0C24B' : '#DCE4EE';
    ctx.beginPath();
    ctx.roundRect(x - size * 0.26, h * 0.885, size * 0.52, size * 0.52, size * 0.13);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(220, 228, 238, 0.75)';
  ctx.font = LETTER_FONT(Math.round(h * 0.03));
  ctx.textAlign = 'center';
  ctx.fillText('24.5°C     座椅加热      风量 2', w * 0.5, h * 0.975);
}

/** 后排小屏（空调/媒体） */
function drawRearScreen(ctx: Ctx2D, w: number, h: number): void {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#101820');
  bg.addColorStop(1, '#1E2C38');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#8FB4DC';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = LETTER_FONT(Math.round(h * 0.22));
  ctx.fillText('24.5°C', w * 0.5, h * 0.36);
  ctx.fillStyle = 'rgba(220, 228, 238, 0.6)';
  ctx.font = LETTER_FONT(Math.round(h * 0.12));
  ctx.fillText('后排空调', w * 0.5, h * 0.68);
}

/** 门板白色网格扬声器罩（参考图后排那张冲孔网） */
function drawSpeakerLattice(ctx: Ctx2D, w: number, h: number): void {
  ctx.fillStyle = '#E7E1D6';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(120, 112, 100, 0.55)';
  const step = w / 22;
  for (let y = step * 0.5; y < h; y += step) {
    for (let x = step * 0.5; x < w; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, step * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 方向盘盾形标（白底盾形 + 内部竖向棱线） */
function drawSteeringShield(ctx: Ctx2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#E9E4DA';
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.06);
  ctx.lineTo(w * 0.9, h * 0.26);
  ctx.lineTo(w * 0.9, h * 0.62);
  ctx.lineTo(w * 0.5, h * 0.94);
  ctx.lineTo(w * 0.1, h * 0.62);
  ctx.lineTo(w * 0.1, h * 0.26);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#B9B2A5';
  ctx.lineWidth = Math.max(1, w * 0.02);
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.16);
  ctx.lineTo(w * 0.5, h * 0.84);
  ctx.moveTo(w * 0.34, h * 0.30);
  ctx.lineTo(w * 0.34, h * 0.70);
  ctx.moveTo(w * 0.66, h * 0.30);
  ctx.lineTo(w * 0.66, h * 0.70);
  ctx.stroke();
}

/** 仪表：10.25" 横条，速度/踏板力/挡位（15Hz 重绘） */
function drawCluster(
  ctx: Ctx2D,
  w: number,
  h: number,
  speedKmh: number,
  forceN: number,
  g: number,
  gear: string,
): void {
  ctx.fillStyle = '#060A08';
  ctx.fillRect(0, 0, w, h);
  // 弧形速度刻度
  const cx = w * 0.30;
  const cy = h * 0.58;
  const r = h * 0.34;
  ctx.strokeStyle = 'rgba(127, 216, 168, 0.22)';
  ctx.lineWidth = Math.max(2, h * 0.028);
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.82, Math.PI * 2.18);
  ctx.stroke();
  const ratio = clamp01(Math.abs(speedKmh) / 200);
  ctx.strokeStyle = '#7FD8A8';
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.82, Math.PI * (0.82 + 1.36 * ratio));
  ctx.stroke();
  ctx.fillStyle = '#EAF6EF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = LETTER_FONT(Math.round(h * 0.30));
  ctx.fillText(String(Math.round(Math.abs(speedKmh))), cx, cy);
  ctx.font = LETTER_FONT(Math.round(h * 0.075));
  ctx.fillStyle = 'rgba(234, 246, 239, 0.6)';
  ctx.fillText('km/h', cx, cy + h * 0.20);
  // 右侧：踏板力条 + G 值 + 挡位
  const bx = w * 0.58;
  const bw = w * 0.10;
  ctx.fillStyle = 'rgba(127, 216, 168, 0.16)';
  ctx.fillRect(bx, h * 0.20, bw, h * 0.60);
  const fRatio = clamp01(forceN / 1612);
  ctx.fillStyle = fRatio > 0.82 ? '#E0533F' : '#7FD8A8';
  ctx.fillRect(bx, h * 0.80 - h * 0.60 * fRatio, bw, h * 0.60 * fRatio);
  ctx.fillStyle = 'rgba(234, 246, 239, 0.65)';
  ctx.font = LETTER_FONT(Math.round(h * 0.07));
  ctx.textAlign = 'left';
  ctx.fillText('踏板力', bx, h * 0.13);
  ctx.fillStyle = '#EAF6EF';
  ctx.font = LETTER_FONT(Math.round(h * 0.11));
  ctx.fillText(`${Math.round(forceN)} N`, bx + bw + w * 0.03, h * 0.30);
  ctx.fillText(`${g.toFixed(2)} g`, bx + bw + w * 0.03, h * 0.52);
  ctx.fillStyle = '#7FD8A8';
  ctx.font = LETTER_FONT(Math.round(h * 0.16));
  ctx.fillText(gear, bx + bw + w * 0.03, h * 0.78);
}

// ------------------------------------------------------------------ 适配器主体

/**
 * 建立 R7 的 Car 适配器。
 * @param tier 质量档：high 保持 spec 玻璃透光率；medium/low 提高玻璃不透明度并关掉部分细节。
 * @param paintId R44 起语义 = **外部壳外观变体 id**（'white'|'purple'|'green'，来自
 *   vehiclePaint 变体表 / URL `#paint=`）；null = 用各车默认（白）。程序化车漆
 *   不再消费该参数，固定工厂墨绿（外部壳装载失败时的回退外观）。
 */
export function createR7CarAdapter(tier: QualityTier = 'high', paintId: string | null = null): CarLike {
  const textureSize = carTextureSizeFor(tier);
  const model = createLuxeedR7Model({ textureSize });
  const runtime = model.userData.sculptRuntime as ProceduralModelRuntime | undefined;

  const root = new THREE.Group();
  root.name = 'R7Car';
  const body = new THREE.Group();
  body.name = 'R7Body';
  body.rotation.y = R7_BASE_YAW; // 工厂车头 +Z → 游戏前进方向 -Z
  body.add(model);
  root.add(body);

  // ---- 组件索引（按 userData.sculptComponent.id；先序先命中 = 外层 pivot）----
  const byId = new Map<string, THREE.Object3D>();
  model.traverse((o) => {
    const id = (o.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
    if (id && !byId.has(id)) byId.set(id, o);
  });

  // ---- 材质索引（按 material.userData.sculptMaterial.id 建表，勿按组件 ID）----
  const matById = new Map<string, THREE.MeshPhysicalMaterial>();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const item of list) {
      const mat = item as THREE.MeshPhysicalMaterial | undefined;
      if (!mat) continue;
      const id = mat.userData?.sculptMaterial?.id as string | undefined;
      if (id && !matById.has(id)) matById.set(id, mat);
    }
  });

  // ---- 隐藏 macro 容器占位几何 ----
  // root 是整车包围盒实心盒、cabin-interior 是容器退化片：只隐藏它们**自身**的 mesh，
  // 绝不能 traverse 子树（那会把整车/整个座舱一起藏掉）。
  for (const containerId of CONTAINER_MESH_IDS) {
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const id = (mesh.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
      if (id === containerId) mesh.visible = false;
    });
  }

  // ---- R33：前脸手作精修层 ----
  // spec 的 front-fascia 是平板，headlamp-l/r 是矩形黑卡，与参考图的斜切灯腔
  // 差距最大。这里隐藏旧灯组（保留 spec 组件与材质，避免破坏 byId/matById 契约），
  // 再挂入程序化灯腔/镀铬刃/下格栅。新组在 batchMergeStatic 之前挂入 ⇒ 参与合批。
  // 隐藏只针对组件自身：headlamp-l/r 可能是 group，visible=false 会连同其下
  // projector/edging 一起不画（这些子件不再需要单独处理）。
  {
    const front = createR7FrontDetails();
    model.add(front.group);
    let hidden = 0;
    for (const id of front.hiddenComponentIds) {
      const node = byId.get(id);
      if (node && node.visible) {
        node.visible = false;
        hidden += 1;
      }
    }
    console.info(
      `[R7Adapter] R33 前脸精修：灯腔/镀铬刃/下格栅 ${Math.round(front.triangleCount)} tri，` +
        `隐藏旧件 ${hidden} 个`
    );
  }

  // ---- 玻璃档位：high 用 spec；中低档提高不透明度（省 fill rate + 避免内饰反白）----
  if (tier !== 'high') {
    for (const glassId of ['glass-dark', 'glass-clear']) {
      const mat = matById.get(glassId);
      if (!mat) continue;
      mat.transparent = true;
      mat.opacity = glassId === 'glass-dark' ? 0.74 : 0.52;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
  } else {
    // 玻璃一律走 transparent alpha，不走 transmission：透射 pass 会整场景重绘，
    // 是整帧 DC 翻倍的根因（R12 铁律）。这里显式钉死，防止以后有人回退。
    for (const glassId of ['glass-dark', 'glass-clear']) {
      const mat = matById.get(glassId);
      if (!mat) continue;
      mat.transmission = 0;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
  }

  // ---- 车漆：墨绿金属漆 clearcoat 语义（工厂已给标量，这里补齐 env 与色调）----
  const paint = matById.get('paint-green');
  if (paint) {
    paint.clearcoat = 1.0;
    paint.clearcoatRoughness = 0.08;
    paint.metalness = 0.55;
    paint.roughness = 0.18;
    paint.iridescence = 0.15;
    paint.envMapIntensity = 1.05;
    // R37-C 的显式选色落色路径退役（R44）：paintId 参数已改语义为外部壳变体 id，
    // 程序化车漆固定工厂墨绿（R7 基线外观 = 回退路径）。iridescence 是 R7 车漆
    // 的身份参数，保持不动。
    paint.needsUpdate = true;
  }
  const matte = matById.get('matte-black');
  if (matte) {
    matte.roughness = 0.78;
    matte.metalness = 0.08;
    matte.needsUpdate = true;
  }
  const wheelMat = matById.get('wheel-alloy');
  if (wheelMat) {
    wheelMat.roughness = 0.32;
    wheelMat.metalness = 0.85;
    wheelMat.envMapIntensity = 0.9;
    wheelMat.needsUpdate = true;
  }

  // ---- 灯光材质句柄（刹车 / 头灯 / 卡钳热）----
  // N-5： brakeMat 只保留兼容语义（涂料 builder 首见实例）。真正的**联动目标集**是
  // 下面 tailMatTargets —— 在 refTextures 之后重建，覆盖尾灯 mesh 实际引用的全部
  // lamp-red 实例（含被克隆改写过的贯穿灯带）。详细病根见 R7_TAIL_STANDBY_EI 注释。
  const brakeMat = matById.get('lamp-red');
  const headMats = [matById.get('lamp-head'), matById.get('lamp-white')].filter(
    (m): m is THREE.MeshPhysicalMaterial => Boolean(m),
  );
  const caliperMat = matById.get('caliper-red');
  if (caliperMat) {
    caliperMat.emissive.setHex(CALIPER_HEAT_HEX);
    caliperMat.emissiveIntensity = 0;
    caliperMat.needsUpdate = true;
  }
  const headBaseIntensity = headMats[0]?.emissiveIntensity ?? HEAD_BASE_INTENSITY;


  // ---- 参考图贴图接线（LUXEED / 铭牌 / 牌照 / 屏幕 / 网罩 / 方向盘标）----
  // 注意：同一材质 ID 被多个 mesh 复用时必须逐 mesh 克隆，否则一句话会串到所有件上
  // （"遮阳板出现 LUXEED"这类串味是 V800 付过学费的坑）。
  const anisotropy = Math.min(8, tier === 'high' ? 8 : 4);
  const cloneForMesh = (meshId: string, patch: (mat: THREE.MeshPhysicalMaterial) => void): void => {
    const node = byId.get(meshId);
    if (!node) return;
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshPhysicalMaterial;
      const clone = src.clone() as THREE.MeshPhysicalMaterial;
      clone.userData = { ...src.userData };
      patch(clone);
      clone.needsUpdate = true;
      mesh.material = clone;
    });
  };

  // ---- R25：前脸贯穿日行灯带（light-bar-front：chrome 装饰刃 → 发光 DRL）----
  // 参考图（智界 R7 前脸官方图）：全宽贯穿式日行灯是该车前脸第一识别特征（1.3m
  // 通栏白刃），原 spec 材质是 chrome——不发光装饰刃，前脸读作"缺魂"。
  // 逐 mesh 克隆为独占发光材质常亮（黄昏场景 DRL 恒亮；V800 的 front-light-bar
  // 同为常亮 lamp-white，双车口径一致）。chrome 原件不动（lamp-edging 等仍共享）。
  cloneForMesh('light-bar-front', (mat) => {
    mat.color.setHex(0xf4f7fa);
    mat.emissive.setHex(0xffffff);
    mat.emissiveIntensity = 1.6;
    mat.metalness = 0.1;
    mat.roughness = 0.22;
    mat.userData = {
      ...mat.userData,
      sculptMaterial: { ...mat.userData?.sculptMaterial, id: 'r25-r7-front-drl' }
    };
  });

  const decalTextures: THREE.Texture[] = [];
  const decal = (
    meshId: string,
    canvasW: number,
    canvasH: number,
    draw: (ctx: Ctx2D, w: number, h: number) => void,
    emissiveIntensity = 0.9,
  ): void => {
    const made = makeCanvas(canvasW, canvasH);
    if (!made) return;
    draw(made.ctx, canvasW, canvasH);
    const tex = toTexture(made.canvas, anisotropy);
    decalTextures.push(tex);
    cloneForMesh(meshId, (mat) => {
      mat.map = tex;
      mat.emissiveMap = tex;
      mat.emissive.setHex(0xffffff);
      mat.emissiveIntensity = emissiveIntensity;
      mat.transparent = true;
      mat.roughness = 0.42;
      mat.metalness = 0.1;
      mat.color.setHex(0xffffff);
    });
  };

  decal('lettering-luxeed', 1024, 128, drawLuxeed, 0.85);
  decal('badge-l', 512, 128, (ctx, w, h) => drawBadge(ctx, w, h, '奇瑞汽车'), 0.7);
  decal('badge-r', 512, 128, (ctx, w, h) => drawBadge(ctx, w, h, '智界R7'), 0.7);
  decal('front-plate', 768, 256, drawPlate, 0.0);
  decal('center-screen', 1536, 864, drawCenterScreen, 1.15);
  decal('rear-screen', 512, 288, drawRearScreen, 1.0);
  decal('steering-badge', 256, 320, drawSteeringShield, 0.35);
  for (const meshId of [
    'door-speaker-front-l',
    'door-speaker-front-r',
    'door-speaker-rear-l',
    'door-speaker-rear-r',
  ]) {
    decal(meshId, 512, 512, drawSpeakerLattice, 0.0);
  }

  // ---- 仪表：单独一块 Canvas，15Hz 重绘 ----
  const clusterMade = makeCanvas(768, 320);
  const clusterTex = clusterMade ? toTexture(clusterMade.canvas, anisotropy) : null;
  if (clusterTex) {
    decalTextures.push(clusterTex);
    cloneForMesh('cluster-screen', (mat) => {
      mat.map = clusterTex;
      mat.emissiveMap = clusterTex;
      mat.emissive.setHex(0xffffff);
      mat.emissiveIntensity = 1.35;
      mat.roughness = 0.12;
      mat.metalness = 0;
      mat.color.setHex(0xffffff);
    });
    if (clusterMade) drawCluster(clusterMade.ctx, 768, 320, 0, 0, 0, 'P');
    clusterTex.needsUpdate = true;
  }
  let lastGaugeAt = -1;
  const pushCluster = (
    speedKmh: number,
    forceN: number,
    g: number,
    gear: string,
    nowSec: number,
  ): void => {
    if (!clusterMade || !clusterTex) return;
    if (nowSec - lastGaugeAt < GAUGE_MIN_INTERVAL) return;
    lastGaugeAt = nowSec;
    drawCluster(clusterMade.ctx, 768, 320, speedKmh, forceN, g, gear);
    clusterTex.needsUpdate = true;
  };

  // ---- 车轮：枢轴即工厂 wheel-* 节点（基准 quaternion 已含 rotZ(90°)）----
  // 直接写 rotation.x 会和基准 rotZ 打架（欧拉组合 = 翻滚而非自转）；
  // 用「基准四元数 × 绕局部 Y（lathe 轴 = 车轴）」重算，才是绕世界 X 的真自转。
  interface SpinRig {
    node: THREE.Object3D;
    base: THREE.Quaternion;
    angle: number;
  }
  const spinRigs: SpinRig[] = [];
  const wheels: WheelPivot[] = [];
  const spinAxis = new THREE.Vector3(0, 1, 0);
  for (const tag of ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']) {
    const node = byId.get(tag);
    if (!node) continue;
    const rig: SpinRig = { node, base: node.quaternion.clone(), angle: 0 };
    spinRigs.push(rig);
    wheels.push({ spin: node });
  }
  const spinQuat = new THREE.Quaternion();
  const applySpin = (rig: SpinRig): void => {
    spinQuat.setFromAxisAngle(spinAxis, rig.angle);
    rig.node.quaternion.copy(rig.base).multiply(spinQuat);
  };

  // ---- 方向盘（setSteer 用；基准 rotX 约 0.32 rad）----
  const steerNode = byId.get('steering');
  const steerBase = steerNode ? steerNode.quaternion.clone() : new THREE.Quaternion();
  const steerAxis = new THREE.Vector3(0, 0, 1);
  let steerAngle = 0;
  let steerTarget = 0;
  const applySteer = (): void => {
    if (!steerNode) return;
    spinQuat.setFromAxisAngle(steerAxis, steerAngle);
    steerNode.quaternion.copy(steerBase).multiply(spinQuat);
  };

  // ---- R15 参考图贴图（与 V800 同一套 6 张实拍图，规则表按组件/材质双索引）----
  // 必须在 batchMergeStatic 之前：贴图按 userData.sculptComponent.id 定位 mesh，
  // 合批后组件身份丢失。R7 的座椅/门板/仪表台/中控屏/S 顶已并入 REF_RULES 的 R7 分支。
  {
    const mounted = applyReferenceTextures(model, { tier });
    if (mounted.length > 0) {
      console.info('[R7Adapter] 参考图贴图挂载材质：', mounted.join(', '));
    }
  }

  // ---- N-5：尾灯联动目标收集（★必须在 refTextures 之后 / batchMergeStatic 之前）----
  // refTextures 的 `tail-lamp` 规则会给「贯穿尾灯带」**克隆并改写**材质（emissiveWhite
  // ⇒ emissive 转白 + 挂灯纹贴图），早于此地就只拿到改写前的旧实例，最显眼的那条灯带
  // 永远不在联动链里（静态读作 ei=1.2 的白图，而非目标待机红）。详见 R7_TAIL_STANDBY_EI。
  const tailMatTargets: THREE.MeshPhysicalMaterial[] = [];
  {
    // 「按材质 id 全树扫描」而非 byId 按组件名：refTextures 会克隆实例（克隆保留
    // sculptMaterial.id），按组件名逐个取会漏掉克隆出的那一份（静态漏 HAVE ⇒ 一侧漂移）。
    // lamp-red 语义即「尾灯红光 + 后保反光条」（工厂 shaderNotes 明文），全收即全联动。
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mt of list) {
        const mat = mt as THREE.MeshPhysicalMaterial | undefined;
        if (!mat) continue;
        if (mat.userData?.sculptMaterial?.id !== 'lamp-red') continue;
        if (!tailMatTargets.includes(mat)) tailMatTargets.push(mat);
      }
    });
    // 兜底：极端情况下（工厂改名）退化到 matById 首见实例，避免尾灯完全不亮
    if (tailMatTargets.length === 0 && brakeMat) tailMatTargets.push(brakeMat);
  }
  /**
   * 统一写 **绝对值**（不按各实例原始基数缩放）——旧写法 `base × (0.55+level)` 会因
   * refTexture 克隆的 base（1.2）与原厂（2.0）不同而漂移；改成绝对值后静态读数恒等于
   * 目标待机值，两条灯带永远同步。
   */
  const applyTailLevel = (level: number, snap: number): void => {
    const ei =
      (R7_TAIL_STANDBY_EI * (BRAKE_BASE_INTENSITY + level)) /
        (BRAKE_BASE_INTENSITY + R7_TAIL_STANDBY_LEVEL) +
      snap * SNAP_GAIN;
    for (const mat of tailMatTargets) mat.emissiveIntensity = ei;
  };
  // ★ 构造期就写一次：静态 / preview 从不进 update()，此前读到的是工厂原始值
  //   （旧口径 2.0×0.55），而 V800 同期读出 2.5 ⇒ 双车静态口径不一致。
  applyTailLevel(R7_TAIL_STANDBY_LEVEL, 0);
  console.info(
    `[R7Adapter] N-5 尾灯联动目标 → ${tailMatTargets.length} 个 lamp-red 实例（静态 ei=${R7_TAIL_STANDBY_EI}）`
  );

  // ---- 静态合批（按材质并 mesh，1 DC 顶 N）----
  // 必须放在「所有 per-mesh 改写」之后、「逐帧驱动」之前 —— 合并器会 dispose 源几何，
  // 之后再拿 mesh 引用就是悬空对象。动态件全部显式排除。
  const dynamicNodes: THREE.Object3D[] = [
    ...spinRigs.map((r) => r.node),
    ...(steerNode ? [steerNode] : []),
  ];
  for (const id of DYNAMIC_EXCLUDE_IDS) {
    const node = byId.get(id);
    if (node) dynamicNodes.push(node);
  }
  // R15c：第一排座椅独占材质 —— 车内机位按材质隐藏（按对象隐藏会被合批吞并）
  // R17：中央隔板实体模块（center-console 中岛 / console-armrest 扶手）纳入遮挡 ——
  // 用户截图 verify/r16f/r7_cabinPassenger.png：cabinPassenger 机位被中控台挡死。
  // ⚠️ 但**不能**并进坐垫克隆：refTextures 给中岛挂的是素皮图（leather-plain
  // tileWorld 0.6）、扶手是 leather-plum 无图、坐垫是菱格图（seat-quilt
  // tileWorld 0.24）—— 混克隆会让车外机位（风挡/侧窗可见中岛）读出错误纹理。
  // 因此按「贴图态材质」分三个克隆，各自 hidden 时整批不画、显示时逐像素不变。
  /**
   * R19f：内舱暗面 = **换材质**，不是翻 side（与 V800 同构）。
   * R19/R19c 的 BackSide 方案实测是错的：body-lower / root 是**单壳实心挤出体**，
   * 切 BackSide 后外表面被剔除、相机直接看穿进壳体内部，整屏变成暗面材质的
   * 自发光底色（V800 实测 (13,8,8) 满屏），内饰全被吞掉 —— 比原问题更糟。
   * 正解：外壳始终 FrontSide，车内机位时把 paint-* 批次材质整体换成「暗车漆」克隆
   *（深色 + 零金属度 + 高粗糙 + 零虹彩），离车切回原漆。
   */
  const paintShadowPairs: Array<{ mesh: THREE.Mesh; exterior: THREE.Material; interior: THREE.Material }> = [];
  const makeInteriorPaintClone = (src: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial => {
    const clone = src.clone() as THREE.MeshPhysicalMaterial;
    clone.color.setHex(0x23282a);
    clone.emissive.setHex(0x0d1112);
    clone.emissiveIntensity = 0.55; // R19f：1.0 时自发光盖过灯光 → 满屏死黑
    clone.emissiveMap = null;
    clone.map = null;
    clone.normalMap = null;
    clone.roughnessMap = null;
    clone.metalness = 0.0;
    clone.roughness = 0.92;
    clone.envMapIntensity = 0.12;

    clone.clearcoat = 0;
    clone.iridescence = 0;
    clone.side = src.side; // 保持原 side（FrontSide）
    clone.userData = { ...clone.userData, cabinPaintShadow: true };
    clone.needsUpdate = true;
    return clone;
  };
  const cabinOccluderMats: THREE.MeshPhysicalMaterial[] = [];
  {
    // R7 的 byId「先序先命中 = 外层 pivot」：seat-driver-cushion 等命中是 Group，
    // mesh 是其子节点。R15c 旧代码直接 `byId.get(id) as THREE.Mesh` + isMesh 判据
    // 恒为 false → 遮挡克隆从未创建（verify/r16f/r7_cabinDriver.png 主驾座椅 +
    // 中控全裸露即为实证）。取源材质必须先下沉到 mesh（与 V800 meshOf 同语义）。
    const meshOf = (id: string): THREE.Mesh | null => {
      const node = byId.get(id);
      if (!node) return null;
      if ((node as THREE.Mesh).isMesh) return node as THREE.Mesh;
      let found: THREE.Mesh | null = null;
      node.traverse((o) => {
        if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
      });
      return found;
    };
    // ① 第一排座椅 6 件 + 前门内饰板：车内机位相机距门板仅 0.5m，而 R7 门板是
    //    素面 box，在画面左侧读作一面白墙（参考图 6/8 的门板有紫色上沿+网罩+
    //    扶手，缺细节）。座舱机位通行做法：近场门板不画，只留 A 柱与顶棚勾出轮廓。
    const seatSrc = meshOf('seat-driver-cushion');
    const seatMat = (seatSrc?.material ?? null) as THREE.MeshPhysicalMaterial | null;
    if (seatMat) {
      const clone = seatMat.clone();
      clone.userData.cabinHidable = true;
      for (const id of [
        'seat-driver-cushion',
        'seat-driver-back',
        'seat-driver-headrest',
        'seat-passenger-cushion',
        'seat-passenger-back',
        'seat-passenger-headrest',
        'door-card-front-l',
        'door-card-front-r',
        'door-trim-front-l',
        'door-trim-front-r',
        'door-speaker-front-l',
        'door-speaker-front-r',
      ] as const) {
        byId.get(id)?.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.material = clone;
        });
      }
      cabinOccluderMats.push(clone);
    } else {
      console.warn('[R7Adapter] cabin occluder 座椅源缺失：seat-driver-cushion');
    }
    // ② 中央模块：每件克隆自身材质（保留各自贴图/染色），互不串味
    for (const id of ['center-console', 'console-armrest'] as const) {
      const node = byId.get(id);
      const srcMesh = meshOf(id);
      const mat = (srcMesh?.material ?? null) as THREE.MeshPhysicalMaterial | null;
      if (!mat || !node) {
        console.warn('[R7Adapter] cabin occluder 组件缺失：', id);
        continue;
      }
      const clone = mat.clone();
      clone.userData.cabinHidable = true;
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = clone;
      });
      cabinOccluderMats.push(clone);
    }
    // ③ R18：中控屏框（center-screen-frame，matte-black）—— 落地审查 §6 射线实锤：
    //    副驾机位 NDC(-0.35,-0.06) 首命中即它（0.848m @world(-0.030,1.144,-0.678)），
    //    在左上视野读作一块悬浮黑板。matte-black 为共享材质，必须独占克隆后再赋给
    //    该件（R17 铁律：合批按材质实例分桶），否则隐藏会连带轮拱/立柱等 matte-black 件。
    {
      const node = byId.get('center-screen-frame');
      const srcMesh = meshOf('center-screen-frame');
      const mat = (srcMesh?.material ?? null) as THREE.MeshPhysicalMaterial | null;
      if (mat && node) {
        const clone = mat.clone();
        clone.userData.cabinHidable = true;
        node.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.material = clone;
        });
        cabinOccluderMats.push(clone);
      } else {
        console.warn('[R7Adapter] cabin occluder 组件缺失：center-screen-frame');
      }
    }
    // ④ R24：A 柱内衬板 + 仪表台下沿（leather-ivory 亮色）—— 用户截图 r7.png 指认
    //    「与 V800 中央隔板同类的车内遮挡」：cabinDriver 机位下 A 柱内衬（apillar-inner-l/r，
    //    亮象牙白）在视野左右读作两面大灰板，仪表台下沿（dash-lower，同料）糊住下半幅。
    //    参考图确认真车此处确为米白，但座舱机位通行做法 = 近场亮面板不画，只留 A 柱
    //    （matte-black）与顶棚勾出轮廓（同 ① 门板策略）。每件克隆自身材质后整体隐藏：
    //    车内机位整批不画，车外机位（风挡/侧窗透视）逐像素不变（R17 铁律：合批按材质
    //    实例分桶，独占克隆不连坐其他 leather-ivory 件）。
    for (const id of ['apillar-inner-l', 'apillar-inner-r', 'dash-lower'] as const) {
      const node = byId.get(id);
      const srcMesh = meshOf(id);
      const mat = (srcMesh?.material ?? null) as THREE.MeshPhysicalMaterial | null;
      if (!mat || !node) {
        console.warn('[R7Adapter] cabin occluder 组件缺失：', id);
        continue;
      }
      const clone = mat.clone();
      clone.userData.cabinHidable = true;
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.material = clone;
      });
      cabinOccluderMats.push(clone);
    }
    console.info(`[R7Adapter] cabin occluder 材质克隆 × ${cabinOccluderMats.length}`);
  }

  // ---- R17 绿色新能源车牌（前后各一）----
  // 同 V800 tailgate-maextro 先例：bbox 实测必须在 batchMergeStatic 之前；面片挂 body 下
  // 不进合批。后牌位 = 尾门中央 LUXEED 字带（y0.98~1.06）下方（用户参考图 100Z 鸿蒙智行
  // 牌位）；前牌位 = spec front-plate 组件面（y0.23~0.36 / z2.47，dev-spec-r7 R17 刚修出
  // 进气口的那块板）。文字「智界R7」（纯文字性引用）。
  if (typeof document !== 'undefined') {
    // R17b 修 R7 双牌「互换嵌体」：必须 root 级刷新——model 级 updateMatrixWorld 时
    // body.matrixWorld 还是陈旧单位阵（rotY π 未计入），Box3.setFromObject 内部
    // updateWorldMatrix(false,true) 也不补祖先 → bbox 停在 model 系，而 body.worldToLocal
    // 用的是新鲜 π 矩阵 → 坐标系错位，后牌被挂到车头鼻端、前牌挂进尾门（探针实锤
    // world z -2.38）。root 级刷新后 bbox/worldToLocal 全链一致。
    root.updateMatrixWorld(true);
    const tgNodeR = byId.get('tailgate');
    if (tgNodeR) {
      const tgBox = new THREE.Box3().setFromObject(tgNodeR);
      if (!tgBox.isEmpty()) {
        const c = tgBox.getCenter(new THREE.Vector3());
        const s = tgBox.getSize(new THREE.Vector3());
        const cl = body.worldToLocal(c.clone());
        mountLicensePlate({
          body,
          name: 'license-plate-rear',
          text: '智界R7',
          size: [0.42, 0.12],
          // LUXEED 字带下、两灯之间：y = 中心 - 14% 门高
          position: [cl.x, cl.y - s.y * 0.14, cl.z - s.z / 2 - 0.02],
          faceRear: true,
          ownedTextures: decalTextures
        });
      }
    }
    const fpNode = byId.get('front-plate') ?? byId.get('front-fascia');
    if (fpNode) {
      const bBox = new THREE.Box3().setFromObject(fpNode);
      if (!bBox.isEmpty()) {
        const c = bBox.getCenter(new THREE.Vector3());
        const s = bBox.getSize(new THREE.Vector3());
        const cl = body.worldToLocal(c.clone());
        mountLicensePlate({
          body,
          name: 'license-plate-front',
          text: '智界R7',
          size: [0.42, 0.12],
          position: [cl.x, cl.y + s.y * 0.15, cl.z + s.z / 2 + 0.02],
          faceRear: false,
          ownedTextures: decalTextures
        });
      }
    }
  }
  // ---- R19 续：合批后把「内舱暗面」赋给 batch/paint-* 批次（同 V800）----
  const wireBatchPaintShadow = (stats: { created: THREE.Mesh[] }): void => {
    for (const mesh of stats.created) {
      const name = mesh.name || '';
      if (!name.startsWith('batch/paint-')) continue;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const mat = mats[0] as THREE.MeshPhysicalMaterial | undefined;
      if (!mat) continue;
      paintShadowPairs.push({ mesh, exterior: mat, interior: makeInteriorPaintClone(mat) });
    }
    console.info(`[R7Adapter] batch/paint-* 内舱暗面 → ${paintShadowPairs.length} 个批次`);
  };

  // ---- R24：座舱亮面板材质级兜底遮挡（治 ① 按 id 克隆的静默漏藏）----
  // 实证（.qa/r24_r7cabin.mjs）：① 的 12 个 id 克隆实际只覆盖 5 个 mesh
  // （byId 先序命中 + 合批按材质实例/几何签名分桶，部分 id 静默 miss），
  // 前排座椅/门板/扬声器网罩仍以 leather-ivory / speaker-lattice 亮色暴露在
  // cabinDriver 机位——用户 r7.png 指认「与 V800 中央隔板同类的车内遮挡」。
  // 材质级兜底：合批后把这三类材质的**所有实例**（含合批批次，batchMerge 不复制
  // 材质实例，直接隐藏即整批不画）纳入 cabinOccluderMats。仅在 interior 机位
  // 隐藏，车外机位（风挡/侧窗透视）逐像素不变。
  // · leather-ivory / speaker-lattice：全内饰件（座椅/门板/遮阳板/方向盘/中岛/
  //   A 柱内衬/仪表台下沿/扬声器网罩），无外外观件共用；
  // · glass-dark：侧窗/后窗/天幕玻璃——座舱内斜向大亮板的真凶（R24 消去法实锤：
  //   侧窗玻璃以 ~1.35 envMapIntensity 反射黄昏天空，从驾员眼点读作右侧暖色大斜
  //   板；Game 只藏 glass-clear 前挡，侧窗不在其列）。隐藏后侧窗读作暗色门体。
  {
    const CABIN_HIDE_MATERIAL_IDS = ['leather-ivory', 'speaker-lattice', 'glass-dark'];
    const seenMat = new Set<THREE.MeshPhysicalMaterial>();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mat = m as THREE.MeshPhysicalMaterial;
        const mid = mat.userData?.sculptMaterial?.id;
        if (!mid || !CABIN_HIDE_MATERIAL_IDS.includes(mid)) continue;
        if (seenMat.has(mat)) continue;
        seenMat.add(mat);
        mat.userData.cabinHidable = true;
        cabinOccluderMats.push(mat);
      }
    });
    console.info(`[R7Adapter] 座舱亮面板材质级兜底 → ${seenMat.size} 个材质实例（leather-ivory/speaker-lattice/glass-dark）`);
  }

  // ---- R24：座舱遮挡稳健扫描（治 byId 先序命中 + 合批分桶的静默漏藏）----
  // 实证（.qa/r24_r7cabin.mjs）：按 id 逐件 byId.get().traverse() 12 件只中 5 件，
  // door-trim-*（leather-plum 门饰板）等静默 miss → cabinDriver 右前门饰板裸露成
  // 「大斜板」（用户 r7.png 指认，与 V800 中央隔板同类）。改为按
  // sculptComponent.id 正则全树扫描：每个源材质实例只克隆一次（保留各自贴图/染色，
  // 互不串味——R17 铁律），整批 cabinHidable，合批后随批次隐藏。
  {
    // R71 修①：`seat-` 细化为 `seat-(driver|passenger)-`，让 seat-rear-*（后排长凳，
    //   cabinRear 后排视角要看的主对象）不再进 hide 名单（R69 只挪机位没豁免，误藏座椅）。
    //   前排 seat-driver/passenger 维持扫成 cabinHidable（外景/副驾仍由材质级隐藏）。
    // R71-driver：seat-driver-* 在**主驾机位**由下方独占克隆（cabinHidable:false）+ 主驾区
    //   逐帧 re-assert 接管可见性（同 seat-rear 模式）；apillar-inner 由 apillarClone 豁免。
    //   探针（tools/r71_driver_probe.mjs）：主驾前视主视线不被座椅挡（座椅顶 y1.048 < 眼点
    //   1.29）、A 柱进视锥且不触近平面 ⇒ 二者「看不见」是被整批隐藏、非穿模 ⇒ 主驾区豁免。
    // R71 修①：dash-upper（上仪表台 leather-plum 紫灰大面）纳入隐藏 —— 原不在任何名单，
    //   从 rear 眼点看横在视线走廊成「带锯齿边缘的紫色大面」。主驾前视在其上沿之上
    //   (视线 z 区高度≈1.19 > 上沿 1.122)，隐藏对主驾影响小。`#r71dashhide=off` 回滚。
    const CABIN_HIDE_RE = new RegExp(
      '^(seat-(?:driver|passenger)-|door-card|door-trim|door-speaker|sun-visor|apillar-inner|dash-lower|steering-hub' +
      (R71_DASH_HIDE ? '|dash-upper' : '') +
      ')'
    );
    const cloneBySrc = new Map<THREE.MeshPhysicalMaterial, THREE.MeshPhysicalMaterial>();
    let swept = 0;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const id = mesh.userData?.sculptComponent?.id as string | undefined;
      if (!id || !CABIN_HIDE_RE.test(id)) return;
      const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshPhysicalMaterial | undefined;
      if (!src || src.userData?.cabinHidable) return;
      let clone = cloneBySrc.get(src);
      if (!clone) {
        clone = src.clone();
        clone.userData = { ...src.userData, cabinHidable: true };
        clone.needsUpdate = true;
        cloneBySrc.set(src, clone);
        cabinOccluderMats.push(clone);
      }
      mesh.material = clone;
      swept += 1;
    });
    console.info(`[R7Adapter] 座舱遮挡稳健扫描 → ${swept} mesh / ${cloneBySrc.size} 材质克隆`);
  }

  // ---- R71 修②/③：cabinRear 后排视角可见性豁免（座椅 / A 柱）+ 藏程序化顶棚 ----
  // 适配器拿不到 rig.mode（setPaintShadow 只收 interior 布尔，Game.syncInteriorOcclusion
  // 驱动 cabinOccluderMaterials 的 material.visible）。改为：为 seat-rear-* 造一支**独占**
  // 材质克隆但不纳入 cabinOccluderMats（故不被 Game 的材质级隐藏连坐），可见性完全由
  // 「相机是否在后排区」逐帧 re-assert；A 柱内衬克隆 + headliner 记下引用，同法覆盖。
  // applyRearViewOverrides 在 setPaintShadow（机位内外态切换）与 updateSteeringGate
  // （每帧）两处调用，保证覆盖 Game 写入的 material.visible=false。
  /** seat-rear-* 独占材质克隆（cabinHidable:false ⇒ 不进 cabinOccluderMats，由本段自管） */
  let rearSeatMat: THREE.MeshPhysicalMaterial | null = null;
  const rearSeatMeshes: THREE.Mesh[] = [];
  /** A 柱内衬克隆（apillar-inner-l/r 共享，cabinOccluderMats 之一）——cabinRear 豁免时显 */
  let apillarClone: THREE.MeshPhysicalMaterial | null = null;
  /** 程序化顶棚（headliner，suede-ivory）——cabinRear 藏之，消除头顶白平板 */
  let headlinerMesh: THREE.Mesh | null = null;
  {
    for (const id of ['seat-rear-cushion', 'seat-rear-back'] as const) {
      const node = byId.get(id);
      if (!node) continue;
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        rearSeatMeshes.push(mesh);
        const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshPhysicalMaterial | undefined;
        if (src && !rearSeatMat) {
          // 独占克隆（保留米白菱格贴图/染色），标记非 cabinHidable ⇒ Game 材质级隐藏不连坐
          rearSeatMat = src.clone();
          rearSeatMat.userData = { ...src.userData, cabinHidable: false };
          rearSeatMat.needsUpdate = true;
        }
        if (rearSeatMat) mesh.material = rearSeatMat;
      });
    }
    // A 柱内衬克隆：R24 ④ 段为 apillar-inner-l/r 建的独占克隆（cabinOccluderMats 之一），
    // 这里下沉到 mesh 取其当前材质实例（即那支克隆）记下，供 cabinRear 豁免时 material.visible=true。
    const apNode = byId.get('apillar-inner-l') ?? byId.get('apillar-inner-r');
    if (apNode) {
      apNode.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshPhysicalMaterial | null;
        if (m && m.userData?.cabinHidable === true && !apillarClone) apillarClone = m;
      });
    }
    headlinerMesh = (byId.get('headliner') as THREE.Mesh | undefined) ?? null;
  }
  /** 相机是否在后排区（cabinRear）——由 updateSteeringGate 每帧按 body 局部 z 无条件刷新，
   *  applyVisibility 每帧读它做 seat-rear / A 柱 / 顶棚的**双向**覆盖（W1 收敛旧系统⑥，
   *  改掉「进 rear 写 false 离开不写回」的非对称旧账）。 */
  let cameraInRearZone = false;

  // ---- R27：内饰件整体抬升（治 body-lower 壳顶「腰带台面」吞掉方向盘/仪表台）----
  // 病根（.qa/r27_pick.mjs 逐三角射线 + 侧视轮廓实测）：body-lower 是连续侧视轮廓
  // 单壳挤出，轮廓上沿（腰带线）在座舱区 z-2.05..+0.86 全程顶在 y≈1.074~1.093 ——
  // 一块比仪表台顶面（dash-upper 0.962）还高 13cm 的实体台面。驾驶眼点
  // (0.30, 1.285, -0.09) 只在台面上方 0.19m，指向仪表/方向盘的射线先命中台面：
  // NDC(0,-0.8) 首命中壳顶 0.30m，方向盘（0.83m）整块被挡，只剩顶缘一小弧。
  // V800 同款壳顶不挡，因其仪表台前伸到腰带前缘之外（dash z1.55..2.01 > 腰线前缘
  // z1.05），而 R7 仪表台整块藏在台面下方（台面前缘 z0.86 > 仪表后缘 z0.716）。
  // 外壳几何禁改（profile 上沿 = 外观侧视腰线，动它侧窗/腰带脱节），故在装配层把
  // 内饰件抬到台面之上：抬升量取自 `R27_INTERIOR_LIFT`（R49 前 0.26、R50-B 校准
  // 0.14，见文件顶部注释）。必须在合批前做——合批会把世界矩阵烘进几何。steering
  // 是 pivot，子节点 hub/badge 随动，转向旋转不受影响。
  // ⚠ R50-B：R27 原值 0.26 抬后 dash-upper 顶 1.222 > driver 眼点 1.285−安全余量
  //   ⇒ cabinDriver 视线被台面挡死（2.3% vs V800 17.0%）。同批已把 R27_INTERIOR_LIFT
  //   降到 0.14 并把眼点抬到 1.40，关系护栏见 tests/r50_r7eye.test.ts。
  {
    const LIFT_IDS = [
      'dash-upper',
      'dash-lower',
      'dash-chrome-strip',
      'dash-vent',
      'center-screen',
      'center-screen-frame',
      'cluster-screen',
      'rear-screen',
      'steering',
      'center-console',
      'console-armrest',
    ] as const;
    let lifted = 0;
    for (const id of LIFT_IDS) {
      const node = byId.get(id);
      if (!node) {
        console.warn('[R7Adapter] R27 抬升缺件：', id);
        continue;
      }
      node.position.y += R27_INTERIOR_LIFT;
      lifted += 1;
    }
    console.info(`[R7Adapter] R27 内饰抬升 +${R27_INTERIOR_LIFT}m → ${lifted}/${LIFT_IDS.length} 件`);
  }

  // ---- R30-C4：同参材质去重（Map 缓存键 = 材质 id + 参数签名，与 V800Adapter 同构）----
  // 外部审查 P0「材质实例复用」的适配层落地：同一 userData.sculptMaterial.id +
  // 同一参数签名（含贴图实例 uuid）的多个实例合并为一个。保 id 驱动逻辑不破（铁律：
  // 适配器全链按材质 id 建表 —— matById / batchMerge 分桶 / 灯光联动 / refTextures
  // 克隆缓存都按 id 寻址，合并同 id 同参实例对它们透明）。
  // 跳过名单（实例级行为件，语义上必须独立）：cabinHidable（座舱遮挡克隆，运行时
  // material.visible=false 整批不画）/ cabinPaintShadow（内舱暗面克隆）/ refTexture
  // （参考图贴图克隆，UV 已按目标 mesh 重写过）/ 无 sculptMaterial.id 的贴花材质。
  // 保留策略 = 遍历首见实例（与 matById「先序先命中」同序 ⇒ 适配器持有引用恒为保留侧）。
  {
    const SCULPT_SIG_KEYS = [
      'side', 'transparent', 'opacity', 'alphaTest', 'depthWrite', 'color', 'emissive',
      'emissiveIntensity', 'metalness', 'roughness', 'envMapIntensity', 'clearcoat',
      'clearcoatRoughness', 'flatShading', 'iridescence', 'sheen', 'transmission', 'thickness'
    ] as const;
    const TEX_KEYS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'alphaMap', 'aoMap', 'metalnessMap'] as const;
    const signatureOf = (m: THREE.Material): string => {
      const p = m as unknown as Record<string, unknown>;
      const parts = SCULPT_SIG_KEYS.map((k) => {
        const v = p[k];
        if (v && typeof v === 'object' && 'getHexString' in (v as object)) {
          return `${k}:${(v as THREE.Color).getHexString()}`;
        }
        return `${k}:${String(v)}`;
      });
      const tex = TEX_KEYS.map((k) => {
        const t = p[k] as THREE.Texture | null | undefined;
        return t ? t.uuid : '-';
      });
      return `${m.type}|${parts.join(',')}|${tex.join(',')}`;
    };
    const keep = new Map<string, THREE.Material>();
    const reassign: Array<{ mesh: THREE.Mesh; from: THREE.Material; to: THREE.Material }> = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mt of arr) {
        if (!mt) continue;
        const ud = mt.userData as {
          sculptMaterial?: { id?: string };
          cabinHidable?: boolean;
          cabinPaintShadow?: boolean;
          refTexture?: unknown;
        };
        if (ud.cabinHidable || ud.cabinPaintShadow || ud.refTexture) continue;
        const id = ud.sculptMaterial?.id;
        if (!id) continue; // 无 id 材质不并（贴花/车牌各承载不同贴图）
        const key = `${id}|${signatureOf(mt)}`;
        const hit = keep.get(key);
        if (!hit) {
          keep.set(key, mt);
          continue;
        }
        if (hit !== mt) reassign.push({ mesh, from: mt, to: hit });
      }
    });
    for (const r of reassign) {
      if (Array.isArray(r.mesh.material)) {
        r.mesh.material = r.mesh.material.map((m) => (m === r.from ? r.to : m));
      } else if (r.mesh.material === r.from) {
        r.mesh.material = r.to;
      }
    }
    if (reassign.length > 0) {
      console.info(`[R7Adapter] R30-C4 同参材质去重：${reassign.length} 个 mesh 引用合并`);
    }
  }

  const mergeResult = batchMergeStatic(model, {
    excludeObjects: dynamicNodes,
    /* R42-P0-B-R7：hood 不参与 paint-green 合批（车内保留引擎盖前缘，与 V800 的
     * hood-panel 同法）。病史（R41，R7Adapter.ts L1194 探针实证）：
     *   `batch[body-lower,hood,front-fascia,tailgate] <paint-green>` 车内下半屏首命中
     *   228 次(49.4%)；setPaintShadow(true) 整批隐藏 paint-green ⇒ 连引擎盖一起拿掉。
     * 处置：只把 `hood`（R7 spec 组件 id = `hood`，材质 paint-green，顶级 leaf 无子件）
     *   从合批摘出（excludeIds，不改合批核心）。hood 保持独立 mesh、复用同一 paint-green
     *   实例（0 新实例）；它不在 paintShadowPairs 内（wireBatchPaintShadow 只认 batch/*、
     *   L1173 暗面块只认 body-lower/root 自身 id）⇒ 车内 hood 恒可见、离车恢复。
     * 代价：可见 DC +1；tri/材质实例/UV/外观不变。回退：删本 excludeIds 一行。 */
    excludeIds: ['hood'],
    excludeMaterialIds: UV_CONTENT_MATERIAL_IDS,
    mergeTarget: model,
  });
  wireBatchPaintShadow(mergeResult);

  // ---- R29（外部审查 O1）：阴影 caster 白名单（与 V800Adapter 同构）----
  // 工厂给每个 mesh 都写了 castShadow ?? true ⇒ 130+ 件全部进 shadow pass；
  // 阴影相机正交 ±28m / 2048² ⇒ texel 27.3mm，徽标/齿环/悬浮标/后视镜/内饰
  // 只占 1~2 texel 或被车体剪影包住，对成品像素零贡献。只留车体壳 + 4 轮。
  {
    const wheelKeep = new Set<THREE.Object3D>();
    for (const w of wheels) w.spin.traverse((o) => wheelKeep.add(o));
    let kept = 0;
    let dropped = 0;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.castShadow) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const isShell = mats.some(
        (mt) =>
          SHADOW_CASTER_MATERIAL_IDS.has(
            (mt as THREE.MeshPhysicalMaterial | undefined)?.userData?.sculptMaterial?.id ?? ''
          )
      );
      if (wheelKeep.has(mesh) || isShell) {
        kept += 1;
        return;
      }
      mesh.castShadow = false;
      dropped += 1;
    });
    if (typeof window !== 'undefined' && window.location.hash.includes('shadowcaster')) {
      console.info(`[R7Adapter] #shadowcaster：保留 ${kept} / 剔除 ${dropped}`);
    }
  }

  // ---- R27：移除 R18 座舱地板衬毯（冗余且与抬升后的方向盘相交）----
  // R18 衬毯是为遮 body-lower 壳顶亮色体漆而加的浮板（y1.102，眼点下 0.18m）。
  // R19f 之后壳顶在车内机位已整体换成暗色内舱漆（setPaintShadow 材质克隆，实测
  // .qa/r27_carpet_test.mjs：隐藏衬毯后 bottom 带仅 +5~9 级，即衬毯本就只是同色
  // 浮板），衬毯既冗余又有害：① 浮板在 NDC(0,-0.8) 首命中 0.30m，把 R27 抬升后
  // 方向盘的下弧（y≈1.0~1.1 @z0.56..0.71）整段切掉；② 与抬升后的方向盘几何相交。
  // 删除后座舱读作「暗色壳顶台面 + 抬升内饰」，与 V800 同构。

  // ---- 运行时状态 ----
  let heat = 0;
  // N-5：尾灯构造即常亮待机（与 V800 TAIL_BASE=2.5 统一静态口径，推导见 R7_TAIL_STANDBY_LEVEL）
  let brakeLevel = R7_TAIL_STANDBY_LEVEL;
  let brakeTarget = R7_TAIL_STANDBY_LEVEL;
  let snapT = 0;
  let headLevel = headBaseIntensity;
  let headTarget = headBaseIntensity;
  let lastSpeedKmh = 0;
  let lastForceN = 0;
  let lastG = 0;
  let lastGear = 'P';

  // ---- R19：内舱暗面（与 V800 同构）----
  // 病根同 V800：body-lower / root 单壳的 paint-green 反面从车内读成亮色金属板
  //（R18 只用衬毯盖色，副驾/主驾下半幅仍是绿漆）。克隆「内舱暗面」材质，
  // Game 进 cabin 系机位时 setPaintShadow(true) 切 BackSide（只画反面=深色内舱）。
  // (声明已提前至 cabinOccluderMats 之前，供 wireBatchPaintShadow 使用)
  void (() => {
    const seen = new Set<THREE.Mesh>();
    for (const id of ['body-lower', 'root'] as const) {
      const node = byId.get(id);
      if (!node) continue;
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || seen.has(mesh)) return;
        if (mesh.userData?.sculptComponent?.id !== id) return; // 只认自身 id
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const src = mats[0] as THREE.MeshPhysicalMaterial | undefined;
        if (!src) return;
        seen.add(mesh);
        paintShadowPairs.push({ mesh, exterior: src, interior: makeInteriorPaintClone(src) });
      });
    }
    console.info(`[R7Adapter] 内舱暗面配对 → ${paintShadowPairs.length} 组（含合批批次）`);
  })();
  /**
   * ══ R41 车内机位「车漆外壳整批隐藏」（与 V800 同构，用户令：遮挡需下移或直接去除）══
   * 实测定罪（`tools/r41_cabin_probe.mjs`）：R7 cabin 下半屏(py≥95,462采样) 首命中
   *   `batch[body-lower,hood,front-fascia,tailgate] <paint-green>` **228 次(49.4%)**、
   *   距 0.30~0.83m；另 `dash-upper <leather-plum>` 44(9.5%) 上缘 py≈304。
   *   ⇒ 遮挡主体是车漆外壳（引擎盖/机盖），比 V800 更严重（近半屏）。
   * 处置：车内机位整批 visible=false（用户授权"直接去除"），离车恢复。
   *   露出的仪表台/方向盘距 0.76~0.96m，全在机盖之后 ⇒ 看到的是该看的东西。
   * 0 tri / 0 DC；外部机位逐像素不变。回退：删 `p.mesh.visible = !interior;` 一行。
   * ⚠ 真机目检项：车内视角露出的仪表台/方向盘无空洞、侧窗与顶棚完整。
   */
  // ---- R44 状态：外部壳句柄 / 程序化外观隐藏标记 / 最近一次内舱态 ----
  let shellHandle: ExternalShellHandle | null = null;
  /** R47：高精度方向盘（仅 cabin 态可见；外景态零 DC / 不透车外） */
  let steeringMesh: THREE.Mesh | null = null;
  /** R47：高精度盘装配成功后要恒隐藏的程序化盘（防双盘重叠 / z-fighting） */
  const proceduralSteeringMeshes: THREE.Mesh[] = [];
  /** R71：距离门控当前态 —— true = 相机过近，隐藏高精盘、显示程序化盘（applyVisibility 每帧消费） */
  let steerNearCam = false;
  // W1 删除旧账本：`proceduralExteriorHidden` / `lastInteriorState` —— 改由 applyVisibility
  // 每帧从 state + shellHandle 现算，不再持「上次态」差量（差量登记是雪崩根因）。
  /** spinWheels 弧长→角度换算半径；外部壳装载成功后取 manifest.wheelRadius */
  let wheelSpinRadius = WHEEL_RADIUS;

  /* ── R50：cabin 车顶内壁剔除（真修 R47 DoubleSide 回归，见 R50_ROOF_CLIP_WORLD_Y 注）── */
  /** index 完整副本（load 时一次性建；null ⇒ 未启用 / 回滚 / 不支持） */
  let roofCullFull: Uint32Array | null = null;
  /** 已按阈值建好的「车顶剔除」index 副本（按阈值缓存，cabinDriver 1.30 / cabinRear 1.42 各一份） */
  const roofCullByThreshold = new Map<number, Uint32Array>();
  /** 当前 bodyMesh index 处于「车顶已剔除」态时的阈值（防重复上传 ~10MB index 到 GPU） */
  let roofCullActiveAt: number | null = null;
  /** 开关：`#r50roof=off` ⇒ 不剔除（回 R47 base 态，车顶内壁重新遮挡，A/B 对照用） */
  const R50_ROOF_CULL: boolean =
    typeof window === 'undefined' || !/(?:^|[#&])r50roof=off/i.test(window.location.hash);
  /**
   * 把 bodyMesh index 切到「车顶剔除 / 完整」态（幂等，仅在态/阈值变化时重传 GPU）。
   * R71 修③：阈值按机位取 —— cabinRear 用更高的 R7_REAR_ROOF_CLIP_WORLD_Y(1.42)，
   * 连风挡上梁 header 一起剔掉，消除后排视角头顶的白平板；cabinDriver 沿用
   * R50_ROOF_CLIP_WORLD_Y(1.30，保住 hood / 仪表台)。`#r71r7roof=off` ⇒ cabinRear
   * 退回 1.30（与 cabinDriver 同阈值，只剔车顶不剔 header）。
   */
  const applyRoofCull = (active: boolean, clipWorldY: number = R50_ROOF_CLIP_WORLD_Y): void => {
    if (!roofCullFull || !shellHandle) return;
    const idx = shellHandle.bodyMesh.geometry.getIndex();
    if (!idx || !(idx.array instanceof Uint32Array)) return;
    if (!active) {
      if (roofCullActiveAt === null) return;
      idx.array.set(roofCullFull);
      idx.needsUpdate = true;
      roofCullActiveAt = null;
      return;
    }
    if (roofCullActiveAt === clipWorldY) return;
    let culled = roofCullByThreshold.get(clipWorldY);
    if (!culled) {
      const built = buildRoofCulledIndex(shellHandle.bodyMesh.geometry, shellHandle.manifest.scale, clipWorldY);
      if (!built) return;
      culled = built.culled;
      roofCullByThreshold.set(clipWorldY, culled);
    }
    idx.array.set(culled);
    idx.needsUpdate = true;
    roofCullActiveAt = clipWorldY;
  };

  /* ══════════════ W1 · 幂等可见性状态表（收敛旧 ①②③④⑤⑥ 六套显隐系统）══════════════
   * 病根（见文件头 R71/R72 注 + 《致主理人_车内视角穿帮结构性结论》§3.2）：R7 的显隐
   * 分散在 6 套系统、交叉写同一属性（mesh.visible 多套写、material.visible 3 套写），
   * 全是「差量登记 + 条件恢复」、无每帧无条件重算 ⇒ 任一系统短路/被抢先改写即状态脱节、
   * 无仲裁者（真机：全车贴图失效 + 上半部消失 + 座椅时有时无 + 切机位雪崩）。
   *
   * 修法：装配期一次性遍历 root 打静态 tag 建「一张状态表」，运行时每帧 applyVisibility
   * 全量重算 + **无条件覆盖**（不读旧值、不进 Set、不做 if(skip)）。表分两层：
   *   · 材质级（覆盖合批）：按材质实例登记（合批批次共享一实例 ⇒ 一表项管整批），
   *     管 material.visible；apillar / rearSeat 克隆按实例单独钉住 cabinRear 双向覆盖。
   *   · 网格级：按 mesh 引用登记，管 mesh.visible + 暗面用哪支材质克隆。
   * mesh 最终可见性 = 各系统语义的**合取/优先级**（先材质级、后网格级），非顺序覆盖。
   *
   * 覆盖旧系统：① windshield / cabinOccluder / paintShadow（原 Game.syncInteriorOcclusion
   *   + QA 副本，改由 Game 调 applyVisibility，删 windshieldHidden 短路）②setPaintShadow
   *   ③setExteriorHidden ④setPokeHidden ⑤cabinOccluderMats ⑥applyRearViewOverrides
   *   （非对称「进 rear 写 false 离开不写回」改按 inRearZone **双向无条件写**）。
   * 删旧账本/短路：lastInteriorState / proceduralExteriorHidden / r44HiddenMaterials /
   *   r44HiddenMeshes / r44PokeShown / r47BlockHidden / windshieldHidden(Game) /
   *   QA 副本(Game)。
   * side 重编译：material.side 切换触发 program 重编译 ⇒ apply 内对 side 保留「值变才
   *   needsUpdate」（与 visible 的无条件写不同，勿一刀切，否则每帧重编译掉帧）。
   * 暗面材质引用：paintShadowPair 存 exterior/interior **克隆引用**（存「用哪支」而非
   *   布尔标量），车内换暗面克隆、车外换回原漆（治 R19 亮铜板回归）。
   * 验收基线 = R73：seat-driver 由 cabinOccluderMats 材质级隐藏、不豁免（勿重回 R72 主驾
   *   座椅穿帮）；seat-rear / apillar 仅 cabinRear 豁免（双向）。 */

  /** `#r47cabin=off` ⇒ 逐位回滚 R44/R46 原状（整壳隐藏 + 玻璃 0.55 + 内饰全留）。
   *  提到适配器作用域（原在 setPaintShadow 内）：applyVisibility / 建表共用。 */
  const r47CabinFix = !/(?:^|[#&])r47cabin=off/i.test(
    typeof window === 'undefined' ? '' : window.location.hash
  );

  /** 材质级表项（覆盖合批：合批批次共享一材质实例 ⇒ 一表项管整批）。 */
  interface MatEntry {
    /** 不限 MeshPhysical：轮拱内衬(MeshStandard)/车牌等非 physical 材质也要能登记统一管 visible。 */
    mat: THREE.Material;
    /** R73：seat-rear 独占克隆（cabinHidable:false）——仅 cabinRear 双向显。 */
    rearSeat: boolean;
    /** R24：A 柱内衬克隆（cabinOccluderMats 之一）——cabin 隐藏但 cabinRear 豁免。 */
    apillar: boolean;
    /** 座舱遮挡克隆（cabinOccluderMats）——cabin 隐藏、车外显。 */
    cabinHidable: boolean;
    /** setExteriorHidden keep（id 白名单）⇒ 车外仍显（透出座舱）；非 keep ⇒ shell ready 后永久隐藏。 */
    kept: boolean;
  }
  /** 网格级表项（管 mesh.visible + 暗面用哪支材质克隆）。 */
  interface MeshEntry {
    mesh: THREE.Mesh;
    /** 任一材质有 sculpt id 或 cabinHidable ⇒ setExteriorHidden 不按 id-less 规则藏。 */
    hasId: boolean;
    /** 名字 ∈ R44_KEEP_MESH_NAMES ⇒ setExteriorHidden keep。 */
    keepByName: boolean;
    /** 材质级 cabinHidable 管（apillar / 座舱遮挡）⇒ mesh 恒可见、apply 不写 mesh.visible。 */
    cabinHidable: boolean;
    /** ④ 车顶穿透件（y > roofGlassY）——cabin 显、外景藏。 */
    isPoke: boolean;
    /** cabin 方块内饰（id 白名单 / keepByName≠welcome-carpet）——外景藏（#r47cabin=off 不藏）。 */
    isBlock: boolean;
    /** ① 风挡（glass-clear）——cabin 藏。 */
    windshield: boolean;
    /** ② 内舱暗面 exterior/interior **克隆引用**（存「用哪支」，非布尔标量）。 */
    pair: { exterior: THREE.Material; interior: THREE.Material } | null;
    /** ⑥ cabinRear：seat-rear 长凳（仅 cabinRear 显）/ headliner 顶棚（cabinRear 藏）。 */
    rearView: 'seat' | 'headliner' | null;
  }

  /** 状态表（buildVisibilityTable 填充；此前为空 ⇒ applyVisibility 对表空转，安全）。 */
  const matEntries: MatEntry[] = [];
  const meshEntries: MeshEntry[] = [];

  /**
   * 装配期一次性建表 + 打静态 tag。在 shell body/glass/lamp 挂载后、**轮拱内衬 / 高精盘
   * 加载前**调用 ⇒ 内衬 / 高精盘不入表（保持恒可见 / 由 steering 专属逻辑管，与 R73 一致；
   * 也因此无需为内衬特设白名单——它根本不进表、applyVisibility 不碰它）。
   * @param roofGlassY 车顶玻璃线 y（④ poke 阈值，外景藏「穿顶内饰」）
   */
  const buildVisibilityTable = (roofGlassY: number): void => {
    matEntries.length = 0;
    meshEntries.length = 0;
    const pairByMesh = new Map<THREE.Mesh, { exterior: THREE.Material; interior: THREE.Material }>();
    for (const p of paintShadowPairs) pairByMesh.set(p.mesh, { exterior: p.exterior, interior: p.interior });
    const rearSeatMeshSet = new Set<THREE.Mesh>(rearSeatMeshes);
    const matSeen = new Set<THREE.Material>();
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if ((mesh.userData as { r44External?: boolean }).r44External === true) return; // 外部壳本体
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // —— 材质级登记（按实例去重；合批批次共享实例 ⇒ 自动覆盖整批）——
      for (const mt of mats) {
        if (!mt) continue;
        if (matSeen.has(mt)) continue;
        matSeen.add(mt);
        const ud = mt.userData as { sculptMaterial?: { id?: string }; cabinHidable?: boolean };
        const id = ud?.sculptMaterial?.id ?? null;
        matEntries.push({
          mat: mt,
          rearSeat: mt === rearSeatMat,
          apillar: mt === apillarClone,
          cabinHidable: ud?.cabinHidable === true,
          kept: id != null && R44_INTERIOR_MATERIAL_IDS.has(id),
        });
      }
      // —— 网格级 tag ——
      const keepByName = R44_KEEP_MESH_NAMES.has(mesh.name);
      let hasId = false;
      let cabinHidableMesh = false;
      let isBlock = false;
      let windshield = false;
      for (const mt of mats) {
        if (!mt) continue;
        const ud = mt.userData as { sculptMaterial?: { id?: string }; cabinHidable?: boolean };
        const id = ud?.sculptMaterial?.id ?? null;
        if (ud?.cabinHidable === true) { hasId = true; cabinHidableMesh = true; }
        if (id != null) {
          hasId = true;
          if (R44_INTERIOR_MATERIAL_IDS.has(id)) isBlock = true;
          if (id === 'glass-clear') windshield = true;
        }
      }
      // welcome-carpet 是车外迎宾光毯（③ setExteriorHidden 单独 keep），不是座舱方块
      if (keepByName && mesh.name !== 'welcome-carpet') isBlock = true;
      // ④ poke：白名单 / keepByName（且非 cabinHidable）且 bbox 顶 > roofGlassY
      const whitelistedForPoke =
        keepByName ||
        mats.some((mt) => {
          const ud = mt?.userData as { sculptMaterial?: { id?: string }; cabinHidable?: boolean } | undefined;
          if (ud?.cabinHidable) return false;
          const id = ud?.sculptMaterial?.id;
          return id != null && R44_INTERIOR_MATERIAL_IDS.has(id);
        });
      let isPoke = false;
      if (whitelistedForPoke) {
        const box = new THREE.Box3().setFromObject(mesh);
        if (box.max.y > roofGlassY) isPoke = true;
      }
      meshEntries.push({
        mesh,
        hasId,
        keepByName,
        cabinHidable: cabinHidableMesh,
        isPoke,
        isBlock,
        windshield,
        pair: pairByMesh.get(mesh) ?? null,
        rearView: rearSeatMeshSet.has(mesh) ? 'seat' : mesh === headlinerMesh ? 'headliner' : null,
      });
    });
    console.info(
      `[R7Adapter] W1 可见性状态表：材质 ${matEntries.length} / 网格 ${meshEntries.length} 项` +
        `（poke 阈值 y>${roofGlassY.toFixed(2)}）`
    );
  };

  /**
   * 每帧全量重算 + 无条件覆盖（R7 显隐**唯一仲裁者**）。Game 每帧传 `interior`（rig.mode
   * 派生）；相机 / 句柄派生门控（inRearZone / steerNearCam / exteriorShellReady / roofCull）
   * 由适配器自算（依赖私有 shellHandle / body 局部系 / 盘世界距离，Game 拿不到）——
   * updateSteeringGate 已在 applyVisibility 前刷新 cameraInRearZone / steerNearCam。
   * 核心铁律：对每表项直接 `visible = computed`，**不读旧值、不进 Set、不做 if(skip)**。
   * 顺序固定：先材质级、后网格级；mesh 最终可见性算成各系统语义的合取 / 优先级。
   */
  const applyVisibility = (state: CarVisibilityState): void => {
    const interior = state.interior;
    const exteriorShellReady = shellHandle != null;
    const inRearZone = interior && cameraInRearZone; // cameraInRearZone 已含 R71_REAR_VIEW 门控
    const steerNear = R71_STEER_GATE && steerNearCam;

    model.visible = true; // ②：外部壳在场时程序化树整体保留（透明玻璃透出座舱 = 官图观感）

    // —— pass 1 · 材质级（先）：material.visible 全量覆盖 ——
    for (const e of matEntries) {
      if (e.rearSeat) e.mat.visible = interior && inRearZone;       // ⑥ seat-rear：仅 cabinRear（双向）
      else if (e.apillar) e.mat.visible = !interior || inRearZone;   // ⑥ A 柱：cabin 隐藏但 cabinRear 豁免（双向）
      else if (e.cabinHidable) e.mat.visible = !interior;           // ①⑤ 座舱遮挡：cabin 隐藏、车外显
      else e.mat.visible = e.kept || !exteriorShellReady;           // ③ 非白名单 ⇒ shell ready 后永久隐藏
    }

    // —— pass 2 · 网格级（后）：mesh.visible + 暗面材质引用 全量覆盖 ——
    for (const e of meshEntries) {
      if (e.cabinHidable) continue; // 材质级已管（apillar / 座舱遮挡），mesh 恒可见
      // ③ id-less 且非 keep ⇒ shell ready 后永久隐藏（含程序化车牌；内衬 / 高精盘不入表）
      if (!e.hasId && !e.keepByName) { e.mesh.visible = !exteriorShellReady; continue; }
      let v = true;
      if (e.isPoke) v = v && interior;                       // ④ poke：cabin 显、外景藏
      if (e.isBlock) v = v && (interior || !r47CabinFix);    // cabin 方块：外景藏（#r47cabin=off 不藏）
      if (e.windshield) v = v && !interior;                  // ① 风挡：cabin 藏
      if (e.pair) {                                          // ② 内舱暗面：换材质 + 显隐
        e.mesh.material = interior ? e.pair.interior : e.pair.exterior; // 存「用哪支克隆」
        v = interior ? false : !exteriorShellReady;          // 外景：外部壳接手 ⇒ 程序化外壳隐藏
      }
      if (e.rearView === 'seat') v = interior && inRearZone;  // ⑥ 后排长凳：仅 cabinRear（双向）
      if (e.rearView === 'headliner') v = v && !(R71_REAR_ROOF && interior && inRearZone); // ⑥ cabinRear 藏顶棚（双向）
      e.mesh.visible = v;
    }

    // —— 外部壳专属（bodyMesh / glass / lamp / side / opacity / roofCull）——
    if (shellHandle) {
      // ②：R47 不再整壳隐藏（FrontSide 背面剔除天然不遮挡座舱视线）
      shellHandle.bodyMesh.visible = r47CabinFix || !interior;
      // ②：外景态隐私玻璃完全不透明（只改 opacity，零 program 重编译）
      shellHandle.setGlassOpaque(!interior && r47CabinFix);
      // ②：cabin 态 DoubleSide 让外模内壁可见（**值变才 needsUpdate**，非每帧重编译）
      const bm = shellHandle.bodyMesh.material as THREE.MeshPhysicalMaterial;
      const wantSide = interior && r47CabinFix ? THREE.DoubleSide : THREE.FrontSide;
      if (bm.side !== wantSide) { bm.side = wantSide; bm.needsUpdate = true; }
      // ②：glass/lamp 语义件与外壳同显隐
      for (const sm of [...shellHandle.glassMeshes, ...shellHandle.lampMeshes]) {
        sm.visible = !interior;
      }
      // ② R50/R71：cabin 剔顶（cabinRear 用更高阈值连 header 一起剔；#r50roof=off 直通）
      applyRoofCull(
        interior && r47CabinFix,
        interior && cameraInRearZone && R71_REAR_ROOF ? R7_REAR_ROOF_CLIP_WORLD_Y : R50_ROOF_CLIP_WORLD_Y,
      );
    }
    // ② R47/R71：高精盘 cabin 显（近距门控覆盖）；程序化盘接管后恒隐藏、近距态恢复
    if (steeringMesh) steeringMesh.visible = interior && !steerNear;
    for (const m of proceduralSteeringMeshes) m.visible = interior && steerNear;
  };

  /* ══════════════ R44 外部壳（外观 GLB 资产化）══════════════
   * 与 V800Adapter 同构（见彼处完整注释）。差异：R7 spin 枢轴自带 rotZ(90°)
   * 基准四元数（lathe 轴），mountExternalWheel 用矩阵反解自动消化；
   * R7 轴距 2.95m（外部 hub ×4.323），fx 轮位按 manifest 同步。 */
  const R44_INTERIOR_MATERIAL_IDS = new Set<string>([
    'ambient', 'carpet', 'gauge-ui', 'leather-charcoal', 'leather-ivory', 'leather-plum',
    'pedal-metal', 'screen-ui', 'speaker-lattice', 'suede-ivory'
  ]);
  const R44_KEEP_MESH_NAMES = new Set<string>(['brake-pedal', 'cabin-floor-carpet', 'cabin-roof-carpet']);
  /* W1：旧「程序化方块内饰外景隐藏」（r47BlockHidden / setCabinBlocksHidden）、
   * 「程序化外观隐藏」（r44HiddenMaterials / r44HiddenMeshes / setExteriorHidden /
   * proceduralExteriorHidden）、「车顶穿透件」（r44PokeMeshes / r44PokeShown /
   * buildPokeList / setPokeHidden）全部删除——职责收敛进 W1 幂等状态表
   * （buildVisibilityTable 打 isBlock / hasId / keepByName / isPoke tag + applyVisibility
   * 每帧全量覆盖）。旧实现是「差量登记（进 Set）+ 条件恢复（has→delete）」，多套交叉写
   * 同一属性且依赖调用顺序（poke 必须先于 block），是切机位状态雪崩的根因之一。 */

  void (async () => {
    try {
    const shell = await loadExternalShell('r7', paintId ?? DEFAULT_VARIANT.r7);
    if (!shell) return;
    shellHandle = shell;
    // 标记外部壳子树：setExteriorHidden 必须跳过（外部壳材质无 sculpt id，
    // 否则会被「id-less 材质按名隐藏」规则连同程序化外观一起藏掉 = 壳隐形）
    shell.bodyMesh.traverse((o) => {
      (o.userData as { r44External?: boolean }).r44External = true;
    });
    for (const wm of Object.values(shell.wheelMeshes)) {
      (wm.userData as { r44External?: boolean }).r44External = true;
    }
    // R44-6 语义部件：glass（透明）/ lamp（emissive）与 bodyMesh 同级挂 body 组
    for (const sm of [...shell.glassMeshes, ...shell.lampMeshes]) {
      (sm.userData as { r44External?: boolean }).r44External = true;
      sm.castShadow = false;
      body.add(sm);
    }
    body.add(shell.bodyMesh);
    // R50：一次性建 cabin 车顶剔除的 index 双缓冲（纯 CPU，body 882,300 tri 一遍）。
    // 必须在 setPaintShadow 之前 ⇒ 首次 setPaintShadow 即可按当前内外态切 index。
    if (R50_ROOF_CULL) {
      const built = buildRoofCulledIndex(
        shell.bodyMesh.geometry, shell.manifest.scale, R50_ROOF_CLIP_WORLD_Y,
      );
      if (built) {
        roofCullFull = built.full;
        roofCullByThreshold.set(R50_ROOF_CLIP_WORLD_Y, built.culled);
        console.info(
          `[R7Adapter] R50 cabin 车顶剔除：${built.roofTris}/${built.totalTris} tri ` +
            `(world y>${R50_ROOF_CLIP_WORLD_Y})`,
        );
      } else {
        console.warn('[R7Adapter] R50 车顶剔除不可用（index 非 Uint32 / 缺失），跳过');
      }
    }
    // W1：建幂等可见性状态表 + 首次 apply。时机 = shell body/glass/lamp 已挂（已打
    // r44External ⇒ 建表自动跳过）、**轮拱内衬 / 高精盘加载前** ⇒ 二者不入表（内衬恒可见、
    // 高精盘由 steering 专属逻辑管，与 R73 一致）。一次性建表取代旧手排
    // ③setExteriorHidden → ②setPaintShadow → ④buildPokeList → ④setPokeHidden 顺序——
    // 那套顺序耦合正是雪崩根因；现在每帧 applyVisibility 全量覆盖，无需手排。
    // 首次 apply 用 exterior（interior=false）= 装配默认外景态；Game 首帧即接管逐帧覆盖。
    buildVisibilityTable(shell.manifest.bodyBBox.max[1] * shell.manifest.scale * 0.90);
    applyVisibility({ interior: false });
    /* R49-A2：阴影投影代理 —— R7 高模壳（body 882,300 + 4 轮 507,655 = 1,389,955 tri）
     * 已退出 shadow pass，改由程序化树里 R29 阴影白名单保留的车体壳 + 4 轮
     * （`SHADOW_CASTER_MATERIAL_IDS` / wheelKeep，见本文件上方同名块）复制代理承担。
     * 与 V800 同构，详见 ExternalShell.buildShadowProxies 头注。 */
    if (shadowProxyEnabled()) {
      try {
        const proxies = buildShadowProxies(root);
        console.info(
          `[R7Adapter] R49-A2 阴影投影代理：${proxies.length} 件（几何共享，colorWrite/depthWrite=false）`
        );
      } catch (err) {
        // 兜底：代理建不出来就把投影权还给高模壳（宁可多 1.39M tri，也不能丢车影）
        console.error('[R7Adapter] R49-A2 代理失败，回退高模壳投影：', err);
        shell.bodyMesh.castShadow = true;
        for (const wm of Object.values(shell.wheelMeshes)) wm.castShadow = true;
      }
    }
    // R47：高精度方向盘（内饰资产线交付，契约 .qa/r47/STEERING_CONTRACT.md）。
    // 主理人裁决：契约 §2.3 的 scale=[1,1,1] 不成立 —— body 组无 scale，
    // 外部壳件都在各自 mesh 上乘 manifest.scale ⇒ 这里同样传 scale（见 InteriorSteering.ts 头注）。
    void (async () => {
      const wheel = await loadInteriorSteering('r7', shell.manifest.scale);
      if (!wheel) return; // 失败：保持程序化方向盘，游戏零感知
      body.add(wheel);
      // 程序化方向盘（三辐双色盘 / 气囊盖+盾标 / steering-spokes）整组交给高精度盘，
      // 组件 id 精确匹配 + 全树正则（R40 铁律）；失败路径不执行 ⇒ 程序化盘保持完整。
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if ((m.userData as { r44External?: boolean }).r44External === true) return;
        if (/方向盘|steering/i.test(m.name)) proceduralSteeringMeshes.push(m);
      });
      steeringMesh = wheel;
      // W1：初值 exterior（隐藏，不透车外 / 零 DC）；此后每帧 applyVisibility 全量覆盖
      // （cabin 显高精盘、近距门控切程序化盘），不再读「上次内舱态」差量。
      wheel.visible = false;
      for (const m of proceduralSteeringMeshes) m.visible = false;
    })();
    const hubTags = ['fl', 'fr', 'rl', 'rr'] as const;
    const usedSpin = new Set<THREE.Object3D>();
    // 切割退化（静态轮）：无外部轮 mesh 时整段跳过
    for (const tag of Object.keys(shell.wheelMeshes).length > 0 ? hubTags : []) {
      try {
        const hubModel = shell.manifest.hubs[tag];
        const hubWorld = new THREE.Vector3(hubModel[0], hubModel[1], hubModel[2]);
        shell.bodyMesh.updateWorldMatrix(true, false);
        shell.bodyMesh.localToWorld(hubWorld);
        let best: { spin: THREE.Object3D; d2: number } | null = null;
        for (const w of wheels) {
          if (usedSpin.has(w.spin)) continue;
          w.spin.updateWorldMatrix(true, false);
          const p = w.spin.getWorldPosition(new THREE.Vector3());
          const d2 = p.distanceToSquared(hubWorld);
          if (!best || d2 < best.d2) best = { spin: w.spin, d2 };
        }
        if (!best) break;
        usedSpin.add(best.spin);
        mountExternalWheel(shell.bodyMesh, hubModel, best.spin, shell.wheelMeshes[tag], shell.manifest.scale);
        // R62-P0-1：挂刹车盘（随 spin 自转）+ 卡钳（挂 spin 的非自转父，静止）
        const brake = shell.brakes[tag];
        if (brake) mountExternalBrake(hubModel, best.spin, brake, shell.manifest.scale);
      } catch (err) {
        console.error(`[R44] 外部轮 ${tag} 挂载失败（该轮回退程序化轮位）:`, err);
      }
    }
    wheelSpinRadius = shell.wheelRadius;
    setFxWheelOffsets(wheelOffsetsWorldXZ(shell.manifest));
    // —— R65：R7 轮拱内衬（此前 R7 无衬板）——
    // 病灶（用户 11-10 截图）：R7 轮辐条间隙可斜视穿到舱内座椅（cabin occluder 座椅
    // seat-driver-cushion 等，line 916-925）。修法同 V800 R36-C1：拱腔内顶补哑光黑衬板，
    // 180° 弧段封死看穿路径（几何见 parts/wheelArchLiner.ts 头注；内凹封、不外凸）。
    // 落在轮胎(0.383)与拱(0.452)之间余量带，不碰轮/拱几何本体；body-local 挂 body（随 rotY π）。
    {
      const linerMat = new THREE.MeshStandardMaterial({
        color: 0x101114,
        metalness: 0.05,
        roughness: 0.85,
        side: THREE.DoubleSide // 掠射/腔内双面可见，防背面剔除漏色
      });
      linerMat.userData.sculptMaterial = { id: WHEEL_ARCH_LINER_MATERIAL_ID };
      linerMat.name = WHEEL_ARCH_LINER_MATERIAL_ID;
      let linerCount = 0;
      /* ══ R68 P0-1 · 四轮拱内衬归位（用户「两个后轮偏后、两个前轮偏前」）══════════
       * 旧值 `WHEEL_HUB_CENTERS` 是 **V800 程序化树口径** (±0.855, 0.382, ±1.715)，
       * 而 R7 外部壳真轮位来自 `manifest.hubs × 4.323` =
       *   fl/fr (±0.8884, 0.3800, +1.4594)、rl/rr (±0.8884, 0.3800, −1.4880)。
       * ⇒ 前轮衬板偏前 +255.6mm、后轮偏后 −227.0mm ⇒ 衬板没封住真轮拱，
       *   舱内 cognac / 橙色点阵从轮辐间隙透出（R65 210° 扩角只解决了角度、没解决轮位）。
       *
       * ⚠ 坐标变换式（body-local）：`body` 组带 rotY(π) 且**无 scale**，
       *   世界系 (xw, y, zw) = (−xl, y, −zl)；`wheelOffsetsWorldXZ` 返回的是
       *   **世界系** (−h[0]·s, −h[2]·s) ⇒ 直接套会再翻一次号。
       *   故 body-local 必须取 (h[0]·s, h[1]·s, h[2]·s)，s = manifest.scale。
       * 几何本体（rIn/rOut/210°/centerDeg 95）不变 ⇒ **零 tri / DC / 材质增量**。
       * `#r68arch=off` ⇒ 逐位回 R65 旧坐标（加载期求值，A/B 各自 reload 走逐字相同序列）。
       * ⚠ 键名不含 noprewarm（Game.ts 入口守卫）。
       */
      const r68ArchOn = !/(?:^|[#&])r68arch=off/i.test(
        typeof window === 'undefined' ? '' : window.location.hash
      );
      const r68HubScale = shell.manifest.scale;
      for (const corner of ['fl', 'fr', 'rl', 'rr'] as const) {
        const c = WHEEL_HUB_CENTERS[corner];
        const mesh = new THREE.Mesh(createWheelArchLiner(c.side), linerMat);
        mesh.name = `r22-arch-liner-${corner}`;
        const hub = shell.manifest.hubs[corner];
        if (r68ArchOn && hub) {
          mesh.position.set(hub[0] * r68HubScale, hub[1] * r68HubScale, hub[2] * r68HubScale);
        } else {
          mesh.position.set(c.x, c.y, c.z);
        }
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        body.add(mesh);
        linerCount += 1;
      }
      console.info(`[R7Adapter] R65 轮拱内衬接线完成（${linerCount} 角 ×哑光黑 180°）`);
    }
    console.info(
      `[R7Adapter] R44 外部壳就绪：body ${shell.manifest.tri.body} tri + 4 轮，` +
        `scale=${shell.manifest.scale} wheelR=${shell.wheelRadius} variant=${shell.variant}`
    );
    } catch (e) {
    console.error(`[R7Adapter] R44 装配失败：`, String(e));
  }
  })();

  /* R71 · 距离门控核心（滞回，与 V800Adapter 同构）：近于 NEAR 切程序化盘、远于 FAR
   * 恢复高精盘，中间保持上次态。W1：本函数只更新 steerNearCam 门控态，**不再直接写
   * visible** —— 高精盘 / 程序化盘的 mesh.visible 统一交 applyVisibility 每帧全量覆盖
   * （消除旧「applySteerGate 写一次 + setPaintShadow 写一次」双写竞态）。GLB 未装载 /
   * 门控关闭则空操作。 */
  const applySteerGate = (dist: number): void => {
    if (!R71_STEER_GATE || !steeringMesh) return;
    const next = steerNearCam ? dist < STEER_GATE_FAR_M : dist < STEER_GATE_NEAR_M;
    if (next === steerNearCam) return;
    steerNearCam = next; // visible 写交给 applyVisibility（每帧全量覆盖）
  };

  // W1：不标 `: CarLike` —— R7 额外暴露 `applyVisibility`（CarLike 定义在 V800Adapter.ts，
  // 本批 sha 冻结禁改，无法加可选成员）。去掉注解让 TS 推断含 applyVisibility 的 richer
  // 类型，`return api` 仍按函数返回类型 CarLike 做结构检查（缺 CarLike 必需成员照样报错），
  // 多出的 applyVisibility 对非新鲜字面量不触发 excess-property 检查。Game 侧用
  // `CarLike & { applyVisibility? }` 交叉类型读取（与既有 interiorViews 读取同款）。
  const api = {
    root,
    body,
    wheels,
    // R15：内饰三机位（装配局部坐标），由 Game → CameraRig.setInteriorViews 消费
    interiorViews: R7_INTERIOR_VIEWS,
    cabinOccluderMaterials: cabinOccluderMats,
    // W1：唯一显隐仲裁入口 —— Game 每帧无条件调（删旧 windshieldHidden 短路 + QA 副本）
    applyVisibility,
    setSteeringCameraDistance: applySteerGate,
    updateSteeringGate(camera: THREE.Camera): void {
      /* R71：Game 每帧调用 —— 高精盘挂 body 下（有变换），须用世界位置算距离。 */
      // W1：先按 body 局部 z 判定相机是否在后排区（cabinRear），**每帧无条件刷新**
      // cameraInRearZone（不再 if-change 早退、不再就地调 applyRearViewOverrides）。
      // 放在 R71_STEER_GATE / steeringMesh 早退之前 —— GLB 未装载时也要跟踪。
      // Game 在 syncInteriorOcclusion → applyVisibility 之前调本方法 ⇒ 这里刷新的
      // cameraInRearZone 当帧即被 applyVisibility 的 seat-rear / A 柱 / 顶棚覆盖消费。
      camera.getWorldPosition(STEER_GATE_TMP_VEC);
      const localCam = body.worldToLocal(STEER_GATE_TMP_VEC);
      cameraInRearZone = R71_REAR_VIEW && localCam.z < R7_REAR_ZONE_LOCAL_Z;
      if (!R71_STEER_GATE || !steeringMesh) return;
      steeringMesh.getWorldPosition(STEER_GATE_TMP_VEC_B);
      applySteerGate(STEER_GATE_TMP_VEC.distanceTo(STEER_GATE_TMP_VEC_B));
    },
    get currentHeat(): number {
      return heat;
    },
    set currentHeat(value: number) {
      heat = value;
    },

    spinWheels(dist: number, _dt: number): void {
      const raw = (dist / wheelSpinRadius) * MS_TO_RPM_SCALE;
      const step = Math.sign(raw) * Math.min(Math.abs(raw), MAX_WHEEL_STEP_PER_FRAME);
      if (step === 0) return;
      for (const rig of spinRigs) {
        // 归一到 (-π, π]，防止无界增长后的浮点精度退化
        rig.angle = THREE.MathUtils.euclideanModulo(rig.angle - step + Math.PI, Math.PI * 2) - Math.PI;
        applySpin(rig);
      }
    },

    setBrakeLights(intensity: number): void {
      /* R64：Game 每帧调用，值未变时跳过标量写；`#r64lampdirty=off` ⇒ 逐位回 R63。 */
      const next = clamp01(intensity);
      if (R64_LAMP_DIRTY_ON && brakeTarget === next) return;
      brakeTarget = next;
    },

    flashBrakeSnap(): void {
      snapT = 1;
    },

    setHeadlights(on: boolean): void {
      const next = on ? headBaseIntensity : HEAD_DIM_INTENSITY;
      if (R64_LAMP_DIRTY_ON && headTarget === next) return;
      headTarget = next;
    },

    setBrakeHeat(t: number): void {
      heat = clamp01(t);
    },

    updateCluster(speedKmh: number, forceN: number, g: number, gear: string): void {
      lastSpeedKmh = speedKmh;
      lastForceN = forceN;
      lastG = g;
      lastGear = gear;
      pushCluster(speedKmh, forceN, g, gear, performance.now() * 0.001);
    },

    setSteer(angle: number): void {
      // R7 玩法是直线制动，转向只是视觉回正：钳到 ±0.42 rad（≈24°）避免打穿轮拱
      steerTarget = THREE.MathUtils.clamp(angle, -0.42, 0.42);
    },

    snapPedal(): void {
      // R7 玩法不实现踏板断裂（第二辆车只跑制动评分，不做断裂演出）。
      // 接口必须在：Game 对两辆车走同一条 update 路径，缺方法会在运行时炸。
    },

    resetPedal(): void {
      // 同上：空实现是契约的一部分，不是遗漏。
    },

    update(_camera: THREE.Camera, dt: number): void {
      const nowSec = performance.now() * 0.001;
      // 刹车灯：平滑 + snap 爆闪
      brakeLevel = damp(brakeLevel, brakeTarget, BRAKE_FADE_K, dt);
      snapT = damp(snapT, 0, 6, dt);
      if (snapT < 0.001) snapT = 0;
      // N-5：写 tailMatTargets 全目标集（含 refTexture 克隆），且是**绝对值**口径
      // （旧的 brakeMat × brakeBaseIntensity 相对写法会随 instances 的初始 ei 漂移）。
      applyTailLevel(brakeLevel, snapT);
      // 头灯
      headLevel = damp(headLevel, headTarget, 14, dt);
      for (const mat of headMats) mat.emissiveIntensity = headLevel;
      // R44-6 外部壳灯组：尾灯跟随统一待机口径、头灯随 headLevel（外景态接管反馈）
      const extRear = shellHandle?.lampRearMat;
      if (extRear) {
        extRear.emissiveIntensity = R48_LAMP_TONE
          ? 0.30 + (brakeLevel + snapT * SNAP_GAIN * 0.12) * 0.85
          : (R7_TAIL_STANDBY_EI * (BRAKE_BASE_INTENSITY + brakeLevel)) /
              (BRAKE_BASE_INTENSITY + R7_TAIL_STANDBY_LEVEL) +
              snapT * SNAP_GAIN; // R47 原状（A/B 回滚）
        /* ══ R51-B1-a · 压亮灯态过曝（`RED_bright 5738` → 门 ≤200）════════════
         * R48 只压了待机态：亮灯/刹车时 Game 把 `setBrakeLights(8)` 写进
         * `brakeTarget`，damp 后 `brakeLevel` 升到 8 ⇒ 上式 ei≈7.1，ACES 把
         * 荧光红 `0xff1e14` 的 G/B 抬进饱和 = 荧光纯红撕裂块。
         * 本子项**三处都只动数值/上限**：
         *   ① 待机系数按官图深红反推 0.30+0.85·L → 0.16+0.34·L（R7 待机 0.895→0.398）；
         *   ② 全局 clamp ≤ R51_TAIL_EI_MAX(1.15)（与 R48 待机口径同源）；
         *   ③ ExternalShell.ts 把 emissive 从荧光红改深红 0x7a1f1a（同子项）。
         * **不改联动链结构、不改 brakeLevel 初值 R7_TAIL_STANDBY_LEVEL、不碰物理**。
         * ⚠ 原 R48/R47 公式字符串逐字保留在上面（r48_lamp.test.ts 源码契约钉着），
         *   R51 开启时以「覆盖写」生效；`#r51tail=off` ⇒ 不进覆盖分支，逐位回 R50。 */
        if (R51_TAIL_ON) {
          extRear.emissiveIntensity = Math.min(
            0.16 + (brakeLevel + snapT * SNAP_GAIN * 0.12) * 0.34,
            R51_TAIL_EI_MAX
          );
        }
      }
      const extFront = shellHandle?.lampFrontMat;
      if (extFront) {
        extFront.emissiveIntensity = 0.12 + (headLevel / Math.max(headBaseIntensity, 1e-3)) * 0.78;
        /* R51-B3：前灯纯 emissive 联动同步降级（ExternalShell 构造初值会被每帧覆盖）。
         * `#r51lamp=off` ⇒ 不进覆盖分支，逐位回 R50 的 0.12+0.78·ratio。 */
        if (R51_LAMP_ON) {
          extFront.emissiveIntensity = 0.10 + (headLevel / Math.max(headBaseIntensity, 1e-3)) * 0.08;
        }
      }
      // 刹车热：卡钳暗红自发光
      if (caliperMat) caliperMat.emissiveIntensity = heat * 1.1;
      // 方向盘回正
      steerAngle = damp(steerAngle, steerTarget, 12, dt);
      if (Math.abs(steerAngle) > 1e-5) applySteer();
      // 仪表按 15Hz 节流重绘（updateCluster 的挡位可能在两次调用间变化）
      pushCluster(lastSpeedKmh, lastForceN, lastG, lastGear, nowSec);
    },

    dispose(): void {
      // R44 外部壳（几何/材质/贴图独立持有，显式释放）
      shellHandle?.dispose();
      shellHandle = null;
      for (const tex of decalTextures) tex.dispose();
      if (clusterTex) clusterTex.dispose();
      const disposedMats = new Set<THREE.Material>();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const item of list) {
          if (!item || disposedMats.has(item)) continue;
          disposedMats.add(item);
          for (const slot of TEXTURE_SLOTS) {
            const tex = (item as unknown as Record<string, THREE.Texture | null>)[slot];
            if (tex && tex !== clusterTex && !decalTextures.includes(tex)) tex.dispose();
          }
          item.dispose();
        }
      });
      root.removeFromParent();
    },
  };

  // 合批结果挂到 userData 供 QA/性能核对（不参与渲染）
  root.userData.r7Merge = {
    meshesBefore: mergeResult.meshesBefore,
    meshesAfter: mergeResult.meshesAfter,
    drawCallsBefore: mergeResult.drawCallsBefore,
    drawCallsAfter: mergeResult.drawCallsAfter,
    trianglesAfter: mergeResult.trianglesAfter,
    skipped: mergeResult.skipped.length,
    problems: mergeResult.problems,
  };
  root.userData.r7Runtime = runtime ? { nodes: Object.keys(runtime.nodes).length } : null;

  return api;
}
