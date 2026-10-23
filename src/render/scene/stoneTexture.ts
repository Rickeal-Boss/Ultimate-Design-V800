/**
 * 程序化石材贴图（零外部图片 / 零外部模型：全部 Canvas 现场画，色值取自参考包
 * 「Fab · White Castle（哥特白石教堂）」的逐像素吸色结果）。
 *
 * ── 口径：一张贴图代表多少米 ─────────────────────────────────────────────
 * 本项目环境件是几百米尺度，贴图像素尺寸不是有效口径，**「1 张贴图 = 多少米」才是**。
 * 换算：repeat = 目标边长(m) / STONE_TILE_METERS[kind]（也可直接调 stoneRepeat）。
 * 例：ashlar 的 1 张贴图 = 2.8m×2.8m（8 皮 × 4 块的开间），贴到 61m 长的教堂立面就传 [21.8, 1]。
 *
 * ⚠ 用法陷阱（R26h，dev-2 在桥面踩到并写回给我）：three 的
 *   `effective roughness = material.roughness × roughnessMap.g`。
 *   本模块的 roughnessMap 已经写了**绝对粗糙度**（floor 石面 ≈0.44，ashlar ≈0.80），
 *   所以使用方必须把 `material.roughness` 留在 **1.0**。写成 0.62 时实际是 0.44×0.62=0.27，
 *   400m 长的桥面会被菲涅耳镜成「刚下过雨的湿沥青」（一条镜面高光贯到底）——这是乘法语义，
 *   不是本贴图偏亮。要么留 1.0，要么自己按乘法换算目标值（0.62 → 传 0.62/0.44≈1.4 无效，>1 会被钳制，
 *   正确做法是降低贴图值或干脆不用这张图）。
 *
 * ── 三条硬约束（生成器验收线）──────────────────────────────────────────
 * 1) 同源高度场：albedo 的灰缝阴影、normalMap 的凹槽、roughnessMap 的缝/面分布全部由
 *    **同一份 h(x,y)** 派生（颜色阴影用 h、法线用 h 的中心差分、粗糙度用 h 的平滑区间）。
 *    因此三者严格对齐，不存在「法线凹槽在 A 处、颜色阴影在 B 处」的错位。
 * 2) 可平铺：块排布用整除网格（行列数整除贴图边长）+ 每皮整数错缝；噪声在**格点索引**
 *    上取模环绕（不是靠镜像/遮罩修补接缝）。逐像素白噪（颗粒/闪光）本身无结构，
 *    接缝不可见，故无需特殊处理。
 * 3) 色彩空间：albedo = SRGBColorSpace；normal/roughness 是**数据**贴图 = NoColorSpace
 *    （若被当颜色做 sRGB 解码，法线 y 分量会整体偏亮 → 光照方向错）。
 *
 * 随机数一律走 makeLcg（可复现）；canvasTex 的 paintNoise 内部用 Math.random，
 * 不可复现，所以这里没用它，改为 LCG 驱动的块级/污渍参数表 + 整数哈希白噪。
 */
import * as THREE from 'three';
import { makeCanvas } from '../../util/canvasTex';
import { makeLcg } from '../../util/math';

export type StoneKind = 'ashlar' | 'wall' | 'floor' | 'rock' | 'gold';

export interface StoneMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export interface StoneOptions {
  /** 贴图边长（2 的幂，默认 512） */
  size?: number;
  /** UV 重复次数（默认 [1,1]）；应按 STONE_TILE_METERS 换算后传入 */
  repeat?: [number, number];
  seed?: number;
  /** 0..1 风化：污渍 + 块间色差（默认 0.35） */
  weather?: number;
}

/**
 * 色族四档色。硬数据来自参考图吸色（主色簇占比见 R26 分析报告）：
 * - ashlar：暖白 ashlar（#e8e1dd 26% / #d6d0cd 23.4% / #c3b9b1 18.9% / 高光 #f9f6f4），
 *   中位 #e3d7d6，亮度 p05..p95 只有 179→247（对比极低，灰缝只能比块面暗一点点）；
 * - wall：次级灰白（#aca8a5 / #8f8c89 / #b7b4b1 / #cfcdca），中位 #c0bdba；
 * - floor：近黑炭灰石板（#43403f / #474442 / #3c3b3a / #4e4b49），中位 #454342，几乎无饱和；
 * - rock：暖褐（#6a5f53 / #72685c / #51422f / #83796e），中位 #655b4c；
 * - gold：做旧黄铜（#d0b886 / #927a47 / #b1965f / 漂白高光 #ece3d5 / 暗金 #39301f），
 *   中位 #a7843c —— 是「暗金」不是饱和金黄，暗部很暗（亮度下探到 10）。
 */
