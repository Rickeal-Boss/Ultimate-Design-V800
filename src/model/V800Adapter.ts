/**
 * V800 新工厂 → 游戏运行时适配器。
 * 将 img2threejs 生成的 createZunjieV800LuxuryMPVModel 包装为 Car 兼容接口：
 * root/body/wheels/灯光联动/悬浮轮标/动态仪表。
 * 车头朝向：游戏前进方向 -Z，新工厂车头 +Z → root 内置 rotY(PI) 中枢。
 */
import * as THREE from 'three';
import { carTextureSizeFor, type QualityTier } from '../config/quality';
import { damp, makeLcg } from '../util/math';
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

export function createV800CarAdapter(tier: QualityTier = 'high'): CarLike {
  const model = createZunjieV800LuxuryMPVModel({ textureSize: carTextureSizeFor(tier) });
  const runtime = model.userData.runtime as ProceduralModelRuntime | undefined;

  const root = new THREE.Group();
  const body = new THREE.Group();
  body.rotation.y = Math.PI; // 车头 +Z → -Z（游戏前进方向）
  body.add(model);
  root.add(body);

  // ---- 节点索引（按组件 ID）----
  const byId = new Map<string, THREE.Object3D>();
  model.traverse((o) => {
    const cid = (o.userData.sculptComponent?.id ?? o.userData.component?.id) as string | undefined;
    if (cid && !byId.has(cid)) byId.set(cid, o);
  });

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
    update(camera: THREE.Camera, dt: number): void {
      const now = performance.now() * 0.001;
      // 刹车灯平滑 + snap 闪红（damp：帧率无关）
      brakeLevel = damp(brakeLevel, brakeTarget, 18, dt);
      const snapGain = snapT > 0 ? snapT * 10 : 0;
      snapT = damp(snapT, 0, 6, dt);
      if (snapT < 0.001) snapT = 0;
      if (tailMat) tailMat.emissiveIntensity = brakeLevel + snapGain;
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
      // 悬浮轮标朝向相机
      if (camera) {
        camera.getWorldQuaternion(tmpQuat);
        for (const c of caps) c.quaternion.copy(tmpQuat);
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
