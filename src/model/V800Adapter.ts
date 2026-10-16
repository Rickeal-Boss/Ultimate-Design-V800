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
import {
  createZunjieV800LuxuryMPVModel,
  type ProceduralModelRuntime,
} from './createV800Model';

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
  'glass-dark': 0.55,
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
 */
function createProceduralSurface(
  size: number,
  normalStrength: number,
  sample: (u: number, v: number) => [number, number, number, number]
): SurfaceMapSet {
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const colorCtx = colorCanvas.getContext('2d')!;
  const colorImage = colorCtx.createImageData(size, size);
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = size;
  normalCanvas.height = size;
  const normalCtx = normalCanvas.getContext('2d')!;
  const normalImage = normalCtx.createImageData(size, size);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const [h, r, g, b] = sample(u, v);
      height[y * size + x] = h;
      const off = (y * size + x) * 4;
      colorImage.data[off] = r;
      colorImage.data[off + 1] = g;
      colorImage.data[off + 2] = b;
      colorImage.data[off + 3] = 255;
    }
  }

  // wrap 有限差分 → 法线（[-1,1] 映射到 [0,255]）
  const s = normalStrength * size;
  for (let y = 0; y < size; y++) {
    const yUp = (y - 1 + size) % size;
    const yDn = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xL = (x - 1 + size) % size;
      const xR = (x + 1) % size;
      const dx = (height[y * size + xR] - height[y * size + xL]) * s;
      const dy = (height[yDn * size + x] - height[yUp * size + x]) * s;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const off = (y * size + x) * 4;
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
 * EX-08 头灯 3 枚圆形 LED 点阵（128×512），lamp-head 材质（两条竖向灯芯独占）。
 * 基底 0.33 亮度：setHeadlights(false)（intensity 0.15）时灯体仍读得出轮廓，
 * 点阵亮芯在常亮/熄灯两态都保持圆形可辨。
 */
function createHeadlampLedTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgb(80, 88, 100)';
  ctx.fillRect(0, 0, W, H);
  // 灯腔棱面：几道极淡竖向亮线
  ctx.strokeStyle = 'rgba(220, 228, 240, 0.1)';
  ctx.lineWidth = 6;
  for (let i = 0; i < 4; i++) {
    const x = 18 + i * 28 + (i % 2) * 6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  // 3 枚圆形 LED（v = 0.25 / 0.5 / 0.75）：柔光晕 + 实心亮芯
  for (const vy of [0.25, 0.5, 0.75]) {
    const y = (1 - vy) * H;
    const halo = ctx.createRadialGradient(W / 2, y, 0, W / 2, y, 52);
    halo.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    halo.addColorStop(0.35, 'rgba(226, 234, 248, 0.55)');
    halo.addColorStop(1, 'rgba(226, 234, 248, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(W / 2, y, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.beginPath();
    ctx.arc(W / 2, y, 22, 0, Math.PI * 2);
    ctx.fill();
  }
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

/**
 * 菱格专用平铺贴图（整幅菱形缝格，无图集分区）。
 * N2 终解：菱格件若沿用共享图集，三平面/盒投影的连续 UV 必然越出分区、
 * mod 折回又会在三角形插值时穿过图集间缝 —— 唯一两全解是给菱格件一张
 * 「整幅都是图案」的可平铺贴图：细胞周期 = size/16（整数）→ RepeatWrapping
 * 无缝环绕，UV 可沿世界坐标无限延展。配合逐三角形三平面投影（见适配器），
 * 任意朝向的面都得到 6cm 等密度菱格。材质用 leather-warm 的克隆（ID 不变，
 * 合批按实例分组 → 菱格件独立成组，+1 draw call）。
 */
function createQuiltTileTexture(size: number, seed: number, baseHex: [number, number, number]): SurfaceMapSet {
  const cells = 16; // 每贴图边 16 个细胞（周期整数 → 无缝）
  const [br, bg, bb] = baseHex;
  const plain = leatherSampler(baseHex, seed);
  const stitchPitch = 0.25; // 缝珠间距（细胞单位的 1/4，同图集版）
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
    const h = clamp01(h0 * 0.55 + 0.45 * puff);
    const shade = 0.86 + 0.3 * h;
    return [h, r0 * shade, g0 * shade, b0 * shade];
  };
  return createProceduralSurface(size, 0.55, sample);
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

  // ---- P1-5 greenhouse 玻璃一致性（适配层覆盖；spec 数值不动，决策回写 spec 留给主理人）----
  // 根因：glass-dark spec 自带 transmission 0.5，但色调 #101418 近黑 —— 透射光被乘成
  // ≈6% 亮度，视觉读作不透明黑板，与 glass-clear 的透明观感不一致。
  // 统一为「深色隐私玻璃但可透视」：high 档提高透射 + 提亮色调；
  // medium/low 由下方既有归零回退接手（opacity 0.55 近似），门控行为与 glass-clear 一致。
  // 透射 pass 本就因 glass-clear/crystal 存在，此处零新增 pass、零 DC 增量。
  const greenhouseMat = matById.get('glass-dark') ?? null;
  if (greenhouseMat) {
    greenhouseMat.transmission = 0.82;
    greenhouseMat.color.set(0x2e3640);
    greenhouseMat.thickness = 0.02;
    greenhouseMat.transparent = true;
    greenhouseMat.needsUpdate = true;
  }

  // ---- 非 high 档：transmission 降级为普通半透明（构造期一次，避免每帧透射 pass）----
  if (tier !== 'high') {
    for (const [id, mat] of matById) {
      if (!(mat.transmission > 0)) continue;
      mat.transmission = 0;
      mat.transparent = true;
      mat.opacity = GLASS_OPACITY_FALLBACK[id] ?? DEFAULT_GLASS_OPACITY;
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
    // 车轮占位盒：0.764×0.764 方块的角部比同直径圆胎外扩 15.8cm 且 castShadow。
    // 只隐藏方块自身（父节点仍是轮心 pivot，子级 cylinder 真轮胎/轮圈保留）。
    // 判据是 primitive === 'box'，**不能用体积**：实测 8 个 tire 材质 mesh
    // （4 个占位盒 + 4 个真轮胎）包围盒同为 0.764×0.764×0.255 ≈ 0.149 m³，
    // 任何体积阈值都会同时命中或同时漏掉，实测不可分。
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const isTire = mats.some(
      (mt) => (mt as THREE.MeshPhysicalMaterial | undefined)?.userData?.sculptMaterial?.id === 'tire'
    );
    if (!isTire) return;
    if (comp?.primitive === 'box') {
      m.visible = false;
      m.castShadow = false;
    }
  });

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
  for (const id of ['tri-screen', 'gauge-screen']) {
    const node = byId.get(id);
    if (node) node.rotateY(Math.PI);
  }

  // ---- 车轮（pivot 在轮心，绕 X 滚动）----
  const wheels: WheelPivot[] = [];
  for (const tag of ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']) {
    const pivot = byId.get(tag);
    if (pivot) wheels.push({ spin: pivot });
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
  const pedalMat = new THREE.MeshPhysicalMaterial({
    color: 0x16181c,
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

  // ---- 集成层贴图：星空顶 / 字标 / 金色签名屏 ----
  // 这三个材质由 spec 声明为 textureless，贴图在集成层现画；
  // 星空顶与签名屏走独立分支、不参与上面的认领，缺失时静默跳过（spec 未落地时不应刷屏）。
  const ownedTextures: THREE.Texture[] = [];
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
  /** 把 mesh 全部 UV 从全幅 0..1 线性压进 [u0,u1]×[v0,v1]（图集分区用） */
  const remapUV = (
    mesh: THREE.Mesh,
    u0: number,
    u1: number,
    v0: number,
    v1: number
  ): void => {
    const uv = mesh.geometry.getAttribute('uv');
    if (!uv) return;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
    uv.needsUpdate = true;
  };
  /**
   * 归一化重映射：先测 mesh 自身 UV 包围盒，再线性压进目标区。
   * extrude / curve-sweep 基元的 UV 是坐标值（实测 leather-warm 合批后
   * u∈[-0.33,1.0]），不是 0..1 —— 直接用 remapUV 会错位，必须走这里。
   * box/cylinder 等 0..1 基元经此函数与 remapUV 结果一致（bbox 即全幅）。
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
    // 壳体外观零变化；线性映射对任意输入 UV 都收敛到目标区，extrude 也安全
    for (const fieldId of ['lantern-emitter-l', 'lantern-emitter-r']) {
      const fieldMesh = meshOf(fieldId);
      if (fieldMesh) remapUV(fieldMesh, 0.004, 0.496, 0.004, 0.996);
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
  // EX-08 头灯 3 枚圆形 LED 点阵：lamp-head 两条竖向灯芯独占
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
    const panelMesh = meshOf('shield-emblem-panel');
    if (panelMesh) remapUV(panelMesh, 0.004, 0.496, 0.004, 0.996);
    for (const barId of ['front-light-bar', 'bumper-light-strip']) {
      const barMesh = meshOf(barId);
      if (barMesh) remapUV(barMesh, 0.55, 0.95, 0.3, 0.7);
    }
  }
  // P1-1 lamp-gold 图集 UV 分区：签名屏 → 点阵图案区；4 扬声器 + 2 高音罩 →
  // 素面拉丝金区（点阵串味修复）。线性 remapUV 对 box/cylinder/capsule（UV 恒 0..1）
  // 与归一化重映射等价；UV 改动必须在 batchMergeStatic 之前烘进源几何。
  if (goldMat) {
    for (const id of ['lantern-signature-l', 'lantern-signature-r']) {
      const mesh = meshOf(id);
      if (mesh) remapUV(mesh, GOLD_PATTERN_REGION[0], GOLD_PATTERN_REGION[1], GOLD_PATTERN_REGION[2], GOLD_PATTERN_REGION[3]);
    }
    for (const id of ['speaker-fl', 'speaker-fr', 'speaker-rl', 'speaker-rr', 'tweeter-l', 'tweeter-r']) {
      const mesh = meshOf(id);
      if (mesh) remapUV(mesh, GOLD_BRUSHED_REGION[0], GOLD_BRUSHED_REGION[1], GOLD_BRUSHED_REGION[2], GOLD_BRUSHED_REGION[3]);
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
    // plane-card 基元 UV 恒 0..1 → 线性 remapUV 足够
    const triScreen = meshOf('tri-screen');
    if (triScreen) remapUV(triScreen, TRI_SCREEN_UI_REGION[0], TRI_SCREEN_UI_REGION[1], TRI_SCREEN_UI_REGION[2], TRI_SCREEN_UI_REGION[3]);
    const rearCtrl = meshOf('rear-control-screen');
    if (rearCtrl) remapUV(rearCtrl, REAR_CTRL_UI_REGION[0], REAR_CTRL_UI_REGION[1], REAR_CTRL_UI_REGION[2], REAR_CTRL_UI_REGION[3]);
    for (const id of ['seat-rear-l-screen', 'seat-rear-r-screen']) {
      const mesh = meshOf(id);
      if (!mesh) continue;
      // 扶手屏 rotation.x = −1.75（上仰朝车尾）→ 图集方向旋转 180°（u/v 反向映射）
      remapUV(mesh, SEAT_CTRL_UI_REGION[1], SEAT_CTRL_UI_REGION[0], SEAT_CTRL_UI_REGION[3], SEAT_CTRL_UI_REGION[2]);
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
  const QUILT_CELL_WORLD = 0.06; // I5/I6 钻石菱格参考边长 ≈6cm
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
  if (leatherWarmMat && !leatherWarmMat.map) {
    // 共享图集：素面粒面承载门板/前排/三排等通用件（左上素面区）
    const warm = createLeatherAtlasTexture(atlasSize, 0x51c9d4, [192, 138, 94], atlasSize / 32);
    applySurface(leatherWarmMat, warm, 0.7);
    // N2：菱格件改用专用平铺贴图 + 材质克隆（ID 不变）——
    // 共享图集的分区约束与「任意朝向面都要 6cm 等密度菱格」不可兼得（三平面
    // 投影的连续 UV 必然越出分区）；整幅可平铺的菱格贴图让 UV 沿世界坐标无限
    // 延展、RepeatWrapping 无缝环绕。克隆材质令合批把菱格件独立成组：+1 draw call。
    const quiltMat = leatherWarmMat.clone();
    const quiltSet = createQuiltTileTexture(atlasSize / 2, 0x51c9d5, [192, 138, 94]);
    ownedTextures.push(quiltSet.map, quiltSet.normalMap);
    quiltMat.map = quiltSet.map;
    quiltMat.normalMap = quiltSet.normalMap;
    quiltMat.userData.quiltTiled = true; // #uvassert 跳过分区判据（整幅菱格，无串味概念）
    quiltMat.needsUpdate = true;
    // 菱格区：后排座椅座面/靠背/头枕可见面 —— 逐三角形三平面投影
    for (const id of [
      'seat-rear-l',
      'seat-rear-l-back',
      'seat-rear-l-headrest',
      'seat-rear-r',
      'seat-rear-r-back',
      'seat-rear-r-headrest'
    ]) {
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
      createProceduralSurface(fabricSize, 0.45, woodSampler([107, 52, 24], 37)),
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
    applySurface(
      curtainMat,
      createProceduralSurface(fabricSize, 0.5, curtainSampler([216, 207, 192], 53)),
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
      { 灯组: '车名牌镀铬字', 期望: 'plate', 命中: plateMat ? 'plate' : '(无)' },
      { 灯组: '盾徽面板分区贴图', 期望: 'lamp-white', 命中: whiteMat ? 'lamp-white' : '(无)' },
      { 灯组: '皮革图集(素面+菱格)', 期望: 'leather-warm', 命中: leatherWarmMat ? 'leather-warm' : '(无)' },
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
   * 怠速尾灯基线（实测复核后维持 2.0，推导如下）。
   * 前值 2.0 被报「偏亮、灯带间隙被辉光糊」——但糊的来源是几何时期 12 条灯带 +
   * 灯芯同强度发光、6mm 视觉间隙在斜视角下被灯芯红晕填满，而非 2.0 超阈：
   * emissive #E03040（线性 ≈ [0.746, 0.030, 0.052]）× 2.0 的相对亮度 ≈ 0.37，
   * 低于 UnrealBloom 阈值 0.72（Postfx.ts），怠速本就不触发 bloom。
   * EX-28 撤几何改贴图（createTailBandAtlasTexture → 暗场内衬）后逐档核算：
   * 亮带 0.96 / 间隙 0（纯黑零发光）→ 怠速 2.0 下间隙完全熄灭，3+3 灯带清晰可辨；
   * 满刹 8.0 下亮带 ≈ 1.47 越阈起爆、间隙仍黑，爆发感增强。怠速压低反而削制动反馈（灯带全暗 = 玩家失去参照），故不动。
   */
  const TAIL_BASE = 2.0;
  const HEAD_BASE = 2.5;
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
    gctx.fillStyle = '#060a08';
    gctx.fillRect(0, 0, w, h);
    gctx.strokeStyle = '#1d3a2c';
    gctx.strokeRect(6, 6, w - 12, h - 12);
    // 速度
    gctx.fillStyle = '#7fd8a8';
    gctx.font = 'bold 92px "Segoe UI", sans-serif';
    gctx.textAlign = 'left';
    gctx.fillText(`${Math.round(speedKmh)}`, 34, 128);
    gctx.font = '26px "Segoe UI", sans-serif';
    gctx.fillStyle = '#4a7a62';
    gctx.fillText('km/h', 40, 164);
    // 踏板力条
    const ratio = Math.min(1, forceN / 1612);
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
    // READY
    gctx.fillStyle = '#7fd8a8';
    gctx.font = '28px "Segoe UI", sans-serif';
    gctx.textAlign = 'center';
    gctx.fillText('READY', w / 2, 240);
    gaugeTex.needsUpdate = true;
  };
  drawGauge(0, 0, 0, 'P'); // 初帧即出 UI（QA 机位 / 待机态不走 updateCluster 也能看到仪表画面）

  let tmpQuat = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  /** billboard 折算用：cap 父节点的世界朝向 */
  const tmpParentQuat = new THREE.Quaternion();

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
  const batchStats = batchMergeStatic(model, {
    excludeObjects: [...wheels.map((w) => w.spin), ...caps, ...(gaugeMesh ? [gaugeMesh] : []), pedal],
    excludeMaterialIds: UV_CONTENT_MATERIAL_IDS
  });
  if (batchStats.problems.length > 0) {
    console.error('[V800Adapter] 静态合批自校验失败：', batchStats.problems);
  }
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
        if ((mat as THREE.MeshPhysicalMaterial | undefined)?.userData?.quiltTiled === true) {
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
    // ERROR 门只看「图案内容」分区（菱格 / 红带 / 点阵 / 盾徽 / 屏幕 UI）——
    // 方向性纹理（木纹/窗帘/拉丝）与匀色区（灯带白场）的设计各向异性不算缺陷，
    // 全量数据在上表供人工复核（QA 密度判据的可见化）。
    const PATTERN_REGION_KEYS = /^(leather-warm\/R1|housing-dark\/R0|lamp-gold\/R0|lamp-white\/R0|screen-ui\/R\d)$/;
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

  const api: CarLike = {
    root,
    body,
    wheels,
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
      // 尾灯暗场红带（housing-dark 图集）：与灯芯同强度联动（几何灯带时期的联动路径）
      if (tailFieldMat) tailFieldMat.emissiveIntensity = brakeLevel + snapGain;
      // 尾灯中部金色签名屏：随刹车联动，比上下横带暗
      if (goldMat) goldMat.emissiveIntensity = brakeLevel * GOLD_BRAKE_RATIO + snapGain * GOLD_BRAKE_RATIO;
      // 头灯平滑
      headLevel = damp(headLevel, headTarget, 14, dt);
      if (headMat) headMat.emissiveIntensity = headLevel;
      // 字标：呼吸强度乘在基准上（不覆盖 spec 自有的 emissiveIntensity）
      if (markMat) markMat.emissiveIntensity = markBase * (1 + MARK_BREATH_AMPLITUDE * Math.sin(now * 1.6));
      // 星空顶：常亮呼吸，不随头灯、不随刹车
      if (starMat) {
        const phase = (now / STARLIGHT_BREATH_PERIOD) * Math.PI * 2;
        starMat.emissiveIntensity =
          STARLIGHT_BASE_INTENSITY * (1 + STARLIGHT_BREATH_AMPLITUDE * Math.sin(phase));
      }
      // ---- 悬浮轮标朝向相机（billboard）----
      // 坑（已修）：这里曾经直接把相机的**世界**四元数赋给 cap 的**局部** quaternion。
      // cap 在 model 子树下，而 body 带 rotation.y = π（工厂车头 +Z → 游戏 -Z），
      // 于是 cap 的世界朝向 = 父链旋转 × 相机朝向，实际差 180° —— 字标是背对相机的。
      // 正确做法是先把目标世界朝向折算到父节点局部空间：local = parentWorldQ⁻¹ × cameraWorldQ。
      if (camera) {
        camera.getWorldQuaternion(tmpQuat);
        for (const c of caps) {
          if (c.parent) {
            c.parent.getWorldQuaternion(tmpParentQuat);
            c.quaternion.copy(tmpParentQuat).invert().multiply(tmpQuat);
          } else {
            c.quaternion.copy(tmpQuat); // 无父节点时局部即世界
          }
        }
      }

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