export const STONE_HEX: Record<StoneKind, { base: string; light: string; dark: string; mortar: string }> = {
  ashlar: { base: '#e3d7d6', light: '#f9f6f4', dark: '#c3b9b1', mortar: '#cbc2bd' },
  wall: { base: '#c0bdba', light: '#cfcdca', dark: '#8f8c89', mortar: '#a6a29f' },
  floor: { base: '#454342', light: '#4e4b49', dark: '#3c3b3a', mortar: '#333230' },
  rock: { base: '#655b4c', light: '#83796e', dark: '#51422f', mortar: '#3e3428' },
  gold: { base: '#a7843c', light: '#deceb0', dark: '#927a47', mortar: '#39301f' }
};

/**
 * 1 张贴图代表的真实边长（米）。改这里之前先看贴图规格：
 * - **ashlar 2.8m（R26b：6.1 → 2.8）**：8 皮（每皮 0.35m 高）× 4 块（每块 0.70m 长）错缝砌石。
 *   收到 2.8m 的理由：6.1m 时一个开间只铺 1 格，2m 距离上看只剩一层灰白渐变、看不出砌缝
 *   （R26b `arcade.png` 实证）；2.8m 让同一视距下横缝密度翻倍，块与缝都能读出来。
 *   物理口径：0.35m 皮高 / 0.70m 块长 = 真实白石 ashlar 的常见规格。
 * - wall 7.2m：5 皮 × 3 块的次级大块灰白墙（皮高 1.44m，比主体更粗犷）；
 * - floor 4.8m：4×4 块 1.2m 方板（教堂石板地面）；
 * - rock 3.6m：4×4 乱石坡面（每块约 0.9m）；
 * - gold 1.2m：鎏金饰带的细腻刷纹（近看用，铺到 6m 就能看出重复）。
 */
export const STONE_TILE_METERS: Record<StoneKind, number> = {
  ashlar: 2.8,
  wall: 7.2,
  floor: 4.8,
  rock: 3.6,
  gold: 1.2
};

/** 按目标边长（米）换算 repeat，省得调用方各自算错 */
export function stoneRepeat(kind: StoneKind, metersX: number, metersY = metersX): [number, number] {
  const tile = STONE_TILE_METERS[kind];
  return [metersX / tile, metersY / tile];
}

const DEFAULT_SEED: Record<StoneKind, number> = {
  ashlar: 20261014,
  wall: 731024,
  floor: 550721,
  rock: 913377,
  gold: 462109
};

/** 砌石类（ashlar / wall / floor）的参数表——三种只差数值，共用同一条生成管线 */
interface MasonryProfile {
  rows: number;
  cols: number;
  /** 奇数皮错缝比例：0.5 = 顺砌（running bond），0 = 通缝对齐（方板） */
  stagger: number;
  /** 灰缝芯宽（px）：芯内高度恒定最低 */
  jointPx: number;
  /** 缝口倒角宽（px）：决定法线凹槽与颜色过渡的宽度 */
  bevelPx: number;
  /** 缝底相对块面的亮度比：白石灰缝只暗一点点，炭灰石板缝才暗得多 */
  mortarShade: number;
  /** 块间色差幅度（0..1，乘在 0.5 中值上） */
  blockTint: number;
  faceRough: number;
  jointRough: number;
  normalStrength: number;
  /** 石面微起伏幅度（相对 0..1 高度场） */
  relief: number;
  /** 逐像素颗粒（白石晶体感） */
  grain: number;
  /** 污渍幅度 */
  stain: number;
  /** 低频脏污幅度（横向拉长的雨水痕/积灰，尺度约 2 块宽 × 2~4 皮高） */
  grime: number;
  /** 行走磨光幅度（仅 floor） */
  wear: number;
}

