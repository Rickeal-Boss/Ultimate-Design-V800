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

function createGoldMatrixTexture(): THREE.CanvasTexture {
  const cols = 16;
  const rows = GOLD_MATRIX_PATTERN.length; // 24
  const cell = 24;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell; // 384
  canvas.height = rows * cell; // 576
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#080604';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 未点亮的点也画一颗极暗的，保留点阵面板质感
  ctx.fillStyle = 'rgba(201, 168, 107, 0.07)';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.beginPath();
      ctx.arc((c + 0.5) * cell, (r + 0.5) * cell, cell * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 点亮羽翼/盾形轮廓（金色 #C9A86B 系，中心略亮形成辉光梯度）
  for (let r = 0; r < rows; r++) {
    const line = GOLD_MATRIX_PATTERN[r];
    for (let c = 0; c < cols && c < line.length; c++) {
      if (line[c] !== '#') continue;
      const cx = (c + 0.5) * cell;
      const cy = (r + 0.5) * cell;
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
    const tex = createGoldMatrixTexture();
    ownedTextures.push(tex);
    goldMat.emissiveMap = tex;
    goldMat.emissive.set(0xffffff);
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
    for (const shellId of ['taillamp-l', 'taillamp-r', 'headlamp-l', 'headlamp-r']) {
      const shellMesh = meshOf(shellId);
      if (shellMesh) remapUV(shellMesh, 0.55, 0.95, 0.3, 0.7);
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
      { 灯组: '盾徽面板分区贴图', 期望: 'lamp-white', 命中: whiteMat ? 'lamp-white' : '(无)' }
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
  const gaugeNode = byId.get('gauge-screen');
  const gaugeMesh =
    gaugeNode && (gaugeNode as THREE.Mesh).isMesh
      ? (gaugeNode as THREE.Mesh)
      : (runtime?.meshes?.['gauge-screen'] as THREE.Mesh | undefined);
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
