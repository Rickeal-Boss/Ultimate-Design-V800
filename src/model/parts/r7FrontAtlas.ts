/**
 * r7FrontAtlas.ts —— R68 · R7 外部壳前灯「4 方灯珠 + 点阵 DRL + 贯穿镀铬细条」程序化重建
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ 本模块**只依赖 three + 纯函数/常量**：禁 import ExternalShell / Adapter / config。 │
 * │   装配由 ExternalShell.ts 的 `if (lfGltf)` 块完成，本文件不接线。                  │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * ══ 定罪背景（开发线 Phase 1 实证）════════════════════════════════════════════
 *  · `src/assets/cars/r7/lamp_front.glb` 单 mesh 18,594 tri，
 *    左灯 x[-0.22923,-0.11580] / 右灯 x[0.11351,0.22855]、y[0.1680,0.2139]、
 *    z[0.4273,0.5408]；**两灯分离、中央 x≈0 无顶点**。
 *  · zmax 沿 x 从 0.4761（外端）→ 0.5408（内端）跨 **64.8mm local = 280mm 世界** 的强楔形曲面；
 *    R53 `r53AddBox` 用**单一 `bb.max.z`** 落全部细节盒 ⇒ 外端细节盒悬空最多
 *    0.0657 local ≈ **0.284 m 世界**（「暗块 + 边缘锯齿」几何根因，R57 对 V800 已修、R7 漏修）。
 *  · `lamp_front_atlas.png` 两车均缺（第 9 轮静默降级 ⇒ `lampFrontMat` 纯 emissive 暗块）。
 *  · R53 生成的 `lamp_front_drl` / `lamp_front_chrome` 是 lampMesh 的 **child**，
 *    未打 `r44External` ⇒ 默认外景态被 `setExteriorHidden(true)` 按 id-less 规则连藏
 *    （R57 只在 V800 分支补了标记，R7 路径漏补）。
 *  · `r7FrontDetails.ts`（4 透镜 / 8 段 DRL / 贯穿镀铬刃）挂在**程序化回退树**，
 *    外部壳 on 态同样被 `setExteriorHidden` 隐藏 ⇒ 只改它等于「改了又没改」。
 *    ⇒ 本模块走外部壳 on 主接线（新 child mesh 自带 `r44External` + 自带 UV 的程序化贴图）。
 *
 * ══ 官图参数（双视觉模型提取，主理人 R68 派单）════════════════════════════════
 *  4 颗方形灯珠水平单行（单颗宽:间距 ≈ 1:0.5）、下沿单行高密度点阵 DRL、
 *  主灯组与点阵带之间一条贯穿镀铬细条、楔形深色灯罩（深色占 70~80%）。
 *
 * ══ 曲面贴合 ══════════════════════════════════════════════════════════════════
 *  `R7_FRONT_Z_PROFILE` 由 GLB POSITION 逐顶点实测（8 x 桶 × 2 y 带，取每桶 zMax），
 *  `r7FrontSurfaceZ()` 双线性插值 ⇒ 每条灯带 8 段 quad、逐顶点取 `zMax + 0.003`，
 *  **不再用单一 bb.max.z**（R56 曲面件铁律 / R57:1066-1067）。
 *  几何写 GLB 局部（模型单位），由父 `lampFrontMeshes[0]` 的 `scale=manifest.scale` 放大。
 *
 * ══ UV / 纪律 ════════════════════════════════════════════════════════════════
 *  · 共享一张 1024×512 不透明 CanvasTexture（左右灯各半幅，零外部图片资产）；
 *  · UV 走 `remapUVToRegion` 按 mesh 自身 UV bbox 归一（禁线性 remap，R4 #uvassert 教训）；
 *  · 灯组不碰 transmission / transparent+alphaTest（R12 铁律⑤、R49 SwiftShader 泛白坑）；
 *  · 新 child 打 `r44External=true`（R57/R59 铁律）。
 *  · 不改共享 `r53SplitLampBoxes` / `R53_R7_ELEMS`（并行元素表，逐字保留旧路径）。
 *  · 回滚：`#r68r7lamp=off` ⇒ 调用方不建本模块 ⇒ 逐位回 R53/R57 基线。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { remapUVToRegion } from './tailLampC2';

/* ══════════════════════ 1. 常量 ══════════════════════ */

export const R7_FRONT_ATLAS_W = 1024;
export const R7_FRONT_ATLAS_H = 512;
/** 每侧灯带的曲面分段数（8 段 × 左右 2 = 16 quad = 32 tri） */
export const R7_FRONT_SEGMENTS = 8;
/** 细节盒相对曲面的外凸量（GLB 局部单位；×4.323 ≈ 13mm 世界） */
export const R7_FRONT_LIFT = 0.003;