const MASONRY: Record<'ashlar' | 'wall' | 'floor', MasonryProfile> = {
  // 主体白石：8 皮/图（0.35m 皮高）× 4 块/皮（0.70m 块长），半块错缝。
  // R26b 三处强化（原值 → 新值，全部针对「奶白平、没有砌缝」）：
  //  ① 缝深：h 底 0.30 → 0.10（h∈[0,1] 对应面板面高差 ≈9mm，即缝深 ~8mm 等效），
  //     倒角 3.0px → 2.6px、缝芯 1.6px → 1.8px ⇒ 缝在 5.47mm/px 下是 9.8mm 芯 + 14mm 坡，
  //     掠光下能投出明确的阴线（旧值只有在贴图正对光时才勉强可见）。
  //  ② 法线强度 0.55 → 0.90：mip 压平远景后，形体全靠法线，0.55 在 400m 外等于没有。
  //  ③ 块间色差 0.055 → 0.12：贴图统计对比低（p05..p95 只有 68 级灰度）≠ 渲染时能读，
  //     渲染是 albedo × 光照，块差必须刻意做出 3~5 级可见差，否则远看是一整块白。
  ashlar: {
    rows: 8,
    cols: 4,
    stagger: 0.5,
    jointPx: 1.8,
    bevelPx: 2.6,
    mortarShade: 0.86,
    blockTint: 0.09,
    faceRough: 0.8,
    jointRough: 0.93,
    normalStrength: 0.9,
    relief: 0.13,
    grain: 0.03,
    stain: 0.45,
    grime: 0.24,
    wear: 0
  },
  // 次级灰白墙：块更大（2.4m × 1.44m）更灰，风化重、缝更粗。
  // 污渍幅度 0.34：首版 0.52 在 512² 上读成大片「水渍云」，而参考图的灰白墙是脏得均匀。
  // 缝深/法线/块差按 ashlar 同步加强一档（同一套「读得出砌体」的目标）。
  wall: {
    rows: 5,
    cols: 3,
    stagger: 0.5,
    jointPx: 2.0,
    bevelPx: 2.8,
    mortarShade: 0.82,
    blockTint: 0.1,
    faceRough: 0.86,
    jointRough: 0.94,
    normalStrength: 0.78,
    relief: 0.15,
    grain: 0.04,
    stain: 0.42,
    grime: 0.34,
    wear: 0
  },
  // 地面石板：4×4 方板（1.2m）通缝对齐，缝深（近黑），面被踩亮 —— roughness 下压到 0.44。
  // 缝底 shade 0.66：参考图地面亮度 p05..p95 只有 49→77，但缝必须比面再暗一档才读得出「石板」，
  // 首版 0.74 在深色底上几乎看不见分缝。
  floor: {
    rows: 4,
    cols: 4,
    stagger: 0,
    jointPx: 2.4,
    bevelPx: 3.2,
    mortarShade: 0.66,
    blockTint: 0.06,
    faceRough: 0.44,
    jointRough: 0.78,
    normalStrength: 0.35,
    relief: 0.035,
    grain: 0.02,
    stain: 0.26,
    grime: 0.18,
    wear: 0.14
  }
};

/** 乱石坡面 / 鎏金的缝底亮度比与闪光幅度（结构不同，单独给） */
const ROCK_SHADE = 0.42;
const GOLD_SHADE = 0.62;
const SPARKLE: Record<StoneKind, number> = {
  ashlar: 0.1,
  wall: 0.04,
  floor: 0.05,
  rock: 0.03,
  gold: 0.16
};

/** DOM 无关的像素集：node/QA shim 可直接复算（makeStoneMaps 只是把它包成 CanvasTexture） */
export interface StonePixelSet {
  size: number;
  /** RGBA，sRGB 编码的 albedo */
  albedo: Uint8ClampedArray;
  /** RGBA，切线空间法线（128,128,255 = 平坦） */
  normal: Uint8ClampedArray;
  /** RGBA，灰度粗糙度 */
  rough: Uint8ClampedArray;
  /** 生成耗时（ms），用于核 <30ms 预算 */
  elapsedMs: number;
}

// ── 小工具 ────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

/**
 * 整数哈希（替代 sin 版 hash）：百万次调用的量级下 Math.sin 会吃掉半个预算，
 * 这里全程 int32 乘法；同 (x,y,seed) 必得同值 ⇒ 可复现。
 */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface NoiseField {
  res: number;
  data: Float32Array;
}

/**
 * 可平铺 value noise：periodX/periodY **必须整除 res**（格点取模环绕 ⇒ 接缝天然对齐；
 * 除不尽时最后一格会被拉伸，接缝处出现一条亮/暗线）。本文件所有调用都取 2 的幂周期。
 */
function noiseField(res: number, periodX: number, periodY: number, seed: number): NoiseField {
  const data = new Float32Array(res * res);
  const cellX = res / periodX;
  const cellY = res / periodY;
  for (let y = 0; y < res; y += 1) {
    const fy = y / cellY;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const iy0 = ((y0 % periodY) + periodY) % periodY;
    const iy1 = (iy0 + 1) % periodY;
    for (let x = 0; x < res; x += 1) {
      const fx = x / cellX;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const ix0 = ((x0 % periodX) + periodX) % periodX;
      const ix1 = (ix0 + 1) % periodX;
      const a = hash2(ix0, iy0, seed);
      const b = hash2(ix1, iy0, seed);
      const c = hash2(ix0, iy1, seed);
      const d = hash2(ix1, iy1, seed);
      const top = a + (b - a) * sx;
      const bot = c + (d - c) * sx;
      data[y * res + x] = top + (bot - top) * sy;
    }
  }
  return { res, data };
}

