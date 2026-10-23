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
import { carTextureSizeFor, type QualityTier } from '../config/quality';
import { damp } from '../util/math';

export type { CarLike, WheelPivot };

/** 车头朝向基准偏航（工厂 +Z → 世界 -Z）。root 不转，只转 body。 */
export const R7_BASE_YAW = Math.PI;

/**
 * 三处内饰机位（装配局部坐标 = spec 坐标：+Z 车头、+Y 上、+X 车侧左）。
 * Game 用它驱动 CameraRig；数值来自实测坐姿：
 *   前排 H 点 (|x|0.36, y0.60, z0.18)，眼点在 H 点上方 0.62m；
 *   后排坐垫面 y0.59、靠背在 z-1.02，眼点取 (0, 1.21, -1.05)。
 * 注意：这里给的是**装配局部**坐标，未含 body.rotation.y=π —— CameraRig 需要
 * 先把机位挂到 body 的局部空间（或用 body.localToWorld）再取世界坐标。
 */
export const R7_INTERIOR_VIEWS = {
  driver: {
    eye: [0.300, 1.285, -0.090] as [number, number, number],
    target: [0.150, 1.020, 1.950] as [number, number, number],
  },
  passenger: {
    eye: [-0.300, 1.285, -0.090] as [number, number, number],
    target: [-0.140, 1.020, 1.750] as [number, number, number],
  },
  rear: {
    eye: [0.0, 1.230, -0.700] as [number, number, number],
    target: [0.0, 1.030, 1.300] as [number, number, number],
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

/** 灯光/热量的基准与幅度 */
const BRAKE_BASE_INTENSITY = 0.55;
const BRAKE_FADE_K = 18;
const SNAP_GAIN = 9;
const HEAD_BASE_INTENSITY = 1.9;
const HEAD_DIM_INTENSITY = 0.18;
const CALIPER_HEAT_HEX = 0x8c1114;

/** 需要隐藏的 macro 容器占位几何（只隐藏它们**自身**的 mesh，不动子树） */
const CONTAINER_MESH_IDS = ['root', 'cabin-interior'] as const;

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
 */
export function createR7CarAdapter(tier: QualityTier = 'high'): CarLike {
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
  const brakeBaseIntensity = brakeMat?.emissiveIntensity ?? 2.0;
  const headBaseIntensity = headMats[0]?.emissiveIntensity ?? HEAD_BASE_INTENSITY;

  // ---- 内饰贴图接线（LUXEED / 铭牌 / 牌照 / 屏幕 / 网罩 / 方向盘标）----
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
    const CABIN_HIDE_RE = /^(seat-|door-card|door-trim|door-speaker|sun-visor|apillar-inner|dash-lower|steering-hub)/;
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

  // ---- R27：内饰件整体抬升（治 body-lower 壳顶「腰带台面」吞掉方向盘/仪表台）----
  // 病根（.qa/r27_pick.mjs 逐三角射线 + 侧视轮廓实测）：body-lower 是连续侧视轮廓
  // 单壳挤出，轮廓上沿（腰带线）在座舱区 z-2.05..+0.86 全程顶在 y≈1.074~1.093 ——
  // 一块比仪表台顶面（dash-upper 0.962）还高 13cm 的实体台面。驾驶眼点
  // (0.30, 1.285, -0.09) 只在台面上方 0.19m，指向仪表/方向盘的射线先命中台面：
  // NDC(0,-0.8) 首命中壳顶 0.30m，方向盘（0.83m）整块被挡，只剩顶缘一小弧。
  // V800 同款壳顶不挡，因其仪表台前伸到腰带前缘之外（dash z1.55..2.01 > 腰线前缘
  // z1.05），而 R7 仪表台整块藏在台面下方（台面前缘 z0.86 > 仪表后缘 z0.716）。
  // 外壳几何禁改（profile 上沿 = 外观侧视腰线，动它侧窗/腰带脱节），故在装配层把
  // 内饰件抬到台面之上：抬升量 0.26m = 眼点−(台面前缘) 视线余量 ≥6cm（仪表顶
  // 1.222 > 视线阈值 1.106；方向盘毂心 1.184 > 1.123）。必须在合批前做——合批会把
  // 世界矩阵烘进几何。steering 是 pivot，子节点 hub/badge 随动，转向旋转不受影响。
  {
    const R27_INTERIOR_LIFT = 0.26;
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

  const mergeResult = batchMergeStatic(model, {
    excludeObjects: dynamicNodes,
    excludeMaterialIds: UV_CONTENT_MATERIAL_IDS,
    mergeTarget: model,
  });
  wireBatchPaintShadow(mergeResult);

  // ---- R27：移除 R18 座舱地板衬毯（冗余且与抬升后的方向盘相交）----
  // R18 衬毯是为遮 body-lower 壳顶亮色体漆而加的浮板（y1.102，眼点下 0.18m）。
  // R19f 之后壳顶在车内机位已整体换成暗色内舱漆（setPaintShadow 材质克隆，实测
  // .qa/r27_carpet_test.mjs：隐藏衬毯后 bottom 带仅 +5~9 级，即衬毯本就只是同色
  // 浮板），衬毯既冗余又有害：① 浮板在 NDC(0,-0.8) 首命中 0.30m，把 R27 抬升后
  // 方向盘的下弧（y≈1.0~1.1 @z0.56..0.71）整段切掉；② 与抬升后的方向盘几何相交。
  // 删除后座舱读作「暗色壳顶台面 + 抬升内饰」，与 V800 同构。

  // ---- 运行时状态 ----
  let heat = 0;
  let brakeLevel = 0;
  let brakeTarget = 0;
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
  const setPaintShadow = (interior: boolean): void => {
    for (const p of paintShadowPairs) {
      p.mesh.material = interior ? p.interior : p.exterior;
    }
  };

  const api: CarLike = {
    root,
    body,
    wheels,
    // R15：内饰三机位（装配局部坐标），由 Game → CameraRig.setInteriorViews 消费
    interiorViews: R7_INTERIOR_VIEWS,
    cabinOccluderMaterials: cabinOccluderMats,
    setPaintShadow,
    get currentHeat(): number {
      return heat;
    },
    set currentHeat(value: number) {
      heat = value;
    },

    spinWheels(dist: number, _dt: number): void {
      const raw = (dist / WHEEL_RADIUS) * MS_TO_RPM_SCALE;
      const step = Math.sign(raw) * Math.min(Math.abs(raw), MAX_WHEEL_STEP_PER_FRAME);
      if (step === 0) return;
      for (const rig of spinRigs) {
        // 归一到 (-π, π]，防止无界增长后的浮点精度退化
        rig.angle = THREE.MathUtils.euclideanModulo(rig.angle - step + Math.PI, Math.PI * 2) - Math.PI;
        applySpin(rig);
      }
    },

    setBrakeLights(intensity: number): void {
      brakeTarget = clamp01(intensity);
    },

    flashBrakeSnap(): void {
      snapT = 1;
    },

    setHeadlights(on: boolean): void {
      headTarget = on ? headBaseIntensity : HEAD_DIM_INTENSITY;
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
      if (brakeMat) {
        brakeMat.emissiveIntensity =
          brakeBaseIntensity * (BRAKE_BASE_INTENSITY + brakeLevel) + snapT * SNAP_GAIN;
      }
      // 头灯
      headLevel = damp(headLevel, headTarget, 14, dt);
      for (const mat of headMats) mat.emissiveIntensity = headLevel;
      // 刹车热：卡钳暗红自发光
      if (caliperMat) caliperMat.emissiveIntensity = heat * 1.1;
      // 方向盘回正
      steerAngle = damp(steerAngle, steerTarget, 12, dt);
      if (Math.abs(steerAngle) > 1e-5) applySteer();
      // 仪表按 15Hz 节流重绘（updateCluster 的挡位可能在两次调用间变化）
      pushCluster(lastSpeedKmh, lastForceN, lastG, lastGear, nowSec);
    },

    dispose(): void {
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