/** 左右灯 x/y 范围（GLB 局部，实测） */
export const R7_FRONT_LAMP_BOX = {
  left: { x0: -0.22923, x1: -0.11580 },
  right: { x0: 0.11351, x1: 0.22855 },
  yLo: 0.1680,
  yHi: 0.2139
} as const;

/**
 * 曲面 zMax 查表（GLB 局部单位，8 x 桶 × 2 y 带）。
 * rows[0] = 低 y 带（y≈0.168）、rows[1] = 高 y 带（y≈0.191）。
 * 实测来源：`src/assets/cars/r7/lamp_front.glb` POSITION accessor 逐顶点分桶取 max(z)。
 */
export const R7_FRONT_Z_PROFILE = {
  left: {
    low: [0.4677, 0.4880, 0.5020, 0.5145, 0.5229, 0.5297, 0.5361, 0.5408],
    high: [0.4761, 0.4935, 0.5059, 0.5152, 0.5230, 0.5302, 0.5361, 0.5404]
  },
  right: {
    low: [0.5407, 0.5361, 0.5305, 0.5231, 0.5151, 0.5026, 0.4877, 0.4711],
    high: [0.5407, 0.5364, 0.5306, 0.5239, 0.5159, 0.5061, 0.4937, 0.4760]
  }
} as const;

/** 双线性插值：给定侧、x（局部）、y（局部）返回该点曲面 zMax（局部）。 */
export function r7FrontSurfaceZ(side: 'left' | 'right', x: number, y: number): number {
  const box = R7_FRONT_LAMP_BOX[side];
  const rows = R7_FRONT_Z_PROFILE[side];
  const t = Math.min(1, Math.max(0, (x - box.x0) / (box.x1 - box.x0)));
  const v = Math.min(1, Math.max(0, (y - R7_FRONT_LAMP_BOX.yLo) / (R7_FRONT_LAMP_BOX.yHi - R7_FRONT_LAMP_BOX.yLo)));
  const fx = t * (R7_FRONT_SEGMENTS - 1);
  const i0 = Math.min(R7_FRONT_SEGMENTS - 1, Math.floor(fx));
  const i1 = Math.min(R7_FRONT_SEGMENTS - 1, i0 + 1);
  const a = fx - i0;
  const lo = rows.low[i0] + (rows.low[i1] - rows.low[i0]) * a;
  const hi = rows.high[i0] + (rows.high[i1] - rows.high[i0]) * a;
  return lo + (hi - lo) * v;
}

/* ══════════════════════ 2. 程序化贴图（纯函数 + painter 注入）══════════════════════ */