/** 多倍频叠加：每层周期翻倍（都整除 res），幅度减半 */
function fbmField(res: number, basePeriodX: number, basePeriodY: number, octaves: number, seed: number): NoiseField {
  const data = new Float32Array(res * res);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o += 1) {
    const layer = noiseField(res, basePeriodX << o, basePeriodY << o, seed + o * 131);
    for (let i = 0; i < data.length; i += 1) data[i] += layer.data[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  const inv = 1 / total;
  for (let i = 0; i < data.length; i += 1) data[i] *= inv;
  return { res, data };
}

/**
 * 把噪声字段双线性放大到贴图分辨率（环绕采样）。
 * 为什么这么做：逐像素对低分辨率字段做 floor/取模/双线性，单价 ~20 次运算 × 26 万像素，
 * 光采样就 5-8ms；先整表放大成 size² 的 Float32Array，内层循环就只剩一次数组读。
 */
function expandInto(src: Float32Array, srcRes: number, dst: Float32Array, dstRes: number): void {
  if (srcRes === dstRes) {
    dst.set(src);
    return;
  }
  const k = dstRes / srcRes;
  const step = 1 / k;
  for (let y = 0; y < dstRes; y += 1) {
    const sy = y * step;
    const y0 = Math.floor(sy);
    const y1 = (y0 + 1) % srcRes;
    const ty = sy - y0;
    const row0 = y0 * srcRes;
    const row1 = y1 * srcRes;
    const dstRow = y * dstRes;
    let sx = 0;
    let x0 = 0;
    for (let x = 0; x < dstRes; x += 1) {
      const tx = sx - x0;
      const x1 = (x0 + 1) % srcRes;
      const top = src[row0 + x0] + (src[row0 + x1] - src[row0 + x0]) * tx;
      const bot = src[row1 + x0] + (src[row1 + x1] - src[row1 + x0]) * tx;
      dst[dstRow + x] = top + (bot - top) * ty;
      // 递增采样坐标，避免 26 万次除法（除法在这里比乘法贵一个数量级）
      sx += step;
      if (sx - x0 >= 1) x0 += 1;
    }
  }
}

function expandField(field: NoiseField, size: number): Float32Array {
  const out = new Float32Array(size * size);
  expandInto(field.data, field.res, out, size);
  return out;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.replace('#', ''), 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255
  };
}

function normalizeSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return 512;
  const bounded = Math.max(64, Math.min(1024, size));
  return Math.max(128, Math.min(1024, 2 ** Math.round(Math.log2(bounded))));
}

// ── 高度场 ────────────────────────────────────────────────────────────

/**
 * 砌体高度场（ashlar / wall / floor 共用）。
 * 填 height（法线/颜色阴影/粗糙度的唯一真源）、tone（albedo 在 dark→light 上的位置）、roughness。
 */
