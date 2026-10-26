/**
 * V800 新工厂 → 游戏运行时适配器。
 * 将 img2threejs 生成的 createZunjieV800LuxuryMPVModel 包装为 Car 兼容接口：
 * root/body/wheels/灯光联动/悬浮轮标/动态仪表。
 * 车头朝向：游戏前进方向 -Z，新工厂车头 +Z → root 内置 rotY(PI) 中枢。
 */
import * as THREE from 'three';
import { GRAVITY } from '../config/physics';
import { carTextureSizeFor, type QualityTier } from '../config/quality';
import { damp, makeLcg } from '../util/math';
import { mergeSafe } from '../util/geo';
import { batchMergeStatic, UV_CONTENT_MATERIAL_IDS } from './batchMerge';
import { applyReferenceTextures } from './refTextures';
import { mountLicensePlate } from './plateTexture';
import { createTailgateCreaseGeometry } from './parts/tailgatePanel';
import {
  createTailLamp,
  createTailLampMaterials,
  makeEaglePanelTexture,
  TAIL_LAMP_GOLD_BRAKE_RATIO,
  TAIL_LAMP_STANDBY,
  type TailLampMaterials
} from './parts/tailLamp';
import { createHeadLamp, createHeadLampMaterials, type HeadLampMaterials } from './parts/headLamp';
import {
  createWindowTrim,
  createWindowTrimMaterials,
  createGlassBand,
  createGlassBandMaterial
} from './parts/windowTrim';
import { createWheelHub, createWheelHubMaterials, type WheelHubSide } from './parts/wheelHub';
import {
  createRoofPod,
  ROOF_POD_POSITION_SPEC_FRAME,
  ROOF_POD_REPLACE_IDS
} from './parts/roofPod';
import { createFrontFascia } from './parts/frontFascia';
import { createMirrors, MIRROR_HIDE_IDS } from './parts/mirror';
import { createBadgeCore } from './parts/badgeCore';
import { createQuarterPatch, QUARTER_PATCH_MATERIAL_ID } from './parts/quarterPatch';
import {
  createZunjieV800LuxuryMPVModel,
  type ProceduralModelRuntime,
} from './createV800Model';
import {
  createBrakePedalTexture,
  createSeatQuiltTexture,
  createSteeringHubTexture,
  createSteeringWheelTexture
} from './interiorTextures';

export interface WheelPivot {
  /** 滚动旋转对象（绕 X 轴） */
  spin: THREE.Object3D;
}

export interface CarLike {
  readonly root: THREE.Group;
  /** 俯仰/翻转作用组（crash 时重置姿态） */
  readonly body: THREE.Group;
  readonly wheels: WheelPivot[];
  currentHeat: number;
  spinWheels(dist: number, dt: number): void;
  setBrakeLights(intensity: number): void;
  flashBrakeSnap(): void;
  setHeadlights(on: boolean): void;
  setBrakeHeat(t: number): void;
  updateCluster(speedKmh: number, forceN: number, g: number, gear: string): void;
  setSteer(angle: number): void;
  /** 踏板断裂：刹车踏板绕顶端转轴翻脱并落进脚窝（纯运动学，不进 cannon） */
  snapPedal(): void;
  /** 复位踏板几何（重开一局） */
  resetPedal(): void;
  update(camera: THREE.Camera, dt: number): void;
  dispose(): void;
  /**
   * 【可选】装配局部坐标（= spec 坐标，未含 body.rotation.y=π）下的内饰机位。
   * R7 提供 driver/passenger/rear 三处（Game → CameraRig.setInteriorViews 消费）；
   * V800 不提供 → CameraRig 只走内置 `cabin` 单机位。
   * 结构型声明（不 import config/vehicles）避免装配层反向依赖运行时配置。
   */
  readonly interiorViews?: Record<
    'driver' | 'passenger' | 'rear',
    { eye: [number, number, number]; target: [number, number, number] }
  >;
  /**
   * 【可选】车内机位专用遮挡**材质**（第一排座椅独占克隆）。Game 在 cabin 系机位期间
   * 把它 `visible=false`，整批不画 —— 与合批实现解耦（按对象隐藏会被合批吞并）。
   */
  readonly cabinOccluderMaterials?: readonly THREE.Material[];
  /** R19：进入/离开 cabin 系机位时切换车漆内舱暗面（BackSide 渲染） */
  setPaintShadow?: (interior: boolean) => void;
}

const MS_TO_RPM_SCALE = 2.6; // 视觉轮速系数（车轮半径 0.382，弧度 = dist/r，视觉略放大）
/**
 * 单帧最大转角（rad）。
 * 推导：轮圈盘缘是 20 开窗的旋转对称图案，走样（车轮频闪/倒转错觉）的奈奎斯特阈值是
 * 每帧转角 < π/20 ≈ 0.157 rad；取 0.9 安全系数得 0.14。
 * 60fps 下最大视觉轮速 8.5 rad/s ≈ 1.35 转/秒，读作"快速旋转"且不走样。
 * 200km/h 的真实轮速是 145 rad/s，但在 20 开窗图案下物理真值本身必然走样——
 * 实时渲染只能在"转得对"和"看着不倒转"之间二选一，这里选后者。
 */
const MAX_WHEEL_STEP_PER_FRAME = (Math.PI / 20) * 0.9;
/** 仪表重绘最小间隔（s）→ 15Hz 上限，避免 512×288 Canvas 每帧重绘 + 纹理上传 */
const GAUGE_MIN_INTERVAL = 1 / 15;

/**
 * 灯光材质 ID 契约（按材质 ID 查表，不再依赖组件 ID）。
 * 工厂里每个材质都带 material.userData.sculptMaterial.id，逐个回退，全链缺失才 warn 一次。
 */
const LAMP_MATERIAL_IDS = {
  /** 尾灯 + 宫灯红点阵：随踏板力上升（无高位刹车灯，实车 82 张参考图均未出现） */
  brake: ['lamp-red'],
  /** 头灯发光内芯：常亮，setHeadlights 控制明暗 */
  head: ['lamp-head', 'lamp-star', 'lamp-white'],
  /** MAEXTRO 字标：呼吸发光（贴图由集成层出） */
  mark: ['lamp-mark', 'lamp-white'],
} as const;

/** 星空顶星点数（真车 800+；按质量档递减，低档只保留观感骨架） */
const STARLIGHT_DENSITY: Record<QualityTier, number> = {
  high: 800,
  medium: 450,
  low: 220,
};
/**
 * 轮圈盘面贴图尺寸（真车封闭大饼 + 盘缘 20 开窗）。
 * 512 已足够：盘面在追尾/侧视角下占屏比例小，且要省显存与启动期生成耗时。
 */
const WHEEL_FACE_SIZE: Record<QualityTier, number> = {
  high: 512,
  medium: 512,
  low: 256,
};
/** 盘缘开窗数：参考图清单第七章目测 18–20 个，取 20 */
const WHEEL_WINDOWS = 20;
/**
 * EX-34 轮胎图集宽度（px）：胎面/胎侧各半幅。high 1024（胎侧字环字高 ≈ 19px），
 * 中低 512（字环 ≈ 10px，轮胎在屏上占比小，低档只保留身份读感）。
 */
const TIRE_ATLAS_W: Record<QualityTier, number> = { high: 1024, medium: 512, low: 512 };
/** EX-33 轮心盾徽贴图边长（px） */
const WHEEL_BADGE_SIZE: Record<QualityTier, number> = { high: 512, medium: 256, low: 256 };
/** EX-09 迎宾光毯贴图宽度（px，画布 4:3 与投影面同纵横比） */
const CARPET_TEX_SIZE: Record<QualityTier, number> = { high: 512, medium: 384, low: 256 };
/** EX-09 投影面尺寸（m）：宽（X）× 长（Z）——光斑主体收进车宽内，贴门下沿 */
const WELCOME_CARPET_W = 0.44;
const WELCOME_CARPET_L = 0.54;
/** 投影面离地高度（m）：避开车轮/路面 z-fight，又低于踏板视差 */
const WELCOME_CARPET_Y = 0.018;
/** 四车门下方的投影面落点（工厂坐标，X=±0.90 贴门下沿不外溢路面；Z 取门板中心） */
const WELCOME_CARPET_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [0.90, 0.85],
  [-0.90, 0.85],
  [0.90, -0.95],
  [-0.90, -0.95]
];
/** 迎宾态速度门限（km/h）：低于它光毯淡入，高于它淡出（行驶中无迎宾态） */
const WELCOME_CARPET_SPEED_GATE = 5;
/** 星空呼吸基准强度 / 周期（s） / 幅度 */
const STARLIGHT_BASE_INTENSITY = 0.9;
const STARLIGHT_BREATH_PERIOD = 4;
const STARLIGHT_BREATH_AMPLITUDE = 0.08;
/** 字标呼吸：基准强度（材质自带优先）与幅度 */
const MARK_BASE_INTENSITY = 2.2;
const MARK_BREATH_AMPLITUDE = 0.16;
/** 尾灯中部签名屏（lamp-gold）比上下横带暗：取 brakeLevel × 0.75 */
const GOLD_BRAKE_RATIO = 0.75;

/** 非 high 档把 transmission 降级为普通半透明时的不透明度（按材质 ID） */
const GLASS_OPACITY_FALLBACK: Record<string, number> = {
  // 隐私玻璃降级也应偏暗不偏透（与上方 high 档隐私玻璃观感一致）
  'glass-dark': 0.68,
  'glass-clear': 0.4,
  crystal: 0.6,
};
const DEFAULT_GLASS_OPACITY = 0.5;

/** 材质 dispose 时需要级联释放的贴图槽 */
const TEXTURE_SLOTS = [
  'map',
  'roughnessMap',
  'normalMap',
  'aoMap',
  'bumpMap',
  'displacementMap',
  'emissiveMap',
  'alphaMap',
  'envMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularColorMap',
  'specularIntensityMap',
  'thicknessMap',
  'transmissionMap',
  'anisotropyMap',
] as const;

// ---------------------------------------------------------------------------
// 集成层程序化贴图：spec 把 starlight / lamp-mark / lamp-gold 声明为 textureless，
// 这三张贴图由集成层（本文件）用 Canvas 现画，dispose 时随 emissiveMap 级联释放。
// ---------------------------------------------------------------------------