/** 2D 绘制指令抽象：浏览器走 CanvasRenderingContext2D，node / vitest 走内存 shim。 */
export interface R7FrontPainter {
  fill(w: number, h: number, color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  dot(x: number, y: number, r: number, color: string): void;
}

/**
 * 单侧半幅绘制（官图归一化）：
 *  · 不透明深色楔形灯罩铺底（深色占比 ≈ 75%）；
 *  · 4 颗方形灯珠水平单行（宽:间距 = 1:0.5）；
 *  · 主灯组与点阵带之间一条贯穿镀铬细条；
 *  · 下沿单行高密度点阵 DRL（48 点，离散非渐变）。
 */
function paintHalf(p: R7FrontPainter, ox: number, half: number, h: number): void {
  // 楔形深色灯罩：整半幅铺深墨，再用梯形暗块暗示楔形上缘（不引入透明/alphaTest）
  p.rect(ox, 0, half, h, '#0a0e12');
  p.rect(ox + half * 0.06, h * 0.06, half * 0.88, h * 0.60, '#070a0f');
  // 上缘镀铬刃（楔形暗罩顶边）
  p.rect(ox + half * 0.06, h * 0.05, half * 0.88, 5, '#aeb6c0');

  // 4 颗方形灯珠：宽:间距 = 1:0.5 ⇒ 总宽 = 4w + 3(0.5w) = 5.5w
  const beadW = (half * 0.80) / 5.5;
  const gap = beadW * 0.5;
  const total = 4 * beadW + 3 * gap;
  const x0 = ox + (half - total) / 2;
  const beadY = h * 0.22;
  for (let i = 0; i < 4; i += 1) {
    const bx = x0 + i * (beadW + gap);
    // 镀铬外圈 + 冷白内芯（近方形，官图 4 颗方形灯珠）
    p.rect(bx - 3, beadY - 3, beadW + 6, beadW + 6, '#b8c2cd');
    p.rect(bx, beadY, beadW, beadW, '#e8f2ff');
  }

  // 贯穿镀铬细条（主灯组与点阵 DRL 带之间）
  p.rect(ox + half * 0.04, h * 0.50, half * 0.92, 6, '#c9ced6');
  p.rect(ox + half * 0.04, h * 0.50 + 6, half * 0.92, 2, '#5a6068');

  // 下沿单行高密度点阵 DRL（48 点，离散、非渐变）
  const dots = 48;
  const dy = h * 0.76;
  for (let i = 0; i < dots; i += 1) {
    const dx = ox + half * 0.05 + (i + 0.5) * (half * 0.90) / dots;
    p.dot(dx, dy, 3.2, '#dceaff');
  }
}

/** 纯函数：绘制整张 atlas（左右各半幅）。零 DOM 依赖。 */
export function paintR7FrontAtlas(p: R7FrontPainter, w: number, h: number): void {
  p.fill(w, h, '#0a0e12');
  const half = w / 2;
  paintHalf(p, 0, half, h);
  paintHalf(p, half, half, h);
}

/** CanvasTexture；node（无 document）返回 null ⇒ 调用方降级为无图材质。 */
export function makeR7FrontAtlasTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = R7_FRONT_ATLAS_W;
  canvas.height = R7_FRONT_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const p: R7FrontPainter = {
    fill: (w, h, color) => { ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); },
    rect: (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); },
    dot: (x, y, r, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  paintR7FrontAtlas(p, R7_FRONT_ATLAS_W, R7_FRONT_ATLAS_H);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ══════════════════════ 3. 曲面灯带几何 ══════════════════════ */

/** 单侧曲面灯带：8 段 quad，逐顶点 (x,y) → zMax + LIFT，法线朝 +Z（车头外侧）。 */
function buildSideStrip(side: 'left' | 'right'): THREE.BufferGeometry {
  const box = R7_FRONT_LAMP_BOX[side];
  const yLo = R7_FRONT_LAMP_BOX.yLo;
  const yHi = R7_FRONT_LAMP_BOX.yHi;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const N = R7_FRONT_SEGMENTS;
  const zAt = (x: number, y: number): number => r7FrontSurfaceZ(side, x, y) + R7_FRONT_LIFT;
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const x = box.x0 + (box.x1 - box.x0) * t;
    const zHi = zAt(x, yHi);
    const zLo = zAt(x, yLo);
    // 每列 2 点：上 / 下
    pos.push(x, yHi, zHi, x, yLo, zLo);
    nor.push(0, 0, 1, 0, 0, 1);
    uv.push(t, 1, t, 0);
  }
  for (let i = 0; i < N; i += 1) {
    const a = i * 2;
    const b = a + 2;
    // 车头 +Z 朝外：绕序 (a上, a下, b上) / (b上, a下, b下)
    // 叉积 z 分量 = +dx·dy > 0（FrontSide 可见）；若写成 (a,b,a+1) 会翻成 −Z 被剔除。
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* ══════════════════════ 4. 对外装配 ══════════════════════ */

export interface R7FrontLampResult {
  /** 恒 1 mesh（左右灯带合并） */
  meshes: THREE.Mesh[];
  mats: THREE.Material[];
  geos: THREE.BufferGeometry[];
  tex: THREE.Texture[];
  budget: { dc: number; tri: number; mat: number; tex: number };
}

/** 构建外部壳 on 态前灯细节（自带 UV 的程序化贴图 + 曲面贴合 + r44External）。 */
export function r68BuildR7FrontLamp(): R7FrontLampResult {
  const tex = makeR7FrontAtlasTexture();
  const left = buildSideStrip('left');
  const right = buildSideStrip('right');
  // 左灯 → atlas 左半幅；右灯 → 右半幅（按 mesh 自身 UV bbox 归一，禁线性 remap）
  remapUVToRegion(left, 0, 0.5, 0, 1);
  remapUVToRegion(right, 0.5, 1, 0, 1);
  const geo = mergeSafe([left, right]);
  left.dispose();
  right.dispose();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex ?? undefined,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: tex ?? undefined,
    emissiveIntensity: 0.85,
    roughness: 0.35,
    metalness: 0.08,
    side: THREE.FrontSide
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'r68_r7_front_lamp';
  // R57/R59 铁律：lampMesh 的 child 必须自己带 r44External，否则 setExteriorHidden 连藏
  (mesh.userData as { r44External?: boolean }).r44External = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.renderOrder = 4; // 绘在 lamp 面（renderOrder=2）与 R53 细节（3）之上

  return {
    meshes: [mesh],
    mats: [mat],
    geos: [geo],
    tex: tex ? [tex] : [],
    budget: {
      dc: 1,
      tri: geo.getAttribute('position').count / 3,
      mat: 1,
      tex: tex ? 1 : 0
    }
  };
}