function buildMasonry(
  size: number,
  seed: number,
  weather: number,
  prof: MasonryProfile,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): void {
  const rowH = size / prof.rows;
  const colW = size / prof.cols;
  const invColW = 1 / colW;
  // 三张字段：大尺度污渍+中频风化（4→16 周期，3 倍频，低 res 省算力）+ 石面微起伏
  //   + R26b 新增「横向拉长的低频脏污」（雨水痕/积灰）。
  const stainField = expandField(fbmField(64, 4, 4, 3, seed + 11), size);
  const reliefField = expandField(noiseField(256, 16, 16, seed + 37), size);
  // 脏污：periodX=2 / periodY=8 ⇒ 格子在 2.8m 贴图上 ≈1.4m 宽 × 0.35m 高（横向 4:1 拉长），
  // 正是「4 块宽 × 1 皮高」的积灰/雨水痕条带。这是白石灰岩最关键的「不像塑料」特征：
  // 只有跨多块砌体的低频脏污才会连成一片，逐块 tint 再大也只是马赛克。
  // （首版用 periodY=4 的 0.7m 高格子 → 预览里读成「一团团水渍云」，长宽比改成 4:1 后才是脏痕。）
  const grimeField = expandField(fbmField(128, 2, 8, 2, seed + 83), size);
  const wearField = prof.wear > 0 ? expandField(noiseField(128, 2, 2, seed + 71), size) : null;
  // 颗粒白噪按 2px 粒度预生成再查表：逐像素 hash 要 26 万次、约 2.5ms，
  // 而 2px 颗粒（ashlar 口径下 2.4cm）在视觉上同样是「细颗粒」，查表只要 0.3ms。
  const grainRes = Math.max(64, size >> 1);
  const grainStep = size / grainRes;
  const grainTable = new Float32Array(grainRes * grainRes);
  for (let gy = 0; gy < grainRes; gy += 1) {
    for (let gx = 0; gx < grainRes; gx += 1) grainTable[gy * grainRes + gx] = hash2(gx, gy, seed + 7) - 0.5;
  }
  // x 方向的颗粒列号提前算成表，内层循环就只剩两次数组读
  const grainCol = new Int32Array(size);
  for (let x = 0; x < size; x += 1) grainCol[x] = Math.floor(x / grainStep);

  // 每块的色差/起伏用 LCG 预生成（块数很少），逐像素只查表 —— 比逐像素 hash 稳得多
  const random = makeLcg(seed + 5);
  const blockCount = prof.rows * prof.cols;
  const blockTint = new Float32Array(blockCount);
  const blockRelief = new Float32Array(blockCount);
  for (let i = 0; i < blockCount; i += 1) {
    blockTint[i] = (random() - 0.5) * 2 * prof.blockTint;
    blockRelief[i] = random();
  }

  const halfJoint = prof.jointPx * 0.5;
  const bevelEnd = halfJoint + prof.bevelPx;

  for (let y = 0; y < size; y += 1) {
    const row = Math.min(prof.rows - 1, Math.floor(y / rowH));
    const ly = y - row * rowH;
    const stagger = prof.stagger * (row % 2);
    const rowBase = row * prof.cols;
    const dstRow = y * size;
    const grainRow = Math.floor(y / grainStep) * grainRes;
    let fx = stagger;
    for (let x = 0; x < size; x += 1) {
      const index = dstRow + x;
      // 错缝：像素映射到「块坐标」后取整，wrap 时同一块自然回到同一 tint（平铺关键）
      const colRaw = Math.floor(fx);
      const lx = (fx - colRaw) * colW;
      const col = ((colRaw % prof.cols) + prof.cols) % prof.cols;
      const block = rowBase + col;
      const edge = Math.min(lx, colW - lx, ly, rowH - ly);
      const bevel = smoothstep(halfJoint, bevelEnd, edge);

      const stain = stainField[index];
      const reliefV = reliefField[index];
      const grain = grainTable[grainRow + grainCol[x]];
      const grime = grimeField[index];

      // 缝深：0.30 → 0.10。h∈[0,1] 对应面板面高差 ≈9mm ⇒ 缝深 ≈8mm 等效；
      // 配合更窄的倒角（2.6px）与 normalStrength 0.9，掠光下才投得出阴线。
      let h = 0.1 + 0.9 * bevel;
      h += (reliefV - 0.5) * prof.relief * (0.55 + 0.9 * blockRelief[block]) * bevel;
      h += grain * prof.grain;
      height[index] = clamp01(h);

      let t = 0.5 + blockTint[block] + (reliefV - 0.5) * 0.22 + (stain - 0.5) * prof.stain * weather;
      t -= (1 - bevel) * 0.12 * weather; // 缝口先积灰：凹处比块面脏得快
      // 低频脏污：只压亮度（不动机理），横向拉长 ⇒ 雨水痕/积灰条带
      t -= (grime - 0.42) * prof.grime * (0.55 + 0.45 * weather);
      let rough = prof.jointRough + (prof.faceRough - prof.jointRough) * smoothstep(0.42, 0.95, bevel);
      rough += (reliefV - 0.5) * 0.08 * weather;
      // 积灰处更哑（脏东西不反光），与亮度下压同源
      rough += Math.max(0, grime - 0.42) * prof.grime * 0.35;
      if (wearField) {
        // 石板被踩出的磨光带：大尺度低频，压低 roughness 才读得出「抛光」
        const wear = smoothstep(0.45, 0.9, wearField[index]);
        rough -= wear * prof.wear * bevel;
        t -= wear * 0.05;
      }
      tone[index] = clamp01(t);
      roughness[index] = clamp01(rough);
      fx += invColW;
    }
  }
}

/**
 * 乱石坡面：抖动格 + 最近/次近点（Voronoi）求缝。
 * 只在「自分格 + 3×3 邻域」里找最近两块（抖动 < 0.35 格 ⇒ 最近块必在邻域内），
 * 用平方距离比大小、只对两个赢家开方 —— 全图平方根数量降到 2/px。
 */