/** 顶棚星空：3 档星点大小 + 少量流星轨迹，1024×512 */
function createStarlightTexture(starCount: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  // 深空底：中间略亮，四周压暗，避免顶棚发灰
  ctx.fillStyle = '#04060c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const glow = ctx.createRadialGradient(
    canvas.width * 0.5,
    canvas.height * 0.5,
    0,
    canvas.width * 0.5,
    canvas.height * 0.5,
    canvas.width * 0.55
  );
  glow.addColorStop(0, 'rgba(30, 46, 78, 0.55)');
  glow.addColorStop(1, 'rgba(4, 6, 12, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const rnd = makeLcg(0x5631a0); // 固定种子：每次加载星空图案一致
  for (let i = 0; i < starCount; i++) {
    const x = rnd() * canvas.width;
    const y = rnd() * canvas.height;
    const roll = rnd();
    // 3 档大小：亮星 ~6%、中星 ~22%、暗星 ~72%
    const radius = roll > 0.94 ? 2.3 : roll > 0.72 ? 1.4 : 0.8;
    const alpha = 0.32 + rnd() * 0.68;
    // 色温微调：偏冷白 → 暖白
    const warm = rnd();
    const r = Math.round(214 + warm * 41);
    const g = Math.round(226 + warm * 24);
    const b = Math.round(255 - warm * 25);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (radius > 2) {
      // 亮星加一圈柔光
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.16})`;
      ctx.beginPath();
      ctx.arc(x, y, radius * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 流星轨迹：3 条，从右上向左下掠过
  for (let i = 0; i < 3; i++) {
    const x0 = canvas.width * (0.15 + rnd() * 0.7);
    const y0 = canvas.height * (0.05 + rnd() * 0.4);
    const len = 90 + rnd() * 130;
    const x1 = x0 - len;
    const y1 = y0 + len * 0.42;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(226, 240, 255, 0.85)');
    grad.addColorStop(1, 'rgba(226, 240, 255, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** MAEXTRO 字标：深色底 + 白色字样，字高占画布 ~55%，居中 */
function createMarkTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f2f4f7';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 字高 ≈ 画布高 55%（70px / 128px），先用 100px 量再横向压缩到目标宽度
  ctx.font = 'bold 100px "Segoe UI", Arial, sans-serif';
  const targetWidth = canvas.width * 0.86;
  const natural = ctx.measureText('MAEXTRO').width;
  const scale = Math.min(1, targetWidth / natural);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, 1);
  ctx.fillText('MAEXTRO', 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 尾灯中部签名屏：16×24 金色点阵「展翅鹰形 + 中央盾形」 */
const GOLD_MATRIX_PATTERN: readonly string[] = [
  '##............##',
  '####........####',
  '#####......#####',
  '.#####....#####.',
  '..#####..#####..',
  '...##########...',
  '....########....',
  '.....######.....',
  '......####......',
  '.......##.......',
  '......####......',
  '.....######.....',
  '....########....',
  '...###....###...',
  '..###......###..',
  '.###........###.',
  '................',
  '.....######.....',
  '....########....',
  '....########....',
  '.....######.....',
  '......####......',
  '.......##.......',
  '................',
];

/**
 * 尾灯中部签名屏 + 音响格栅 分区图集（512×512）。
 *
 * P1-1 修复：lamp-gold 是共享材质 —— 金色签名屏（lantern-signature-l/r）与
 * 4 扬声器 + 2 高音罩共用一份 emissiveMap，此前音响格栅显示金色点阵（串味）。
 * 解法沿用 EX-07/EX-28 图集先例：
 *   左区 = 点阵屏图案区（供签名屏重映射落点）；
 *   右区 = 素面拉丝金暗场（供 6 个音频组件重映射落点，近黑基底 × 材质金色 albedo
 *          = 只留极弱暖光晕，点阵彻底消失）。
 * 图案区按 cell=20 绘制 16×24 = 320×480，纵横比 2:3 与签名屏 0.09×0.135m 完全一致
 * （原 384×576 同为 2:3），图案布局/配色逐格不变 —— 尾灯金屏观感零变化。
 * 音频组件 UV 由 remapUV 在 batchMergeStatic 之前烘进源几何。
 */
/** 签名屏点阵在图集内的 UV 分区（cell=20 图案画在画布 x[8,328] y[16,496]） */
const GOLD_PATTERN_REGION = Object.freeze([8 / 512, 328 / 512, 16 / 512, 496 / 512]);
/** 音响格栅素面拉丝金 UV 分区（画布 x[348,502] y[10,502]） */
const GOLD_BRUSHED_REGION = Object.freeze([348 / 512, 502 / 512, 10 / 512, 502 / 512]);

function createGoldAtlasTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  // 全幅黑底：黑 = 零发光，任何未覆盖区域都不会漏光
  ctx.fillStyle = '#080604';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cols = 16;
  const rows = GOLD_MATRIX_PATTERN.length; // 24
  const cell = 20;
  const ox = 8;
  const oy = 16;
  // 未点亮的点也画一颗极暗的，保留点阵面板质感
  ctx.fillStyle = 'rgba(201, 168, 107, 0.07)';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.beginPath();
      ctx.arc(ox + (c + 0.5) * cell, oy + (r + 0.5) * cell, cell * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 点亮羽翼/盾形轮廓（金色 #C9A86B 系，中心略亮形成辉光梯度）
  for (let r = 0; r < rows; r++) {
    const line = GOLD_MATRIX_PATTERN[r];
    for (let c = 0; c < cols && c < line.length; c++) {
      if (line[c] !== '#') continue;
      const cx = ox + (c + 0.5) * cell;
      const cy = oy + (r + 0.5) * cell;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.42);
      grad.addColorStop(0, 'rgba(255, 236, 196, 0.98)');
      grad.addColorStop(0.45, 'rgba(201, 168, 107, 0.9)');
      grad.addColorStop(1, 'rgba(201, 168, 107, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- 右区：素面拉丝金暗场（音频组件落点）----
  // 近黑暖底 + 细横向拉丝：emissive 上只留极弱织理（×1.8 强度后≈0.02 亮度，不点阵），
  // 金属观感由材质自身的 #C2A263 albedo + metalness 1.0 + envMap 承担。
  const bx0 = GOLD_BRUSHED_REGION[0] * S;
  const bx1 = GOLD_BRUSHED_REGION[1] * S;
  const by0 = (1 - GOLD_BRUSHED_REGION[3]) * S;
  const by1 = (1 - GOLD_BRUSHED_REGION[2]) * S;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx0, by0, bx1 - bx0, by1 - by0);
  ctx.clip();
  const bgrad = ctx.createLinearGradient(bx0, 0, bx1, 0);
  bgrad.addColorStop(0, 'rgb(22, 17, 10)');
  bgrad.addColorStop(0.5, 'rgb(34, 26, 15)');
  bgrad.addColorStop(1, 'rgb(22, 17, 10)');
  ctx.fillStyle = bgrad;
  ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
  // 拉丝：细横线（沿 U 向），亮度微抖，确定性 LCG
  const rnd = makeLcg(0x9d15b3);
  for (let y = by0; y <= by1; y += 2) {
    const a = 0.04 + rnd() * 0.07;
    ctx.strokeStyle = `rgba(201, 168, 107, ${a.toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx0, y + (rnd() - 0.5) * 0.8);
    ctx.lineTo(bx1, y + (rnd() - 0.5) * 0.8);
    ctx.stroke();
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 轮圈盘面贴图：封闭大饼 + 盘缘 20 开窗 + 中央曜日盾标。
 * 真车是封闭大饼轮圈（参考图清单第七章：盘缘开窗目测 18–20 个），不是细辐条——
 * 辐条几何已从 spec 删除，开窗形态由这张贴图承担，1 个 draw call。
 */
function createWheelFaceTexture(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;

  // 盘面：亮银抛光底 + 由内向外的柔和缎面渐变
  ctx.fillStyle = '#C8CACD';
  ctx.fillRect(0, 0, size, size);
  const face = ctx.createRadialGradient(c, c, size * 0.05, c, c, c);
  face.addColorStop(0, 'rgba(238, 240, 244, 0.95)');
  face.addColorStop(0.55, 'rgba(190, 194, 200, 0.55)');
  face.addColorStop(1, 'rgba(120, 124, 130, 0.85)');
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();

  // 盘缘 20 开窗：周向均分的圆角梯形镂空（露黑色轮辋内壁）
  const rOuter = c * 0.995;
  const rInner = c * 0.80;
  const rMid = (rOuter + rInner) / 2;
  const halfW = (Math.PI / WHEEL_WINDOWS) * rMid * 0.42;
  for (let i = 0; i < WHEEL_WINDOWS; i++) {
    const ang = (i / WHEEL_WINDOWS) * Math.PI * 2;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(ang);
    ctx.fillStyle = '#14161A';
    ctx.beginPath();
    ctx.moveTo(-halfW, -rOuter);
    ctx.lineTo(halfW, -rOuter);
    ctx.lineTo(halfW * 1.05, -rInner);
    ctx.lineTo(-halfW * 1.05, -rInner);
    ctx.closePath();
    ctx.fill();
    // 开窗上下缘的受光亮边，读作切削倒角
    ctx.strokeStyle = 'rgba(226, 228, 232, 0.85)';
    ctx.lineWidth = Math.max(1, size * 0.0035);
    ctx.beginPath();
    ctx.moveTo(-halfW, -rOuter);
    ctx.lineTo(halfW, -rOuter);
    ctx.moveTo(-halfW * 1.05, -rInner);
    ctx.lineTo(halfW * 1.05, -rInner);
    ctx.stroke();
    ctx.restore();
  }

  // 盘缘最外圈：抛光轮辋外缘
  ctx.strokeStyle = 'rgba(236, 238, 242, 0.9)';
  ctx.lineWidth = Math.max(1, size * 0.008);
  ctx.beginPath();
  ctx.arc(c, c, c * 0.995, 0, Math.PI * 2);
  ctx.stroke();

  // 中央曜日盾标（与 emblem-shield 同源的简化几何）：六边盾形 + 放射曜日纹
  const r = c * 0.30;
  ctx.save();
  ctx.translate(c, c);
  ctx.fillStyle = '#6A5240';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(232, 204, 138, 0.9)';
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.stroke();
  // 放射曜日纹：12 条细线
  ctx.strokeStyle = 'rgba(232, 204, 138, 0.75)';
  ctx.lineWidth = Math.max(1, size * 0.0025);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.28, Math.sin(a) * r * 0.28);
    ctx.lineTo(Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(240, 236, 226, 0.95)';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// EX 身份特征贴图（spec textureless 声明 → 集成层 Canvas 路径，同金色签名屏先例）。
// 坐标换算口径：CanvasTexture flipY=true，画布 y=0 对应几何 v=1（顶）；
// 各函数按「组件局部坐标 → 画布像素」显式换算，不靠目测对位。
// 色彩空间口径：全部为颜色/发光内容 → SRGBColorSpace；无数据贴图（法线/粗糙度）。
// ---------------------------------------------------------------------------

/** EX-28 采样面板：尾灯暗场内衬 lantern-emitter 的几何 0.135×0.425，半宽/半高 */
const TAIL_FIELD_HALF_W = 0.0675;
const TAIL_FIELD_HALF_H = 0.2125;
/** EX-28 灯带布局（spec taillamp-band-* 撤除前实测坐标）：局部 y 中心 / x 中心 / 宽 */
const TAIL_BANDS: ReadonlyArray<{ y: number; x: number; w: number }> = [
  { y: 0.175, x: 0, w: 0.13 }, // 上长带（横贯）
  { y: 0.118, x: -0.034, w: 0.062 }, // 上短·左（中央留 6mm 间隙）
  { y: 0.118, x: 0.034, w: 0.062 }, // 上短·右
  { y: -0.118, x: -0.034, w: 0.062 }, // 下短·左
  { y: -0.118, x: 0.034, w: 0.062 }, // 下短·右
  { y: -0.175, x: 0, w: 0.13 } // 下长带（横贯）
];
const TAIL_BAND_H = 0.032;

/**
 * EX-28 尾灯 3+3 红横带图集（512×512）。
 * 分层依据（spec 世界 z，越负越靠观察者）：壳体 -2.865 ← 暗场内衬 -2.8718 ←
 * 红带/金屏 -2.8745；红光核心在最深层（-2.869），被暗场遮住只露一圈红晕（EX-27 设计）。
 * 所以横带图案的承载面是暗场内衬（lantern-emitter，housing-dark），不是红光核心。
 * 图集左半 = 红带区（黑底 + 亮带，乘在适配层设置的红色 emissive 上）；
 * 右半 = 纯黑零发光区，供 housing-dark 其余壳体（尾灯壳/头灯壳）UV 重映射落点，
 * 同材质同贴图下壳体外观零变化，合批组不变、DC 零增量。
 * glow 不画进贴图：辉光交给 emissiveIntensity（随 brakeLevel 联动）+ bloom。
 */
function createTailBandAtlasTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  // 全幅黑底：黑 = 零发光（右半壳体落点直接可用）
  ctx.fillStyle = 'rgb(0, 0, 0)';
  ctx.fillRect(0, 0, S, S);
  // ---- 左半：暗场红带区 ----
  const px = (x: number): number =>
    ((x + TAIL_FIELD_HALF_W) / (TAIL_FIELD_HALF_W * 2)) * (S / 2);
  const pyTop = (y: number): number =>
    (1 - (y + TAIL_FIELD_HALF_H) / (TAIL_FIELD_HALF_H * 2)) * S;
  const bandPxH = (TAIL_BAND_H / (TAIL_FIELD_HALF_H * 2)) * S;
  for (const b of TAIL_BANDS) {
    const x0 = px(b.x - b.w / 2);
    const w = (b.w / (TAIL_FIELD_HALF_W * 2)) * (S / 2);
    const y0 = pyTop(b.y + TAIL_BAND_H / 2);
    const grad = ctx.createLinearGradient(0, y0, 0, y0 + bandPxH);
    grad.addColorStop(0, 'rgb(190, 92, 88)');
    grad.addColorStop(0.24, 'rgb(255, 246, 244)');
    grad.addColorStop(0.76, 'rgb(255, 246, 244)');
    grad.addColorStop(1, 'rgb(190, 92, 88)');
    ctx.fillStyle = grad;
    ctx.fillRect(x0, y0, w, bandPxH);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * EX-22/EX-08 星尘颗粒面板（512×512），lamp-star 材质共用：
 * 门把手星辰发光条（4 条）与大灯星点卡（2 张）采样同一张贴图 —— 两者要的都是
 * 「暗基底上的星尘」，共用一份不串味（发光条沿长度采样、星点卡沿高度采样，
 * 星尘图案无方向性）。确定性 LCG 种子；6 颗锚位亮星对齐撤除前几何星点的
 * 把手长度向位置（u=0.125..0.875），v 上下交错避免在大灯卡上排成一条横线。
 */
function createHandleStarTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  // 基底 0.27 亮度冷白：发光条保留「条」的存在感，星尘在其上提亮
  ctx.fillStyle = 'rgb(64, 70, 82)';
  ctx.fillRect(0, 0, S, S);
  // 钻石切割棱面走向：极淡斜向亮线（只做质感提示，不抢星尘）
  ctx.strokeStyle = 'rgba(210, 220, 238, 0.06)';
  ctx.lineWidth = 10;
  const rnd = makeLcg(0xa2c17e); // 固定种子：星尘图案逐次加载一致
  for (let i = 0; i < 14; i++) {
    const o = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(o - S * 0.2, -20);
    ctx.lineTo(o + S * 0.45, S + 20);
    ctx.stroke();
  }
  // 星尘颗粒：3 档大小（与星空顶同手法）
  for (let i = 0; i < 340; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const roll = rnd();
    const radius = roll > 0.93 ? 2.6 : roll > 0.7 ? 1.6 : 0.9;
    const alpha = 0.35 + rnd() * 0.65;
    ctx.fillStyle = `rgba(238, 244, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (radius > 2.2) {
      // 亮颗粒加十字星芒（把手「闪烁感」的静态基础，动态闪烁交给头灯联动路径）
      ctx.strokeStyle = `rgba(238, 244, 255, ${alpha * 0.5})`;
      ctx.lineWidth = 1;
      const len = radius * 4;
      ctx.beginPath();
      ctx.moveTo(x - len, y);
      ctx.lineTo(x + len, y);
      ctx.moveTo(x, y - len);
      ctx.lineTo(x, y + len);
      ctx.stroke();
    }
  }
  // 6 颗锚位亮星：对齐撤除前 handle-star-dot-* 的 u 位置
  for (let i = 0; i < 6; i++) {
    const x = (0.125 + i * 0.15) * S;
    const y = (i % 2 === 0 ? 0.32 : 0.68) * S;
    const halo = ctx.createRadialGradient(x, y, 0, x, y, 14);
    halo.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    halo.addColorStop(0.4, 'rgba(238, 244, 255, 0.4)');
    halo.addColorStop(1, 'rgba(238, 244, 255, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 11, y);
    ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11);
    ctx.lineTo(x, y + 11);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// P1 内饰程序化织物贴图（皮革 ×3 / 木纹 / 麂皮 / 窗帘 / 地毯）。
// 七个材质在 spec 声明 textureless（normal/bump 全 null）—— 这里是唯一支撑，
// 不画就是光滑塑料回归。全部 Canvas 程序化绘制（合规铁律：零照片像素），
// 高度场 → 颜色/法线同源派生，周期噪声保证 tileable。
// ---------------------------------------------------------------------------

/** 整数哈希 → [0,1)，确定性（同一 seed 逐次加载一致） */
function hash2i(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smoothT = (t: number): number => t * t * (3 - 2 * t);

/**
 * 周期 value noise：x/y 以「格」为单位，格数 = period（整数 ⇒ 贴图 tileable）。
 * x, y 应在 [0, period) 内取值（由调用方乘频率保证）。
 */
function pnoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothT(x - x0);
  const fy = smoothT(y - y0);
  const wrap = (n: number): number => ((n % period) + period) % period;
  const ix0 = wrap(x0);
  const ix1 = wrap(x0 + 1);
  const iy0 = wrap(y0);
  const iy1 = wrap(y0 + 1);
  const a = hash2i(ix0, iy0, seed);
  const b = hash2i(ix1, iy0, seed);
  const c = hash2i(ix0, iy1, seed);
  const d = hash2i(ix1, iy1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

interface SurfaceMapSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

/**
 * 通用程序化表面贴图生成器：sample(u, v) 返回 [h, r, g, b]
 * （h ∈ 0..1 高度场供法线派生；rgb 为 0..255 颜色通道）。
 * 法线由高度场 wrap 边缘的有限差分求出 —— 与颜色同源，凹凸必然对位。
 * map = SRGBColorSpace（颜色内容）；normalMap = NoColorSpace（数据贴图，绝不设 sRGB）。
 * height 参数允许非正方形画布（EX-34 胎面/胎侧图集 1024×512 走这条）。
 */
function createProceduralSurface(
  size: number,
  normalStrength: number,
  sample: (u: number, v: number) => [number, number, number, number],
  height: number = size
): SurfaceMapSet {
  const w = size;
  const h = height;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = w;
  colorCanvas.height = h;
  const colorCtx = colorCanvas.getContext('2d')!;
  const colorImage = colorCtx.createImageData(w, h);
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = w;
  normalCanvas.height = h;
  const normalCtx = normalCanvas.getContext('2d')!;
  const normalImage = normalCtx.createImageData(w, h);
  const heights = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const [hh, r, g, b] = sample(u, v);
      heights[y * w + x] = hh;
      const off = (y * w + x) * 4;
      colorImage.data[off] = r;
      colorImage.data[off + 1] = g;
      colorImage.data[off + 2] = b;
      colorImage.data[off + 3] = 255;
    }
  }

  // wrap 有限差分 → 法线（[-1,1] 映射到 [0,255]）
  const s = normalStrength * Math.min(w, h);
  for (let y = 0; y < h; y++) {
    const yUp = (y - 1 + h) % h;
    const yDn = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const xL = (x - 1 + w) % w;
      const xR = (x + 1) % w;
      const dx = (heights[y * w + xR] - heights[y * w + xL]) * s;
      const dy = (heights[yDn * w + x] - heights[yUp * w + x]) * s;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const off = (y * w + x) * 4;
      normalImage.data[off] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      normalImage.data[off + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      normalImage.data[off + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
      normalImage.data[off + 3] = 255;
    }
  }
  colorCtx.putImageData(colorImage, 0, 0);
  normalCtx.putImageData(normalImage, 0, 0);

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  map.needsUpdate = true;
  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.colorSpace = THREE.NoColorSpace; // 数据贴图：绝不 sRGB
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.needsUpdate = true;
  return { map, normalMap };
}

/** 皮革粒面采样：三层周期噪声（大粒 + 细粒 + 脊状褶皱），颜色 = 基色 × 高度明暗 */
function leatherSampler(baseHex: [number, number, number], seed: number) {
  const [br, bg, bb] = baseHex;
  return (u: number, v: number): [number, number, number, number] => {
    const n1 = pnoise(u * 10, v * 10, 10, seed);
    const n2 = pnoise(u * 28, v * 28, 28, seed + 1);
    const ridge = 1 - Math.abs(2 * pnoise(u * 40, v * 40, 40, seed + 2) - 1);
    const h = clamp01(0.42 * n1 + 0.33 * n2 + 0.25 * ridge);
    const shade = 0.8 + 0.4 * h;
    const warm = 0.97 + 0.06 * n2;
    return [h, br * shade, bg * shade * warm, bb * shade];
  };
}

/**
 * 皮革图集（正方形 size，左半素面 / 右半菱形缝格）—— leather-warm 专用。
 * 共享材质图集 + UV 重映射是硬约束（MEMORY）：素面给全车通用件，
 * 菱格区给 seat-rear-*（座面/靠背/头枕，I5/I6 钻石菱格参考）。
 * 底半幅复制素面（防意外采样露出花屏，多余 25% 显存换零风险）。
 * 菱格：45° 旋转方格阵，缝线凹槽 + 珠状缝点 + 格心微鼓（高度场直接体现，
 * 法线由同一场派生，缝线立体感免费获得）。
 */
function createLeatherAtlasTexture(
  size: number,
  seed: number,
  baseHex: [number, number, number],
  quiltCell: number
): SurfaceMapSet {
  const half = size / 2;
  const plain = leatherSampler(baseHex, seed);
  const [br, bg, bb] = baseHex;
  const stitchPitch = quiltCell / 4; // 缝珠间距
  const sample = (u: number, v: number): [number, number, number, number] => {
    const x = u * size;
    const y = v * size;
    if (x >= half && y < half) {
      // ---- 右上：菱形缝格区 ----
      const qx = x - half;
      // 45° 菱格：两条正交线族 (x+y) 与 (x−y)，周期 = quiltCell
      const d1 = ((qx + y) % quiltCell + quiltCell) % quiltCell;
      const d2 = ((qx - y) % quiltCell + quiltCell) % quiltCell;
      const w = quiltCell * 0.055; // 缝线半宽
      const dist = Math.min(Math.min(d1, quiltCell - d1), Math.min(d2, quiltCell - d2));
      const [h0, r0, g0, b0] = plain(u, v);
      if (dist < w) {
        // 缝线凹槽：压暗 + 周期缝珠提亮
        const beadPhase = ((qx + y) % stitchPitch) / stitchPitch;
        const bead = dist < w * 0.5 && beadPhase < 0.22 ? 1 : 0;
        const shade = bead ? 1.35 : 0.55;
        const h = bead ? 0.95 : 0.12;
        return [h, Math.min(255, br * shade), Math.min(255, bg * shade), Math.min(255, bb * shade)];
      }
      // 格心微鼓：距缝线越远越高
      const puff = clamp01(dist / (quiltCell * 0.5));
      const h = clamp01(h0 * 0.55 + 0.45 * puff);
      const shade = 0.86 + 0.3 * h;
      return [h, r0 * shade, g0 * shade, b0 * shade];
    }
    return plain(u, v);
  };
  return createProceduralSurface(size, 0.55, sample);
}

/** 开放木纹（沿 U 拉伸）：u 向低频 / v 向高频，脊状深条纹 + 细纤维 */
function woodSampler(baseHex: [number, number, number], seed: number) {
  const [br, bg, bb] = baseHex;
  return (u: number, v: number): [number, number, number, number] => {
    // 沿 U 拉伸：u 方向频率 3，v 方向频率 34（约 11:1 拉伸比）
    const streak = pnoise(u * 3, v * 34, 3 * 34, seed);
    const ring = 1 - Math.abs(2 * pnoise(u * 2, v * 12, 2 * 12, seed + 1) - 1);
    const fiber = pnoise(u * 6, v * 90, 6 * 90, seed + 2);
    const h = clamp01(0.4 * streak + 0.4 * ring * ring + 0.2 * fiber);
    // 深色开放纹：ring 峰值处压暗
    const dark = 1 - 0.38 * ring * ring;
    const shade = (0.78 + 0.44 * h) * dark;
    return [h, br * shade, bg * shade, bb * shade];
  };
}

/** 麂皮微颗粒：极细密噪声、极低起伏 */
function suedeSampler(baseHex: [number, number, number], seed: number) {
  const [br, bg, bb] = baseHex;
  return (u: number, v: number): [number, number, number, number] => {
    const fine = pnoise(u * 96, v * 96, 96, seed);
    const mid = pnoise(u * 18, v * 18, 18, seed + 1);
    const h = clamp01(0.7 * fine + 0.3 * mid);
    const shade = 0.92 + 0.16 * h;
    return [h, br * shade, bg * shade, bb * shade];
  };
}

/** 竖向织纹（窗帘）：u 向密条纹 + v 向缓慢波动 + 细纤维 */
function curtainSampler(baseHex: [number, number, number], seed: number) {
  const [br, bg, bb] = baseHex;
  return (u: number, v: number): [number, number, number, number] => {
    const warp = 0.5 + 0.5 * Math.sin(2 * Math.PI * u * 28 + 1.4 * pnoise(u * 4, v * 3, 4 * 3, seed));
    const weft = pnoise(u * 64, v * 5, 64 * 5, seed + 1);
    const h = clamp01(0.6 * warp + 0.4 * weft);
    const shade = 0.86 + 0.26 * h;
    return [h, br * shade, bg * shade, bb * shade];
  };
}

/** 短绒地毯：高频斑驳 + 中频簇团 */
function carpetSampler(baseHex: [number, number, number], seed: number) {
  const [br, bg, bb] = baseHex;
  return (u: number, v: number): [number, number, number, number] => {
    const speck = hash2i(Math.floor(u * 128) % 128, Math.floor(v * 128) % 128, seed);
    const clump = pnoise(u * 22, v * 22, 22, seed + 1);
    const h = clamp01(0.45 * speck + 0.55 * clump);
    const shade = 0.72 + 0.56 * h;
    return [h, br * shade, bg * shade, bb * shade];
  };
}

/**
 * EX-26 车名牌「尊界 V800」镀铬立体字（1024×272，字标类允许 1024²）。
 * 参考图为镀铬立体字而非黑底印字：黑底保留（plate 组件身份），字面用
 * 五段铬渐变 + 暗侧挤压层 + 细暗描边模拟立体感；金属反射由 spec 侧
 * plate 材质标量（metalness/roughness 已按其材质证据修正）接 envMap。
 * 文字性商标引用，同 MAEXTRO 字标先例。
 */
function createNameplateTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 272;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgb(18, 19, 22)');
  bg.addColorStop(0.5, 'rgb(10, 11, 13)');
  bg.addColorStop(1, 'rgb(6, 7, 9)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(196, 202, 212, 0.22)';
  ctx.lineWidth = 3;
  ctx.strokeRect(9, 9, W - 18, H - 18);
  const text = '尊界 V800';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 148px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
  const natural = ctx.measureText(text).width;
  const scale = Math.min(1, (W * 0.84) / natural);
  const mid = H * 0.52;
  ctx.save();
  ctx.translate(W / 2, H / 2 + 4);
  ctx.scale(scale, 1);
  // ① 挤压侧壁：向下偏移的两层暗字，模拟字厚
  ctx.fillStyle = 'rgb(30, 33, 38)';
  ctx.fillText(text, 3, 8);
  ctx.fillText(text, 2, 5);
  // ② 铬面：天光白 → 亮银 → 暗银 → 地平反光 → 暗银
  const chrome = ctx.createLinearGradient(0, -mid, 0, mid);
  chrome.addColorStop(0, 'rgb(250, 252, 255)');
  chrome.addColorStop(0.34, 'rgb(206, 212, 222)');
  chrome.addColorStop(0.52, 'rgb(112, 120, 132)');
  chrome.addColorStop(0.56, 'rgb(236, 240, 246)');
  chrome.addColorStop(1, 'rgb(96, 104, 116)');
  ctx.fillStyle = chrome;
  ctx.fillText(text, 0, 0);
  // ③ 立体描边：细暗边把铬面从黑底上收出来
  ctx.strokeStyle = 'rgba(8, 10, 14, 0.85)';
  ctx.lineWidth = 3;
  ctx.strokeText(text, 0, 0);
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * R12-T1 尾门顶部 MAEXTRO 贯通小字（1024×80，透明底）。
 * 参考图 C3：真车尾门顶沿一行宽字距 MAEXTRO 细铬字。同尾标贴花先例：
 * 五段铬渐变 + 细暗描边，字距用 canvas letterSpacing 拉宽（细体大写字）。
 */
function createTailMaextroTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 80;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  const text = 'MAEXTRO';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '300 46px "Segoe UI", Arial, sans-serif';
  ctx.letterSpacing = '26px'; // 宽字距（真车贯通小字构图）
  const natural = ctx.measureText(text).width;
  const scale = Math.min(1, (W * 0.9) / natural);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(scale, 1);
  const mid = 20;
  const chrome = ctx.createLinearGradient(0, -mid, 0, mid);
  chrome.addColorStop(0, 'rgb(246, 248, 251)');
  chrome.addColorStop(0.34, 'rgb(202, 208, 218)');
  chrome.addColorStop(0.52, 'rgb(108, 116, 128)');
  chrome.addColorStop(0.56, 'rgb(232, 236, 242)');
  chrome.addColorStop(1, 'rgb(92, 100, 112)');
  ctx.fillStyle = chrome;
  ctx.fillText(text, 0, 0);
  ctx.strokeStyle = 'rgba(10, 12, 16, 0.7)';
  ctx.lineWidth = 1.6;
  ctx.strokeText(text, 0, 0);
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * EX-07 盾徽面板分区贴图（512×512 图集）。
 * lamp-white 是共享材质（shield-emblem-panel + front-light-bar + bumper-light-strip），
 * 三者的盒面 UV 都是全幅 0..1 —— 直接画纹样会把曜日线串到两条贯穿灯带上。
 * 解法是图集 + UV 重映射（见适配器 remapUV）：左半为盾徽面板区（白底发光面板 +
 * 放射曜日细线 + 中部 MAEXTRO 字带），右半纯白区供两条灯带重映射落点，
 * 同材质同贴图下互不串味，合批组不变、DC 零增量。
 */
function createEmblemAtlasTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  // 全幅白底（灯带区直接可用）
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, S, S);
  // ---- 左半：盾徽面板区 ----
  const cx = S * 0.25;
  const cy = S / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, S / 2, S);
  ctx.clip();
  // 放射曜日细线：面板 0.06×0.17 纵横比 0.353，画布上已按米制比例换算 ——
  // 射线端点取纵向 0.085m（256px）、横向 0.070m（300px），左右越界部分由 clip 收掉
  ctx.strokeStyle = 'rgba(96, 102, 112, 0.8)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + dx * 20, cy + dy * 17);
    ctx.lineTo(cx + dx * 300, cy + dy * 256);
    ctx.stroke();
  }
  // 中部 MAEXTRO 字带：暗带 + 白字（面板上的身份锚点，同 MAEXTRO 字标先例）
  ctx.fillStyle = 'rgb(24, 26, 30)';
  ctx.fillRect(0, cy - 20, S / 2, 40);
  ctx.fillStyle = 'rgb(244, 246, 250)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 26px "Segoe UI", Arial, sans-serif';
  ctx.fillText('MAEXTRO', cx, cy + 1);
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * EX-08 头灯竖向光导（128×512），lamp-head 材质（两条竖向灯带 + 6 枚几何点阵共用）。
 *
 * R3 裁决（依据搭景 spec 注 + A1/A8/E1/E2 参考）：headlamp-led-l/r 是「竖向细白
 * LED 线（灯罩外缘光导）」，3 枚圆形点阵由 headlamp-led-dot-* 几何件承担 ——
 * 旧版「3 圆点贴图」会让光导表面再浮现一轮点阵（与几何点阵双重图案），且连续
 * 光导被切成三截，与参考图不符。故简化为纯竖向光导：
 *   暗基底（熄灯 intensity 0.15 时仍读得出灯体轮廓）+ 中央全高亮带（柔边 + 白热芯）。
 * 6 枚几何点阵的 remapUVToRegion 落点 [0.328,0.672]×[0.457,0.543]（画布
 * x[42,86]）正落在亮带 x[40,88] 内 → 点阵仍是白心柔边圆面，重映射无需改动。
 * lamp-head 不进 UV_ATLAS_REGIONS：全幅同质（暗底 + 光导），点阵采亮带是刻意
 * 行为，无分区冲突（无串味概念）。
 */
function createHeadlampLedTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  // 暗基底：熄灯时灯体轮廓可读
  ctx.fillStyle = 'rgb(80, 88, 100)';
  ctx.fillRect(0, 0, W, H);
  // 竖向光导亮带：x[40,88] 全高连续；横向柔边渐变 → 白热芯（点亮时过 bloom 阈值起辉光）
  const band = ctx.createLinearGradient(40, 0, 88, 0);
  band.addColorStop(0, 'rgba(80, 88, 100, 0)');
  band.addColorStop(0.14, 'rgba(196, 204, 218, 0.85)');
  band.addColorStop(0.32, 'rgba(242, 246, 252, 0.97)');
  band.addColorStop(0.5, 'rgb(255, 255, 255)');
  band.addColorStop(0.68, 'rgba(242, 246, 252, 0.97)');
  band.addColorStop(0.86, 'rgba(196, 204, 218, 0.85)');
  band.addColorStop(1, 'rgba(80, 88, 100, 0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 屏幕家族 UI 图集（1024×512）。screen-ui 是共享材质（三联屏 + 后排控制屏 +
 * 2 块零重力座椅扶手屏，IN-21/43），四块屏各自要不同的 UI 画面 ——
 * 沿用图集 + UV 重映射先例：左上横条 = 三联屏（1.46×0.315m，纵横比 4.6，
 * 分仪表/中控/副驾三段 HarmonyOS 风卡片）；左下 = 后排控制屏（0.24×0.15）；
 * 中下小卡 = 扶手屏（0.07×0.05）。其余近黑，任何未重映射的采样都不露 UI。
 * 深底浅字（H1-H5 参考：仪表+副驾娱乐+中控，深色底 + 浅灰字 + 绿色点缀）。
 */
const TRI_SCREEN_UI_REGION = Object.freeze([4 / 1024, 1020 / 1024, 1 - 227 / 512, 1 - 4 / 512]);
const REAR_CTRL_UI_REGION = Object.freeze([4 / 1024, 316 / 1024, 1 - 508 / 512, 1 - 300 / 512]);
const SEAT_CTRL_UI_REGION = Object.freeze([332 / 1024, 470 / 1024, 1 - 482 / 512, 1 - 380 / 512]);

function createScreenUIAtlasTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  // 全幅深底：未覆盖区域 = 熄屏
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, W, H);
  const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  const panel = (x: number, y: number, w: number, h: number): void => {
    roundRect(x, y, w, h, 8);
    ctx.fillStyle = '#10141b';
    ctx.fill();
    ctx.strokeStyle = 'rgba(159, 182, 200, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  const label = (text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left'): void => {
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.font = `${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.fillText(text, x, y);
  };

  // ---- 左上：三联屏（y 4..227）----
  panel(4, 4, 1016, 223);
  // 分段隔断
  ctx.strokeStyle = 'rgba(159, 182, 200, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(342, 14); ctx.lineTo(342, 217);
  ctx.moveTo(682, 14); ctx.lineTo(682, 217);
  ctx.stroke();
  // ① 仪表段（驾驶位）
  label('88', 60, 108, 92, '#e8f2ec');
  label('km/h', 60, 176, 22, '#6e8494');
  label('P', 300, 60, 44, '#9fb6c8', 'right');
  // 电量/踏板力条
  ctx.fillStyle = '#16241d';
  roundRect(56, 196, 220, 12, 6); ctx.fill();
  ctx.fillStyle = '#7fd8a8';
  roundRect(56, 196, 150, 12, 6); ctx.fill();
  label('READY', 180, 26, 18, '#7fd8a8', 'center');
  // ② 中控段（时钟 + 卡片）
  label('10:36', 512, 62, 56, '#eef3f8', 'center');
  label('10月16日 周五', 512, 104, 20, '#6e8494', 'center');
  panel(376, 128, 272, 76);
  label('♪ 湖畔晨曲 — 车载歌单', 512, 152, 22, '#c8d4de', 'center');
  label('导航 · 前往公司 24 分钟', 512, 186, 18, '#7fa8c8', 'center');
  // ③ 副驾段（娱乐）
  panel(716, 28, 268, 120);
  label('多媒体', 850, 78, 26, '#c8d4de', 'center');
  label('视频卡片', 850, 112, 18, '#6e8494', 'center');
  panel(716, 160, 128, 52);
  label('23°C 晴', 780, 186, 20, '#c8d4de', 'center');
  panel(856, 160, 128, 52);
  label('空气净化中', 920, 186, 17, '#7fd8a8', 'center');

  // ---- 左下：后排控制屏（0.24×0.15 → 312×208 @ y300..508）----
  panel(4, 300, 312, 208);
  label('后排控制', 160, 330, 24, '#c8d4de', 'center');
  for (const [i, t] of [['24°C', '温度'], ['座椅', '加热'], ['遮阳', '窗帘'], ['氛围', '灯效']].entries()) {
    const bx = 28 + (i % 2) * 140;
    const by = 356 + Math.floor(i / 2) * 68;
    panel(bx, by, 120, 56);
    label(t[0], bx + 60, by + 24, 20, '#e8eef4', 'center');
    label(t[1], bx + 60, by + 44, 13, '#6e8494', 'center');
  }

  // ---- 中下小卡：零重力座椅扶手屏（0.07×0.05 → 138×102 @ x332..470 y380..482）----
  panel(332, 380, 138, 102);
  for (const [i, t] of [['座椅', '按摩'], ['腰托', '通风']].entries()) {
    const by = 392 + i * 42;
    label(t[0], 402, by, 15, '#d8e2ea', 'center');
    label(t[1], 402, by + 18, 11, '#5f7080', 'center');
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * lamp-gold 反照率图集（512×512，与 createGoldAtlasTexture 同布局）。
 * N3 修复：此前素面金观感呈「奶油色 blob」—— albedo #C2A263（亮金）× metalness 1
 * × roughness 0.28 + 环境反射 = 亮奶油色。目标是「深色拉丝金属格栅」：
 *   左区（签名屏底）：近黑暖底 —— EX-29 金色点阵在深色屏体上更符合实拍；
 *   右区（音频格栅）：深青铜底 + 横向拉丝明暗 —— 拉丝金属观感由 map 承担，
 *   金属反射强度由 roughness 上调收敛（0.28 → 0.45）。
 * UV 分区沿用既有 remapUV 落点（签名屏 → 左区 / 6 音频件 → 右区），零额外映射。
 */
function createGoldAlbedoAtlasTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  // 全幅深青铜暗底
  ctx.fillStyle = '#181309';
  ctx.fillRect(0, 0, S, S);
  // 左区：签名屏底 —— 近黑暖灰
  ctx.fillStyle = 'rgb(12, 10, 7)';
  ctx.fillRect(0, 0, S / 2, S);
  // 右区：音频格栅 —— 深青铜 + 横向拉丝（沿 U 明暗抖动，确定性 LCG）
  const bx0 = GOLD_BRUSHED_REGION[0] * S;
  const bx1 = GOLD_BRUSHED_REGION[1] * S;
  const by0 = (1 - GOLD_BRUSHED_REGION[3]) * S;
  const by1 = (1 - GOLD_BRUSHED_REGION[2]) * S;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx0, by0, bx1 - bx0, by1 - by0);
  ctx.clip();
  const base = ctx.createLinearGradient(bx0, 0, bx1, 0);
  base.addColorStop(0, 'rgb(38, 30, 18)');
  base.addColorStop(0.5, 'rgb(52, 41, 25)');
  base.addColorStop(1, 'rgb(38, 30, 18)');
  ctx.fillStyle = base;
  ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
  const rnd = makeLcg(0x71c3a5);
  for (let y = by0; y <= by1; y += 1) {
    const a = 0.05 + rnd() * 0.12;
    const light = rnd() > 0.5;
    ctx.strokeStyle = light
      ? `rgba(122, 98, 58, ${a.toFixed(3)})`
      : `rgba(16, 12, 7, ${a.toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx0, y + (rnd() - 0.5) * 0.6);
    ctx.lineTo(bx1, y + (rnd() - 0.5) * 0.6);
    ctx.stroke();
  }
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// EX-34 轮胎图集：胎面沟槽（左半）+ 胎侧字环（右半），1024×512 @ high / 512×256 @ 中低。
//
// 为什么是图集：tire 是 cylinder（side=胎面 + 两枚帽面=胎侧）共用同一材质实例
// （spec material 'tire'，用户 = 4 条真胎 + 4 个隐藏占位盒）。胎面采样整幅
// [0,1]²，直接把字环画满画布会把字裹到胎面上 —— 必须图集 + 按 group 分区。
// 帽面 UV 是 [0,1]² 内切圆（a2 探针实证 discR2max=0.25），右半幅内切圆即整张侧壁。
//
// 合规口径（EX-34）：参考图 D3/D4/U3 的胎侧是第三方轮胎商标（MICHELIN /
// Pilot Sport 有商标风险）—— 不写真机商标实体，只取「大字号品牌名绕侧壁
// 一周」的排版构图，字样用品牌中性的「V800 + MAESTRO + 星形图案」。
// 此口径差异登记在集成层（本注释为证）；spec evidence 归 spec 侧，本层不改 spec。
//
// 底帽 v 翻转补偿：three CylinderGeometry.generateCap 的 uv.y = sinθ·0.5·sign+0.5，
// 底帽 sign=−1（v 相对顶帽翻转）—— 朝外侧的那张侧壁字会是倒的。适配层把底帽
// UV 的 v 取 1−v（见 remapTireUV）补偿后，两枚帽面在世界空间同向，字环在
// 左右两侧车轮上都正立（side 与 cap 顶点集实测零相交，逐 group 重映射安全）。
// ---------------------------------------------------------------------------

/**
 * 胎面（torso）分区：u 压进左半；v **只占 0.23**（R4 收窄，原为全幅 0..1）。
 *
 * 为什么收窄 —— #uvassert 密度判据实测（1014×512 图集，1 UV-u = 1024px、
 * 1 UV-v = 512px）：
 *   胎面世界尺寸 = 周向 2.40 m × 母线 0.282 m（含两侧 1cm 圆角肩）。
 *   旧分区 [0,0.5]×[0,1] = 512×512px → 纹素 4.69mm(u) × 0.55mm(v)，
 *   纵横比 8.5:1，判据报 17x（UV 口径，等于像素口径 ×H/W 的倒数… 见下）。
 *   收窄到 Δv=0.23 = 512×118px → 纹素 4.69mm × 2.39mm，纵横比 ≈2:1。
 * 判据口径提示：本判据的「各向异性」= d_u/d_v（m per UV 单位），对非正方形
 * 图集（1024×512）会把真实像素纵横比放大 W/H = 2×。旧值 17x ≈ 真实 8.5:1，
 * 新值 ≈4x（判据口径）≈ 真实 2:1。
 * 代价：胎面竖向像素 512 → 118。但配合下方「母线按**世界弧长**参数化」后，
 * 真正可见的胎面（占母线 69.5%）反而从 57px 升到 82px —— 因为旧参数化是
 * 按母线点序均分（肩部 4 条 1cm 圆角带各吃掉 11% v，胎面只剩 11%）。
 */
const TIRE_TREAD_REGION = Object.freeze([0.004, 0.496, 0.385, 0.615]);
/** 胎侧字环（两枚帽面）分区：u 平移进右半，v 全幅（512×512px 内切圆，不变） */
const TIRE_SIDEWALL_REGION = Object.freeze([0.5, 1, 0, 1]);
/** 菱格细胞的世界边长（m）—— 与适配层 QUILT_CELL_WORLD 同源，供打孔孔径换算 */
const QUILT_CELL_WORLD_M = 0.06;
/**
 * leather-warm 贴图基色（R2 色调校准后）：#C08A5E（浅焦糖）→ #7A4034（深 Cognac 偏酒红）。
 * 参考 U1 半剖内饰（酒红）与 I5/I6 二排零重力（深 Cognac）的交集方向；
 * spec 材质颜色 #C08A5E 不动（spec 所有权），校准只落在贴图像素侧。
 */
const LEATHER_WARM_BASE: [number, number, number] = [88, 48, 40];

/**
 * 胎侧字环 + 模压环线（画在 W×H 画布上，随后被逐像素采样进颜色/高度场）。
 * 读法：字顶朝外（真实胎侧读法）—— 环顶正常读、环底倒置，四对角缀星形。
 * 逐字符按弧长放置：自左向右 θ 递减（顶朝外读法的统一方向，见推导注释）。
 */
function drawTireSidewallLettering(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const cx = W * 0.75;
  const cy = H * 0.5;
  // 字环半径：世界 0.335m ÷ 轮胎半径 0.382m × 帽面半径 0.5 UV
  // （胎侧可见环带 = 轮圈外缘 0.30 .. 胎面肩 0.382，字环取中段）
  const R = (H * 0.5) * (0.335 / 0.382);
  const ink = 'rgb(232, 224, 202)'; //  raised 白字（乘在黑色橡胶上）
  // 模压环线：字环外侧一道（近胎面肩）、内侧一道（刚出轮圈缘）
  ctx.strokeStyle = 'rgb(120, 118, 112)';
  ctx.lineWidth = Math.max(1, H * 0.005);
  for (const rr of [R + H * 0.035, R - H * 0.03]) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  const placeText = (s: string, thetaC: number, px: number): void => {
    ctx.save();
    ctx.font = `bold ${px}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    const widths = [...s].map((ch) => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0);
    // 自左向右 θ 递减：字符 k 的中心角 = thetaC + Δ/2 − Σ(前 k 字符宽)/R − 半宽/R
    let theta = thetaC + total / R / 2;
    for (let i = 0; i < s.length; i++) {
      const cw = widths[i];
      theta -= cw / R / 2;
      ctx.save();
      ctx.translate(cx + R * Math.cos(theta), cy - R * Math.sin(theta));
      // 字符局部 +X → 读向 (sinθ, cosθ)，字顶朝外 (cosθ, −sinθ) ⇒ 旋转 π/2−θ
      ctx.rotate(Math.PI / 2 - theta);
      ctx.fillText(s[i], 0, 0);
      ctx.restore();
      theta -= cw / R / 2;
    }
    ctx.restore();
  };
  placeText('V800', Math.PI / 2, Math.round(H * 0.05));
  placeText('MAEXTRO', Math.PI * 1.5, Math.round(H * 0.045));
  // 四对角星形（避开 u=0/1 的帽面接缝点 θ=0/2π）
  ctx.fillStyle = ink;
  for (const theta of [Math.PI / 4, (Math.PI * 3) / 4, (Math.PI * 5) / 4, (Math.PI * 7) / 4]) {
    const sx = cx + R * Math.cos(theta);
    const sy = cy - R * Math.sin(theta);
    const len = H * 0.032;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(Math.PI / 2 - theta);
    ctx.beginPath();
    ctx.moveTo(0, -len);
    ctx.lineTo(len * 0.22, -len * 0.22);
    ctx.lineTo(len, 0);
    ctx.lineTo(len * 0.22, len * 0.22);
    ctx.lineTo(0, len);
    ctx.lineTo(-len * 0.22, len * 0.22);
    ctx.lineTo(-len, 0);
    ctx.lineTo(-len * 0.22, -len * 0.22);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // 星形两侧各一小段星点（读作胎侧点缀）
  for (const theta of [Math.PI / 4, (Math.PI * 3) / 4, (Math.PI * 5) / 4, (Math.PI * 7) / 4]) {
    for (const d of [-0.09, 0.09]) {
      const t = theta + d;
      ctx.beginPath();
      ctx.arc(cx + R * Math.cos(t), cy - R * Math.sin(t), Math.max(1, H * 0.008), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * EX-34 轮胎图集（map + normalMap 同源派生）。
 * 左半 = 胎面：4 道周向沟槽（v 向 9mm，smoothstep 柔边）+ 肩筋 + 横向刀槽
 *   （80 等分 ≈ 3mm 宽，胎面在追尾/侧视角下只占几十像素，刀槽是纹素级细节）；
 *   噪声频率取 2×period —— 环绕发生在 region 边 u=0.5，必须保证 region 内 tileable。
 * 右半 = 胎侧：黑橡胶底 + drawTireSidewallLettering 预栅格化的字环/模压线，
 *   同一 alpha 同时驱动颜色混合与高度场凸起 → 法线免费获得字环浮雕。
 */
function createTireAtlasTexture(size: number): SurfaceMapSet {
  const W = size;
  const H = size / 2;
  // 字环先 rasterize 到 scratch（Node shim 下 getImageData 返回全零 = 无字，
  // 探针只核几何/UV，像素由 QA 实机截图负责）
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  drawTireSidewallLettering(scratch.getContext('2d')!, W, H);
  const letter = scratch.getContext('2d')!.getImageData(0, 0, W, H).data;

  const sample = (u: number, v: number): [number, number, number, number] => {
    const x = Math.min(W - 1, Math.floor(u * W));
    const y = Math.min(H - 1, Math.floor(v * H));
    const off = (y * W + x) * 4;
    const la = letter[off + 3] / 255;
    if (u >= 0.5) {
      // ---- 胎侧（右半）：橡胶底 + 字环 ----
      const grain = pnoise(u * 60, v * 60, 60, 0x5eed1);
      const base = 17 + grain * 7;
      let r = base;
      let g = base + 1;
      let b = base + 4; // 微冷黑橡胶
      let h = 0.5 + grain * 0.12;
      if (la > 0) {
        r = r * (1 - la) + letter[off] * la;
        g = g * (1 - la) + letter[off + 1] * la;
        b = b * (1 - la) + letter[off + 2] * la;
        h = h * (1 - la) + 0.92 * la; // 字环凸起
      }
      return [h, r, g, b];
    }
    // ---- 胎面（左半）：周向沟槽 + 肩筋 + 横向刀槽 ----
    // R4：胎面分区收窄为 v∈[tv0,tv1]（Δv=0.23≈118px，见 TIRE_TREAD_REGION）。
    // 图案坐标一律在「分区内归一化」vb 上算：4 道沟槽按设计横跨胎面宽度，
    // 肩筋落在 vb 两端（= 世界上的两条圆角肩）。分区外取 vb 端值 —— 双线性 /
    // 各向异性过滤在分区边界的溢出落到同色橡胶，不会出现亮暗边。
    const tv0 = TIRE_TREAD_REGION[2];
    const tv1 = TIRE_TREAD_REGION[3];
    const vb = Math.min(1, Math.max(0, (v - tv0) / (tv1 - tv0)));
    const P = 12;
    const grain = pnoise(u * 2 * P, vb * P, P, 0x71de);
    const fine = pnoise(u * 2 * 48, vb * 48, 48, 0x9a2c);
    let groove = 0;
    for (const gv of [0.13, 0.38, 0.62, 0.87]) {
      const m = clamp01(1 - Math.abs(vb - gv) / 0.035);
      groove = Math.max(groove, m * m * (3 - 2 * m)); // smoothstep 柔边
    }
    const shoulder = clamp01(1 - Math.min(vb, 1 - vb) / 0.06);
    const sp = (u * 80) % 1;
    const sipe = clamp01(1 - Math.min(sp, 1 - sp) / 0.33) * (1 - shoulder);
    let hh = 0.56 + grain * 0.14 + fine * 0.06;
    hh = hh * (1 - groove) + 0.08 * groove;
    hh = hh * (1 - sipe) + 0.2 * sipe;
    const shade = 0.5 + 0.55 * hh;
    const tint = 0.98 + fine * 0.06;
    return [hh, 21 * shade * tint, 21 * shade, 23 * shade * (2 - tint)];
  };
  return createProceduralSurface(size, 0.15, sample, H);
}

/**
 * EX-31 后保反光条分段图集（256×256，emissiveMap）。
 * lamp-red 是共享材质（尾灯芯 ×2 + 反光条 ×4 + 尾灯横带 ×4）—— 适配层克隆一份
 * 专供反光条（ID 不变），本图集只服务克隆：左半 = 5 段红反光条（暗红缘 →
 * 亮芯 → 暗红缘，乘在克隆继承的红色 emissive 上），右半纯黑零发光（防御性）。
 * 反光条不是刹车灯：克隆的 emissiveIntensity 设静态弱值，不随 brakeLevel 联动。
 * R2 兼容搭景新件：rear-reflector-strip-l/r（EX-31 下条）同材质同尺寸，
 * 一并进克隆与分段区（上下两条读感一致，否则下条会随刹车联动、亮度跳变）。
 */
const REFLECTOR_PATTERN_REGION = Object.freeze([0.004, 0.496, 0.004, 0.996]);
const REFLECTOR_EMISSIVE_INTENSITY = 0.55;

function createReflectorAtlasTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  // 全幅黑底：未覆盖区 = 零发光
  ctx.fillStyle = 'rgb(0, 0, 0)';
  ctx.fillRect(0, 0, S, S);
  const x0 = REFLECTOR_PATTERN_REGION[0] * S;
  const x1 = REFLECTOR_PATTERN_REGION[1] * S;
  const y0 = (1 - REFLECTOR_PATTERN_REGION[3]) * S;
  const y1 = (1 - REFLECTOR_PATTERN_REGION[2]) * S;
  const SEGS = 5; // 横向 5 段（段间隔为纯黑零发光 → 分段读感）
  const pitch = (x1 - x0) / SEGS;
  const bandW = pitch * 0.66;
  for (let i = 0; i < SEGS; i++) {
    const bx = x0 + i * pitch + (pitch - bandW) / 2;
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, 'rgb(96, 20, 26)');
    grad.addColorStop(0.18, 'rgb(226, 96, 88)');
    grad.addColorStop(0.5, 'rgb(255, 236, 228)');
    grad.addColorStop(0.82, 'rgb(226, 96, 88)');
    grad.addColorStop(1, 'rgb(96, 20, 26)');
    ctx.fillStyle = grad;
    ctx.fillRect(bx, y0, bandW, y1 - y0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * EX-33 轮心黑底盾徽（512×512 @ high / 256 @ 中低，emissiveMap）。
 * lamp-mark 是共享材质（车尾 MAEXTRO 字标 plane-card 13:1 横条 + 4 枚悬浮轮标
 * cylinder）—— 克隆一份专供轮标。帽面 UV 是 [0,1]² 内切圆（探针实证），
 * 盾徽画满整幅画布即自然落在帽面上：无需 UV 重映射、无图集分区 → 无串味概念。
 * 设计：黑底 + 外圈细金环（与搭景 EX-33 滚花齿环几何同心过渡）+ 六边盾形
 * 金描边 + 盾内上星形 / 中 MAEXTRO 字标。
 */
function createWheelBadgeTexture(size: number): THREE.CanvasTexture {
  const S = size;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const cx = S / 2;
  const cy = S / 2;
  // 黑底（悬浮轮标的身份色）
  ctx.fillStyle = '#04050a';
  ctx.fillRect(0, 0, S, S);
  // 外圈细金环
  ctx.strokeStyle = 'rgba(216, 179, 106, 0.6)';
  ctx.lineWidth = Math.max(1.5, S * 0.01);
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.465, 0, Math.PI * 2);
  ctx.stroke();
  // 六边盾形：上宽下尖
  const sw = S * 0.33;
  const top = cy - S * 0.3;
  const bot = cy + S * 0.335;
  ctx.beginPath();
  ctx.moveTo(cx - sw, top);
  ctx.lineTo(cx + sw, top);
  ctx.lineTo(cx + sw, cy + S * 0.05);
  ctx.quadraticCurveTo(cx + sw * 0.62, bot - S * 0.11, cx, bot);
  ctx.quadraticCurveTo(cx - sw * 0.62, bot - S * 0.11, cx - sw, cy + S * 0.05);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, top, 0, bot);
  fill.addColorStop(0, 'rgb(17, 15, 12)');
  fill.addColorStop(0.55, 'rgb(28, 24, 17)');
  fill.addColorStop(1, 'rgb(11, 10, 8)');
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgb(216, 179, 106)';
  ctx.lineWidth = Math.max(2, S * 0.014);
  ctx.stroke();
  // 盾内：上星形
  const star = (sx: number, sy: number, len: number): void => {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.beginPath();
    ctx.moveTo(0, -len);
    ctx.lineTo(len * 0.22, -len * 0.22);
    ctx.lineTo(len, 0);
    ctx.lineTo(len * 0.22, len * 0.22);
    ctx.lineTo(0, len);
    ctx.lineTo(-len * 0.22, len * 0.22);
    ctx.lineTo(-len, 0);
    ctx.lineTo(-len * 0.22, -len * 0.22);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  ctx.fillStyle = 'rgb(233, 198, 128)';
  star(cx, cy - S * 0.155, S * 0.05);
  // 盾内：MAEXTRO 字标（横向压缩到盾宽 86%）
  ctx.fillStyle = 'rgb(242, 244, 247)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const px = Math.round(S * 0.062);
  ctx.font = `bold ${px}px "Segoe UI", Arial, sans-serif`;
  const natural = ctx.measureText('MAEXTRO').width;
  const scale = Math.min(1, (sw * 2 * 0.86) / natural);
  ctx.save();
  ctx.translate(cx, cy + S * 0.06);
  ctx.scale(scale, 1);
  ctx.fillText('MAEXTRO', 0, 0);
  ctx.restore();
  // 盾内：字标下细金线
  ctx.strokeStyle = 'rgba(216, 179, 106, 0.85)';
  ctx.lineWidth = Math.max(1, S * 0.006);
  ctx.beginPath();
  ctx.moveTo(cx - sw * 0.5, cy + S * 0.145);
  ctx.lineTo(cx + sw * 0.5, cy + S * 0.145);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * EX-09 迎宾光毯贴图（正方形画布，图案为纯径向渐变光池 —— 中心亮、边缘平滑到 0）。
 * 收敛修订：取消旧版鹰形/星点/星芒等硬边图案（小尺寸投影面下读作地面 X 光斑杂纹），
 * 只保留「暖金光池」一层径向渐变 —— 渐变终点 alpha 恒为 0，天然无硬边，无需再叠
 * destination-out 外缘溶入。emissive 观感由贴图亮度 + 适配层呼吸动画承担
 * （材质是无光照 MeshBasicMaterial 的投影贴花）。
 */
function createWelcomeCarpetTexture(size: number): THREE.CanvasTexture {
  const W = size;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = W;
  const ctx = canvas.getContext('2d')!;
  // 径向渐变光池：暖金核心 → 边缘 0（无硬边；4:3 投影面下轻微椭圆化由平面纵横比自然承担）
  const pool = ctx.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
  pool.addColorStop(0, 'rgba(255, 224, 168, 0.92)');
  pool.addColorStop(0.35, 'rgba(244, 198, 128, 0.55)');
  pool.addColorStop(0.7, 'rgba(232, 180, 112, 0.2)');
  pool.addColorStop(1, 'rgba(228, 174, 106, 0)');
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, W, W);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 菱格专用平铺贴图（整幅菱形缝格，无图集分区）。
 * N2 终解：菱格件若沿用共享图集，三平面/盒投影的连续 UV 必然越出分区、
 * mod 折回又会在三角形插值时穿过图集间缝 —— 唯一两全解是给菱格件一张
 * 「整幅都是图案」的可平铺贴图：细胞周期 = size/16（整数）→ RepeatWrapping
 * 无缝环绕，UV 可沿世界坐标无限延展。配合逐三角形三平面投影（见适配器），
 * 任意朝向的面都得到 6cm 等密度菱格。材质用 leather-warm 的克隆（ID 不变，
 * 合批按实例分组 → 菱格件独立成组，+1 draw call）。
 * perforated = true 时在每格中心加 3×3 微孔阵（IN-08 打孔通风区）：
 * 孔半径按贴图尺寸换算（1024 → 世界 1.5mm；低档放大孔径保可读），
 * 颜色压暗 + 高度场下沉 → 法线同源派生，孔沿有真实凹陷。
 */
function createQuiltTileTexture(
  size: number,
  seed: number,
  baseHex: [number, number, number],
  perforated = false
): SurfaceMapSet {
  const cells = 16; // 每贴图边 16 个细胞（周期整数 → 无缝）
  const [br, bg, bb] = baseHex;
  const plain = leatherSampler(baseHex, seed);
  const stitchPitch = 0.25; // 缝珠间距（细胞单位的 1/4，同图集版）
  // 打孔半径（细胞单位）：世界 1.5mm @1024²；中低档放大孔径避免亚像素
  const holeR = (size >= 1024 ? 0.0015 : size >= 512 ? 0.003 : 0.006) / QUILT_CELL_WORLD_M;
  const sample = (u: number, v: number): [number, number, number, number] => {
    const cx = u * cells;
    const cy = v * cells;
    // 45° 菱格：两条正交线族（细胞单位）
    const d1 = ((cx + cy) % 1 + 1) % 1;
    const d2 = ((cx - cy) % 1 + 1) % 1;
    const w = 0.055; // 缝线半宽（细胞单位，同图集版 0.055×cell）
    const dist = Math.min(Math.min(d1, 1 - d1), Math.min(d2, 1 - d2));
    const [h0, r0, g0, b0] = plain(u, v);
    if (dist < w) {
      const beadPhase = (((cx + cy) % stitchPitch) + stitchPitch) % stitchPitch / stitchPitch;
      const bead = dist < w * 0.5 && beadPhase < 0.22 ? 1 : 0;
      const shade = bead ? 1.35 : 0.55;
      const h = bead ? 0.95 : 0.12;
      return [h, Math.min(255, br * shade), Math.min(255, bg * shade), Math.min(255, bb * shade)];
    }
    const puff = clamp01(dist / 0.5);
    let h = clamp01(h0 * 0.55 + 0.45 * puff);
    let r = r0;
    let g = g0;
    let b = b0;
    const shade = 0.86 + 0.3 * h;
    r *= shade;
    g *= shade;
    b *= shade;
    if (perforated) {
      // 格心 3×3 微孔阵（孔心距格心 ±0.08 细胞 ≈ ±4.8mm）
      const fx = cx - Math.floor(cx) - 0.5;
      const fy = cy - Math.floor(cy) - 0.5;
      let bd = Infinity;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const d = Math.hypot(fx - i * 0.08, fy - j * 0.08);
          if (d < bd) bd = d;
        }
      }
      if (bd < holeR) {
        const k = clamp01(bd / holeR); // 孔沿柔边（1px 量级）
        h = h * k + 0.05 * (1 - k);
        const dark = 0.45 + 0.55 * k;
        r *= dark;
        g *= dark;
        b *= dark;
      }
    }
    return [h, r, g, b];
  };
  return createProceduralSurface(size, 0.55, sample);
}

/**
 * R29（外部审查 O1）阴影 caster 白名单：只有**车体外壳**和**4 个轮子**投影。
 * 判据是材质 id 而不是组件 id —— 合批后组件 id 已丢失（batchMerge 不写
 * userData.sculptComponent），按 `material.userData.sculptMaterial.id` 建表才拿得到批次件。
 */
const SHADOW_CASTER_MATERIAL_IDS = new Set<string>(['paint-upper', 'paint-lower']);

/* ────────────────────────────────────────────────────────────────────────────
 * R32-D1 车模预算常量（**唯一真源**）
 *
 * 背景：审查方（秦核源）与 CI 都要按同一组上限裁决，写死在测试里的数字会与
 * 实现漂移 —— 一旦两侧不同步，红线就形同虚设。故上限一律在这里导出，由
 * `tests/r32_car_material.test.ts` 直接 import 消费（测试侧不得再抄数字）。
 *   · 上调 = 明确的预算决策，须在主理人处登记并在本注释写明原因；
 *   · 下调 = 收紧，理应放行（但仍须在报告中登记新的实测值）。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 装配后**材质实例**上限。实测 78（R32-D1：前后绿牌合并，79 → 78）。
 * ⚠ 外部审查 P0 给的期望值是 ≤45，本工位实测结论是**在不动视觉语义的前提下达不到**
 * （逐实例理由见 `.qa/r32_tmp_car/D1_material_merge.md` §4：真正可并的同 id 同签名
 * 实例对为 0，其余 78 例各自承载不同参考图 / 不同实例级运行时语义 / 不同标量参数）。
 * 降到 45 只有三条路：① 参考图去重（牺牲 per-part 观感）；② 砍掉座舱遮挡克隆
 * （毁 cabin 显隐）；③ 改工厂 spec 合并材质定义（非适配层文件，本波禁改）。
 * 三条都属于视觉/范围变更 ⇒ 保持 78 并在此登记，不做静默降级。
 */
export const V800_MATERIAL_INSTANCE_BUDGET = 78;

/**
 * 车模 tri **可见口径**红线（= 渲染器 `info.render.triangles` 口径；实测 79,798）。
 * brief §3 / `r32_lead_phase3_spec.md` §3 写的「tri #assembled ~79.9k，红线 90k」
 * 指的就是这条 —— 79,798 与历史 `r24_b_report.md` 的 79,878 同口径。
 */
export const V800_VISIBLE_TRI_BUDGET = 90_000;

/**
 * 车模 tri **全树 #assembled 口径**（含 `visible=false` 的备选/占位几何，
 * InstancedMesh 按 count 计倍）红线。
 * 处置建议（非本波执行）：要么把这条正式改成「可见口径 90k + 全树 ≤100k 双线」，
 * 要么立项清掉 19,860 tri 的死几何（届时可降回 90k）。在此之前本常量按实测登记，
 * 保证 CI 不红、数字不撒谎。
 */
export const V800_ASSEMBLED_TRI_BUDGET = 100_000;

/**
 * 同参材质实例判定：**全量**渲染参数签名。
 * R30-C4 初版只列 19 个标量 + 7 个贴图槽，漏了 bumpMap / displacementMap(+Scale/Bias) /
 * normalScale / aoMapIntensity / clearcoatNormalMap —— 两例材质若只差在这些槽上，
 * 旧签名判同 ⇒ 合并后观感静默改变（同 id 同色同糙但法线强度不同 = 不同材质）。
 * 导出给测试共用，保证「被测签名」与「适配器实际合并时用的签名」永不漂移。
 */
const V800_MATERIAL_SIGNATURE_KEYS = [
  'side', 'transparent', 'opacity', 'alphaTest', 'depthWrite', 'color', 'emissive',
  'emissiveIntensity', 'metalness', 'roughness', 'envMapIntensity', 'clearcoat',
  'clearcoatRoughness', 'flatShading', 'iridescence', 'sheen', 'transmission', 'thickness',
  'wireframe', 'reflectivity', 'specularIntensity', 'aoMapIntensity',
  'displacementScale', 'displacementBias', 'attenuationDistance', 'anisotropy',
  'anisotropyRotation', 'iridescenceIOR', 'sheenRoughness', 'dispersion'
] as const;
const V800_MATERIAL_TEXTURE_KEYS = [
  'map', 'emissiveMap', 'normalMap', 'roughnessMap', 'alphaMap', 'aoMap', 'metalnessMap',
  'bumpMap', 'displacementMap', 'clearcoatNormalMap'
] as const;

/** 签名值序列化：Color 取 hex、Vector2 取 (x,y)，其余 String() */
function v800SignatureValue(v: unknown): string {
  if (v && typeof v === 'object') {
    if ('getHexString' in (v as object)) return (v as THREE.Color).getHexString();
    const rec = v as { x?: unknown; y?: unknown };
    if (typeof rec.x === 'number' && typeof rec.y === 'number') return `${rec.x},${rec.y}`;
  }
  return String(v);
}

/**
 * 材质参数的**实例级**签名（不含 userData 行为旗标）。
 * 与 `tests/r32_car_material.test.ts` 同源：测试断言「同 id + 同签名最多 1 个可合并
 * 实例」时用的就是这个函数 ⇒ 不可能出现「测试换了一套更窄的签名、放过了回归」。
 */
export function v800MaterialSignature(m: THREE.Material): string {
  const p = m as unknown as Record<string, unknown>;
  const parts = V800_MATERIAL_SIGNATURE_KEYS.map((k) => `${k}:${v800SignatureValue(p[k])}`);
  const tex = V800_MATERIAL_TEXTURE_KEYS.map((k) => {
    const t = p[k] as THREE.Texture | null | undefined;
    return t ? t.uuid : '-';
  });
  return `${m.type}|${parts.join(',')}|${tex.join(',')}`;
}

export function createV800CarAdapter(tier: QualityTier = 'high'): CarLike {
  const model = createZunjieV800LuxuryMPVModel({ textureSize: carTextureSizeFor(tier) });
  const runtime = model.userData.runtime as ProceduralModelRuntime | undefined;

  const root = new THREE.Group();
  const body = new THREE.Group();
  body.rotation.y = Math.PI; // 车头 +Z → -Z（游戏前进方向）
  body.add(model);
  root.add(body);

  // ---- 节点索引（按组件 ID）----
  // 同一 ID 可能在 pivot 节点和它的 mesh 上各挂一份；traverse 先序，先命中的是外层 pivot，
  // 运行时要驱动的正是 pivot，这个顺序恰好是我们想要的。
  const indexComponents = (scope: THREE.Object3D): Map<string, THREE.Object3D> => {
    const map = new Map<string, THREE.Object3D>();
    scope.traverse((o) => {
      const cid = (o.userData.sculptComponent?.id ?? o.userData.component?.id) as string | undefined;
      if (cid && !map.has(cid)) map.set(cid, o);
    });
    return map;
  };
  // let 而不是 const：合批之后要重建一次（见下方 §静态合批）
  let byId = indexComponents(model);

  // ---- R12-T2 车轮正下方「皮带状」异物根治（消去法实锤）----
  // 用户游戏截图：每个车轮正下方一条黑色皮带状物从轮底伸向地面。低机位消去法
  // （r12_mat/lowfront45_norims/nospokes/norings/noliner 逐个隐藏对照）定罪：
  // 工厂组件 arch-fr（前轮拱护缘）/ arch-rr（后轮拱护缘）几何退化 ——
  //   世界 bbox x ∈ [-0.001, 0.001]（塌缩进车身中心平面，厚度仅 2mm）、
  //   y ∈ [-0.096, 0.896]（下缘穿地 9.6cm）、z 跨度 ≈0.99m（半径 ≈0.5 的整圆环），
  //   1152 tris，位于前后轴正中。即：两枚完整圆环竖立在车身中剖面，下弧从车底
  //   露出 → 低机位读作「轮底皮带」。几何本体（整圆而非半圆拱、半径超胎廓、
  //   错放在中剖面）属 spec/工厂侧问题，本层无法在不动面数的前提下摆正
  //   （平移到轮侧仍是穿地整圆环）。处置：隐藏退化件；轮拱深度改由工厂
  //   body-lower 拱形开口本体承担（R18 已删除外凸的 wheel-arch-liner 衬筒）。
  //   并汇报主理人转 spec 线重雕（半圆拱护缘、贴轮拱口、左右各一）。
  // 注意：必须在此处（batchMergeStatic 之前）置 visible=false —— 合并器按
  // 「可见性」跳过隐藏件，避免退化几何被烘进 batch/matte-black 后无法单独处理。
  for (const brokenArchId of ['arch-fr', 'arch-rr']) {
    const node = byId.get(brokenArchId);
    if (!node) continue;
    node.traverse((o) => {
      o.visible = false;
    });
  }

  // ---- 材质索引（按材质 ID：userData.sculptMaterial.id）----
  const matById = new Map<string, THREE.MeshPhysicalMaterial>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const arr = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of arr) {
      const id = (mt as THREE.MeshPhysicalMaterial | undefined)?.userData?.sculptMaterial?.id as
        | string
        | undefined;
      if (id && !matById.has(id)) matById.set(id, mt as THREE.MeshPhysicalMaterial);
    }
  });

  // ---- R10 外观纯色件弃用图集（挤出帽面 UV 串味根治）----
  // 工厂烘焙图集按「侧面 UV」设计，挤出帽面/棱边碎 UV 会采到木纹/皮革等装饰区
  // （机盖大理石纹、腰带杂色 = 实机 r7-side/front45 实证）。这些材质语义就是
  // 纯色，直接撤 map/normalMap 回退 spec 颜色 —— 串味源头整体消失。
  for (const solidId of ['paint-upper', 'paint-lower', 'matte-black', 'chrome', 'wheel-alloy']) {
    const mat = matById.get(solidId);
    if (!mat) continue;
    if (mat.map) mat.map = null;
    if (mat.normalMap) mat.normalMap = null;
    const sc = mat.userData?.sculptMaterial as { color?: string } | undefined;
    if (sc?.color) mat.color.set(sc.color);
    mat.needsUpdate = true;
  }
  // R10b：平滑法线后高金属漆面把 RoomEnvironment 暖色矩形镜像成大理石漩涡
  // （前后两次截图逐像素一致、撤 map 无效 → 反射实锤）。车漆改清漆语义：
  // 低金属度+较高粗糙+压低 env；铬件同压。
  const paintMat = matById.get('paint-upper');
  if (paintMat) {
    paintMat.metalness = 0.12;
    paintMat.roughness = 0.42;
    paintMat.envMapIntensity = 0.55;
    paintMat.needsUpdate = true;
  }
  const paintLowerMat = matById.get('paint-lower');
  if (paintLowerMat) {
    paintLowerMat.metalness = 0.1;
    paintLowerMat.roughness = 0.5;
    paintLowerMat.envMapIntensity = 0.45;
    paintLowerMat.needsUpdate = true;
  }
  const chromeMatSolid = matById.get('chrome');
  if (chromeMatSolid) {
    chromeMatSolid.metalness = 0.42;
    chromeMatSolid.roughness = 0.42;
    chromeMatSolid.envMapIntensity = 0.26; // R12b：软光箱下眉线/徽框过曝成白板，压反射读作缎面银
    chromeMatSolid.needsUpdate = true;
  }

  // R12b 内饰材质纯化在文件末「终局覆盖」执行（必须在程序化皮革/菱格贴图接线之后，
  // 否则会被 applySurface 的 !mat.map 判据重新挂回图集）。
  // ---- P1-5 greenhouse 玻璃一致性（适配层覆盖；spec 数值不动，决策回写 spec 留给主理人）----
  // 根因：高透射（0.82）+ 中灰色调下侧窗整条读作「天空色空带」，顶棚视觉悬空
  // （第四轮审查 S1）。改走「隐私玻璃」观感：透射压到 0.10（R6 修订）、色调近黑，
  // 靠环境反射（envMapIntensity 1.35）给镜面层次替代透射 —— 玻璃读作深色实体，
  // 座舱轮廓由反射勾勒，不再透出天空色。透射 pass 本就因 glass-clear/crystal
  // 存在，此处零新增 pass、零 DC 增量；transparent 关闭（透射材质不再叠加混合）。
  const greenhouseMat = matById.get('glass-dark') ?? null;
  if (greenhouseMat) {
    // trans 0.12（R10 终值）：深烟灰偏黑 —— B1 黑版侧窗只隐约透出座舱轮廓；
    // 0.22 时木纹/菱格透色成「大理石腰带」（hide-test 实证：纹样=舱内 wood/皮革）。
    greenhouseMat.transmission = 0.12;
    greenhouseMat.color.set(0x10151b);
    greenhouseMat.roughness = 0.06;
    greenhouseMat.envMapIntensity = 1.35;
    greenhouseMat.thickness = 0.02;
    greenhouseMat.transparent = false;
    greenhouseMat.needsUpdate = true;
  }

  // ---- R12b 透射路径整体下线（R11 P0：整帧 DC 244 > 红线 150）----
  // 根因：transmission 透射 pass 每帧把整个场景（车模 + 场景 + 阴影）重复渲染一遍，
  // 深烟灰隐私玻璃在平板件上并无可见折射差异。改为 transparent alpha + 金属度
  // Fresnel 补偿（F0≈0.22）后：侧视反射层次保留、座舱轮廓仍可见，每帧少一整趟
  // 场景绘制。质量档只差透明度（high 更透，low 更暗）。
  {
    const opacityFor = tier === 'high' ? 0.7 : tier === 'medium' ? 0.66 : 0.62;
    for (const [id, mat] of matById) {
      if (!(mat.transmission > 0)) continue;
      mat.transmission = 0;
      mat.transparent = true;
      mat.depthWrite = false;
      // 复用既有降级不透明度表（玻璃/crystal 语义），质量档只在 high 上再放开一档
      const fallback = GLASS_OPACITY_FALLBACK[id] ?? DEFAULT_GLASS_OPACITY;
      mat.opacity = Math.min(1, Math.max(fallback * 0.94, opacityFor * 0.9));
      if (id === 'glass-dark') {
        mat.metalness = 0.22;
        mat.roughness = 0.07;
        mat.envMapIntensity = 1.55;
      }
      if (id === 'glass-clear') {
        // 前挡用低反射：软光箱下 1.6 会把整块玻璃读成白板（r12e 实证），
        // 0.7 + 低不透明度才能既透出座舱又不糊成墙。
        // R13：opacity 0.34→0.66 —— 0.34 时从正/侧前方直接看穿风挡，米白
        // 仪表台顶 + 顶棚内饰透出，被用户指认「奶白色面板/白板」的一部分；
        // 参考图 A1-A8/bilibili 正面风挡均为深色隐私玻璃观感。
        mat.metalness = 0.02;
        mat.roughness = 0.03;
        mat.envMapIntensity = 0.7;
        mat.opacity = Math.min(Math.max(mat.opacity, 0.66), 0.72);
      }
      mat.needsUpdate = true;
    }
  }

  // ---- 隐藏占位盒：root/cabin-interior 实心盒 + 轮胎材质方块盒 ----
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const comp = o.userData.sculptComponent as { id?: string; primitive?: string } | undefined;
    const cid = (comp?.id ?? o.userData.component?.id) as string | undefined;
    if (cid === 'root' || cid === 'cabin-interior') {
      // N1：tri-screen / gauge-screen / rear-control-screen 以 cabin-interior 为父 ——
      // 直接隐藏会把三块屏整棵藏掉（屏 UI 永远不渲染）。先把屏移出占位盒
      // （attach 保持世界变换），再隐藏占位盒本体。
      m.visible = false;
      return;
    }
    // 车轮占位件的隐藏判据已单独下移（见紧随其后的「R4 修订」块）。
  });

  // 车轮占位件隐藏 —— ⚠️ R4 修订（R3 引入的显形回归）：
  // 占位件是 0.764×0.764 的方块，角部比同直径圆胎外扩 15.8cm 且 castShadow，
  // 必须隐藏；只隐藏方块自身（父节点仍是轮心 pivot，子级真轮胎/轮圈/齿环保留）。
  // 旧判据 primitive === 'box' 在搭景 R3 失效 —— R3 把 wheel-fl..rr 由 box 改为
  // 圆角 extrude，条件不再命中，**4 个占位方块重新可见**：每个轮子外挂一块
  // 0.764 见方的圆角板并投阴影（a2 探针实测：184 mesh 里只有 2 个不可见，
  // 4 个占位件全在可见集合里）。
  // 新判据：真胎是 lathe 回转体，占位件不是（box / 圆角 extrude 都是方块）。
  // **不能用体积**：实测 8 个 tire 材质 mesh（4 占位 + 4 真胎）包围盒同为
  // 0.764×0.764×0.255 ≈ 0.149 m³，任何体积阈值都会同时命中或同时漏掉。
  // 双重保险：若本批一个 lathe 真胎都找不到（spec 又换了基元），就不隐藏任何
  // tire 材质件 —— 宁可多画一个方块，也不能把真胎藏掉。
  {
    const tireMeshes: THREE.Mesh[] = [];
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (
        mats.some(
          (mt) =>
            (mt as THREE.MeshPhysicalMaterial | undefined)?.userData?.sculptMaterial?.id === 'tire'
        )
      ) {
        tireMeshes.push(m);
      }
    });
    if (tireMeshes.some((m) => m.geometry.type === 'LatheGeometry')) {
      for (const m of tireMeshes) {
        if (m.geometry.type === 'LatheGeometry') continue; // 真胎，保留
        m.visible = false;
        m.castShadow = false;
      }
    }
  }

  // ---- N1：屏幕家族脱离隐藏的 cabin-interior 占位盒 ----
  // spec 里 tri-screen / gauge-screen / rear-control-screen 的 parent 是 cabin-interior
  // （占位实心盒，上方已 visible=false）—— 子树随父隐藏，三块屏从未渲染过。
  // attach() 到 model 根并保持世界变换；扶手屏挂在 seat-rear-* 下不受影响。
  // ⚠️ attach 依赖 matrixWorld：全新场景图尚未计算过，必须先刷新一次，
  // 否则 attach 用恒等矩阵反解局部变换 → 屏幕飞位。
  root.updateMatrixWorld(true);
  for (const id of ['tri-screen', 'gauge-screen', 'rear-control-screen']) {
    const node = byId.get(id);
    if (node && node.parent && node.parent !== model) {
      model.attach(node);
    }
  }
  // 屏面朝向修正：工厂 plane-card 的 UI 面朝 +z（风挡方向），背对驾驶者 ——
  // FrontSide 材质下驾驶者视角整体背面剔除（屏「消失」），车外透过风挡才见灰板
  // （QA 终验 H4-tri-screen 灰白素板的真因）。绕局部 Y 旋转 π 让 UI 面向乘员。
  // rear-control-screen 同型缺陷：UI 面朝 +z 背对二排乘客（下方 N1 屏幕家族
  // 处只做 UV 重映射、不翻面，无双重翻转风险）。
  for (const id of ['tri-screen', 'gauge-screen', 'rear-control-screen']) {
    const node = byId.get(id);
    if (node) node.rotateY(Math.PI);
  }

  // ---- 车轮（pivot 在轮心，绕 X 滚动）----
  const wheels: WheelPivot[] = [];
  for (const tag of ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']) {
    const pivot = byId.get(tag);
    if (!pivot) continue;
    // ---- R8 轮心对轴（修「轮子反着乱晃」根因）----
    // 工厂 spin 节点原点 ≠ 轮心：wheel-fl 节点在 z1.333，而 tire 子件挂在
    // local z+0.382（×节点 scale0.764 ≈ 世界 +0.29）——直接绕节点转 rotation.x
    // 等于让整个轮体绕轴「公转」，视觉上就是乱晃 + 倒转感。
    // 修法：包一层 hub 组（原点=轮心），把轮子子树整体 attach 进去（保持世界
    // 位姿不变），spin 改转 hub。合批保护清单按 /^wheel-/ 命名匹配，hub 命名
    // 沿用 wheel-* 前缀天然受保护。
    const hub = new THREE.Group();
    hub.name = `${tag}-hub`;
    // 轮心实测：取 pivot 子树里第一个 tire-* mesh 的世界 bbox 中心，反算 pivot 局部坐标
    // （工厂在 mesh 与 spec 节点间包了中间组，position 不可直读；bbox 才是真值）。
    // 必须先落位 hub 再 attach 子件——attach 按当时 hub 世界矩阵重算子件局部坐标。
    pivot.updateMatrixWorld(true);
    let centerLocal: THREE.Vector3 | null = null;
    pivot.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || centerLocal) return;
      const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
      const isTire = comp?.id?.startsWith('tire-') || (m.name || '').includes('tire');
      if (!isTire) return;
      const b = new THREE.Box3().setFromObject(m);
      centerLocal = pivot.worldToLocal(b.getCenter(new THREE.Vector3()));
    });
    if (!centerLocal) {
      pivot.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || centerLocal) return;
        const b = new THREE.Box3().setFromObject(m);
        centerLocal = pivot.worldToLocal(b.getCenter(new THREE.Vector3()));
      });
    }
    if (centerLocal) hub.position.copy(centerLocal);
    pivot.add(hub);
    const moved = [...pivot.children].filter((c) => c !== hub);
    for (const c of moved) hub.attach(c);
    pivot.updateMatrixWorld(true);
    wheels.push({ spin: hub });
  }

  // 注：辐条 InstancedMesh 已从 spec 整体删除（原 4 个系统 80 实例 = 15,360 面，
  // 全被实心 cylinder 胎/圈包住 100% 不可见）。盘缘 20 开窗改由 wheel-alloy 的
  // Canvas 贴图（见 createWheelFaceTexture）承担，各 1 个 draw call。

  // ---- 刹车踏板（集成层程序化组件，未走 spec 工厂）----
  // 为什么不放进 spec：踏板是「断裂演出」的交互主体，需要运行时运动学脱落动画，
  // 而工厂产物不可手改、本轮也不重跑生成器（回写 spec → validate → generate → tsc）。
  // 已登记为集成层资产；下一轮若动 spec 再迁为 meso 组件（切记 level 必须 meso）。
  // 几何合并为单个 mesh（踏板臂 + 踏板面 + 3 条防滑条）→ 整帧只 +1 draw call，
  // 且仅在相机贴近（车内视角）时可见，车外视角零开销。
  // 坐标口径同 spec：工厂车头 +Z、驾驶侧 +X（与 cabin 机位实测一致）。
  const PEDAL_PIVOT = new THREE.Vector3(0.5, 0.62, 1.42);
  /** 脚窝地板相对枢轴的高度（下坠终止面） */
  const PEDAL_FALL_FLOOR = -0.3;
  /** 断裂瞬间绕顶端转轴甩向驾驶者的角度 */
  const PEDAL_FLING_RAD = (40 * Math.PI) / 180;
  // R13：踏板贴图（上 38% 橡胶防滑垫 + 下拉丝不锈钢，程序化 Canvas）。
  // color 放白防「贴图 × 深色底」双重压暗；盒体各面 UV 0-1，踏板面整贴单面图。
  const pedalTex = createBrakePedalTexture();
  pedalTex.anisotropy = 4;
  const pedalMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: pedalTex,
    roughness: 0.78,
    metalness: 0.12,
    clearcoat: 0.2,
    clearcoatRoughness: 0.6
  });
  const pedalGeo = mergeSafe([
    // 踏板臂（自顶端枢轴向下 0.26）
    new THREE.BoxGeometry(0.032, 0.26, 0.036).translate(0, -0.13, 0),
    // 踏板面（略向驾驶者后倾）
    new THREE.BoxGeometry(0.1, 0.13, 0.024).translate(0, -0.28, -0.055),
    // 防滑条 ×3
    new THREE.BoxGeometry(0.088, 0.008, 0.006).translate(0, -0.245, -0.112),
    new THREE.BoxGeometry(0.088, 0.008, 0.006).translate(0, -0.28, -0.112),
    new THREE.BoxGeometry(0.088, 0.008, 0.006).translate(0, -0.315, -0.112)
  ]);
  const pedal = new THREE.Mesh(pedalGeo, pedalMat);
  pedal.name = 'brake-pedal';
  pedal.position.copy(PEDAL_PIVOT);
  pedal.castShadow = false;
  pedal.visible = false;
  body.add(pedal);
  /** 脱落动画状态：pedalT < 0 表示未断裂 */
  let pedalT = -1;
  let pedalVelY = 0;
  let pedalVelZ = 0;
  let pedalBounce = 0;
  let pedalRotX = 0;

  /**
   * 集成层自产贴图登记表：所有运行时生成的 CanvasTexture 都压在这里，
   * dispose 时统一释放（已挂到材质上的会随材质槽级联释放，重复 dispose 无副作用；
   * 材质缺失时的孤儿贴图在这里兜底）。声明在踏板/光毯之前 —— 两者都要登记。
   */
  const ownedTextures: THREE.Texture[] = [];

  // ---- EX-09 迎宾光毯（集成层运行时资产，同踏板先例：不进 spec/工厂）----
  // 四车门下方各一张投影面（工厂坐标，X=±0.90 贴门下沿 —— 旧 ±1.13 时 0.72 宽
  // 光斑总 span 2.98m，主体落在车外 0.48m 路面上；现 0.44 宽 × ±0.90 总 span
  // 2.24m 收进车宽内。Z 取门板中心 ±0.85/∓0.95，实测前后轮接地质心
  // z=±1.715±0.382 均不重叠），合并为单 mesh → +1 draw call。
  // 挂在 body 下（工厂坐标系），不进 batchMergeStatic 的遍历范围。
  // 观感：无光照 MeshBasicMaterial 贴花（投影光不随场景明暗变化）+ 透明混合 +
  // 深度不写（贴在地面上不与路面 z-fight）。emissive 弱发光由贴图金芯亮度 +
  // 缓慢呼吸 + bloom 阈值以下的保守亮度承担；行驶中（>5km/h）淡出（无迎宾态）。
  const welcomeGeo = mergeSafe(
    WELCOME_CARPET_SPOTS.map(([sx, sz]) =>
      new THREE.PlaneGeometry(WELCOME_CARPET_W, WELCOME_CARPET_L)
        .rotateX(-Math.PI / 2) // 面朝上（法线 +Y）
        .translate(sx, WELCOME_CARPET_Y, sz)
    )
  );  const welcomeTex = createWelcomeCarpetTexture(CARPET_TEX_SIZE[tier]);
  ownedTextures.push(welcomeTex);
  const welcomeMat = new THREE.MeshBasicMaterial({
    map: welcomeTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
    color: 0xffffff
  });
  const welcomeMesh = new THREE.Mesh(welcomeGeo, welcomeMat);
  welcomeMesh.name = 'welcome-carpet';
  welcomeMesh.castShadow = false;
  welcomeMesh.receiveShadow = false;
  body.add(welcomeMesh);
  /** 迎宾态增益（速度门控 + damp 平滑），1 = 完全可见 */
  let welcomeGain = 1;
  /** 最近一次 updateCluster 的车速（km/h）—— 迎宾态判定用 */
  let lastSpeedKmh = 0;

  // ---- 灯光材质（按 ID 查表 + 回退链，缺失只 warn 一次）----
  const warnedLamps = new Set<string>();
  /**
   * 按回退链认领材质，返回命中的材质 ID + 材质本体。
   * 回退链可能收敛到同一材质（如 lamp-head/lamp-mark 都落到 lamp-white），
   * 按 尾灯 > 头灯 > 字标 的顺序认领，避免后者每帧覆盖前者。
   */
  const usedMats = new Set<THREE.MeshPhysicalMaterial>();
  const pickLamp = (
    label: string,
    chain: readonly string[]
  ): { id: string; mat: THREE.MeshPhysicalMaterial } | null => {
    for (const id of chain) {
      const mat = matById.get(id);
      if (mat && !usedMats.has(mat)) {
        usedMats.add(mat);
        return { id, mat };
      }
    }
    if (!warnedLamps.has(label)) {
      warnedLamps.add(label);
      console.warn(`[V800Adapter] 未找到「${label}」灯光材质（尝试：${chain.join(' → ')}），该灯组保持无发光`);
    }
    return null;
  };
  const tailLamp = pickLamp('刹车灯', LAMP_MATERIAL_IDS.brake);
  const headLamp = pickLamp('头灯', LAMP_MATERIAL_IDS.head);
  const markLamp = pickLamp('字标', LAMP_MATERIAL_IDS.mark);
  const tailMat = tailLamp?.mat ?? null;
  const headMat = headLamp?.mat ?? null;
  const markMat = markLamp?.mat ?? null;
  // R21-B/C：手写尾灯 / 前大灯材质引用（在下方 R21 接线块赋值，update() 联动用）
  let tailLampMats: TailLampMaterials | null = null;
  let headLampMats: HeadLampMaterials | null = null;
  // R12b：头灯 LED 白条在装配态整条过曝成白柱（正视 r12c_nose 实证），
  // 压到 0.62 保留日行灯亮度层次、仍高于 bloom 阈值。
  if (headMat) {
    headMat.emissiveIntensity = Math.min(headMat.emissiveIntensity, 0.62);
    headMat.needsUpdate = true;
  }

  // ---- 集成层贴图：星空顶 / 字标 / 金色签名屏 ----
  // 这三个材质由 spec 声明为 textureless，贴图在集成层现画；
  // 星空顶与签名屏走独立分支、不参与上面的认领，缺失时静默跳过（spec 未落地时不应刷屏）。
  const starMat = matById.get('starlight') ?? null;
  const goldMat = matById.get('lamp-gold') ?? null;
  if (starMat) {
    const tex = createStarlightTexture(STARLIGHT_DENSITY[tier]);
    ownedTextures.push(tex);
    starMat.emissiveMap = tex;
    starMat.emissive.set(0xffffff);
    starMat.needsUpdate = true;
  }
  if (goldMat) {
    const tex = createGoldAtlasTexture();
    ownedTextures.push(tex);
    goldMat.emissiveMap = tex;
    goldMat.emissive.set(0xffffff);
    // N3 素面金观感：亮金 albedo × metalness 1 × roughness 0.28 = 奶油色 blob。
    // 深色拉丝 albedo 图集承担「深色拉丝金属」底色，roughness 收敛镜面反射；
    // 签名屏（左区近黑底）上的金色点阵对比度同步提升（EX-29）。
    const albedo = createGoldAlbedoAtlasTexture();
    ownedTextures.push(albedo);
    goldMat.map = albedo;
    goldMat.color.set(0xffffff); // 底色交给 map（同 plate 先例：避免 albedo 相乘压色）
    goldMat.roughness = 0.45;
    goldMat.needsUpdate = true;
  }
  // 字标贴图只在真正命中 lamp-mark 时挂，避免污染回退到的 lamp-white（星空顶也在用它）
  let markBase = MARK_BASE_INTENSITY;
  if (markMat && markLamp?.id === 'lamp-mark') {
    const tex = createMarkTexture();
    ownedTextures.push(tex);
    markMat.emissiveMap = tex;
    markMat.emissive.set(0xffffff);
    // 呼吸强度改为「乘」在基准上，尊重 spec 自有的 emissiveIntensity
    if (markMat.emissiveIntensity > 0) markBase = markMat.emissiveIntensity;
    markMat.needsUpdate = true;
  }
  // 轮圈盘面：封闭大饼 + 盘缘 20 开窗 + 中央曜日盾标。
  // 真车是封闭大饼轮圈（不是细辐条），辐条几何已从 spec 删除，开窗由贴图承担。
  // 走 map（不发光），配合 spec 的 metalness 0.95 / roughness 0.2 / envMapIntensity 1.15。
  const wheelMat = matById.get('wheel-alloy') ?? null;
  if (wheelMat && !wheelMat.map) {
    const tex = createWheelFaceTexture(WHEEL_FACE_SIZE[tier]);
    ownedTextures.push(tex);
    wheelMat.map = tex;
    wheelMat.needsUpdate = true;
  }

  // ---- EX 身份特征贴图（Canvas 程序化，spec textureless 声明的集成层路径）----
  // 必须在 batchMergeStatic 之前完成：UV 重映射要烘进源几何，合并时逐顶点保留。
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
  /**
   * 归一化重映射：先测 mesh 自身 UV 包围盒，再线性压进目标区。
   * —— 图集分区重映射**唯一**入口。
   *
   * extrude / curve-sweep 基元的 UV 是坐标值（实测 leather-warm 合批后
   * u∈[-0.33,1.0]，R3 圆角化的反光条/签名屏/灯壳 u∈[-0.5,0.5]、v∈[-0.5,1.0]），
   * 不是 0..1 —— 只有先归一才不会把负值带出分区。box/cylinder/lathe 等
   * 0..1 基元下 bbox 即全幅，与线性压进等价。
   *
   * ⚠️ R4：已删除旧的线性版 remapUV（"把 UV 从全幅 0..1 线性压进目标区"）。
   * 它暗含「输入 ⊆ [0,1]」前提，而该前提在 R2/R3 圆角化中被静默打破两次
   * （R3 一次 814 个三角形串味）。留着这个"看起来更省事"的入口只会再犯。
   */
  const remapUVToRegion = (
    mesh: THREE.Mesh,
    u0: number,
    u1: number,
    v0: number,
    v1: number
  ): void => {
    const uv = mesh.geometry.getAttribute('uv');
    if (!uv || uv.count === 0) return;
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const du = uMax - uMin;
    const dv = vMax - vMin;
    if (du < 1e-6 || dv < 1e-6) {
      // 退化 UV（共线/共点）：落到分区中心，避免除零后 NaN
      const uc = (u0 + u1) / 2;
      const vc = (v0 + v1) / 2;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uc, vc);
      uv.needsUpdate = true;
      return;
    }
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(
        i,
        u0 + ((uv.getX(i) - uMin) / du) * (u1 - u0),
        v0 + ((uv.getY(i) - vMin) / dv) * (v1 - v0)
      );
    }
    uv.needsUpdate = true;
  };

  /**
   * R4 新增 · LatheGeometry 的「平帽面 / 筒身」分区重映射。
   *
   * 为什么必须单写一条：搭景 R3 把 tire-fl..rr 与 wheel-cap-fl..rr 由 cylinder
   * 改为 lathe（a2_uvraw 实测：tire-fl / wheel-cap-fl 现为 LatheGeometry，
   * groups=0）。LatheGeometry 的 UV 是 (i/segments, j/(points−1))：
   *   · u = 回转角、v = 沿母线序号，**整条母线连两端平帽面一起被压进 v∈[0,1]**；
   *   · 平帽面上这个 UV 是**极坐标**（u=角度、v=半径），而胎侧字环（EX-34）与
   *     轮心盾徽（EX-33）都是按**平面内切圆** UV 画的 —— 承 CylinderGeometry
   *     generateCap 约定（three r186 源码：顶点 x=R·sinθ、z=R·cosθ，
   *     uv.x=cosθ·0.5+0.5、uv.y=sinθ·0.5·sign+0.5）。极坐标喂给平面图案会把
   *     字环/盾徽拉成同心弧带：R3 前正常，R3 后失效。
   *
   * 做法（与旧 cylinder 分组重映射等价，且**不产生跨区三角形**）：
   *   1. 按母线点序切三角带：首带与末带 = 平帽面，其余 = 筒身；
   *   2. 帽面顶点改赋平面内切圆 UV（R = 母线最大回转半径）
   *        su = 0.5 + 0.5·(z/R)，sv = 0.5 + 0.5·(x/R)
   *      —— 与 generateCap 同约定；两枚帽面同式，等价于已做底帽 v 翻转补偿
   *      （旧 remapTireUV 的 1−v、旧 remapWheelCapCapUV 的底帽补偿）；
   *   3. 筒身顶点 u 保持回转角，v 按自身段 [1/(N−1), (N−2)/(N−1)] 归一；
   *   4. **复制交界环**：交界母线点同时属于两条带，不复制就会出现「一个三角形
   *      两区」（bbox 跨区 → #uvassert 判串味）。复制后两条带顶点集零相交。
   * 非 lathe 或结构不符预期 → 返回 false，由调用方回退到 bbox 归一。
   */
  const remapLatheCapAndBandUV = (
    mesh: THREE.Mesh,
    capRegion: readonly number[],
    bandRegion: readonly number[]
  ): boolean => {
    const geo = mesh.geometry;
    if (geo.type !== 'LatheGeometry') return false;
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const nor = geo.getAttribute('normal');
    const index = geo.getIndex();
    if (!pos || !uv || !index) return false;
    const params = (geo as unknown as { parameters?: { points?: unknown[]; segments?: number } })
      .parameters;
    const N = params?.points?.length ?? 0; // 母线点数（轮胎 / 轮标 = 12）
    const seg = params?.segments ?? 0; // 回转段数（轮胎 = 48，轮标 = 36）
    if (N < 4 || seg < 3) return false;
    const bandCount = N - 1; // 三角带数（= 11）
    if (pos.count !== (seg + 1) * N) return false;
    // 帽面内切圆半径：母线最大回转半径
    let rMax = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (r > rMax) rMax = r;
    }
    if (rMax < 1e-6) return false;
    // 母线按**世界弧长**参数化：LatheGeometry 的 v 默认是「母线点序号 / (N−1)」，
    // 而 R3 的轮胎母线点疏密极不均匀 —— 胎面中段一条带占几何长度 0.765，
    // 两侧 8 条 1cm 圆角带各只占 0.011~0.045。按序号均分会给每条圆角带 1/9 的
    // v：#uvassert 实测各向异性 6.9x~45.7x（最差 45.5x @ 轮胎 fl#461），且
    // 4 道周向沟槽有 3 道落进 1cm 圆角带、胎面一条不剩。改按世界弧长分配后
    // v 段与各带实际尺寸成正比，密度均匀、沟槽回到胎面上。
    mesh.updateWorldMatrix(true, false);
    const wm = mesh.matrixWorld;
    const pa = new THREE.Vector3();
    const pb = new THREE.Vector3();
    const arcLen = new Float64Array(N); // 沿母线累计世界弧长（回转对称，取 i=0 环）
    for (let j = 1; j < N; j++) {
      pa.set(pos.getX(j - 1), pos.getY(j - 1), pos.getZ(j - 1)).applyMatrix4(wm);
      pb.set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(wm);
      arcLen[j] = arcLen[j - 1] + pa.distanceTo(pb);
    }
    const aLo = arcLen[1]; // 筒身首点（母线 j=1）
    const aHi = arcLen[N - 2]; // 筒身末点（母线 j=N−2）
    if (aHi - aLo < 1e-6) return false;

    const outPos: number[] = [];
    const outNor: number[] = [];
    const outUv: number[] = [];
    const outIdx: number[] = [];
    const copyOf = new Map<number, number>(); // key = vi*2 + kind（0=帽面 1=筒身）
    const emit = (vi: number, cap: boolean): number => {
      const key = vi * 2 + (cap ? 0 : 1);
      const hit = copyOf.get(key);
      if (hit !== undefined) return hit;
      const id = outPos.length / 3;
      outPos.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      if (nor) outNor.push(nor.getX(vi), nor.getY(vi), nor.getZ(vi));
      if (cap) {
        const su = 0.5 + 0.5 * (pos.getZ(vi) / rMax);
        const sv = 0.5 + 0.5 * (pos.getX(vi) / rMax);
        outUv.push(
          capRegion[0] + su * (capRegion[1] - capRegion[0]),
          capRegion[2] + sv * (capRegion[3] - capRegion[2])
        );
      } else {
        const t = (arcLen[vi % N] - aLo) / (aHi - aLo); // 世界弧长参数化
        outUv.push(
          bandRegion[0] + uv.getX(vi) * (bandRegion[1] - bandRegion[0]),
          bandRegion[2] + t * (bandRegion[3] - bandRegion[2])
        );
      }
      copyOf.set(key, id);
      return id;
    };
    for (let b = 0; b < bandCount; b++) {
      const cap = b === 0 || b === bandCount - 1;
      for (let i = 0; i < seg; i++) {
        // 绕序同 LatheGeometry：push(a,b',d) + push(c,d,b')
        const a = emit(i * N + b, cap);
        const b2 = emit((i + 1) * N + b, cap);
        const c = emit((i + 1) * N + b + 1, cap);
        const d = emit(i * N + b + 1, cap);
        outIdx.push(a, b2, d, c, d, b2);
      }
    }
    if (outIdx.length !== index.count) return false; // 兜底：三角形数必须守恒
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
    if (nor) out.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3));
    out.setIndex(outIdx);
    mesh.geometry = out; // 旧几何尚未上传 GPU，无显存可泄漏
    return true;
  };

  /**
   * EX-34 轮胎 UV 分区：胎面 → TIRE_TREAD_REGION（左半），胎侧字环 →
   * TIRE_SIDEWALL_REGION（右半）。
   *
   * 历史（R3 之前 tire-* 为 CylinderGeometry，按 3 个 group 分）：
   *   group0 = 胎面（side）→ u 压进左半 [0, 0.5]（v 不变，保留环绕语义）；
   *   group1 = 顶帽 → u 平移进右半 [0.5, 1]；
   *   group2 = 底帽 → 进右半且 v 取 1−v（generateCap sign=−1 的翻转补偿）；
   *   补偿后两枚帽面同向：u = 0.75 + 0.25·(z/R)，v = 0.5 + 0.5·(x/R)。
   *
   * ⚠️ R3 之后 tire-* 变 LatheGeometry（groups=0），「按 CylinderGeometry
   * 分组」判据失效 → 落到非圆柱分支，那一支又假设「UV 恒 0..1」，而隐藏
   * 占位件 wheel-fl..rr 在 R3 也由 box 变圆角 extrude（a2_uvraw 实测
   * u∈[-0.5,0.5]、v∈[-0.5,1.0]）→ #uvassert 实测 232/4528 串味。
   * 现在：lathe 走 remapLatheCapAndBandUV（帽面平面内切圆 → 字环区；筒身 →
   * 胎面区）；其余基元一律 bbox 归一压进胎面区（占位件不可见，只为 #uvassert
   * 全绿，占位件随 spec 保留不删）。
   */
  const remapTireUV = (mesh: THREE.Mesh): void => {
    if (remapLatheCapAndBandUV(mesh, TIRE_SIDEWALL_REGION, TIRE_TREAD_REGION)) return;
    // 隐藏占位件（wheel-fl..rr，适配器已 visible=false）：观感上无任何意义，
    // 钉死到胎面区中心一个纹素即可 —— 只为 #uvassert 全绿。不钉死的话它们仍会
    // 进密度判据（实测 24/3536 超阈、最差 9.6x），把一个不可见件的映射缺陷
    // 记到胎面分区头上，反而掩盖真胎的数字。
    if (mesh.visible === false) {
      const uvAttr = mesh.geometry.getAttribute('uv');
      if (uvAttr) {
        const uc = (TIRE_TREAD_REGION[0] + TIRE_TREAD_REGION[1]) / 2;
        const vc = (TIRE_TREAD_REGION[2] + TIRE_TREAD_REGION[3]) / 2;
        for (let i = 0; i < uvAttr.count; i++) uvAttr.setXY(i, uc, vc);
        uvAttr.needsUpdate = true;
      }
      return;
    }
    remapUVToRegion(
      mesh,
      TIRE_TREAD_REGION[0],
      TIRE_TREAD_REGION[1],
      TIRE_TREAD_REGION[2],
      TIRE_TREAD_REGION[3]
    );
  };

  /**
   * EX-33 轮标帽面补偿。
   * 历史：wheel-cap-* 与轮胎同族（CylinderGeometry），底帽 UV 自带 v 翻转
   * （generateCap sign=−1）。自平衡 billboard 下盘面法线（局部 +Y）水平指向
   * 相机，不补偿则盾徽上下颠倒；底帽 v 取 1−v 后两枚帽面同向（徽标上沿都在
   * 局部 +X），左右两侧车轮、任意机位都正立。
   * ⚠️ R3 之后 wheel-cap-* 变 LatheGeometry（groups=0），旧函数直接 return ——
   * 补偿失效；且 lathe 帽面拿到的是极坐标 UV，而盾徽是画满整幅画布的平面
   * 图案（金环半径 0.465·S）→ 会被拉成同心弧带。改走 remapLatheCapAndBandUV：
   * 帽面平面内切圆 UV、筒身（薄 rim + 倒角）保留回转角并把 v 按自身段归一。
   * 整幅即盾徽、无图集分区（无串味概念）→ cap / band 都落在 [0,1]²。
   */
  const remapWheelCapCapUV = (mesh: THREE.Mesh): void => {
    const FULL: readonly number[] = [0, 1, 0, 1];
    if (remapLatheCapAndBandUV(mesh, FULL, FULL)) return;
    // 回退：仍是 CylinderGeometry 3 组（旧 spec）→ 底帽 v 翻转
    const geo = mesh.geometry;
    const uv = geo.getAttribute('uv');
    const index = geo.getIndex();
    const groups = geo.groups;
    if (!uv || !index || groups.length !== 3) return;
    const seen = new Set<number>();
    const g = groups[2]; // 底帽
    for (let t = g.start; t < g.start + g.count; t++) {
      const vi = index.getX(t);
      if (seen.has(vi)) continue;
      seen.add(vi);
      uv.setXY(vi, uv.getX(vi), 1 - uv.getY(vi));
    }
    uv.needsUpdate = true;
  };

  // EX-28 尾灯 3+3 横带：12 条几何灯带撤除后，图案落在暗场内衬（lantern-emitter，
  // housing-dark）上 —— 红光核心在最深层只露红晕环，见 createTailBandAtlasTexture 注释。
  // housing-dark spec 无 emissive：适配层设同尾灯红色，并在 update() 与 brakeLevel 联动。
  const tailFieldMat = matById.get('housing-dark') ?? null;
  if (tailFieldMat && !tailFieldMat.emissiveMap) {
    const tex = createTailBandAtlasTexture();
    ownedTextures.push(tex);
    tailFieldMat.emissiveMap = tex;
    tailFieldMat.emissive.set(0xe03040); // 与 lamp-red 同色，间隙为纯黑零发光
    tailFieldMat.needsUpdate = true; // 初值不重要：update() 每帧按 brakeLevel 覆盖
    // UV 分区：暗场内衬采样红带区（左半）；尾灯壳/头灯壳重映射到纯黑区（右半），
    // 壳体外观零变化。
    // ⚠️ R4 修订（#uvassert 实测 116/304 串味）：上一版注释写的「线性映射对任意
    // 输入 UV 都收敛到目标区」是错的 —— 只有输入 ⊆ [0,1] 才收敛。搭景 R3 把
    // lantern-emitter-* 由 box 改为圆角 extrude，UV 变成坐标值（a2_uvraw 实测
    // u∈[-0.5,0.5]、v∈[-0.5,1.0]），线性 remapUV 直接把负值带出分区。
    // 一律改走 remapUVToRegion（按 mesh 自身 UV bbox 归一）：0..1 基元下与线性
    // 等价，坐标值基元下才正确。
    for (const fieldId of ['lantern-emitter-l', 'lantern-emitter-r']) {
      const fieldMesh = meshOf(fieldId);
      if (fieldMesh) remapUVToRegion(fieldMesh, 0.004, 0.496, 0.004, 0.996);
    }
    // 壳体是 extrude 基元（UV 为坐标值非 0..1）—— 必须走归一化重映射。
    // #uvassert 实测：旧写法线性 remapUV 有 104/536 三角形越出合法分区
    // （落在 u 0.496..0.55 黑缝与 v<0.3 区域，存在串进红带区的风险）。
    for (const shellId of ['taillamp-l', 'taillamp-r', 'headlamp-l', 'headlamp-r']) {
      const shellMesh = meshOf(shellId);
      if (shellMesh) remapUVToRegion(shellMesh, 0.55, 0.95, 0.3, 0.7);
    }
  }
  // EX-22/EX-08 星尘颗粒：门把手发光条 + 大灯星点卡共用 lamp-star
  const starDustMat = matById.get('lamp-star') ?? null;
  if (starDustMat && !starDustMat.emissiveMap) {
    const tex = createHandleStarTexture();
    ownedTextures.push(tex);
    starDustMat.emissiveMap = tex;
    starDustMat.needsUpdate = true;
  }
  // EX-08 头灯竖向光导：lamp-head 两条竖向灯带 + 6 枚几何点阵共用（R3 裁决：
  // 光导表面去点阵图案、点阵由几何件独撑，详见 createHeadlampLedTexture 注释）
  const ledMat = matById.get('lamp-head') ?? null;
  if (ledMat && !ledMat.emissiveMap) {
    const tex = createHeadlampLedTexture();
    ownedTextures.push(tex);
    ledMat.emissiveMap = tex;
    ledMat.needsUpdate = true;
  }
  // EX-26 车名牌镀铬字（map，非发光；plate 材质独占）
  const plateMat = matById.get('plate') ?? null;
  if (plateMat && !plateMat.map) {
    const tex = createNameplateTexture();
    ownedTextures.push(tex);
    plateMat.map = tex;
    // textureless 路径给的是黑底 albedo（#0C0C0E），会与 map 相乘把整牌压成纯黑 ——
    // 挂 map 后底色改由贴图自带的黑底承担，材质 color 放白
    plateMat.color.set(0xffffff);
    plateMat.needsUpdate = true;
  }
  // EX-07 盾徽面板图集 + UV 分区：面板采样纹样区（左半），两条贯穿灯带重映射
  // 到纯白区（右半），同材质合批组不变、DC 零增量
  const whiteMat = matById.get('lamp-white') ?? null;
  if (whiteMat && !whiteMat.emissiveMap) {
    const tex = createEmblemAtlasTexture();
    ownedTextures.push(tex);
    whiteMat.emissiveMap = tex;
    whiteMat.needsUpdate = true;
    // R4：三件在搭景 R3 全由 box 改为圆角 extrude（a2_uvraw 实测 u∈[-0.5,0.5]、
    // v∈[-0.5,1.0]），线性 remapUV 越界 118/228 → 改 bbox 归一重映射。
    const panelMesh = meshOf('shield-emblem-panel');
    if (panelMesh) remapUVToRegion(panelMesh, 0.004, 0.496, 0.004, 0.996);
    for (const barId of ['front-light-bar', 'bumper-light-strip']) {
      const barMesh = meshOf(barId);
      if (barMesh) remapUVToRegion(barMesh, 0.55, 0.95, 0.3, 0.7);
    }
  }
  // S5 前脸贯穿灯带（front-light-bar）常亮签名：lamp-white 与盾徽面板/后保灯带
  // 共享（head/mark 回退链也可能认领），不能整材质调强度 —— 克隆专供（同
  // reflectorMat 先例：ID 不变、合批按材质实例独立成组），常亮 1.2 白色，
  // 不接头灯/刹车联动。UV 已在上方向纯白灯带区重映射，克隆继承同一 emissiveMap。
  {
    const barMesh = meshOf('front-light-bar');
    if (barMesh && whiteMat) {
      const lightBarMat = whiteMat.clone();
      lightBarMat.emissive.set(0xffffff);
      lightBarMat.emissiveIntensity = 1.2;
      lightBarMat.needsUpdate = true;
      barMesh.material = lightBarMat;
    }
  }
  // P1-1 lamp-gold 图集 UV 分区：签名屏 → 点阵图案区；4 扬声器 + 2 高音罩 →
  // 素面拉丝金区（点阵串味修复）。UV 改动必须在 batchMergeStatic 之前烘进源几何。
  // ⚠️ R4 修订：签名屏 lantern-signature-* 在搭景 R3 由 box 改为圆角 extrude
  // （a2_uvraw 实测 u∈[-0.5,0.5]、v∈[-0.5,1.0]）→ 线性 remapUV 越界 116/3768。
  // 全部改 bbox 归一：box/cylinder/capsule/lathe（UV 恒 0..1）下与线性等价，
  // 圆角 extrude（坐标值 UV）下才正确。
  if (goldMat) {
    for (const id of ['lantern-signature-l', 'lantern-signature-r']) {
      const mesh = meshOf(id);
      if (mesh) remapUVToRegion(mesh, GOLD_PATTERN_REGION[0], GOLD_PATTERN_REGION[1], GOLD_PATTERN_REGION[2], GOLD_PATTERN_REGION[3]);
    }
    for (const id of ['speaker-fl', 'speaker-fr', 'speaker-rl', 'speaker-rr', 'tweeter-l', 'tweeter-r']) {
      const mesh = meshOf(id);
      if (mesh) remapUVToRegion(mesh, GOLD_BRUSHED_REGION[0], GOLD_BRUSHED_REGION[1], GOLD_BRUSHED_REGION[2], GOLD_BRUSHED_REGION[3]);
    }
  }

  // N1 屏幕家族 UI：screen-ui 是共享材质（三联屏 + 后排控制屏 + 2 扶手屏，IN-21/43），
  // spec 声明 textureless（画面由集成层 Canvas 提供）—— 此前从未挂图，四块屏全是
  // 均匀发光素板。图集 + UV 分区：三联屏 → 顶部横条（4.6:1），后排控制屏 → 左下，
  // 扶手屏 → 中下小卡。四块屏不在合批范围（UV_CONTENT_MATERIAL_IDS），逐件重映射安全。
  const screenMat = matById.get('screen-ui') ?? null;
  if (screenMat && !screenMat.emissiveMap) {
    const tex = createScreenUIAtlasTexture();
    ownedTextures.push(tex);
    screenMat.emissiveMap = tex;
    screenMat.map = tex; // 屏体自发光为主，map 同源避免关闭 bloom 后纯黑
    screenMat.emissive.set(0xffffff);
    screenMat.color.set(0xffffff);
    screenMat.emissiveIntensity = 1.25;
    screenMat.needsUpdate = true;
    // R4：plane-card 基元 UV 恒 0..1，线性与 bbox 归一等价；统一走 bbox 归一，
    // 将来若换成坐标值 UV 的基元（如圆角 extrude）不至于再出串味。
    const triScreen = meshOf('tri-screen');
    if (triScreen) remapUVToRegion(triScreen, TRI_SCREEN_UI_REGION[0], TRI_SCREEN_UI_REGION[1], TRI_SCREEN_UI_REGION[2], TRI_SCREEN_UI_REGION[3]);
    const rearCtrl = meshOf('rear-control-screen');
    if (rearCtrl) remapUVToRegion(rearCtrl, REAR_CTRL_UI_REGION[0], REAR_CTRL_UI_REGION[1], REAR_CTRL_UI_REGION[2], REAR_CTRL_UI_REGION[3]);
    for (const id of ['seat-rear-l-screen', 'seat-rear-r-screen']) {
      const mesh = meshOf(id);
      if (!mesh) continue;
      // 扶手屏 rotation.x = −1.75（上仰朝车尾）→ 图集方向旋转 180°（u/v 反向映射）
      remapUVToRegion(mesh, SEAT_CTRL_UI_REGION[1], SEAT_CTRL_UI_REGION[0], SEAT_CTRL_UI_REGION[3], SEAT_CTRL_UI_REGION[2]);
    }
  }

  // EX-34 胎面沟槽 + 胎侧字环：tire 材质（4 真胎 + 4 隐藏占位盒）全部同图集。
  // 必须在合批前烘进源几何（合批保留逐顶点 UV，但分区重映射要在合并前做完）。
  const tireMat = matById.get('tire') ?? null;
  if (tireMat && !tireMat.map) {
    const set = createTireAtlasTexture(TIRE_ATLAS_W[tier]);
    ownedTextures.push(set.map, set.normalMap);
    tireMat.map = set.map;
    tireMat.normalMap = set.normalMap;
    tireMat.normalScale.setScalar(0.8);
    tireMat.color.set(0xffffff); // 底色交给贴图（同 plate/lamp-gold 先例）
    tireMat.needsUpdate = true;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (!mats.includes(tireMat)) return;
      remapTireUV(m);
    });
  }

  // EX-31 后保反光条分段：lamp-red 共享（尾灯芯×2 + 反光条×4 + 尾灯横带×4）——
  // 直接给 lamp-red 挂图会把分段图案串到尾灯上，故克隆一份专供反光条
  // （ID 不变，合批按材质实例分组 → 反光条独立成组，尾灯组不变）。
  const lampRedMat = matById.get('lamp-red') ?? null;
  const reflectorMat = lampRedMat ? lampRedMat.clone() : null;
  if (reflectorMat && !reflectorMat.emissiveMap) {
    const tex = createReflectorAtlasTexture();
    ownedTextures.push(tex);
    reflectorMat.emissiveMap = tex;
    // 反光条不是刹车灯：静态弱发光（不接 brakeLevel；0.55 × #E03040 ≈ 0.20 亮度，
    // 低于 UnrealBloom 阈值 0.72，怠速/满刹都不起爆）
    reflectorMat.emissiveIntensity = REFLECTOR_EMISSIVE_INTENSITY;
    reflectorMat.needsUpdate = true;
    // ⚠️ R4 修订（#uvassert 实测 232/304 串味，本波最严重一组）：四件在搭景
    // R2/R3 全由 box 改为圆角 extrude（a2_uvraw 实测 u∈[-0.5,0.5]、v∈[-0.5,1.0]），
    // 「盒基元 UV 恒 0..1 → 线性 remapUV 足够」的前提已失效 → 改 bbox 归一。
    // 上下两排反光条采样同一分段区，读感一致。
    for (const id of [
      'rear-reflector-l',
      'rear-reflector-r',
      'rear-reflector-strip-l',
      'rear-reflector-strip-r'
    ]) {
      const mesh = meshOf(id);
      if (mesh) {
        mesh.material = reflectorMat;
        remapUVToRegion(
          mesh,
          REFLECTOR_PATTERN_REGION[0],
          REFLECTOR_PATTERN_REGION[1],
          REFLECTOR_PATTERN_REGION[2],
          REFLECTOR_PATTERN_REGION[3]
        );
      }
    }
  }

  // EX-08 大灯 3-LED 点阵（架构组 R2 新件 headlamp-led-dot-1/2/3-l/r，extrude）：
  // lamp-head 的 emissiveMap 是「暗底 + 3 圆 LED」贴图，extrude 的 UV 是坐标值
  // （实测 ≈±0.02）—— 不重映射会采到画布角的暗蓝灰底，灯珠呈灰蓝（架构组已通告）。
  // 解法：归一化重映射到中枚 LED 的实心白芯区（createHeadlampLedTexture 画布
  // x[42,86] y[234,278] → UV [0.328,0.672]×[0.457,0.543]），灯珠读作纯白发光点。
  // lamp-head 不进 UV_ATLAS_REGIONS：全幅同质（暗底 + LED 点），点阵采中芯白区
  // 是刻意行为，无分区冲突（无串味概念）；两条竖向灯芯保持全幅采样不变。
  const LED_DOT_REGION = Object.freeze([0.328, 0.672, 0.457, 0.543]);
  let ledDotCount = 0;
  for (const id of [
    'headlamp-led-dot-1-l',
    'headlamp-led-dot-2-l',
    'headlamp-led-dot-3-l',
    'headlamp-led-dot-1-r',
    'headlamp-led-dot-2-r',
    'headlamp-led-dot-3-r'
  ]) {
    const mesh = meshOf(id);
    if (mesh) {
      remapUVToRegion(
        mesh,
        LED_DOT_REGION[0],
        LED_DOT_REGION[1],
        LED_DOT_REGION[2],
        LED_DOT_REGION[3]
      );
      ledDotCount++;
    }
  }

  // EX-33 轮心黑底盾徽：lamp-mark 共享（车尾 MAEXTRO 字标 13:1 横条 + 4 枚悬浮
  // 轮标 cylinder）—— 克隆专供轮标。帽面 UV 内切圆约定下盾徽画满整幅画布即自然
  // 落在帽面，无需重映射（无图集分区 → 无串味概念，探针已实证 discR2max=0.25）。
  // 搭景 R2 已落地的滚花齿环（cap-*，extrude 20 齿环，内径 0.19 让位本盾徽
  // r0.07、齿尖外径 0.296、chrome 材质避免采样盘面贴图）与本盾徽同心：
  // 齿环随轮旋转，盾徽自平衡朝向观察者 —— 参考图 D1-D4 的轮心构图成立。
  const markMatForBadge = matById.get('lamp-mark') ?? null;
  const wheelCapMat = markMatForBadge ? markMatForBadge.clone() : null;
  // ⚠️ R4：原守卫 `!wheelCapMat.emissiveMap` 恒为 false —— THREE.Material.clone()
  // 会把 emissiveMap 一起复制，而 lamp-mark 自 EX-07 波起就挂着 MAEXTRO 字标条，
  // 于是克隆体上永远「已挂图」→ 整个块被跳过：4 枚悬浮轮标一直显示的是字标条
  // （512×128）而不是盾徽（256×256），块内的 remapWheelCapCapUV 也从未执行。
  // a2 探针实测（对比 emissiveMap uuid）：wheel-cap-fl..rr 与 maextro-mark 用的是
  // 同一张 512×128 贴图。改为「盾徽未挂则挂」的显式判据。
  if (wheelCapMat && wheelCapMat.userData.wheelBadgeApplied !== true) {
    const tex = createWheelBadgeTexture(WHEEL_BADGE_SIZE[tier]);
    ownedTextures.push(tex);
    wheelCapMat.emissiveMap = tex;
    wheelCapMat.emissive.set(0xffffff);
    wheelCapMat.needsUpdate = true;
    wheelCapMat.userData.wheelBadgeApplied = true;
    for (const id of ['wheel-cap-fl', 'wheel-cap-fr', 'wheel-cap-rl', 'wheel-cap-rr']) {
      const mesh = meshOf(id);
      if (mesh) {
        mesh.material = wheelCapMat;
        remapWheelCapCapUV(mesh); // 底帽 v 翻转补偿（自平衡 billboard 下两侧都正立）
      }
    }
  }

  // ---- 尾门 MAEXTRO 贯通小字（运行时叠加面片，挂 body 下、不进合批）----
  // R13 用户裁决：车尾只保留 MAEXTRO 贯通小字，「尊界 V800」镀铬字牌（P1-6
  // tailgate-badge）整块移除 —— 参考图 C3 实锤真车尾门无中文铭牌。位置实测：
  // tailgate 组件世界 bbox（工厂坐标车尾 -Z 面），必须在 batchMergeStatic **之前**
  // 测 —— 合并会把 tailgate 子树的 leaf mesh 摘掉，之后 setFromObject 得到空盒。
  // 字牌挂 body（不在 model 子树）→ 合并器遍历不到，但 bbox 数据此刻有效。
  // 面朝车尾（body 局部 -Z = 世界 +Z），离尾门面外偏 1.5cm + 匹配尾门 rotation.x
  // 倾角，防 z-fight。透明贴花 depthWrite:false，MeshBasic + 透明底贴图
  // （无光照贴花，同迎宾光毯先例）。+1 draw call。
  if (typeof document !== 'undefined') {
    const tgNode = byId.get('tailgate');
    if (tgNode) {
      model.updateMatrixWorld(true);
      const tgBox = new THREE.Box3().setFromObject(tgNode);
      if (!tgBox.isEmpty()) {
        const tgCenter = tgBox.getCenter(new THREE.Vector3());
        const tgSize = tgBox.getSize(new THREE.Vector3());
        // 世界 → body 局部（body rotY(π)：车尾世界 +Z ↔ body 局部 -Z）
        const centerLocal = body.worldToLocal(tgCenter.clone());
        // R21-A1：MAEXTRO 字标垂直居中到尾部镀铬贯条（tail-chrome-strip）。
        // 实测 badge 中心 y≈1.098 vs 铬条中心 y≈1.1145，badge 偏下 ~17mm。
        // 不写死猜测值：按铬条运行时 world bbox 中心重定位（spec 微调后也不会失准）。
        // 该测量必须在 batchMergeStatic 之前（铬条 leaf 合批后被摘走 → setFromObject 空盒）。
        let badgeY = centerLocal.y + tgSize.y * 0.36; // fallback：测不到铬条时回退旧公式
        const chromeNode = byId.get('tail-chrome-strip');
        if (chromeNode) {
          const chromeBox = new THREE.Box3().setFromObject(chromeNode);
          if (!chromeBox.isEmpty()) {
            const chromeCenterLocal = body.worldToLocal(chromeBox.getCenter(new THREE.Vector3()));
            badgeY = chromeCenterLocal.y;
            console.info(
              `[V800Adapter] MAEXTRO badge 垂直居中：铬条 world bbox y ${chromeBox.min.y.toFixed(4)}..${chromeBox.max.y.toFixed(4)}` +
                `（中心 ${chromeCenterLocal.y.toFixed(4)}）→ badge.y=${badgeY.toFixed(4)}`
            );
          } else {
            console.warn('[V800Adapter] tail-chrome-strip 测到空盒（合批前不应发生），badge 回退旧公式');
          }
        } else {
          console.warn('[V800Adapter] 找不到 tail-chrome-strip 组件，badge 回退旧公式');
        }
        // R12-T1：尾门上部 MAEXTRO 贯通小字（参考图 C3 实锤：真车尾门顶沿有一行
        // 宽字距 MAEXTRO 铬字）。承载面实证：尾门上部贯穿红带（y≈1.12 世界）与
        // 顶沿饰条之间有一整段干净漆面（r12_mat/tail_view.png）。同 badge 先例：
        // 透明贴花、同倾角、同外偏面；+1 draw call。
        const maextroTex = createTailMaextroTexture();
        ownedTextures.push(maextroTex);
        const maextroGeo = new THREE.PlaneGeometry(0.46, 0.036);
        const maextroMat = new THREE.MeshBasicMaterial({
          map: maextroTex,
          transparent: true,
          depthWrite: false
        });
        const maextro = new THREE.Mesh(maextroGeo, maextroMat);
        maextro.name = 'tailgate-maextro';
        maextro.castShadow = false;
        maextro.receiveShadow = false;
        maextro.position.set(
          centerLocal.x,
          badgeY, // R21-A1：垂直居中到镀铬条（实测 bbox 中心，非写死）
          centerLocal.z - tgSize.z / 2 - 0.015
        );
        maextro.rotation.y = Math.PI;
        maextro.rotation.x = 0; // R12b：同尾门直立
        body.add(maextro);
      }
    }
  }

  // ---- R17 绿色新能源车牌（前后各一，用户截图红框位）----
  // 同 tailgate-maextro 先例：bbox 实测必须在 batchMergeStatic **之前**（合并摘掉 leaf
  // mesh 后 setFromObject 得空盒）；面片挂 body 下不进合批，MeshBasic 透明贴花 +1 DC/牌。
  // 后牌位：尾门中央 MAEXTRO 条带（tail-chrome-strip y1.30~1.34）下方、两尾灯之间
  // （用户截图 077Z 红框 ≈ 尾门 y+5% 处）；前牌位：前保中央下部（用户截图 096Z 红框）。
  if (typeof document !== 'undefined') {
    model.updateMatrixWorld(true);
    // 后牌
    const tgNodeR = byId.get('tailgate');
    let plateRear: THREE.Mesh | null = null;
    if (tgNodeR) {
      const tgBox = new THREE.Box3().setFromObject(tgNodeR);
      if (!tgBox.isEmpty()) {
        const c = tgBox.getCenter(new THREE.Vector3());
        const s = tgBox.getSize(new THREE.Vector3());
        const cl = body.worldToLocal(c.clone());
        plateRear = mountLicensePlate({
          body,
          name: 'license-plate-rear',
          text: '尊界V800',
          size: [0.44, 0.126],
          // 尾门中下部（用户 R17b 指认「适当下调」）：y = 中心 -16% 门高
          // （尾灯下缘 y0.67 之上、MAEXTRO 条带 y1.30 之下，居中偏下）
          position: [cl.x, cl.y - s.y * 0.16, cl.z - s.z / 2 - 0.02],
          faceRear: true,
          ownedTextures
        });
      }
    }
    // 前牌：前保（bumper-lower）中央面
    const bbNode = byId.get('bumper-lower');
    const feNode = byId.get('front-end');
    const plateSrc = bbNode ?? feNode;
    let plateFront: THREE.Mesh | null = null;
    if (plateSrc) {
      const bBox = new THREE.Box3().setFromObject(plateSrc);
      if (!bBox.isEmpty()) {
        const c = bBox.getCenter(new THREE.Vector3());
        const s = bBox.getSize(new THREE.Vector3());
        const cl = body.worldToLocal(c.clone());
        plateFront = mountLicensePlate({
          body,
          name: 'license-plate-front',
          text: '尊界V800',
          size: [0.44, 0.126],
          // 前保面上部（贴 MAEXTRO 字行下缘），面朝 +Z 车头
          position: [cl.x, cl.y + s.y * 0.32, cl.z + s.z / 2 + 0.02],
          faceRear: false,
          ownedTextures
        });
      }
    }
    // ---- R32-D1：前后绿牌共用同一材质实例 + 同一张贴图 ----
    // mountLicensePlate 每次调用各建一份 CanvasTexture + MeshBasicMaterial，而
    // createGreenPlateTexture 自 R18 起忽略 text（牌面不含字符，只有渐变底+边框）
    // ⇒ 两块牌的贴图逐位一致、参数一致（MeshBasic + transparent + depthWrite:false）。
    // 把后牌并到前牌（保留先建者）：材质实例 −1；两块牌仍是各自 mesh（贴花不参与
    // 合批，DC 不变）。被并掉的贴图在装配期内即被替换、从未上传 GPU，dispose 防
    // 泄漏，并同步移出 ownedTextures 登记表（避免 dispose 时二次释放）。
    if (plateRear && plateFront) {
      const rearMat = plateRear.material as THREE.MeshBasicMaterial;
      const frontMat = plateFront.material as THREE.MeshBasicMaterial;
      if (rearMat && frontMat && rearMat !== frontMat) {
        plateRear.material = frontMat;
        const dropped = rearMat.map;
        if (dropped) {
          dropped.dispose();
          const at = ownedTextures.indexOf(dropped);
          if (at >= 0) ownedTextures.splice(at, 1);
        }
        // R32-D1 复核补：`car.dispose()` 是按 mesh 上的 material 引用遍历回收的，
        // 换掉引用后的 rearMat 已成孤儿、遍历不到 ⇒ 这里显式释放（否则程序的
        // refcount 直到 JS GC 才回落，且 userData 上的 spec 元数据会多留一轮）。
        rearMat.dispose();
      }
    }
  }

  // ---- P1 内饰织物贴图：皮革 ×3 / 木纹 / 麂皮 / 窗帘 / 地毯 ----
  // 七个材质 spec 声明 textureless（normal/bump 全 null），这里的 Canvas 程序化
  // 贴图是唯一支撑。可平铺纹理全车通用 → 合批照合不误；唯一需要分区的是
  // leather-warm（菱格只给后排座椅）→ 图集 + UV 归一化重映射。
  // 挂 map 后 color 放白（同 plate 先例：底色由贴图承担，避免 albedo 相乘压暗）。
  const fabricSize = tier === 'low' ? 256 : 512;
  const atlasSize = tier === 'high' ? 1024 : 512; // 贴图 ≤1024 硬约束
  const applySurface = (
    mat: THREE.MeshPhysicalMaterial,
    set: SurfaceMapSet,
    normalScale: number
  ): void => {
    ownedTextures.push(set.map, set.normalMap);
    mat.map = set.map;
    mat.normalMap = set.normalMap;
    mat.normalScale.setScalar(normalScale);
    mat.color.set(0xffffff);
    mat.needsUpdate = true;
  };
  const leatherDarkMat = matById.get('leather-dark') ?? null;
  if (leatherDarkMat && !leatherDarkMat.map) {
    applySurface(
      leatherDarkMat,
      createProceduralSurface(fabricSize, 0.6, leatherSampler([74, 52, 42], 11)),
      0.7
    );
  }
  const leatherIvoryMat = matById.get('leather-ivory') ?? null;
  if (leatherIvoryMat && !leatherIvoryMat.map) {
    applySurface(
      leatherIvoryMat,
      createProceduralSurface(fabricSize, 0.55, leatherSampler([232, 224, 208], 23)),
      0.65
    );
  }
  /**
   * N2 菱格 UV 重建（盒投影）：curve-sweep 基元的参数 UV 相对世界局部各向异性
   * 实测高达 25–220×（#uvassert 密度判据），线性归一化重映射修不了局部畸变 ——
   * 直接按模型空间坐标重建 UV：取包围盒最小的轴为投影法向，其余两轴作 u/v，
   * 细胞数按世界尺寸 ÷ 目棱格边长取整 → 细胞在世界空间近似正方形、纹素密度均匀。
   * 子区原点 (u0,v0)、每细胞 UV 跨度 cellUV（= 图集菱格周期），子区必须在
   * 菱格分区内（u0 + nx·cellUV ≤ 0.992）。
   */
  const QUILT_CELL_WORLD = QUILT_CELL_WORLD_M; // I5/I6 钻石菱格参考边长 ≈6cm（与打孔孔径换算同源）
  /**
   * N2 菱格 UV 重建（逐三角形三平面投影 + 世界锚定连续 UV）：
   * 单平面盒投影对「接近投影方向的面」（头枕顶面、座面沿 Mes）必然压扁 —— 实测
   * 16 个 6.5–11cm² 三角形各向异性 4.5–18x。改为逐三角形按面法线主轴选投影平面
   * （伪三平面），UV = 世界坐标 ÷ 细胞边长 ÷ 贴图细胞数 —— 连续无 mod，环绕交给
   * RepeatWrapping（平铺贴图整幅菱格、细胞周期整数 → 无缝）。折痕两侧 UV 跳变
   * 落在几何折角上（真实软包在此有滚边），不产生可见拉伸。
   * 索引几何先 toNonIndexed（逐三角形独立 UV 需要独立顶点）。
   */
  const remapUVQuiltTriplanar = (mesh: THREE.Mesh): void => {
    let geo = mesh.geometry;
    if (geo.index) {
      const old = geo;
      geo = geo.toNonIndexed();
      mesh.geometry = geo;
      old.dispose();
    }
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    if (!pos || !uv || pos.count === 0) return;
    model.updateMatrixWorld(true);
    const modelToLocal = new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(mesh.matrixWorld);
    const count = pos.count;
    const pts = new Float32Array(count * 3);
    const tv = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      tv.fromBufferAttribute(pos, i).applyMatrix4(modelToLocal);
      pts[i * 3] = tv.x;
      pts[i * 3 + 1] = tv.y;
      pts[i * 3 + 2] = tv.z;
    }
    // 贴图每边 16 细胞（createQuiltTileTexture）→ UV 每细胞 1/16，周期 1.0
    const uvPerCell = 1 / 16;
    for (let t = 0; t < count; t += 3) {
      // 面法线（模型空间）
      const ax = pts[(t + 1) * 3] - pts[t * 3];
      const ay = pts[(t + 1) * 3 + 1] - pts[t * 3 + 1];
      const az = pts[(t + 1) * 3 + 2] - pts[t * 3 + 2];
      const bx = pts[(t + 2) * 3] - pts[t * 3];
      const by = pts[(t + 2) * 3 + 1] - pts[t * 3 + 1];
      const bz = pts[(t + 2) * 3 + 2] - pts[t * 3 + 2];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const abs = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
      const a = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2;
      const a1 = (a + 1) % 3;
      const a2 = (a + 2) % 3;
      for (let k = 0; k < 3; k++) {
        const i = t + k;
        const u = (pts[i * 3 + a1] / QUILT_CELL_WORLD) * uvPerCell;
        const v = (pts[i * 3 + a2] / QUILT_CELL_WORLD) * uvPerCell;
        uv.setXY(i, u, v);
      }
    }
    uv.needsUpdate = true;
  };
  /**
   * N2 扩展：素面区盒投影（统一纹素密度，大面可环绕）。
   * 素面粒面无细胞结构，关键是「两个主方向密度一致」+「不越入菱格区」：
   *   - 短轴 → u：压进素面分区 [0.008, 0.492]（u<0.5 的整列都是素面 paint 区）；
   *   - 长轴 → v：按同一密度自由延展，RepeatWrapping 环绕 —— 粒面噪声以 1.0 UV
   *     为周期（pnoise period 10/28/40），环绕采样无缝；且 u 恒 <0.5，无论 v 环绕到
   *     哪里都落在素面 paint 区（u≥0.5 且 v≥0.5 才是菱格区），零串味风险。
   * 密度下限取 minDensity（≈ 全车素面中位 0.47 m/UV），大件超出分区容量时才放大。
   */
  const PLAIN_MIN_DENSITY = 0.47; // m per UV 单位（对照 #uvassert 密度中位表）
  const remapUVPlainBoxProject = (mesh: THREE.Mesh, u0: number, v0: number, span: number): void => {
    remapUVBoxProject(mesh, u0, v0, (size, axes) => {
      // axes[0] = 最大轴，axes[1] = 次轴。u 取次轴（短），v 取最大轴（长，可环绕）
      const short = size[axes[1]];
      const long = size[axes[0]];
      const density = Math.max(short / span, PLAIN_MIN_DENSITY);
      return [short / density, long / density];
    }, true);
  };
  function remapUVBoxProject(
    mesh: THREE.Mesh,
    u0: number,
    v0: number,
    spansOf: (size: number[], axes: number[]) => [number, number],
    swapAxes = false
  ): void {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    if (!pos || !uv || pos.count === 0) return;
    model.updateMatrixWorld(true);
    const modelToLocal = new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(mesh.matrixWorld);
    const count = pos.count;
    const pts = new Float32Array(count * 3);
    const tv = new THREE.Vector3();
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      tv.fromBufferAttribute(pos, i).applyMatrix4(modelToLocal);
      for (let a = 0; a < 3; a++) {
        const val = a === 0 ? tv.x : a === 1 ? tv.y : tv.z;
        pts[i * 3 + a] = val;
        if (val < mn[a]) mn[a] = val;
        if (val > mx[a]) mx[a] = val;
      }
    }
    const size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const axes = [0, 1, 2].sort((a, b) => size[b] - size[a]); // 大→小
    const uAxis = swapAxes ? axes[1] : axes[0]; // 素面：u 取短轴（压进分区），v 取长轴（环绕）
    const vAxis = swapAxes ? axes[0] : axes[1];
    const w = size[uAxis];
    const h = size[vAxis];
    if (w < 1e-6 || h < 1e-6) return;
    const [uSpan, vSpan] = spansOf(size, axes);
    for (let i = 0; i < count; i++) {
      const pu = (pts[i * 3 + uAxis] - mn[uAxis]) / w;
      const pv = (pts[i * 3 + vAxis] - mn[vAxis]) / h;
      uv.setXY(i, u0 + pu * uSpan, v0 + pv * vSpan);
    }
    uv.needsUpdate = true;
  }
  const leatherWarmMat = matById.get('leather-warm') ?? null;
  /** IN-08 打孔通风区专用克隆（null = 未接线，#lightassert 可见） */
  let quiltPerfMat: THREE.MeshPhysicalMaterial | null = null;
  if (leatherWarmMat && !leatherWarmMat.map) {
    // R2 色调校准：基色 #C08A5E（浅焦糖）→ #7A4034（深 Cognac 偏酒红）。
    // 依据 U1_半剖内饰（酒红）+ I5/I6 二排零重力（深 Cognac）取交集方向压深；
    // 挂在 map 上后 color 放白，故校准必须落在贴图像素侧（spec 颜色不动）。
    // 与 leather-dark（#4A342A，仅 dash-upper）仍可区分：R/B 比 2.35 vs 1.76，
    // 亮度中位 ≈1.4×。
    // 共享图集：素面粒面承载门板/前排/三排等通用件（左上素面区）
    const warm = createLeatherAtlasTexture(atlasSize, 0x51c9d4, LEATHER_WARM_BASE, atlasSize / 32);
    applySurface(leatherWarmMat, warm, 0.7);
    // N2：菱格件改用专用平铺贴图 + 材质克隆（ID 不变）——
    // 共享图集的分区约束与「任意朝向面都要 6cm 等密度菱格」不可兼得（三平面
    // 投影的连续 UV 必然越出分区）；整幅可平铺的菱格贴图让 UV 沿世界坐标无限
    // 延展，RepeatWrapping 无缝环绕。克隆材质令合批把菱格件独立成组：+1 draw call。
    const quiltMat = leatherWarmMat.clone();
    const quiltSet = createQuiltTileTexture(atlasSize / 2, 0x51c9d5, LEATHER_WARM_BASE);
    ownedTextures.push(quiltSet.map, quiltSet.normalMap);
    quiltMat.map = quiltSet.map;
    quiltMat.normalMap = quiltSet.normalMap;
    quiltMat.userData.quiltTiled = true; // #uvassert 跳过分区判据（整幅菱格，无串味概念）
    quiltMat.needsUpdate = true;
    // IN-08 打孔通风区：后排座垫/靠背（不含头枕）用第二份克隆 —— 菱格平铺 +
    // 格心 3×3 微孔阵。头枕保持素菱格（真车通风区不含头枕）。
    // 打孔孔径世界 1.5mm，需要 ≥1024² 才不亚像素 → 贴图用 atlasSize（非 /2）。
    const quiltPerf = leatherWarmMat.clone();
    const perfSet = createQuiltTileTexture(atlasSize, 0x51c9d5, LEATHER_WARM_BASE, true);
    ownedTextures.push(perfSet.map, perfSet.normalMap);
    quiltPerf.map = perfSet.map;
    quiltPerf.normalMap = perfSet.normalMap;
    quiltPerf.userData.quiltTiled = true;
    quiltPerf.needsUpdate = true;
    quiltPerfMat = quiltPerf;
    // 菱格区：后排座椅座面/靠背（打孔）与头枕（素面）—— 逐三角形三平面投影
    for (const id of ['seat-rear-l', 'seat-rear-l-back', 'seat-rear-r', 'seat-rear-r-back']) {
      const mesh = meshOf(id);
      if (mesh) {
        mesh.material = quiltPerf;
        remapUVQuiltTriplanar(mesh);
      }
    }
    for (const id of ['seat-rear-l-headrest', 'seat-rear-r-headrest']) {
      const mesh = meshOf(id);
      if (mesh) {
        mesh.material = quiltMat;
        remapUVQuiltTriplanar(mesh);
      }
    }
    // 素面区（左上）：其余全部 leather-warm 用户（门板/前排/扶手/腿托），
    // 不重映射会采到整幅图集把菱格串到门板上。cabin-interior 是隐藏占位盒，
    // 一并重映射让 #uvassert 全绿（且将来若取消隐藏也不会露出菱格）。
    // 三排大件（1.34m 长凳）改走素面盒投影：归一化重映射下其 curve-sweep UV
    // 的局部各向异性把粒面拉成波浪乱纹（复拍机位正对它），统一密度后消除。
    const half = 0.5;
    const inset = 0.008;
    for (const id of ['seat-third-row', 'seat-third-row-back', 'seat-third-row-headrest']) {
      const mesh = meshOf(id);
      if (mesh) remapUVPlainBoxProject(mesh, inset, half + inset, half - inset * 2);
    }
    for (const id of [
      'cabin-interior',
      'seat-driver',
      'seat-driver-back',
      'seat-driver-headrest',
      'seat-passenger',
      'seat-passenger-back',
      'seat-passenger-headrest',
      'door-panel-fl',
      'door-panel-fr',
      'door-panel-rl',
      'door-panel-rr',
      'seat-rear-l-armrest',
      'seat-rear-l-legrest',
      'seat-rear-r-armrest',
      'seat-rear-r-legrest'
    ]) {
      const mesh = meshOf(id);
      if (mesh) remapUVToRegion(mesh, inset, half - inset, half + inset, 1 - inset);
    }
  }
  const woodMatTrim = matById.get('wood') ?? null;
  if (woodMatTrim && !woodMatTrim.map) {
    applySurface(
      woodMatTrim,
      createProceduralSurface(fabricSize, 0.45, woodSampler([54, 32, 20], 37)),
      0.45
    );
  }
  const suedeMat = matById.get('headliner-suede') ?? null;
  if (suedeMat && !suedeMat.map) {
    applySurface(
      suedeMat,
      createProceduralSurface(fabricSize, 0.35, suedeSampler([58, 42, 32], 41)),
      0.3
    );
  }
  const curtainMat = matById.get('curtain') ?? null;
  if (curtainMat && !curtainMat.map) {
    // R6 压暗（基色 ×0.48）：窗帘原亮度在 trans 0.10 隐私玻璃后仍透出一排扎眼
    // 红白图案（R6 侧视截图实证）；压到暗米色后隐约可辨、不再抢戏。
    applySurface(
      curtainMat,
      createProceduralSurface(fabricSize, 0.5, curtainSampler([104, 99, 92], 53)),
      0.6
    );
  }
  const carpetMat = matById.get('carpet') ?? null;
  if (carpetMat && !carpetMat.map) {
    applySurface(
      carpetMat,
      createProceduralSurface(fabricSize, 0.5, carpetSampler([138, 90, 48], 61)),
      0.8
    );
  }

  // ---- QA 钩子：#lightassert —— 灯光联动命中表 ----
  // 审查建议（A-1）：灯组断链曾靠 if (mat) 静默吞掉，实机零报错但刹车灯不亮。
  // URL hash 含 lightassert 时输出命中表，miss 即 console.error，断链从此可见。
  if (typeof window !== 'undefined' && window.location.hash.includes('lightassert')) {
    const rows = [
      { 灯组: '刹车灯(尾灯/红带)', 期望: 'lamp-red', 命中: tailLamp?.id ?? '(无)' },
      { 灯组: '头灯内芯', 期望: 'lamp-head', 命中: headLamp?.id ?? '(无)' },
      { 灯组: 'MAEXTRO 字标', 期望: 'lamp-mark', 命中: markLamp?.id ?? '(无)' },
      { 灯组: '星空顶', 期望: 'starlight', 命中: starMat ? 'starlight' : '(无)' },
      { 灯组: '金色签名屏', 期望: 'lamp-gold', 命中: goldMat ? 'lamp-gold' : '(无)' },
      { 灯组: '轮圈盘面', 期望: 'wheel-alloy', 命中: wheelMat ? 'wheel-alloy' : '(无)' },
      { 灯组: '尾灯 3+3 灯带贴图', 期望: 'housing-dark', 命中: tailFieldMat ? 'housing-dark' : '(无)' },
      { 灯组: '星尘颗粒', 期望: 'lamp-star', 命中: starDustMat ? 'lamp-star' : '(无)' },
      { 灯组: '头灯 LED 点阵', 期望: 'lamp-head', 命中: ledMat ? 'lamp-head' : '(无)' },
      { 灯组: '头灯 3-LED 点阵灯珠(EX-08)', 期望: 'led-dot×6', 命中: ledDotCount > 0 ? `remapped×${ledDotCount}` : '(无)' },
      // R11b 工厂（22:00 版）front-plate 组件被移除，plate 材质零 mesh 引用 ——
      // matById 永远收不到，(无) 是 spec 正确状态而非断链；EX-26 名牌贴图逻辑
      // 因 plateMat null 跳过（R13 尾门镀铬字牌 tailgate-badge 已按用户裁决移除）
      { 灯组: '车名牌镀铬字', 期望: 'plate（spec 已移除引用）', 命中: plateMat ? 'plate' : '(无·spec 移除)' },
      { 灯组: '盾徽面板分区贴图', 期望: 'lamp-white', 命中: whiteMat ? 'lamp-white' : '(无)' },
      { 灯组: '皮革图集(素面+菱格)', 期望: 'leather-warm', 命中: leatherWarmMat ? 'leather-warm' : '(无)' },
      { 灯组: '皮革色调校准(深Cognac)', 期望: '#7A4034', 命中: leatherWarmMat?.map ? '#7A4034' : '(无)' },
      { 灯组: '座椅打孔区(IN-08)', 期望: 'leather-warm 打孔克隆', 命中: quiltPerfMat ? 'quilt-perf' : '(无)' },
      { 灯组: '胎面沟槽+胎侧字环(EX-34)', 期望: 'tire', 命中: tireMat ? 'tire' : '(无)' },
      { 灯组: '后保反光条分段(EX-31)', 期望: 'lamp-red 克隆', 命中: reflectorMat ? 'reflector-clone' : '(无)' },
      { 灯组: '轮心黑底盾徽(EX-33)', 期望: 'lamp-mark 克隆', 命中: wheelCapMat ? 'wheel-badge' : '(无)' },
      { 灯组: '迎宾光毯(EX-09)', 期望: 'welcome-carpet', 命中: welcomeMesh ? 'welcome-carpet' : '(无)' },
      { 灯组: '尾门 MAEXTRO 小字(R12-T1)', 期望: 'tailgate-maextro', 命中: body.children.some((c) => c.name === 'tailgate-maextro') ? 'tailgate-maextro' : '(无)' },
      { 灯组: '屏幕家族UI(三联/后排/扶手)', 期望: 'screen-ui', 命中: matById.has('screen-ui') ? 'screen-ui' : '(无)' },
      { 灯组: '深棕皮革粒面', 期望: 'leather-dark', 命中: leatherDarkMat ? 'leather-dark' : '(无)' },
      { 灯组: '米白皮革粒面', 期望: 'leather-ivory', 命中: leatherIvoryMat ? 'leather-ivory' : '(无)' },
      { 灯组: '开放木纹', 期望: 'wood', 命中: woodMatTrim ? 'wood' : '(无)' },
      { 灯组: '顶棚麂皮', 期望: 'headliner-suede', 命中: suedeMat ? 'headliner-suede' : '(无)' },
      { 灯组: '窗帘织纹', 期望: 'curtain', 命中: curtainMat ? 'curtain' : '(无)' },
      { 灯组: '地毯短绒', 期望: 'carpet', 命中: carpetMat ? 'carpet' : '(无)' },
      { 灯组: 'greenhouse 玻璃透射', 期望: 'glass-dark', 命中: greenhouseMat ? `trans=${greenhouseMat.transmission.toFixed(2)}` : '(无)' }
    ];
    console.table(rows);
    if (!tailLamp || !headLamp || !markLamp) {
      console.error('[V800Adapter] #lightassert：灯组断链，见上表 (无) 行');
    }
  }

  /**
   * 怠速尾灯基线（R11 质感波 2.0 → 2.5，对标报告 ③ 号差距复核）。
   * 历史：几何灯带时期 2.0 曾被报「偏亮」——根因是 12 条几何灯带 + 灯芯同强度
   * 发光糊住 6mm 间隙，非强度超阈；EX-28 撤几何改贴图后间隙为纯黑零发光，
   * 强度提升不再糊间隙。R11 复核：怠速 2.0 下 emissive #E03040 × 2.0 相对亮度
   * ≈ 0.37，低于 UnrealBloom 阈值 0.72 —— 怠速尾灯完全不晕开，缺「贯穿式尾灯
   * 红光晕」的展厅观感。提到 2.5（≈0.47 线性，过 ACES 后接近阈值边缘）：
   * 截图目检怠速红晕若仍不 bloom 再微调（保持 < 满刹 8.0 的爆发梯度）。
   * 联动链不动：brakeLevel 从 TAIL_BASE 出发，housing-dark 红带 / lamp-gold
   * 金屏（×0.75）/ 灯芯随刹车同源联动，基线抬升后刹车爆发同步增强。
   * 反光条克隆件 REFLECTOR_EMISSIVE_INTENSITY 0.55 静态弱值不动（EX-31 机制）。
   */
  const TAIL_BASE = 2.5;
  // 前脸签名增强（S5 朝向线索）：基础 2.5 正面视角辨识度不足，提到 3.2 ——
  // 只动常亮基础值，setHeadlights 开关 / damp 联动映射语义不变（headTarget 同源）
  const HEAD_BASE = 3.2;
  let brakeLevel = TAIL_BASE;
  let brakeTarget = TAIL_BASE;
  let headLevel = HEAD_BASE;
  let headTarget = HEAD_BASE;
  let snapT = 0;
  let heat = 0;

  // ---- 悬浮轮标（可选节点：spec 现用 wheel-cap-*，兼容旧名 cap-*，全缺失即无）----
  const caps: THREE.Object3D[] = [];
  for (const corner of ['fl', 'fr', 'rl', 'rr']) {
    const c = byId.get(`wheel-cap-${corner}`) ?? byId.get(`cap-${corner}`);
    if (c) caps.push(c);
  }

  // ---- 动态仪表（gauge-screen CanvasTexture）----
  const gaugeCanvas = document.createElement('canvas');
  gaugeCanvas.width = 512;
  gaugeCanvas.height = 288;
  const gctx = gaugeCanvas.getContext('2d')!;
  const gaugeTex = new THREE.CanvasTexture(gaugeCanvas);
  gaugeTex.colorSpace = THREE.SRGBColorSpace;
  // gauge-ui 材质在工厂里可能挂在与 byId 首个命中不同的 mesh 实例上 ——
  // 沿组件节点向下找第一个真正的 mesh（与 meshOf 同口径），确保画布贴到渲染件上
  let gaugeMesh: THREE.Mesh | null = null;
  {
    const gaugeNode = byId.get('gauge-screen');
    if (gaugeNode) {
      if ((gaugeNode as THREE.Mesh).isMesh) gaugeMesh = gaugeNode as THREE.Mesh;
      else gaugeNode.traverse((o) => {
        if (!gaugeMesh && (o as THREE.Mesh).isMesh) gaugeMesh = o as THREE.Mesh;
      });
    }
    if (!gaugeMesh) gaugeMesh = (runtime?.meshes?.['gauge-screen'] as THREE.Mesh | undefined) ?? null;
  }
  if (gaugeMesh && gaugeMesh.material) {
    const mat = gaugeMesh.material as THREE.MeshStandardMaterial;
    mat.map = gaugeTex;
    mat.emissiveMap = gaugeTex;
    mat.emissive.set(0xffffff);
    mat.emissiveIntensity = 1.2;
    mat.color.set(0x0a0a0c);
    // R17b：透明底——gauge-screen 与三联屏左段在空间上重叠（真车仪表即三联屏左段），
    // 不透明黑底会把 READY/P 盖成「黑盒压屏」。数字/力度条内容自身着色，其余全透明。
    mat.transparent = true;
    mat.depthWrite = false;
    mat.needsUpdate = true;
  }
  let lastGaugeKey = '';
  let lastGaugeTime = -Infinity;
  const drawGauge = (speedKmh: number, forceN: number, g: number, gear: string): void => {
    const key = `${Math.round(speedKmh)}|${Math.round(forceN / 8)}|${gear}`;
    const now = performance.now();
    // 双门控：内容必须变化 + 距上次重绘 ≥ 1/15s（刹车段每帧重绘会拖垮上传带宽）
    if (key === lastGaugeKey) return;
    if (now - lastGaugeTime < GAUGE_MIN_INTERVAL * 1000) return;
    lastGaugeKey = key;
    lastGaugeTime = now;
    const w = gaugeCanvas.width;
    const h = gaugeCanvas.height;
    // R17b：透明底（材质 transparent=true）——只画内容像素，其余清成 alpha 0，
    // 露出三联屏左段贴图（READY/P 属于它）；黑盒盖屏是旧观感杂乱的根因。
    gctx.clearRect(0, 0, w, h);
    // 速度
    gctx.fillStyle = '#7fd8a8';
    gctx.font = 'bold 92px "Segoe UI", sans-serif';
    gctx.textAlign = 'left';
    gctx.fillText(`${Math.round(speedKmh)}`, 34, 128);
    gctx.font = '26px "Segoe UI", sans-serif';
    gctx.fillStyle = '#4a7a62';
    gctx.fillText('km/h', 40, 164);
    // 踏板力条（自带半透明底衬保证可读）
    const ratio = Math.min(1, forceN / 1612);
    gctx.fillStyle = 'rgba(10, 22, 16, 0.6)';
    gctx.fillRect(222, 44, 256, 116);
    gctx.fillStyle = '#16241d';
    gctx.fillRect(230, 52, 240, 30);
    gctx.fillStyle = ratio > 0.85 ? '#ff4a3c' : ratio > 0.6 ? '#ffb067' : '#7fd8a8';
    gctx.fillRect(230, 52, 240 * ratio, 30);
    gctx.fillStyle = '#9fb6c8';
    gctx.font = '24px "Segoe UI", sans-serif';
    gctx.fillText(`踏板力 ${Math.round(forceN)} N`, 230, 118);
    gctx.fillText(`G ${g.toFixed(2)}`, 230, 152);
    // 挡位
    gctx.fillStyle = '#e8e0d0';
    gctx.font = 'bold 64px "Segoe UI", sans-serif';
    gctx.textAlign = 'right';
    gctx.fillText(gear, w - 34, 220);
    // R17b：READY 文本删除——透明底后与三联屏左段贴图自带的 READY 重复
    gaugeTex.needsUpdate = true;
  };
  drawGauge(0, 0, 0, 'P'); // 初帧即出 UI（QA 机位 / 待机态不走 updateCluster 也能看到仪表画面）

  let tmpQuat = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  /** billboard 折算用：cap 父节点的世界朝向 */
  const tmpParentQuat = new THREE.Quaternion();
  /** 自平衡 billboard 用：相机世界位置 / 水平指向 / up×dir / basis 矩阵 */
  const tmpCamVec = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  const tmpCross = new THREE.Vector3();
  const tmpBasis = new THREE.Matrix4();
  /** billboard 的局部 +X 目标方向（世界竖直向上）—— 徽标"上" */
  const BILLBOARD_UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------------------
  // 静态合批：静止的同材质小件压成单 draw call（DC 是本项目唯一贴红线的指标）
  //
  // 位置选在这里是有意的：上面已经把全部运行时引用取好了 ——
  // wheels[].spin（每帧 rotation.x）、caps（每帧 quaternion）、gaugeMesh（适配器持有引用）、
  // pedal（每帧 position/rotation/visible）、matById（按材质 ID 驱动灯光）。
  // 合批器拿这些对象当保护清单，它们整棵子树都不参与合并。
  //
  // 合并范围只有 model 子树：pedal 挂在 body 上，天然不在其中，免受影响。
  // 合并后 leaf mesh 会被摘掉，byId 里若有条目指向它们就变成「挂着但不再渲染」的死引用，
  // 因此紧接着按合并后的树重建索引，保证后续按 ID 取到的一定还是活对象。
  // 灯光链路按 matById 的材质对象驱动，材质实例不因合批改变，这条链路不受影响（已实测）。
  // UV_CONTENT_MATERIAL_IDS：这是一份**防御性契约**，不是修复合批缺陷 ——
  // 合批本身不破坏 UV（实测 17,882 个顶点 UV 误差 = 0），但这些材质承载的是"画面内容"
  // （UI 画布 / 星空图案 / 灯箱点阵），集成层会在运行时换贴图（仪表 gaugeTex、星空顶 emissiveMap）；
  // 一旦将来 spec 把它们拆成多实例或逐件换图，合批会让"换一张图"连带影响同组其他 mesh。
  // 当前每组只有 1 个成员（crystal 有 2 个，但已被「透明 + counter-rotate」拦下），排除代价 0 DC。
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // R12b 内饰材质纯化（终局覆盖）
  // 病根：P1 程序化皮革/菱格/木纹贴图按小件 UV 设计，贴到座椅/中岛/门板后被拉伸，
  // 屏幕里读作「碎砖/锈斑」，透过深烟灰玻璃看即用户所述的破碎团块。内饰语义是
  // 纯色真皮/木饰 —— 这里在全部贴图接线之后统一撤 map/normal/roughness，回退
  // 策展色 + 粗糙度/清漆语义。必须在 batchMergeStatic 之前执行，材质实例才一致。
  // ---------------------------------------------------------------------------
  {
    const INTERIOR_SOLID: Record<
      string,
      { color: string; rough: number; metal: number; env: number; clearcoat?: number }
    > = {
      'leather-warm': { color: '#6B4437', rough: 0.62, metal: 0.0, env: 0.32, clearcoat: 0.14 },
      'leather-dark': { color: '#2A211D', rough: 0.56, metal: 0.0, env: 0.36, clearcoat: 0.2 },
      'leather-ivory': { color: '#D6D0C4', rough: 0.58, metal: 0.0, env: 0.3, clearcoat: 0.12 },
      wood: { color: '#3B2418', rough: 0.24, metal: 0.05, env: 0.5, clearcoat: 0.65 },
      curtain: { color: '#4A2C28', rough: 0.88, metal: 0.0, env: 0.16 },
      'headliner-suede': { color: '#6F6862', rough: 0.94, metal: 0.0, env: 0.12 },
      carpet: { color: '#26221F', rough: 0.96, metal: 0.0, env: 0.08 },
      plate: { color: '#141519', rough: 0.46, metal: 0.15, env: 0.35 }
    };
    const done = new Set<THREE.Material>();
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const arr = Array.isArray(m.material) ? m.material : [m.material];
      for (const mt of arr) {
        const mat = mt as THREE.MeshPhysicalMaterial;
        if (!mat || done.has(mat)) continue;
        const id = (mat.userData?.sculptMaterial as { id?: string } | undefined)?.id;
        const tune = id ? INTERIOR_SOLID[id] : undefined;
        if (!tune) continue;
        done.add(mat);
        if (mat.map) mat.map = null;
        if (mat.normalMap) mat.normalMap = null;
        if (mat.roughnessMap) mat.roughnessMap = null;
        if (mat.aoMap) mat.aoMap = null;
        mat.color.set(tune.color);
        mat.roughness = tune.rough;
        mat.metalness = tune.metal;
        mat.envMapIntensity = tune.env;
        if (tune.clearcoat !== undefined) {
          mat.clearcoat = tune.clearcoat;
          mat.clearcoatRoughness = 0.18;
        }
        mat.needsUpdate = true;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // R13 内饰质感贴图（纯化后接线）
  // 顺序契约：必须在本文件「R12b 内饰材质纯化（终局覆盖）」之后执行——
  // 该块会整体撤 map/normal 回策展纯色；这里把 R13 新程序化贴图
  // （src/model/interiorTextures.ts，固定种子 LCG、零外部图片）重新挂上，
  // 仅限用户指认三件：方向盘（木纹+真皮轮缘）、刹车踏板（已在创建处接线）、
  // 座椅（菱格绗缝）。克隆材质令合批独立成组（+1~2 DC），color 放白防双重压暗。
  // ---------------------------------------------------------------------------
  {
    const SEAT_WARM_IDS = [
      'seat-driver',
      'seat-driver-back',
      'seat-driver-headrest',
      'seat-passenger',
      'seat-passenger-back',
      'seat-passenger-headrest',
      'seat-rear-l',
      'seat-rear-l-back',
      'seat-rear-l-headrest',
      'seat-rear-l-legrest',
      'seat-rear-l-armrest',
      'seat-rear-r',
      'seat-rear-r-back',
      'seat-rear-r-headrest',
      'seat-rear-r-legrest',
      'seat-rear-r-armrest',
      'seat-third-row',
      'seat-third-row-back',
      'seat-third-row-headrest'
    ] as const;
    // 座椅菱格：基色取纯化层的策展色（warm=#6B4437 Cognac），贴图承载颜色、材质 color 放白
    const quiltWarmTex = createSeatQuiltTexture('#6B4437');
    quiltWarmTex.anisotropy = 4;
    ownedTextures.push(quiltWarmTex, pedalTex);
    const quiltSeatMat = leatherWarmMat
      ? (leatherWarmMat.clone() as THREE.MeshPhysicalMaterial)
      : null;
    if (quiltSeatMat) {
      quiltSeatMat.color.set(0xffffff);
      quiltSeatMat.map = quiltWarmTex;
      quiltSeatMat.userData.quiltTiled = true; // #uvassert 跳过图集分区判据（整幅菱格）
      quiltSeatMat.needsUpdate = true;
      for (const id of SEAT_WARM_IDS) {
        const mesh = meshOf(id);
        if (mesh) {
          mesh.material = quiltSeatMat;
          remapUVQuiltTriplanar(mesh);
        }
      }
    }
    // 方向盘：轮缘环展图（深咖真皮+胡桃木饰段+缝线），克隆 wood 材质
    const steeringTex = createSteeringWheelTexture();
    steeringTex.anisotropy = 8;
    ownedTextures.push(steeringTex);
    const steeringMesh = meshOf('steering');
    if (steeringMesh) {
      const srcMat = Array.isArray(steeringMesh.material)
        ? (steeringMesh.material[0] as THREE.MeshPhysicalMaterial)
        : (steeringMesh.material as THREE.MeshPhysicalMaterial);
      const steerMat = (srcMat?.clone() ?? new THREE.MeshPhysicalMaterial()) as THREE.MeshPhysicalMaterial;
      steerMat.color.set(0xffffff);
      steerMat.map = steeringTex;
      steerMat.roughness = 0.45;
      steerMat.needsUpdate = true;
      steeringMesh.material = steerMat;
    }
    // 方向盘气囊盖：米白真皮盘面 + 亮铬环 + 徽标底座，克隆 leather-ivory
    const hubTex = createSteeringHubTexture();
    hubTex.anisotropy = 4;
    ownedTextures.push(hubTex);
    const hubMesh = meshOf('steering-hub');
    if (hubMesh) {
      const srcMat = Array.isArray(hubMesh.material)
        ? (hubMesh.material[0] as THREE.MeshPhysicalMaterial)
        : (hubMesh.material as THREE.MeshPhysicalMaterial);
      const hubMat = (srcMat?.clone() ?? new THREE.MeshPhysicalMaterial()) as THREE.MeshPhysicalMaterial;
      hubMat.color.set(0xffffff);
      hubMat.map = hubTex;
      hubMat.needsUpdate = true;
      hubMesh.material = hubMat;
    }
  }

  // ---- R15 参考图贴图接线（src/assets/ref/*.jpg）----
  // 三重顺序契约（违反任一条都会静默失效）：
  //  ① 必须在「R12b 内饰材质纯化」之后 —— 纯化层会撤 map/normalMap 回策展纯色，
  //     且 applySurface 的 `!mat.map` 守卫会把工厂图集重新挂回去，只有在这之后
  //     挂的贴图才是最终态；
  //  ② 必须在 batchMergeStatic **之前** —— 贴图按 userData.sculptComponent.id
  //     定位 mesh，合批后组件身份丢失（只剩材质），函数会直接拒动；
  //  ③ 必须在 R13 程序化内饰贴图之后 —— 两者写同一批材质（座椅/门板/仪表台），
  //     参考图是「实拍优先」的终局层，顺序反了会被程序化菱格覆盖。
  // 贴图异步解码：未就绪时保持程序化纹理并在图到后补挂（优雅降级，绝不黑屏）。
  {
    const mounted = applyReferenceTextures(model, { tier, verbose: false });
    if (mounted.length > 0) {
      console.info('[V800Adapter] 参考图贴图挂载材质：', mounted.join(', '));
    }
  }

  // ---- R15c：第一排座椅专属材质实例（车内机位遮挡件的可靠开关）----
  // 消去法实证（`#hidemat=leather-warm`，verify/r15b/）：cabin 机位正前方那两块「绗缝大板」
  // 就是第一排座椅（坐垫+靠背+头枕）。座舱机位通行做法是**不画自己的座椅**。
  //
  // 为什么不用「排除合批 + visible=false」：合批器按对象列表跳过时仍会把子树 mesh 烘进
  // 其它批次（R15 首版实测 = 隐藏无效，eye 后移到 −0.58 时座椅又冒出来）。
  // 改用**材质身份**：给第一排座椅一个独占的材质克隆，合批必然把它分到独立 batch，
  // 运行时 `material.visible = false` 这一批整体不画 —— 与合批实现解耦，稳定可靠。
  // 代价：+1 draw call（三种机位共用一个专属 batch）。
  //
  // R16 回归教训（用户截图 verify/r14/game/cabin_r14b.png）：R16 把赋值集合缩成了
  // 2 个坐垫，靠背/头枕 4 件漏配 → 它们留在 leather-warm 大批里照样画，车内正前方
  // 依然是那面「中央隔板实体模块」。第一排 6 件（坐垫+靠背+头枕，左右各 3）必须全列。
  /**
   * R19f：内舱暗面 = **换材质**，不是翻 side。
   * R19/R19c 的 BackSide 方案实测是错的：body-lower / root 是**单壳实心挤出体**，
   * 切 BackSide 后外表面被剔除、相机直接看穿进壳体内部，整屏变成暗面材质的
   * 自发光底色（实测 (13,8,8) 满屏），仪表台/三联屏/方向盘全被吞掉 —— 比原问题更糟。
   * 正解：外壳始终 FrontSide，车内机位时把批次材质整体换成「暗车漆」克隆
   *（深色 + 零金属度 + 高粗糙），离车切回原漆。目标面（引擎盖/甲板 y≈1.09）仍是
   * 可见实体，只是不再被黄昏暖光读成亮铜色金属板。
   */
  const paintShadowPairs: Array<{ mesh: THREE.Mesh; exterior: THREE.Material; interior: THREE.Material }> = [];
  const makeInteriorPaintClone = (src: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial => {
    const clone = src.clone() as THREE.MeshPhysicalMaterial;
    clone.color.setHex(0x2a211c);
    clone.emissive.setHex(0x120d0a);
    clone.emissiveIntensity = 0.55; // R19f：1.0 时自发光直接盖过灯光 → 满屏死黑
    clone.emissiveMap = null;
    clone.map = null;
    clone.normalMap = null;
    clone.roughnessMap = null;
    clone.metalness = 0.0;
    clone.roughness = 0.92;
    clone.envMapIntensity = 0.12;
    clone.clearcoat = 0;
    clone.side = src.side; // 保持原 side（FrontSide）
    clone.userData = { ...clone.userData, cabinPaintShadow: true };
    clone.needsUpdate = true;
    return clone;
  };
  const cabinOccluderMats: THREE.MeshPhysicalMaterial[] = [];
  void (() => {
    const src = (meshOf('seat-driver')?.material ?? meshOf('seat-passenger')?.material) as
      | THREE.MeshPhysicalMaterial
      | undefined;
    if (!src) return null;
    const clone = src.clone() as THREE.MeshPhysicalMaterial;
    clone.userData.cabinHidable = true;
    let assigned = 0;
    for (const id of [
      'seat-driver',
      'seat-passenger',
      'seat-driver-back',
      'seat-driver-headrest',
      'seat-passenger-back',
      'seat-passenger-headrest'
    ] as const) {
      const node = byId.get(id);
      if (!node) {
        console.warn('[V800Adapter] cabin occluder 组件缺失：', id);
        continue;
      }
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.material = clone;
          assigned++;
        }
      });
    }
    console.info(`[V800Adapter] cabin occluder 座椅材质克隆 → ${assigned} 个 mesh`);
    cabinOccluderMats.push(clone);
    return clone;
  })();

  // ---- R17：中央模块第二遮挡克隆（console-riser / tunnel-rear）----
  // 与座椅同一机制（独占克隆 + material.visible=false），但**不能**并进皮革克隆：
  // 这两件是 wood 材质（spec material: "wood"），混入皮革克隆会让车外机位的中控台
  // 读出菱格皮革纹。克隆源取 console-riser 自身材质 —— 此刻它已是 R13 木纹贴图
  // 挂载后的实例，车外观感与隐藏前逐像素一致，只有 cabin 机位整批不画。
  // （V800 spec 无 center-console 组件；console-island-* 是木纹台上的水晶/托盘小件，
  // 体积小不挡视野，不纳入。）
  void (() => {
    const src = (meshOf('console-riser')?.material ?? meshOf('tunnel-rear')?.material) as
      | THREE.MeshPhysicalMaterial
      | undefined;
    if (!src) return null;
    const clone = src.clone() as THREE.MeshPhysicalMaterial;
    clone.userData.cabinHidable = true;
    let assigned = 0;
    for (const id of ['console-riser', 'tunnel-rear'] as const) {
      const node = byId.get(id);
      if (!node) {
        console.warn('[V800Adapter] cabin occluder 组件缺失：', id);
        continue;
      }
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.material = clone;
          assigned++;
        }
      });
    }
    console.info(`[V800Adapter] cabin occluder 中控材质克隆 → ${assigned} 个 mesh`);
    cabinOccluderMats.push(clone);
    return clone;
  })();

  // ---- R19 续：合批后把「内舱暗面」行为赋给 batch/paint-* 批次 ----
  // 合批把 body-lower/root 等 paint-* 件并进 batch/paint-upper|paint-lower（材质实例
  // 被复制到批次网格上）。克隆替换仅对未进批次的源 mesh 有效；批次网格用一个轻量
  // userData 注入：Game 切换机位时遍历 batch/paint-* 直接改 side，语义与 setPaintShadow
  // 等价（外观态 FrontSide / 内舱态 BackSide）。
  const wireBatchPaintShadow = (stats: { created: THREE.Mesh[] }): void => {
    for (const mesh of stats.created) {
      const name = mesh.name || '';
      if (!name.startsWith('batch/paint-')) continue;
      const mat = mesh.material as THREE.MeshPhysicalMaterial | undefined;
      if (!mat) continue;
      const clone = makeInteriorPaintClone(mat);
      paintShadowPairs.push({ mesh, exterior: mat, interior: clone });
    }
    console.info(`[V800Adapter] batch/paint-* 内舱暗面 → ${paintShadowPairs.length} 个批次`);
  };

  // ---- R20-1：尾门「上下折线」手写几何替换（必须在 batchMergeStatic **之前**）----
  // 病灶：工厂尾门是 ExtrudeGeometry 平板 —— 实测 distinctZ(z@1e-3) = 2（只有 0 与外
  // 表面 0.07 两个 z 平面），用户从 R18 起连续指认「尾门缺上下折线」。spec 侧无解：
  // deformationStack / edgeTreatment 是生成器不读的散文字段，挤出基元 steps:1 只能
  // 出常面。故在适配层把几何换成规则网格解析面（parts/tailgatePanel.ts）：外表面
  // z = 冠面 + 上折线 V 槽 + 下折线 V 槽，折线槽两侧拆点拿硬边 catch-light。
  // 几何逐位沿用旧件的局部帧与世界 bbox（x ±0.8459 / y 0.53..1.19 / z −2.836..−2.766），
  // 所以本文件下方「尾门 MAEXTRO 贴花 / 后牌」按 tailgate 子树 bbox 定位的逻辑**不受影响**，
  // 且必须在合批前替换 —— 合批后再换会与 batch/paint-upper 已有顶点集不一致。
  // ⚠️ 主键是 mesh 自身的 userData.sculptComponent.id === 'tailgate'（精确自匹配）。
  // 绝不可退化成「子树里全部 Mesh」：历史事故是误克隆 24 件外壳、整车外观全毁。
  {
    const creased = createTailgateCreaseGeometry();
    let swapped = 0;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData?.sculptComponent?.id !== 'tailgate') return; // 自身精确匹配
      const previous = mesh.geometry;
      mesh.geometry = creased;
      previous.dispose();
      swapped += 1;
    });
    if (swapped === 1) {
      const tris = (creased.index ? creased.index.count : creased.getAttribute('position').count) / 3;
      console.info(`[V800Adapter] 尾门折线几何 → ${tris} tri（旧件 28 tri 平板已 dispose）`);
    } else if (swapped === 0) {
      creased.dispose();
      console.warn('[V800Adapter] 尾门折线几何未命中任何 mesh（期望 1）——保持工厂原几何');
    } else {
      console.warn(`[V800Adapter] 尾门折线几何命中 ${swapped} 个 mesh（期望 1）——同一几何实例被共享`);
    }
  }

  // ---- R21-A2：rear-glass-upper 由 paint-lower 不透明漆面改为真实深色后风挡玻璃 ----
  // 现状：该件是 spec 把「后风挡玻璃带（下延段）」错误地用 paint-lower（深色亮面漆）渲染，
  // 车外读成一块黑漆板而非玻璃。真车（白车尾参考图）：MAEXTRO 铬条上方是一整块深色后风挡，
  // 形态大块玻璃。本层只换材质、不动几何（几何是 R18c 已定稿的平板，与 greenhouse 后窗带衔接）。
  // 选「克隆 glass-dark」而非直接复用同一实例：
  //   · R18c 历史：旧 glass-dark 太透(0.34) 会让机位看穿空腔内饰、被判「没装玻璃」。
  //     这里压到 opacity 0.80（近不透明隐私玻璃），靠反射(金属0.22 / envMap 1.55)给镜面层次，
  //     读成深色隐私玻璃而不是空洞 —— 与侧窗 greenhouse-glass 观感同源但更实。
  //   · 独占克隆避免与侧窗玻璃-dark 互扰；且透明件本就被 batchMerge 跳过合批，独立实例
  //     也不会并入 greenhouse 桶，零 DC 增量风险。
  //   · 必须在 batchMergeStatic **之前**换材质（与尾门折线替换同窗口）。
  {
    const glassDarkSrc = matById.get('glass-dark');
    const rgNode = byId.get('rear-glass-upper');
    if (glassDarkSrc && rgNode) {
      const rearGlassMat = glassDarkSrc.clone();
      rearGlassMat.transmission = 0;
      rearGlassMat.transparent = true;
      rearGlassMat.depthWrite = false;
      rearGlassMat.opacity = 0.8;
      rearGlassMat.color.set(0x10151b);
      rearGlassMat.metalness = 0.22;
      rearGlassMat.roughness = 0.07;
      rearGlassMat.envMapIntensity = 1.55;
      rearGlassMat.thickness = 0.02;
      // 保留 sculptMaterial.id='glass-dark'：下游若按键查材质保持一致；合批按实例主键不受影响。
      rearGlassMat.userData.sculptMaterial = {
        ...(glassDarkSrc.userData.sculptMaterial ?? {}),
        id: 'glass-dark'
      };
      rearGlassMat.needsUpdate = true;
      let swapped = 0;
      rgNode.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (m.userData?.sculptComponent?.id !== 'rear-glass-upper') return; // 自身精确匹配
        m.material = rearGlassMat;
        swapped += 1;
      });
      if (swapped > 0) {
        console.info(`[V800Adapter] rear-glass-upper → 克隆 glass-dark（隐私玻璃 opacity 0.80），命中 ${swapped} mesh`);
      } else {
        console.warn('[V800Adapter] rear-glass-upper 未命中任何 leaf mesh（期望 ≥1）——保持工厂 paint-lower');
      }
    }
  }

  // ---- R21-B/C：尾灯 / 前大灯手写几何接线（parts/tailLamp.ts + parts/headLamp.ts）----
  // 与 R20 尾门同律：必须在 batchMergeStatic **之前**替换——合批会把子树 leaf 的
  // sculptComponent 摘掉，之后 setFromObject 得空盒。旧件整组隐藏（batchMerge 跳过
  // visible=false 子树），新件挂 pivot 本体（挂在隐藏节点下 three 不渲染）。
  const lampPivots: THREE.Object3D[] = [];
  {
    // pivot 消歧：taillamp-l/r 与壳 mesh 同 id，凭「有子节点」取 pivot；
    // headlamp-l/r 节点自身即旧壳体 mesh（下有 led/star 子件），同样有子节点。
    const findLampPivot = (id: string): THREE.Object3D | null => {
      let found: THREE.Object3D | null = null;
      model.traverse((o) => {
        if (found) return;
        if (o.userData?.sculptComponent?.id === id && o.children.length > 0) found = o;
      });
      return found;
    };

    // —— B：尾灯（镀铬包边 + 上3红刃 + 鹰形点阵屏 + 下2红刃，C1 特写口径）——
    tailLampMats = createTailLampMaterials(makeEaglePanelTexture());
    for (const side of ['left', 'right'] as const) {
      const pivot = findLampPivot(side === 'left' ? 'taillamp-l' : 'taillamp-r');
      if (!pivot) {
        console.warn(`[V800Adapter] R21-B 找不到尾灯 pivot taillamp-${side === 'left' ? 'l' : 'r'}，保持旧件`);
        continue;
      }
      // 隐旧：7 件/侧全部（壳/上下横杠/核心/拉丝银框/灯带场/签名屏）
      for (const child of [...pivot.children]) child.visible = false;
      // 挂新：pivot 本体保持 visible=true。
      // ⚠️ R21 补验（主理人，探针实证 verify/r21/lamp-probe/lamp_probe.json）：
      // tailLamp.ts 头部注释假设「taillamp pivot 自带 rotY(π)」与真实场景不符——
      // 场景中 pivot 无旋转（preview 世界车尾 = +Z，pivot 世界 z=+2.839 恒等变换），
      // 直接挂会把整灯内缩 ~4cm 且鹰形屏法线朝车内。故套一层 rotY(π) 外层容器：
      //   R30-C1 起内层 group 的右侧镜像改为**几何烘焙**（mirrorGeometryX：position.x /
      //   normal.x 取反 + 绕序反转），不再有 scale.x=-1 负尺度；烘焙镜像与外层 rotY(π)
      //   的复合 R_y(π)·M_x = S_z(−1)，与旧「内层 scale.x=-1 + 外层 rotY(π)」逐位一致
      //   （左右件世界 bbox 对称，.qa/r30c 探针实证）——QA 契约不破。
      const tl = createTailLamp({ side, materials: tailLampMats });
      const wrap = new THREE.Group();
      wrap.name = `taillamp-${side === 'left' ? 'l' : 'r'}-hand-wrap`;
      wrap.rotation.y = Math.PI;
      wrap.add(tl.group);
      pivot.add(wrap);
      lampPivots.push(pivot);
    }

    // —— C：前大灯（顶部横 DRL + 4 透镜堆叠 + 星点，E1/E2 口径）——
    headLampMats = createHeadLampMaterials();
    for (const side of ['left', 'right'] as const) {
      const pivot = findLampPivot(side === 'left' ? 'headlamp-l' : 'headlamp-r');
      if (!pivot) {
        console.warn(`[V800Adapter] R21-C 找不到前灯 pivot headlamp-${side === 'left' ? 'l' : 'r'}，保持旧件`);
        continue;
      }
      // pivot 自身即旧壳体 mesh：不能整节点 visible=false（会连新件一起藏），
      // 按 headLamp.ts 接线说明改走「geometry 换空」方案。
      const oldShell = pivot as THREE.Mesh;
      if (oldShell.isMesh && oldShell.geometry) {
        oldShell.geometry = new THREE.BufferGeometry();
      }
      // 隐旧：led/star 子件
      for (const child of [...pivot.children]) child.visible = false;
      pivot.add(createHeadLamp({ side, materials: headLampMats }).group);
      lampPivots.push(pivot);
    }

    if (lampPivots.length > 0) {
      console.info(`[V800Adapter] R21-B/C 手写灯组接线完成：${lampPivots.length} 个 pivot（尾灯×2 + 前灯×2）`);
    }
    // 防合批吞并：独占材质 r21-tail-lamp-* / r21-head-lamp-* 若被按 id 并进全车
    // 批次，batch 复制材质实例会导致刹车联动改不到实际渲染材质。
  }

  // ═══ R22 手写部件接线（涡轮盘轮毂 / 镀铬窗框 / 玻璃带）═══
  // 与 R21 灯组同律：工厂件置 visible=false 后挂手写件；独占材质进 excludeObjects，
  // 避免被合批吞并（丢高光 / 刹车联动改不到实际渲染材质）。
  const r22Exclude: THREE.Object3D[] = [];

  // —— R22-B 涡轮盘式轮毂（手写几何，替换工厂 rim-* / wheel-cap-*）——
  {
    const hubMats = createWheelHubMaterials();
    const tags = ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr'] as const;
    let wired = 0;
    for (let i = 0; i < tags.length; i++) {
      const corner = tags[i].slice('wheel-'.length) as 'fl' | 'fr' | 'rl' | 'rr';
      const spin = wheels[i]?.spin;
      if (!spin) {
        console.warn(`[V800Adapter] R22-B 找不到轮系 ${tags[i]}，保持旧件`);
        continue;
      }
      // 隐旧：rim-* / wheel-cap-*（pivot + mesh 两节点，按 sculptComponent.id 精确匹配）
      spin.traverse((o) => {
        const id = (o.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
        if (id === `rim-${corner}` || id === `wheel-cap-${corner}`) o.visible = false;
      });
      const side: WheelHubSide = corner === 'fl' || corner === 'rl' ? 1 : -1;
      const hub = createWheelHub(side, hubMats);
      hub.position.set(0, 0, 0); // spin 原点已是轮心（R8 轮心对轴），随轮滚动
      spin.add(hub);
      wired++;
    }
    if (wired > 0) console.info(`[V800Adapter] R22-B 涡轮盘轮毂接线完成：${wired} 轮`);
  }

  // —— R22-C 镀铬窗框 + 玻璃带（手写几何；替换 window-belt-*，chrome-belt-* 间距过挤一并隐）——
  {
    const trimMats = createWindowTrimMaterials();
    // R30-C4：玻璃带材质只建一次、左右共用（旧写法每侧各 new 一份同参材质 → 2 实例）
    const glassMat = createGlassBandMaterial();
    for (const side of [1, -1] as const) {
      const wbId = side === 1 ? 'window-belt-l' : 'window-belt-r';
      const cbId = side === 1 ? 'chrome-belt-l' : 'chrome-belt-r';
      // 隐旧窗线 + 旧镀铬腰带（与窗框仅 80-130mm，参考≈350mm，过挤）
      model.traverse((o) => {
        const id = (o.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
        if (id === wbId || id === cbId) o.visible = false;
      });
      const trim = createWindowTrim(side, trimMats);
      model.add(trim);
      r22Exclude.push(trim);
      const glass = createGlassBand(side, glassMat);
      model.add(glass);
      r22Exclude.push(glass);
    }
    console.info('[V800Adapter] R22-C 镀铬窗框 + 玻璃带接线完成（左右；玻璃带材质共用 1 实例）');
  }

  // ═══ R23 手写部件接线（车顶传感模块 / 前脸面板+MAEXTRO字标 / 外后视镜）═══
  // 与 R21/R22 同律：必须在 batchMergeStatic **之前**；工厂旧件隐掉后挂手写件；
  // 独占材质整组进 excludeObjects，避免被合批吞并（材质改名不可寻址 / 法线被抹平）。
  const r23Exclude: THREE.Object3D[] = [];

  // —— R23-C 车顶传感器模块（parts/roofPod.ts；隐 spec 占位件 lidar-wedge，挂 root）——
  {
    const podReplace: readonly string[] = ROOF_POD_REPLACE_IDS;
    model.traverse((o) => {
      const id = (o.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
      if (id && podReplace.includes(id)) o.visible = false;
    });
    // ★ 坐标框：ROOF_POD_POSITION（默认 z=+2.23，源自照片 L≈0.09 换算）会悬在引擎盖上方
    //   ——spec 实测风挡顶/车顶前缘只到 z≈+1.65，故用 SPEC_FRAME 校正版。
    const pod = createRoofPod({ position: [...ROOF_POD_POSITION_SPEC_FRAME] });
    model.add(pod);
    r23Exclude.push(pod);
    console.info('[V800Adapter] R23-C 车顶传感器模块接线完成（隐 lidar-wedge，挂 root，z=+1.65）');
  }

  // —— R23-D 前脸封闭格栅面板 + 引擎盖 MAEXTRO 发光字标（parts/frontFascia.ts）——
  // 附加件（FRONT_FASCIA_REPLACE_IDS 为空），几何按 front-end 局部系构建 → 挂 front-end 节点。
  {
    const feNode = byId.get('front-end');
    if (feNode) {
      const ff = createFrontFascia();
      feNode.add(ff.group);
      r23Exclude.push(ff.group);
      console.info('[V800Adapter] R23-D 前脸面板 + MAEXTRO 字标接线完成（挂 front-end 局部系）');
    } else {
      console.warn('[V800Adapter] R23-D 找不到 front-end 节点，前脸件未挂载');
    }
  }

  // —— R23-F 外后视镜一对（parts/mirror.ts；隐 spec 占位件 mirror-*/cap-*/arm-*，挂 root）——
  {
    const hide = new Set<string>(MIRROR_HIDE_IDS);
    model.traverse((o) => {
      const id = (o.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
      if (id && hide.has(id)) o.visible = false;
    });
    const mirrors = createMirrors();
    model.add(mirrors.group);
    r23Exclude.push(mirrors.group);
    console.info('[V800Adapter] R23-F 外后视镜接线完成（左右一对，MIRROR_MOUNT z=+1.82）');
  }

  // ═══ R24-B 手写部件接线（前脸中央徽标发光内芯）═══
  // 与 R21/R22/R23 同律：必须在 batchMergeStatic **之前**（合批摘掉 leaf mesh 后
  // setFromObject 得空盒），且独占材质整组进 excludeObjects，避免被合批吞并。
  const r24Exclude: THREE.Object3D[] = [];

  // —— R24-B 前脸中央徽标发光内芯（parts/badgeCore.ts）——
  // 承载面实测（.qa/r24_b_probe.mjs，工厂系车头 +Z）：
  //   shield-emblem-panel  x±0.030 y[0.808,0.977] z[2.421,2.445]（lamp-white 曜日纹面板）
  //   shield-logo          x±0.045 y[0.661,0.901] z[2.465,2.506]（bronze-dark 六边盾，**最前**）
  // 结论：任务书写的「徽标 = shield-emblem-panel」在实机上被更靠前的 shield-logo 盾座
  //   **整体遮挡**（面板 z 仅探出 front-end 面 7mm）——这正是外部审查「内部发光白芯
  //   未渲染、近看像挂坠」的几何根因。若只按面板 bbox 贴面，内芯会有一半埋进盾座里。
  //   因此：锚定 mesh 仍按任务书精确匹配 shield-emblem-panel（铁律13），但居中/贴面
  //   用「徽标簇 = shield-emblem-panel ∪ shield-logo」的并集 bbox：并集中心 y=0.819
  //   落在盾座 y 带内、贴面深度取簇内沿外法线的最大支撑 = 盾座前面 z=2.506 ——
  //   内芯整块落在盾座正面之上（真车即「盾形徽标中央有一块亮白发光核」）。
  {
    // 铁律13：按 sculptComponent.id **精确匹配自身 mesh** —— 绝不用「子树全部 Mesh」
    // （会误克隆整车外板），也不能用 byId.get()（先命中的是外层 pivot Group，不是 mesh）。
    const wantIds = ['shield-emblem-panel', 'shield-logo'];
    const hits = new Map<string, THREE.Mesh>();
    model.traverse((o) => {
      if (hits.size === wantIds.length) return;
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const id = m.userData?.sculptComponent?.id as string | undefined;
      if (id && wantIds.includes(id) && !hits.has(id)) hits.set(id, m);
    });
    const anchor = hits.get('shield-emblem-panel') ?? null;
    if (!anchor) {
      console.warn('[V800Adapter] R24-B 找不到 shield-emblem-panel 自身 mesh，徽标内芯未挂载');
    } else {
      root.updateMatrixWorld(true); // body 有 rotY(π)，世界系车头 = −Z（铁律19：实测，不推导）
      const boxes = new Map<string, THREE.Box3>();
      for (const [id, mesh] of hits) boxes.set(id, new THREE.Box3().setFromObject(mesh));
      const anchorBox = boxes.get('shield-emblem-panel')!;
      if (anchorBox.isEmpty()) {
        console.warn('[V800Adapter] R24-B shield-emblem-panel 测到空盒，徽标内芯未挂载');
      } else {
        // 安装面 mesh：取簇内**最前**的可见面。实测 shield-logo（bronze 盾座，root 直挂）
        // 前面 z=2.506 比 shield-emblem-panel（front-end 子件，带 rotX(-0.12) 倾角）前面
        // z=2.445 更靠前 —— 内芯必须贴盾座正面、且朝向与盾座一致（盾座无倾角、面法线
        // 即车头方向）；若沿用面板的倾角法线，24cm 高的盾面上内芯下缘会悬空 2.9cm。
        const mount = hits.get('shield-logo') ?? anchor;
        mount.updateWorldMatrix(true, false);
        // 外法线：安装面自身局部 +Z 变换到世界，再按「远离整车中心」的一侧定向
        // —— 前脸件成立，换成尾门件同样成立，不依赖任何朝向注释（铁律19）。
        const fwd = new THREE.Vector3(0, 0, 1).transformDirection(mount.matrixWorld).normalize();
        const modelCenter = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
        if (fwd.dot(anchorBox.getCenter(new THREE.Vector3()).sub(modelCenter)) < 0) fwd.negate();
        // 徽标簇并集 bbox（居中用）与簇内沿外法线的最大支撑（贴面用）。
        // ⚠️ 支撑不能直接用世界 AABB（对带 rotX(-0.12) 倾角的件会高估 ~2cm，
        // 内芯下缘会悬空）—— 这里取「几何局部 bbox 八角 → world 变换 → 投影」的
        // 最大值，对薄板挤出体即其前面所在平面，精确。
        const cluster = new THREE.Box3();
        for (const b of boxes.values()) if (!b.isEmpty()) cluster.union(b);
        const supportOf = (mesh: THREE.Mesh, dir: THREE.Vector3): number => {
          const g = mesh.geometry;
          if (!g.boundingBox) g.computeBoundingBox();
          const bb = g.boundingBox;
          if (!bb) return 0;
          let maxD = -Infinity;
          const p = new THREE.Vector3();
          for (const x of [bb.min.x, bb.max.x]) {
            for (const y of [bb.min.y, bb.max.y]) {
              for (const z of [bb.min.z, bb.max.z]) {
                p.set(x, y, z).applyMatrix4(mesh.matrixWorld);
                const d = p.dot(dir);
                if (d > maxD) maxD = d;
              }
            }
          }
          return maxD;
        };
        let surface = supportOf(anchor, fwd);
        for (const [id, mesh] of hits) {
          if (id !== 'shield-emblem-panel') surface = Math.max(surface, supportOf(mesh, fwd));
        }
        const size = cluster.getSize(new THREE.Vector3());
        // 内芯按徽标簇 bbox 自适应（默认 34×98mm 的 0.62 / 0.66 比例，限幅防放大出框）
        const core = createBadgeCore({
          width: Math.min(0.038, size.x * 0.62),
          height: Math.min(0.112, size.y * 0.66)
        });
        // 贴着徽标最前表面放置：表面点 + 外法线 × 1.5mm（内芯厚 2mm ⇒ 背面仍外露
        // 0.5mm 不共面、正面外凸 2.5mm，防 z-fighting）
        core.group.position
          .copy(cluster.getCenter(new THREE.Vector3()))
          .addScaledVector(fwd, surface - cluster.getCenter(new THREE.Vector3()).dot(fwd) + 0.0015);
        // 朝向：直接复制**安装面**的世界旋转（纯旋转，不翻绕序）；局部 +Z 与外法线反向时
        // 绕局部 Y 转 π 补偿 —— 是旋转不是反射，FrontSide 无需改 DoubleSide（铁律12）。
        const q = new THREE.Quaternion();
        mount.getWorldQuaternion(q);
        if (new THREE.Vector3(0, 0, 1).transformDirection(mount.matrixWorld).dot(fwd) < 0) {
          q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
        }
        core.group.quaternion.copy(q);
        model.attach(core.group); // attach 保持世界变换；挂在 model 下随 body 俯仰
        r24Exclude.push(core.group);
        console.info(
          `[V800Adapter] R24-B 徽标发光内芯接线完成：簇 bbox ` +
            `x[${cluster.min.x.toFixed(3)},${cluster.max.x.toFixed(3)}] ` +
            `y[${cluster.min.y.toFixed(3)},${cluster.max.y.toFixed(3)}] ` +
            `z[${cluster.min.z.toFixed(3)},${cluster.max.z.toFixed(3)}] ` +
            `→ 内芯 world pos(${core.group.position.x.toFixed(3)},${core.group.position.y.toFixed(3)},${core.group.position.z.toFixed(3)}) ` +
            `tri=${core.triangleCount}`
        );
      }
    }
  }

  // ---- R30-C3：侧围后部破洞补面（parts/quarterPatch.ts）----
  // 外部深度审计 P1：C/D 柱与尾窗间内凹缺面（侧围后部楔形空洞，|x|∈[0.95,1.01]、
  // y∈[1.05,1.17]、z∈[−2.78,−2.66]，射线探针实证该域首命中全空=外部透视进车内）。
  // spec/工厂禁改 ⇒ 按 R20/R22 手写件先例补封闭面片：与 R24-B 同窗口（合批前）、
  // 独占材质 r30-quarter-paint 进 excludeObjects（+1 DC，双侧合并 1 mesh）。
  {
    const patch = createQuarterPatch();
    model.add(patch.group);
    r24Exclude.push(patch.group);
    console.info(
      `[V800Adapter] R30-C3 侧围后部补面完成：${patch.triangleCount} tri（双侧，` +
        `材质 ${QUARTER_PATCH_MATERIAL_ID}）`
    );
  }

  // ---- R30-C4 → R32-D1：同参材质去重（Map 缓存键 = 材质 id + 全量参数签名）----
  // 外部审查 P0「材质实例复用（77 → 40 以内）」的适配层落地：同一
  // userData.sculptMaterial.id + 同一参数签名（含**贴图实例 uuid**）的多个材质实例
  // 合并为一个实例。保 id 驱动逻辑不破（铁律：适配器全链按材质 id 建表 —— matById /
  // batchMerge 分桶 / 灯光联动 / refTextures 克隆缓存都按 id 寻址，合并同 id 同参实例
  // 对它们透明）。
  // 跳过名单（实例级行为件，语义上必须独立，合并即毁功能）：
  //   · cabinHidable     —— 座舱遮挡克隆，运行时 material.visible=false 整批不画；
  //   · cabinPaintShadow —— 内舱暗面克隆，setPaintShadow 切换；
  //   · refTexture       —— 参考图贴图克隆（UV 已按目标 mesh 重写过）；
  //   · 无 sculptMaterial.id 的贴花/地毯材质（license plate / MAEXTRO / carpet）。
  // 保留策略 = 遍历首见实例（与 matById 的「先序先命中」同序 ⇒ 适配器持有的引用恒为保留侧）。
  //
  // R32-D1 实测口径（.qa/r32_tmp_car/D1_material_merge.md，node shim + DOM 补全）：
  // 当前工况下「同 id + 同全量签名」的实例对为 **0** —— 每个重复用途的材质都因
  // 承载不同参考图（refTextures 按规则各挂各的图）/ 不同 tuned 参数而天然不同参，
  // 唯一两对同签名的（wood 的 tunnel-front vs 座舱遮挡克隆、leather-warm 的
  // seat-quilt 克隆 vs 座舱遮挡克隆）都被 cabinHidable 正确拦下。故本块今天是
  // 「守门员」而非「削减器」：真正价值在签名完备性（见下方 SCULPT_SIG_KEYS 注释）。
  // R32-D1：上面的常量注释已登记「实测 0 对可并」结论；这里复用模块级
  // `v800MaterialSignature()`（与测试同源），不再维护第二份签名表。
  {
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
        if (!id) continue; // 无 id 材质不并（贴花/地毯各承载不同贴图）
        const key = `${id}|${v800MaterialSignature(mt)}`;
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
      console.info(`[V800Adapter] R30-C4 同参材质去重：${reassign.length} 个 mesh 引用合并`);
    }
  }

  const batchStats = batchMergeStatic(model, {
    excludeObjects: [
      ...wheels.map((w) => w.spin),
      ...caps,
      ...(gaugeMesh ? [gaugeMesh] : []),
      pedal,
      ...lampPivots,
      ...r22Exclude,
      ...r23Exclude,
      ...r24Exclude,
    ],
    excludeMaterialIds: UV_CONTENT_MATERIAL_IDS
  });
  if (batchStats.problems.length > 0) {
    console.error('[V800Adapter] 静态合批自校验失败：', batchStats.problems);
  }
  wireBatchPaintShadow(batchStats);
  byId = indexComponents(model);
  if (typeof window !== 'undefined' && window.location.hash.includes('batchmerge')) {
    console.table(
      batchStats.groups
        .slice()
        .sort((a, b) => b.meshesIn - a.meshesIn)
        .map((g) => ({
          材质: g.materialId,
          '合并前 mesh': g.meshesIn,
          '合并后 mesh': g.meshesOut,
          减少: g.meshesIn - g.meshesOut,
          合并件三角面: g.triangles
        }))
    );
    console.info(
      `[V800Adapter] #batchmerge：mesh ${batchStats.meshesBefore} → ${batchStats.meshesAfter}，` +
        `可见 ${batchStats.drawCallsBefore} → ${batchStats.drawCallsAfter}，` +
        `Draw Call −${batchStats.drawCallReduction}`
    );
  }

  // R18：轮拱衬筒（wheel-arch-liner）整块删除。用户指出「四个车轮外围的突出围边」
  // 即这 4 个半圆筒（半径 0.44 / 宽 0.5，比车身外凸约 9cm），指令为去掉，且不保留
  // 隐藏兜底 —— 拱口深度交回工厂 body-lower 的拱形开口本身承担。

  // ---- R18：座舱地板衬毯（覆盖 body-lower 挤出壳顶面，消灭「中央隔板」）----
  // 病根（落地审查 §5 射线实锤）：body-lower 挤出壳顶面 y=1.090（paint-upper）比仪表台
  // 上沿(1.012)还高，车内机位 NDC(0,-0.35) 首命中即它（0.533m @world(0.40,1.09,1.18)），
  // 画面下半 ~45% 读作一块铜色体漆硬板 = 用户所指「中央隔板/实体模块」。车身壳顶是
  // 单一材质，无法单独隐藏（hide paint-upper 会连整个车身外观一起消失）。处置：在壳顶
  // 上方 6mm 铺一层深色内饰地毯，把车内看到的体漆换成深色内舱地板；贴面在车身壳内，
  // 车外机位透过玻璃读作深色地板（真实），不改外观轮廓。合批之后新增，不进 batch，+1 DC。
  {
    root.updateMatrixWorld(true);
    const carpetMat = new THREE.MeshStandardMaterial({
      color: 0x26221f,
      roughness: 0.96,
      metalness: 0.0
    });
    // R19 凹槽后：壳顶分两段 —— 前段（z>1.05）仍 1.090，舱段（z 1.05..-1.52）顶面 1.66。
    // 衬毯铺在**舱段凹槽顶面**（=新的「地板」高度 1.66+8mm），把凹槽顶盖成深色内饰面；
    // 前段保留旧毯，衔接中控。两块毯子均合批后新增，+2 DC。
    const mk = (w: number, d: number, y: number, z: number, name: string): void => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), carpetMat);
      const wp = new THREE.Vector3(0, y, z);
      body.worldToLocal(wp);
      mesh.position.copy(wp);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      body.add(mesh);
    };
    mk(1.86, 0.95, 1.098, 1.52, 'cabin-floor-carpet'); // 前段：中控/脚坑上方
    mk(1.86, 2.15, 1.668, -0.45, 'cabin-roof-carpet'); // 舱段：凹槽顶面（z 0.575..-1.525，避开前坡转角）
  }

  // ---- R29（外部审查 O1）：阴影 caster 白名单 ----
  // 工厂给**每个** mesh 都写了 `castShadow = options.castShadow ?? true`（185 件全开），
  // 合批后仍由 batchMerge 按 b.cast 逐批继承 ⇒ 90 个 caster 全部进 shadow pass。
  // 但阴影相机是正交 ±28m / 2048²，texel = 56/2048 ≈ 27.3mm：徽标、齿环、悬浮轮标、
  // 后视镜、内饰件要么被车体剪影完全包住，要么只占 1~2 个 texel —— 对成品像素零贡献，
  // 却是 shadow pass 里 90 次 draw call + 顶点变换的来源。
  // 白名单：车体外壳（paint-upper / paint-lower）+ 4 个轮子（轮胎/轮圈/轮心盖）。
  {
    const wheelKeep = new Set<THREE.Object3D>();
    for (const w of wheels) w.spin.traverse((o) => wheelKeep.add(o));
    let kept = 0;
    let dropped = 0;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.castShadow) return; // 已被前序逻辑关掉的（占位件/地毯/迎宾毯…）不动
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
      console.info(`[V800Adapter] #shadowcaster：保留 ${kept} / 剔除 ${dropped}`);
    }
  }

  // ---- QA 钩子：#uvassert —— 图集串味验证（三角形-矩形相交法）----
  // MEMORY 铁律的机器化：凡共享材质图集 + UV 重映射，必须验证每个三角形的
  // UV 包围盒完整落在其合法分区内（容差 0.0015），越界即串味。合批实测不破坏
  // UV（逐点比对误差 0），所以在合批后的几何上检验等价于源几何检验。
  if (typeof window !== 'undefined' && window.location.hash.includes('uvassert')) {
    // 素面 v 环绕语义材质：判据按 paint 布局（左半幅恒素面）而非单一矩形
    const WRAP_PLAIN_MATS = new Set<string>(['leather-warm']);
    const UV_ATLAS_REGIONS: Record<string, Array<[number, number, number, number]>> = {
      // lamp-gold：点阵图案区 + 素面拉丝金区（P1-1）
      'lamp-gold': [
        [GOLD_PATTERN_REGION[0], GOLD_PATTERN_REGION[1], GOLD_PATTERN_REGION[2], GOLD_PATTERN_REGION[3]],
        [GOLD_BRUSHED_REGION[0], GOLD_BRUSHED_REGION[1], GOLD_BRUSHED_REGION[2], GOLD_BRUSHED_REGION[3]]
      ],
      // leather-warm：素面粒面区（左上）+ 菱形缝格区（右上）（P1-2）；
      // R2/R3 = 素面环绕扩展区（下半幅两象限：素面长轴 v 经 RepeatWrapping 环绕时
      // 采样落点，粒面噪声 1.0 UV 周期故内容与 R0 连续；u<0.5 或 v<0.5 恒为素面 paint 区）
      'leather-warm': [
        [0.008, 0.492, 0.508, 0.992],
        [0.508, 0.992, 0.508, 0.992],
        [0.008, 0.492, 0.0, 0.492],
        [0.508, 0.992, 0.0, 0.492]
      ],
      // housing-dark：3+3 红带区 + 纯黑壳体区（EX-28）
      'housing-dark': [
        [0.004, 0.496, 0.004, 0.996],
        [0.55, 0.95, 0.3, 0.7]
      ],
      // lamp-white：盾徽面板区 + 纯白灯带区（EX-07）
      'lamp-white': [
        [0.004, 0.496, 0.004, 0.996],
        [0.55, 0.95, 0.3, 0.7]
      ],
      // screen-ui：三联屏横条 + 后排控制屏 + 扶手屏（N1）
      'screen-ui': [
        [TRI_SCREEN_UI_REGION[0], TRI_SCREEN_UI_REGION[1], TRI_SCREEN_UI_REGION[2], TRI_SCREEN_UI_REGION[3]],
        [REAR_CTRL_UI_REGION[0], REAR_CTRL_UI_REGION[1], REAR_CTRL_UI_REGION[2], REAR_CTRL_UI_REGION[3]],
        [SEAT_CTRL_UI_REGION[0], SEAT_CTRL_UI_REGION[1], SEAT_CTRL_UI_REGION[2], SEAT_CTRL_UI_REGION[3]]
      ],
      // tire：胎面沟槽区（左半）+ 胎侧字环区（右半）（EX-34）
      'tire': [
        [TIRE_TREAD_REGION[0], TIRE_TREAD_REGION[1], TIRE_TREAD_REGION[2], TIRE_TREAD_REGION[3]],
        [TIRE_SIDEWALL_REGION[0], TIRE_SIDEWALL_REGION[1], TIRE_SIDEWALL_REGION[2], TIRE_SIDEWALL_REGION[3]]
      ],
      // lamp-red：反光条分段图集（EX-31）—— 只对克隆（挂了 emissiveMap）生效，
      // 原例（尾灯芯/尾灯横带，无图集）被下方「未挂图集材质跳过」守卫挡住
      'lamp-red': [
        [REFLECTOR_PATTERN_REGION[0], REFLECTOR_PATTERN_REGION[1], REFLECTOR_PATTERN_REGION[2], REFLECTOR_PATTERN_REGION[3]]
      ]
    };
    const EPS = 0.0015;
    const perMat = new Map<string, { tris: number; bad: number; perRegion: number[]; samples: string[] }>();
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const mid = (mat as THREE.MeshPhysicalMaterial | undefined)?.userData?.sculptMaterial?.id as
        | string
        | undefined;
      const regions = mid ? UV_ATLAS_REGIONS[mid] : undefined;
      if (!regions) return;
      // 守卫：同 ID 的材质实例可能一个挂图集一个没挂（lamp-red 反光条克隆 vs
      // 尾灯原例）—— 没挂图集的实例不采样分区，无串味概念，直接跳过。
      const matRec = mat as THREE.MeshPhysicalMaterial | undefined;
      if (!matRec?.map && !matRec?.emissiveMap) return;
      const uv = m.geometry.getAttribute('uv');
      const index = m.geometry.getIndex();
      const pos = m.geometry.getAttribute('position');
      // mergeSafe 合并产物是 non-indexed（toNonIndexed）—— 无 index 时按 position 数
      if (!uv || !pos) return;
      const triCount = index ? index.count / 3 : pos.count / 3;
      let rec = perMat.get(mid!);
      if (!rec) {
        rec = { tris: 0, bad: 0, perRegion: regions.map(() => 0), samples: [] };
        perMat.set(mid!, rec);
      }
      const vertexOf = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);
      for (let t = 0; t < triCount; t++) {
        let uMin = Infinity;
        let uMax = -Infinity;
        const vArr = [0, 0, 0];
        let vMin = Infinity;
        let vMax = -Infinity;
        for (let k = 0; k < 3; k++) {
          const i = vertexOf(t, k);
          const u = uv.getX(i);
          const v = uv.getY(i);
          vArr[k] = v;
          if (u < uMin) uMin = u;
          if (u > uMax) uMax = u;
          if (v < vMin) vMin = v;
          if (v > vMax) vMax = v;
        }
        rec!.tris++;
        let regionHit = -1;
        // 菱格平铺材质（quiltTiled）：整幅皆图案、无分区概念 → 直接合法
        // refTextures 参考图材质（userData.refTexture）：UV 由世界坐标重建、整幅图
        // 平铺（triplanar/planar forced repeat），同样无图集分区概念 → 直接合法
        // （R17：R15 接入参考图后 384 三角被误报「串味」——判据没跟上 refTextures）。
        const matUd = (mat as THREE.MeshPhysicalMaterial | undefined)?.userData;
        if (matUd?.quiltTiled === true || matUd?.refTexture !== undefined) {
          regionHit = 0;
        }
        // 判据分两族：
        //  一般材质（bbox 严判）：三角形 UV bbox 完整落入某分区；
        //  leather-warm（环绕语义）：素面长轴 v 经 RepeatWrapping 环绕，其采样足迹
        //  是「左半幅任意 v」∪「右下象限 v<0.5」的并集，单个矩形无法表达 ——
        //  改按 paint 布局判：u 全程 <0.5 → 左半幅恒素面（合法）；u 触及右半幅 →
        //  逐顶点 mod-v 必须落在菱格区（≥0.508）或右下素面区（≤0.492）。
        else if (WRAP_PLAIN_MATS.has(mid!)) {
          if (uMax <= 0.492 + EPS) {
            regionHit = 0; // 左半幅：素面 paint 区，v 任意（环绕）
          } else if (uMin >= 0.5 - EPS) {
            let quilt = true;
            let lowerPlain = true;
            for (let k2 = 0; k2 < 3; k2++) {
              const mv = vArr[k2] - Math.floor(vArr[k2]);
              if (mv < 0.508 - EPS || mv > 0.992 + EPS) quilt = false;
              if (mv > 0.492 + EPS) lowerPlain = false;
            }
            regionHit = quilt ? 1 : lowerPlain ? 3 : -1;
          }
        } else {
          for (let ri = 0; ri < regions.length; ri++) {
            const [u0, u1, v0, v1] = regions[ri];
            if (uMin >= u0 - EPS && uMax <= u1 + EPS && vMin >= v0 - EPS && vMax <= v1 + EPS) {
              regionHit = ri;
              break;
            }
          }
        }
        if (regionHit >= 0) rec!.perRegion[regionHit]++;
        else {
          rec!.bad++;
          if (rec!.samples.length < 3) {
            rec!.samples.push(
              `${(m.userData.component as { id?: string } | undefined)?.id ?? m.name}#${t}[${uMin.toFixed(3)},${vMin.toFixed(3)}..${uMax.toFixed(3)},${vMax.toFixed(3)}]`
            );
          }
        }
      }
    });
    const rows = [...perMat.entries()].map(([id, r]) => ({
      材质: id,
      检查三角面: r.tris,
      越界串味: r.bad,
      '分区0三角面': r.perRegion[0],
      '分区1三角面': r.perRegion[1],
      样例: r.bad > 0 ? r.samples.join(' | ') : '—'
    }));
    console.table(rows);
    const totalBad = rows.reduce((s, r) => s + r['越界串味'], 0);
    if (totalBad > 0) console.error(`[V800Adapter] #uvassert：${totalBad} 个三角形 UV 越出图集分区（串味）`);
    else console.info('[V800Adapter] #uvassert：全部三角形 UV 落在合法分区内，无串味');

    // ---- N2 扩展判据：纹素密度 / 各向异性拉伸 ----
    // 分区归属判据只验证「采样落在合法分区内」，验证不了拉伸：QA 终验实测
    // curve-sweep 基元的参数 UV 局部各向异性达 25–220×（菱格被拉成水平乱纹）。
    // 判据：逐三角形比较「UV 边长 ↔ 世界边长」两个主方向的密度比（各向异性），
    // 世界面积 > 1cm² 且各向异性 > 4× 记超阈；同时输出密度中位数（mm/px）供目测复核。
    // 合并几何已是 model-local（scale=1）；未合并件经 modelToLocal 折算后同口径。
    const modelInv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    const m2m = new THREE.Matrix4();
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const pC = new THREE.Vector3();
    const ANISO_LIMIT = 4;
    const AREA_MIN = 1e-5; // m²，排除接缝退化三角形
    interface DensityStat {
      n: number;
      dens: number[];
      aniso: number[];
      over: number;
      over8: number;
      worst: number;
      worstAt: string;
    }
    const densStats = new Map<string, DensityStat>();
    const statOf = (key: string): DensityStat => {
      let s = densStats.get(key);
      if (!s) {
        s = { n: 0, dens: [], aniso: [], over: 0, over8: 0, worst: 0, worstAt: '' };
        densStats.set(key, s);
      }
      return s;
    };
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const matRec = mat as THREE.MeshPhysicalMaterial | undefined;
      const mid = matRec?.userData?.sculptMaterial?.id as string | undefined;
      if (!mid) return;
      if (!matRec?.map && !matRec?.emissiveMap) return;
      const geo = m.geometry;
      const pos = geo.getAttribute('position');
      const uvA = geo.getAttribute('uv');
      if (!pos || !uvA || pos.count < 3) return;
      m2m.copy(modelInv).multiply(m.matrixWorld);
      const index = geo.getIndex();
      const triCount = index ? index.count / 3 : pos.count / 3;
      const vid = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);
      const regions = UV_ATLAS_REGIONS[mid];
      for (let t = 0; t < triCount; t++) {
        pA.fromBufferAttribute(pos, vid(t, 0)).applyMatrix4(m2m);
        pB.fromBufferAttribute(pos, vid(t, 1)).applyMatrix4(m2m);
        pC.fromBufferAttribute(pos, vid(t, 2)).applyMatrix4(m2m);
        const wArea = ((pB.x - pA.x) * (pC.y - pA.y) - (pC.x - pA.x) * (pB.y - pA.y)) * 0.5;
        if (Math.abs(wArea) < AREA_MIN) continue;
        // 分区归属（与上方串味判据同口径；无分区材质按 'tile' 记）
        const us = [uvA.getX(vid(t, 0)), uvA.getX(vid(t, 1)), uvA.getX(vid(t, 2))];
        const vs = [uvA.getY(vid(t, 0)), uvA.getY(vid(t, 1)), uvA.getY(vid(t, 2))];
        let regionKey = 'tile';
        if (regions) {
          const uMin = Math.min(...us);
          const uMax = Math.max(...us);
          let ri = -1;
          let forceTile = false;
          if ((mat as THREE.MeshPhysicalMaterial | undefined)?.userData?.quiltTiled === true) {
            regionKey = 'tile'; // 菱格平铺材质：无分区，按 tile 统计密度/各向异性
            forceTile = true; // R1（P5 复核）：不参与分区归属，但必须进下方密度判据，否则整组被 ri<0 continue 跳过成空集结论
          } else if (WRAP_PLAIN_MATS.has(mid!)) {
            if (uMax <= 0.492 + EPS) {
              ri = uMin >= 0.008 - EPS ? 0 : -1; // 左半幅素面（v 环绕）
            } else if (uMin >= 0.5 - EPS) {
              let quilt = true;
              let lowerPlain = true;
              for (let k2 = 0; k2 < 3; k2++) {
                const mv = vs[k2] - Math.floor(vs[k2]);
                if (mv < 0.508 - EPS || mv > 0.992 + EPS) quilt = false;
                if (mv > 0.492 + EPS) lowerPlain = false;
              }
              ri = quilt ? 1 : lowerPlain ? 3 : -1;
            }
          } else {
            const vMin = Math.min(...vs);
            const vMax = Math.max(...vs);
            for (let k = 0; k < regions.length && ri < 0; k++) {
              const [u0, u1, v0, v1] = regions[k];
              if (uMin >= u0 - EPS && uMax <= u1 + EPS && vMin >= v0 - EPS && vMax <= v1 + EPS) {
                ri = k;
              }
            }
          }
          if (ri < 0 && !forceTile) continue; // 越界件已由串味判据上报，此处不重复计；forceTile（菱格平铺）照常进密度判据
          if (ri >= 0) regionKey = `R${ri}`;
        }
        const uvArea = Math.abs(
          (us[1] - us[0]) * (vs[2] - vs[0]) - (us[2] - us[0]) * (vs[1] - vs[0])
        ) / 2;
        if (uvArea < 1e-12) continue;
        const edges: Array<[THREE.Vector3, THREE.Vector3, number, number, number, number]> = [
          [pA, pB, us[0], vs[0], us[1], vs[1]],
          [pB, pC, us[1], vs[1], us[2], vs[2]],
          [pC, pA, us[2], vs[2], us[0], vs[0]]
        ];
        // 折边剔除：盒投影下跨越折痕的薄壁三角形有一条「世界长度可观、UV 长度≈0」
        // 的边（厚度方向被投影吃掉）—— 其纹理横向被压扁属计划内行为（相当于真实
        // 软包的包边），不参与密度/各向异性统计，单独计数供审查。
        let isFold = false;
        for (const [P, Q, su, sv, tu, tvv] of edges) {
          const ul = Math.hypot(tu - su, tvv - sv);
          if (ul < 1e-4 && P.distanceTo(Q) > 0.005) { isFold = true; break; }
        }
        if (isFold) {
          statOf(`${mid}/foldWalls`).n++;
          continue;
        }
        let dMax = 0;
        let dMin = Infinity;
        for (const [P, Q, su, sv, tu, tvv] of edges) {
          const ul = Math.hypot(tu - su, tvv - sv);
          if (ul < 1e-12) continue;
          const d = P.distanceTo(Q) / ul;
          if (d > dMax) dMax = d;
          if (d < dMin) dMin = d;
        }
        if (!isFinite(dMin) || dMin <= 0) continue;
        const aniso = dMax / dMin;
        const key = `${mid}/${regionKey}`;
        const st = statOf(key);
        st.n++;
        st.dens.push(Math.sqrt(Math.abs(wArea) / uvArea)); // m per UV 单位
        st.aniso.push(aniso);
        if (aniso > 8) st.over8++;
        if (aniso > ANISO_LIMIT) {
          st.over++;
          if (aniso > st.worst) {
            st.worst = aniso;
            st.worstAt = `${(m.userData.component as { id?: string } | undefined)?.id ?? m.name}#${t}@(${pA.x.toFixed(2)},${pA.y.toFixed(2)},${pA.z.toFixed(2)})`;
          }
        }
      }
    });
    const ATLAS_PX = 1024; // 图集像素跨度（每 UV 单元的 px 数；密度仅供目测复核的参考口径）
    const densRows = [...densStats.entries()].map(([key, s]) => {
      const sorted = s.dens.slice().sort((a, b) => a - b);
      const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const aSorted = s.aniso.slice().sort((a, b) => a - b);
      const aMed = aSorted.length ? aSorted[Math.floor(aSorted.length / 2)] : 0;
      return {
        '材质/分区': key,
        三角形: s.n,
        '密度中位(mm/px)': +((med / ATLAS_PX) * 1000).toFixed(2),
        '各向异性中位': +aMed.toFixed(2),
        超阈: s.over,
        超阈8x: s.over8,
        最差: s.worst > 0 ? `${s.worst.toFixed(1)}x ${s.worstAt}` : '—'
      };
    });
    console.table(densRows);
    // ERROR 门只看「图案内容」分区（菱格 / 红带 / 点阵 / 盾徽 / 屏幕 UI / 胎侧字环）——
    // 方向性纹理（木纹/窗帘/拉丝/胎面沟槽）与匀色区（灯带白场）的设计各向异性不算缺陷，
    // 全量数据在上表供人工复核（QA 密度判据的可见化）。
    // 注：tire/R0（胎面）周向 4.8m/UV vs 轴向 0.255m/UV ≈ 19× 是圆柱 UV 的固有压缩
    // （周向沟槽本就无周向细节），R1（胎侧字环）帽面 UV 各向同性才是图案分区。
    const PATTERN_REGION_KEYS = /^(leather-warm\/R1|housing-dark\/R0|lamp-gold\/R0|lamp-white\/R0|screen-ui\/R\d|tire\/R1)$/;
    const totalOver = densRows
      .filter((r) => PATTERN_REGION_KEYS.test(r['材质/分区']))
      .reduce((s2, r) => s2 + r['超阈8x'], 0);
    if (totalOver > 0) {
      console.error(
        `[V800Adapter] #uvassert 密度判据：图案分区 ${totalOver} 个三角形各向异性拉伸 > 8x（世界面积 > ${AREA_MIN * 1e4}cm²），见上表`
      );
    } else {
      console.info(`[V800Adapter] #uvassert 密度判据：图案分区无 > 8x 的各向异性拉伸（世界面积 > ${AREA_MIN * 1e4}cm² 口径）`);
    }
  }

  // ---- R19f：内舱暗面（换材质；声明与工具见 cabinOccluderMats 之前）----
  // 病根：body-lower / root 挤出壳顶面 y≈1.09 是全宽平顶，黄昏暖光把它读成
  // 大片亮铜色金属板 = 用户指认的「中央隔板实体模块」（r19_grid 网格射线定罪
  // batch/paint-upper 占满画面上半，命中点 y 1.20~1.34）。
  // 处置：车内机位把 paint-* 批次材质整体换成「暗车漆」克隆（深色 / 零金属度 / 高粗糙），
  // 离车切回原漆。外壳保持 FrontSide —— 车头盖、甲板仍是可见实体，不再发亮铜色。
  // 只取 **自身 sculptComponent.id 等于 body-lower / root** 的 Mesh（pivot 与 mesh 同名，
  // 工厂里 mesh 挂在 pivot 下）。⚠️ 绝不取「子树全部 Mesh」—— root 子树含整车外板，
  // 那样会把车漆整体染成暗面（实测误克隆 24 件，外观直接毁掉）。
  // 与 cabinOccluderMats 同一开关时机，零每帧开销。
  void (() => {
    const targets = ['body-lower', 'root'] as const;
    const seen = new Set<THREE.Mesh>();
    for (const id of targets) {
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
    console.info(`[V800Adapter] 内舱暗面配对 → ${paintShadowPairs.length} 组（含合批批次）`);
  })();
  const setPaintShadow = (interior: boolean): void => {
    for (const p of paintShadowPairs) {
      p.mesh.material = interior ? p.interior : p.exterior;
    }
  };

  const api: CarLike = {
    root,
    body,
    wheels,
    cabinOccluderMaterials: cabinOccluderMats,
    setPaintShadow,
    get currentHeat() {
      return heat;
    },
    spinWheels(dist: number, _dt: number): void {
      const raw = (dist / 0.382) * MS_TO_RPM_SCALE;
      // 钳制单帧转角并保留符号，避免高速下频闪/倒转错觉
      const step = Math.sign(raw) * Math.min(Math.abs(raw), MAX_WHEEL_STEP_PER_FRAME);
      for (const w of wheels) {
        // 归一到 ±π，防止 rotation.x 无界增长导致的浮点精度退化
        const next = w.spin.rotation.x - step;
        w.spin.rotation.x = THREE.MathUtils.euclideanModulo(next + Math.PI, Math.PI * 2) - Math.PI;
      }
    },
    setBrakeLights(intensity: number): void {
      brakeTarget = intensity;
    },
    flashBrakeSnap(): void {
      snapT = 1;
    },
    setHeadlights(on: boolean): void {
      headTarget = on ? HEAD_BASE : 0.15;
    },
    setBrakeHeat(t: number): void {
      heat = t;
    },
    updateCluster(speedKmh: number, forceN: number, g: number, gear: string): void {
      lastSpeedKmh = speedKmh;
      drawGauge(speedKmh, forceN, g, gear);
    },
    setSteer(_angle: number): void {
      /* 直线赛道无转向输入 */
    },
    snapPedal(): void {
      if (pedalT >= 0) return; // 只触发一次
      pedalT = 0;
      pedalVelY = 0;
      pedalVelZ = -0.4; // 向驾驶者方向（-Z = 车后）甩出
      pedalBounce = 0;
      pedalRotX = 0;
    },
    resetPedal(): void {
      pedalT = -1;
      pedalVelY = 0;
      pedalVelZ = 0;
      pedalBounce = 0;
      pedalRotX = 0;
      pedal.position.copy(PEDAL_PIVOT);
      pedal.rotation.set(0, 0, 0);
    },
    update(camera: THREE.Camera, dt: number): void {
      const now = performance.now() * 0.001;
      // 刹车灯平滑 + snap 闪红（damp：帧率无关）
      brakeLevel = damp(brakeLevel, brakeTarget, 18, dt);
      const snapGain = snapT > 0 ? snapT * 10 : 0;
      snapT = damp(snapT, 0, 6, dt);
      if (snapT < 0.001) snapT = 0;
      if (tailMat) tailMat.emissiveIntensity = brakeLevel + snapGain;
      // R21-B：手写尾灯（独占材质，刹车联动在旧件链路之外单独走）
      if (tailLampMats) {
        tailLampMats.red.emissiveIntensity =
          TAIL_LAMP_STANDBY.red + brakeLevel + snapGain;
        tailLampMats.gold.emissiveIntensity =
          TAIL_LAMP_STANDBY.gold + (brakeLevel + snapGain) * TAIL_LAMP_GOLD_BRAKE_RATIO;
      }
      // 尾灯暗场红带（housing-dark 图集）：与灯芯同强度联动（几何灯带时期的联动路径）
      if (tailFieldMat) tailFieldMat.emissiveIntensity = brakeLevel + snapGain;
      // 尾灯中部金色签名屏：随刹车联动，比上下横带暗
      if (goldMat) goldMat.emissiveIntensity = brakeLevel * GOLD_BRAKE_RATIO + snapGain * GOLD_BRAKE_RATIO;
      // 头灯平滑
      headLevel = damp(headLevel, headTarget, 14, dt);
      if (headMat) headMat.emissiveIntensity = headLevel;
      // 字标：呼吸强度乘在基准上（不覆盖 spec 自有的 emissiveIntensity）
      if (markMat) markMat.emissiveIntensity = markBase * (1 + MARK_BREATH_AMPLITUDE * Math.sin(now * 1.6));
      // EX-33 轮心盾徽（lamp-mark 克隆）：与车尾字标同相位呼吸（原本同材质同呼吸）
      if (wheelCapMat) {
        wheelCapMat.emissiveIntensity = markBase * (1 + MARK_BREATH_AMPLITUDE * Math.sin(now * 1.6));
      }
      // 星空顶：常亮呼吸，不随头灯、不随刹车
      if (starMat) {
        const phase = (now / STARLIGHT_BREATH_PERIOD) * Math.PI * 2;
        starMat.emissiveIntensity =
          STARLIGHT_BASE_INTENSITY * (1 + STARLIGHT_BREATH_AMPLITUDE * Math.sin(phase));
      }
      // ---- 悬浮轮标：自平衡 billboard（EX-33）----
      // 口径（spec + 参考图 D1-D4 + checklist 七）：自平衡悬浮式 —— 行驶中保持
      // **正立**，盘面朝向观察者。盘面法线是节点局部 +Y（CylinderGeometry 轴向），
      // 徽标"上"是局部 +X（帽面 UV 约定，a2 探针实证）—— 即绕世界 Y 轴的圆柱
      // billboard：R(x̂)=世界上, R(ŷ)=水平指向相机, R(ẑ)=up×dir。
      // 历史坑（两次）：
      //  ① 直接赋相机世界四元数 → 父链 rotation.y=π 叠加后差 180°，字标背对相机；
      //  ② 折算到局部（local = parentQ⁻¹ × cameraQ）后世界朝向 = 相机朝向 —— 但
      //     盘面法线被带到世界 +Y（朝上平躺！），侧视/追逐/环绕全是近水平机位，
      //     盘面侧对相机只剩 1.2cm 一条边，徽标不可见（PERF.md #19 只验了"朝向
      //     等于相机"，没验"盘面朝向观察者"，对称盘面也看不出）。
      // 本实现按 basis 重建：徽标在左右两侧车轮、任意机位都正立且朝向观察者。
      // ⚠️ PERF.md #19 的旧验收口径（世界朝向 == 相机朝向）与本需求不等价，
      // 已按 spec「保持正立」口径改写，QA 复核时需同步更新该判据。
      if (camera) {
        camera.getWorldPosition(tmpCamVec);
        for (const c of caps) {
          c.getWorldPosition(tmpVec);
          const dx = tmpCamVec.x - tmpVec.x;
          const dz = tmpCamVec.z - tmpVec.z;
          const len = Math.hypot(dx, dz);
          if (len <= 1e-4) continue; // 相机在盘面正上/正下：保持上一帧朝向
          tmpDir.set(dx / len, 0, dz / len);
          tmpCross.set(tmpDir.z, 0, -tmpDir.x); // up × dir
          tmpBasis.makeBasis(BILLBOARD_UP, tmpDir, tmpCross);
          tmpQuat.setFromRotationMatrix(tmpBasis);
          if (c.parent) {
            c.parent.getWorldQuaternion(tmpParentQuat);
            c.quaternion.copy(tmpParentQuat).invert().multiply(tmpQuat);
          } else {
            c.quaternion.copy(tmpQuat); // 无父节点时局部即世界
          }
        }
      }

      // ---- EX-09 迎宾光毯：速度门控 + 缓慢呼吸 ----
      // 静止（<5km/h）= 迎宾态淡入；行驶中淡出（damp 帧率无关）。
      // 门控 k=6：0.5s 量级收干净 —— k=3 时 55km/h 巡航仍拖 ~0.5s 残光带
      // （用户截图的地面 X 光痕主因之一），提速到 6 后残光 <0.2s 消隐。
      // 呼吸幅度 ±10%（0.55..0.65 × 增益）：基础亮度同步压低（光池收进车宽内
      // 后亮度要跟随收敛，避免窄光斑过曝），仍不进 bloom。
      const carpetTarget = lastSpeedKmh < WELCOME_CARPET_SPEED_GATE ? 1 : 0;
      welcomeGain = damp(welcomeGain, carpetTarget, 6, dt);
      welcomeMat.opacity = (0.55 + 0.1 * Math.sin(now * 1.35)) * welcomeGain;
      const welcomeVisible = welcomeGain > 0.02;
      if (welcomeMesh.visible !== welcomeVisible) welcomeMesh.visible = welcomeVisible;

      // ---- 踏板：脱落动画 + 可见性门控 ----
      // 可见性按「相机到踏板的世界距离」判定：只有车内视角（≈1.1m）会进入，
      // 车外各机位（hood ≈3.0 / side 4.6 / chase 8）全部剔除 → 车外零 draw call。
      pedal.getWorldPosition(tmpVec);
      const pedalVisible = tmpVec.distanceTo(camera.position) < 2.5;
      if (pedal.visible !== pedalVisible) pedal.visible = pedalVisible;
      if (pedalT >= 0) {
        pedalT += dt;
        if (pedalT < 0.12) {
          // 0–0.12s：绕顶端枢轴向驾驶者甩转 40°
          pedalRotX = (pedalT / 0.12) * PEDAL_FLING_RAD;
        } else {
          // 之后自由落体 + 向驾驶者方向的初速，落地两次弹跳（恢复系数 0.35/0.2）后躺平
          pedalVelY -= GRAVITY * dt;
          pedal.position.y += pedalVelY * dt;
          pedal.position.z += pedalVelZ * dt;
          const floor = PEDAL_PIVOT.y + PEDAL_FALL_FLOOR;
          if (pedal.position.y <= floor) {
            pedal.position.y = floor;
            if (pedalBounce < 2 && Math.abs(pedalVelY) > 0.35) {
              pedalVelY = -pedalVelY * (pedalBounce === 0 ? 0.35 : 0.2);
              pedalVelZ *= 0.6;
              pedalBounce++;
            } else {
              pedalVelY = 0;
              pedalVelZ = 0;
            }
          }
          pedalRotX = damp(pedalRotX, 1.45, 3, dt); // 渐稳至平躺
        }
        pedal.rotation.x = pedalRotX;
      }
    },
    dispose(): void {
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => disposeMaterial(x));
          else disposeMaterial(mat);
        }
      });
      pedalGeo.dispose();
      pedalMat.dispose();
      // EX-09 迎宾光毯（挂在 body 下，不在 model 遍历范围，显式释放）
      welcomeGeo.dispose();
      welcomeMat.dispose();
      gaugeTex.dispose();
      // 集成层贴图：已挂到材质上的会被 disposeMaterial 的 emissiveMap 槽释放，
      // 剩下的（材质缺失时的孤儿）在这里兜底，重复 dispose 无副作用
      for (const tex of ownedTextures) tex.dispose();
    },
  };
  void runtime;
  return api;
}

/** 材质 dispose：Material.dispose() 不级联贴图，这里显式释放全部贴图槽 + 断开 spec 引用 */
function disposeMaterial(mat: THREE.Material): void {
  const rec = mat as unknown as Record<string, unknown>;
  for (const slot of TEXTURE_SLOTS) {
    const tex = rec[slot];
    if (tex && (tex as THREE.Texture).isTexture) {
      (tex as THREE.Texture).dispose();
      rec[slot] = null;
    }
  }
  // 断开程序化材质 spec，帮助 GC（spec 内嵌大段 JSON 元数据）
  if (mat.userData) {
    mat.userData.sculptMaterial = null;
    mat.userData.referencePbr = null;
    mat.userData.materialEvidence = null;
    mat.userData.validationViews = null;
  }
  mat.dispose();
}