function buildRock(
  res: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): void {
  const cells = 4;
  const cellSize = res / cells;
  const random = makeLcg(seed + 3);
  const offsetX = new Float32Array(cells * cells);
  const offsetY = new Float32Array(cells * cells);
  const tint = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i += 1) {
    offsetX[i] = 0.16 + random() * 0.68;
    offsetY[i] = 0.16 + random() * 0.68;
    tint[i] = (random() - 0.5) * 2;
  }

  const reliefField = expandField(fbmField(res, 8, 8, 2, seed + 41), res);
  const stainField = expandField(fbmField(res >> 1, 4, 4, 2, seed + 53), res);
  const grainField = expandField(noiseField(res >> 1, 32, 32, seed + 61), res);

  const seamPx = cellSize * 0.075; // 缝宽 ≈ 6.7cm（3.6m / 4 块口径）

  for (let y = 0; y < res; y += 1) {
    const cy = Math.floor(y / cellSize);
    const dstRow = y * res;
    for (let x = 0; x < res; x += 1) {
      const index = dstRow + x;
      const cx = Math.floor(x / cellSize);
      let best = Infinity;
      let second = Infinity;
      let bestId = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const gx = cx + ox;
          const gy = cy + oy;
          const wx = ((gx % cells) + cells) % cells;
          const wy = ((gy % cells) + cells) % cells;
          const cid = wy * cells + wx;
          // 中心点要用「未取模」的格号重建，否则跨边界那一列的距离会算错
          const px = (gx + offsetX[cid]) * cellSize;
          const py = (gy + offsetY[cid]) * cellSize;
          const dx = px - x;
          const dy = py - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) {
            second = best;
            best = d2;
            bestId = cid;
          } else if (d2 < second) {
            second = d2;
          }
        }
      }
      // 到缝隙的距离 ≈ 两中心距离之差（F2−F1 近似，够用且便宜）
      const gap = Math.sqrt(second) - Math.sqrt(best);
      const bevel = smoothstep(seamPx * 0.35, seamPx, gap);
      // 块顶圆隆：离本块中心越近越高 → 读作坡面乱石而不是平板
      const dome = 1 - Math.min(1, Math.sqrt(best) / (cellSize * 0.85));
      const reliefV = reliefField[index];
      const grain = grainField[index] - 0.5;

      let h = 0.18 + 0.62 * bevel + 0.2 * dome * bevel;
      h += (reliefV - 0.5) * 0.16 * bevel;
      h += grain * 0.05;
      height[index] = clamp01(h);

      const stain = stainField[index];
      let t = 0.5 + tint[bestId] * 0.11 + (reliefV - 0.5) * 0.3 + (stain - 0.5) * 0.55 * weather;
      t -= (1 - bevel) * 0.22 * weather;
      tone[index] = clamp01(t);
      roughness[index] = clamp01(0.95 - 0.09 * bevel + (stain - 0.5) * 0.06);
    }
  }
}

/**
 * 鎏金饰带：沿 x 拉长的各向异性刷纹（periodX 小 = u 方向变化慢）+ 低频氧化斑。
 * 氧化斑同时压暗、抬粗糙度、压低高度 —— 三者同源，才不会被读成「贴上去的脏点」。
 */
function buildGold(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): void {
  // 刷纹只在 256² 上算再放大：512² 直算要多花 ~6ms，而刷纹本来就是高通细节，
  // 放大后的 2px 丝纹在 1.2m 贴图口径下等价于 4.7mm 一道，够细。
  const brush = expandField(noiseField(256, 4, 128, seed + 13), size);
  const brushFine = expandField(noiseField(256, 8, 256, seed + 29), size);
  const oxField = expandField(fbmField(128, 4, 4, 3, seed + 47), size);
  const grainField = expandField(noiseField(size >> 1, 32, 32, seed + 67), size);

  for (let y = 0; y < size; y += 1) {
    const dstRow = y * size;
    for (let x = 0; x < size; x += 1) {
      const index = dstRow + x;
      const b1 = brush[index];
      const b2 = brushFine[index];
      const ox = oxField[index];
      const grain = grainField[index] - 0.5;
      // 氧化：低频斑块取门限上段，weather 越高斑越多
      const oxidized = smoothstep(0.62 - 0.22 * weather, 0.9, ox);

      let h = 0.58 + (b1 - 0.5) * 0.12 + (b2 - 0.5) * 0.06;
      h += grain * 0.015;
      h -= oxidized * 0.16;
      height[index] = clamp01(h);

      let t = 0.5 + (b1 - 0.5) * 0.35 + (b2 - 0.5) * 0.2;
      t -= oxidized * 0.62; // 氧化斑压到暗金 #39301f 一带
      tone[index] = clamp01(t);

      // 抛光面 0.34 左右；刷纹沟槽略高；氧化斑明显发哑（+0.34）
      let rough = 0.34 + (b2 - 0.5) * 0.16 + Math.abs(b1 - 0.5) * 0.1;
      rough += oxidized * 0.34;
      roughness[index] = clamp01(rough);
    }
  }
}

// ── 高度场 → 三张贴图（单趟同时出 albedo / normal / roughness）───────────

interface MapBuild {
  size: number;
  seed: number;
  base: Rgb;
  light: Rgb;
  dark: Rgb;
  height: Float32Array;
  tone: Float32Array;
  roughness: Float32Array;
  /** 缝底相对块面的亮度比（颜色阴影的唯一参数） */
  mortarShade: number;
  sparkle: number;
  normalStrength: number;
}

/**
 * 一趟循环同时写出三张图。合并的理由不是省代码而是省两趟 26 万像素的数组往返（实测 −7ms）；
 * 更重要的是：颜色阴影、法线、粗糙度在**同一个循环里读同一份 height[i]**，
 * 从结构上就不可能错位（同源高度场验收线）。
 *
 * 法线用中心差分 (−dh/dx, −dh/dy, 1) 归一化，强度×6 与 createV800Model 同口径；
 * 差分取样一律环绕（x±1 越界回到对侧），因此平铺接缝处法线也连续。
 */
function composeMaps(build: MapBuild): { albedo: Uint8ClampedArray; normal: Uint8ClampedArray; rough: Uint8ClampedArray } {
  const { size, seed, base, light, dark, height, tone, roughness } = build;
  const count = size * size;
  const albedo = new Uint8ClampedArray(count * 4);
  const normal = new Uint8ClampedArray(count * 4);
  const rough = new Uint8ClampedArray(count * 4);
  const scale = build.normalStrength * 6;
  const shadeLo = build.mortarShade;

  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    // 环绕邻居用滚动下标（x±1 越界即回到对侧），避免逐像素 4 次取模
    let left = size - 1;
    let right = 1;
    for (let x = 0; x < size; x += 1) {
      const index = row + x;
      const offset = index * 4;
      const h = height[index];

      // —— albedo：tone 定 dark→base→light 上的位置，shade 由 h 定缝口阴影
      const t = tone[index];
      let r: number;
      let g: number;
      let b: number;
      if (t < 0.5) {
        const k = t * 2;
        r = dark.r + (base.r - dark.r) * k;
        g = dark.g + (base.g - dark.g) * k;
        b = dark.b + (base.b - dark.b) * k;
      } else {
        const k = (t - 0.5) * 2;
        r = base.r + (light.r - base.r) * k;
        g = base.g + (light.g - base.g) * k;
        b = base.b + (light.b - base.b) * k;
      }
      const shade = shadeLo + (1 - shadeLo) * smoothstep(0.26, 0.9, h);
      albedo[offset] = r * shade * 255;
      albedo[offset + 1] = g * shade * 255;
      albedo[offset + 2] = b * shade * 255;
      albedo[offset + 3] = 255;

      // —— normal：中心差分（环绕）
      const dx = (height[row + right] - height[row + left]) * scale;
      const dy = (height[down + x] - height[up + x]) * scale;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      normal[offset] = (-dx * inv * 0.5 + 0.5) * 255;
      normal[offset + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      normal[offset + 2] = (inv * 0.5 + 0.5) * 255;
      normal[offset + 3] = 255;

      // —— roughness：灰度
      const rb = clamp01(roughness[index]) * 255;
      rough[offset] = rb;
      rough[offset + 1] = rb;
      rough[offset + 2] = rb;
      rough[offset + 3] = 255;

      left = x;
      right = x + 2 === size ? 0 : x + 2;
    }
  }

  scatterSparkles(albedo, size, seed, build.sparkle);
  return { albedo, normal, rough };
}

/**
 * 稀疏亮点（白石晶体 / 金箔剥落）。
 * 为什么单独做：逐像素算一次 hash 判定要 26 万次哈希（~2.5ms），而目标密度只有 0.35%——
 * 直接按 LCG 抽 0.35% 个像素点亮，成本 ~900 次操作，视觉完全等价（都是无结构白噪）。
 */
function scatterSparkles(albedo: Uint8ClampedArray, size: number, seed: number, sparkle: number): void {
  if (sparkle <= 0) return;
  const random = makeLcg(seed + 977);
  const count = Math.round(size * size * 0.0035);
  const lift = 1 + sparkle;
  const bias = sparkle * 0.12 * 255;
  for (let i = 0; i < count; i += 1) {
    const offset = Math.floor(random() * size * size) * 4;
    albedo[offset] = Math.min(255, albedo[offset] * lift + bias);
    albedo[offset + 1] = Math.min(255, albedo[offset + 1] * lift + bias);
    albedo[offset + 2] = Math.min(255, albedo[offset + 2] * lift + bias);
  }
}

/**
 * DOM 无关的核心：算出三张图的像素。node / QA shim 可直接调用复算数值，
 * makeStoneMaps 只负责把这些像素塞进 canvas 变成 CanvasTexture。
 */
export function makeStonePixelSet(kind: StoneKind, opts: StoneOptions = {}): StonePixelSet {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const size = normalizeSize(opts.size);
  const seed = (opts.seed ?? DEFAULT_SEED[kind]) >>> 0;
  const weather = clamp01(opts.weather ?? 0.35);
  const count = size * size;

  const height = new Float32Array(count);
  const tone = new Float32Array(count);
  const roughness = new Float32Array(count);
  let normalStrength = MASONRY.ashlar.normalStrength;
  let mortarShade = MASONRY.ashlar.mortarShade;

  if (kind === 'rock') {
    // 乱石的 3×3 最近邻在 512² 上逐像素算太贵（>25ms），改为 256² 算完双线性放大：
    // 放大只软化 1~2px 的石棱，视觉上反而更像被风化磨圆的坡面石。
    const half = Math.max(128, size >> 1);
    const h2 = new Float32Array(half * half);
    const t2 = new Float32Array(half * half);
    const r2 = new Float32Array(half * half);
    buildRock(half, seed, weather, h2, t2, r2);
    expandInto(h2, half, height, size);
    expandInto(t2, half, tone, size);
    expandInto(r2, half, roughness, size);
    normalStrength = 1.0;
    mortarShade = ROCK_SHADE;
  } else if (kind === 'gold') {
    buildGold(size, seed, weather, height, tone, roughness);
    normalStrength = 0.45;
    mortarShade = GOLD_SHADE;
  } else {
    const prof = MASONRY[kind];
    buildMasonry(size, seed, weather, prof, height, tone, roughness);
    normalStrength = prof.normalStrength;
    mortarShade = prof.mortarShade;
  }

  const hex = STONE_HEX[kind];
  const maps = composeMaps({
    size,
    seed,
    base: hexToRgb(hex.base),
    light: hexToRgb(hex.light),
    dark: hexToRgb(hex.dark),
    height,
    tone,
    roughness,
    mortarShade,
    sparkle: SPARKLE[kind],
    normalStrength
  });

  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { size, albedo: maps.albedo, normal: maps.normal, rough: maps.rough, elapsedMs: ended - started };
}

// ── CanvasTexture 包装 + 缓存 ─────────────────────────────────────────

const cache = new Map<string, StoneMaps>();
let buildCount = 0;

function pixelCanvas(size: number, data: Uint8ClampedArray): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(size, size);
  const image = ctx.createImageData(size, size);
  image.data.set(data);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function toTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  repeat: [number, number]
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  // 石材必须 Repeat：环境件几百米，一张图铺一次根本看不到砌缝
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.needsUpdate = true;
  // 各向异性过滤需要 renderer.capabilities，这里不猜；调用方可自行设
  // tex.anisotropy = maxAniso（斜视墙面时砌缝不会糊成一片）
  return tex;
}

/**
 * node（无 DOM）兜底：没有 canvas 就不画，返回 1×1 哑纹理。
 * 不做 throw 是因为 QA shim / SSG 会 import 建筑模块，崩溃会连带校验跑不起来。
 */
function makeFallbackMaps(repeat: [number, number]): StoneMaps {
  const stub = { width: 1, height: 1 } as unknown as HTMLCanvasElement;
  const make = (colorSpace: THREE.ColorSpace): THREE.CanvasTexture => {
    const tex = new THREE.CanvasTexture(stub);
    tex.colorSpace = colorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
    return tex;
  };
  return {
    map: make(THREE.SRGBColorSpace),
    normalMap: make(THREE.NoColorSpace),
    roughnessMap: make(THREE.NoColorSpace)
  };
}

/**
 * 取石材三张贴图。同 kind + 同参数复用同一组纹理：教堂立面上几十个构件共用一个色族，
 * 重复生成几十次会直接吃掉首屏时间。
 */
export function makeStoneMaps(kind: StoneKind, opts: StoneOptions = {}): StoneMaps {
  const size = normalizeSize(opts.size);
  const seed = (opts.seed ?? DEFAULT_SEED[kind]) >>> 0;
  const weather = clamp01(opts.weather ?? 0.35);
  const repeat = opts.repeat ?? ([1, 1] as [number, number]);
  const key = `${kind}|${size}|${seed}|${weather.toFixed(3)}|${repeat[0]}x${repeat[1]}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (typeof document === 'undefined') {
    const fallback = makeFallbackMaps(repeat);
    cache.set(key, fallback);
    return fallback;
  }

  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pixels = makeStonePixelSet(kind, { size, seed, weather });
  const maps: StoneMaps = {
    map: toTexture(pixelCanvas(pixels.size, pixels.albedo), THREE.SRGBColorSpace, repeat),
    normalMap: toTexture(pixelCanvas(pixels.size, pixels.normal), THREE.NoColorSpace, repeat),
    roughnessMap: toTexture(pixelCanvas(pixels.size, pixels.rough), THREE.NoColorSpace, repeat)
  };
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  buildCount += 1;
  // 只在新生成时打印一次：缓存命中保持安静，否则每次取图都刷一行
  console.info(
    `[stoneTexture] ${kind} ${size}² weather=${weather.toFixed(2)} 像素 ${pixels.elapsedMs.toFixed(1)}ms / 总 ${(ended - started).toFixed(1)}ms（第 ${buildCount} 套）`
  );
  cache.set(key, maps);
  return maps;
}

/** 全清缓存（换场景/关卡时调用），三张纹理各自 dispose */
export function disposeStoneCache(): void {
  for (const maps of cache.values()) {
    maps.map.dispose();
    maps.normalMap.dispose();
    maps.roughnessMap.dispose();
  }
  cache.clear();
}
