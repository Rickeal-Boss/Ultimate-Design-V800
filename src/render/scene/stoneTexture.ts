/**
 * 程序化石材/建材贴图（零外部图片 / 零外部模型：全部现场算像素，色值取自参考包
 * 「Fab · White Castle（哥特白石教堂）」的**统计量**）。
 *
 * ── 法律红线（R29 复核）─────────────────────────────────────────────────
 * 参考包 45 张 PBR png 只被 `tools/r29_tex_stats.py` 读过一次，产出的是标量统计量
 * （`.qa/r29_tex_stats.json`）。本文件**不含任何参考包字节、图块或派生图**；
 * 运行时不读任何外部文件。调参依据全部标注在 `R29_REF` 里（可逐条回查 JSON）。
 *
 * ── 口径：一张贴图代表多少米 ─────────────────────────────────────────────
 * 本项目环境件是几百米尺度，贴图像素尺寸不是有效口径，**「1 张贴图 = 多少米」才是**。
 * 换算：repeat = 目标边长(m) / STONE_TILE_METERS[kind]（也可直接调 stoneRepeat）。
 *
 * ⚠ 用法陷阱（R26h / 铁律 34）：three 的
 *   `effective roughness = material.roughness × roughnessMap.g`。
 *   本模块的 roughnessMap 写的是**绝对粗糙度**，所以使用方必须按 1/g 反算
 *   `material.roughness`（`StoneStats.roughMean` 就是给你反算用的）。
 *
 * ── R30 架构：单一「带状烘焙引擎」（B 线 / 启动热升级 N1）─────────────────
 * 所有族共用同一条 `createStoneBake()` 管线，把生成拆成四个**可按行带分片**的阶段：
 *   build(expand) → compose → finish。同步的 `makeStonePixelSet()` 只是「一个行带跑完」
 *   的特例；`bakeStoneMapsAsync()` 用同一引擎按行带 + requestIdleCallback/setTimeout
 *   让出主线程，实现「256² 同步上架 → 目标尺寸 idle 重烘 → 热替换」（见 castle.ts）。
 *   ⇒ 同步与异步走**同一套 per-pixel 公式**，异步产物与同步产物逐字节一致（shim 可证）。
 *
 * ── R29 四条硬约束（生成器验收线，较 R26 收紧）─────────────────────────
 * 1) 同源高度场：albedo 的灰缝阴影、normalMap 的凹槽、roughnessMap 的缝/面分布全部由
 *    **同一份 h(x,y)** 派生；三者严格对齐，不可能错位。
 * 2) 可平铺：块排布用整除网格 + 每皮整数错缝；噪声在**格点索引**上取模环绕。
 * 3) 色彩空间：albedo = SRGBColorSpace；normal/roughness 是**数据**贴图 = NoColorSpace。
 * 4) **多尺度**：每个族 = 基色多倍频 fbm（≥4 octave）+ 结构层 + 风化层 + 高频颗粒层。
 *
 * 随机数一律走 makeLcg / hash2（可复现）；本文件**没有 Math.random**。
 */
import * as THREE from 'three';
import { makeCanvas } from '../../util/canvasTex';
import { makeLcg } from '../../util/math';
import type { QualityTier } from '../../config/quality';

export type StoneKind =
  | 'ashlar'
  | 'wall'
  | 'floor'
  | 'rock'
  | 'gold'
  | 'roof'
  | 'wood'
  | 'glass'
  | 'marble';

export interface StoneMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  /** 生成实测统计（给使用方反算 material.roughness / 自检用） */
  stats: StoneStats;
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
 * 色族四档色。硬数据来自参考包吸色（见 `.qa/r29_tex_stats.json`）：
 * - ashlar：暖白（Heaven_Castle_*_diff 族实测 L mean 198.7 / std 49.3 / 对比 124，
 *   R−B +53.6 ⇒ 明显暖偏）。游戏内受光后对比会塌到 ~68 级（R27 实测），
 *   所以**贴图基色对比按 124 取、渲染观感按 68 校准**，别做成脏兮兮的高对比砖墙；
 * - wall：次级灰白（Wallwhite 实测 L 175.7 / std 24.4 / 对比 79.9，R−B +6.1 近中性）；
 * - floor：近黑炭灰石板（StoneFloor_albedo 实测中位 **#413f3d** / L 63.7 / std 9.4 /
 *   对比 31.9 / R−B +3.9）—— 与 R27_PALETTE.roadDark 完全一致，是硬数据交点；
 * - rock：暖褐（实测 L 100.8 / std 32.9 / 对比 106，R−B +32.6）；
 * - gold：做旧黄铜（Details_albedo 实测 R−B +118 / 饱和 118 / metalness 0.789）；
 * - roof/wood/glass/marble：R29 新增，参考包无同名贴图，按同类建材 + 上述统计的
 *   「对比/颗粒/法线强度」量级外推（细节量级见 R29_REF）。
 */
export const STONE_HEX: Record<StoneKind, { base: string; light: string; dark: string; mortar: string }> = {
  ashlar: { base: '#e3d7d6', light: '#f9f6f4', dark: '#bcaea4', mortar: '#cbc2bd' },
  wall: { base: '#c0bdba', light: '#dbd8d5', dark: '#8b8683', mortar: '#a6a29f' },
  floor: { base: '#413f3d', light: '#605d59', dark: '#2c2a29', mortar: '#262524' },
  rock: { base: '#655b4c', light: '#83796e', dark: '#51422f', mortar: '#3e3428' },
  gold: { base: '#c9a227', light: '#f0d45c', dark: '#7d6222', mortar: '#39301f' },
  // 屋面板岩（冷灰，与白石立面拉开冷暖对比）
  roof: { base: '#565a5e', light: '#767b80', dark: '#33363a', mortar: '#26282b' },
  // 城门木（旧橡木，暖褐）
  wood: { base: '#4a3527', light: '#6d5138', dark: '#2b1f15', mortar: '#1c1410' },
  // 窗玻璃（冷调铅条窗，低粗糙度靠环境反射出「玻璃感」，不走 transmission —— R12 铁律⑤）
  glass: { base: '#9db9c2', light: '#d9e8ec', dark: '#5f7c86', mortar: '#39464c' },
  // 柱身/台基大理石（暖白 + 灰脉）
  marble: { base: '#ded9d4', light: '#f4f1ec', dark: '#a8a29a', mortar: '#7d766d' }
};

/**
 * 1 张贴图代表的真实边长（米）。改这里之前先看贴图规格：
 * - **ashlar 6.4m**：8 皮 × 3 块的开间（皮高 0.8m、块长 2.13m，大板块弱缝）；
 * - wall 7.2m：5 皮 × 3 块的次级大块灰白墙（皮高 1.44m）；
 * - floor 3.6m：**乱石板 crazy-paving**（3×3 抖动格 Voronoi，~2.4m 不规则板块；castleKit
 *   paveTile = 本值×2 = 7.2m/张，据 r29_vision §2-D，非旧规则方板）；
 * - rock 3.6m：4×4 乱石坡面；
 * - gold 1.2m：鎏金饰带的细腻刷纹；
 * - roof 2.4m：12 皮 × 8 片板岩瓦；
 * - wood 2.0m：4 块竖向木板；
 * - glass 1.6m：3 行 × 2 列铅条窗格；
 * - marble 3.2m：抛光石材的脉络尺度（无块缝）。
 */
export const STONE_TILE_METERS: Record<StoneKind, number> = {
  ashlar: 6.4,
  wall: 7.2,
  floor: 3.6,
  rock: 3.6,
  gold: 1.2,
  roof: 2.4,
  wood: 2.0,
  glass: 1.6,
  marble: 3.2
};

/** 按目标边长（米）换算 repeat，省得调用方各自算错 */
export function stoneRepeat(kind: StoneKind, metersX: number, metersY = metersX): [number, number] {
  const tile = STONE_TILE_METERS[kind];
  return [metersX / tile, metersY / tile];
}

/**
 * R29 参考统计量锚点（`.qa/r29_tex_stats.json` 的实测值，逐条可回查）。
 * 只存**标量**，不含任何图像数据。改参数前先看这里 —— 这是「细到什么程度」的判据。
 */
export const R29_REF = {
  ashlar: { lumMean: 198.7, lumStd: 49.3, contrast: 124.3, warmRB: 53.6, grain: 146.5, nxy: 0.186, tilt: 11.3, lowfreq: 0.724 },
  wall: { lumMean: 175.7, lumStd: 24.4, contrast: 79.9, warmRB: 6.1, grain: 142.0, nxy: 0.112, tilt: 6.7, lowfreq: 0.605 },
  floor: { lumMean: 63.7, lumStd: 9.4, contrast: 31.9, warmRB: 3.9, grain: 210.0, nxy: 0.192, tilt: 11.4, lowfreq: 0.507 },
  gold: { lumMean: 112.4, lumStd: 46.1, contrast: 143.3, warmRB: 118.3, grain: 143.0, nxy: 0.159, tilt: 9.8, lowfreq: 0.872 },
  rock: { lumMean: 100.8, lumStd: 32.9, contrast: 106.1, warmRB: 32.6, grain: 193.0, nxy: 0.352, tilt: 23.6, lowfreq: 0.468 }
} as const;

const DEFAULT_SEED: Record<StoneKind, number> = {
  ashlar: 20261014,
  wall: 731024,
  floor: 550721,
  rock: 913377,
  gold: 462109,
  roof: 314159,
  wood: 271828,
  glass: 161803,
  marble: 141421
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
  /** 低频脏污幅度（横向拉长的雨水痕/积灰） */
  grime: number;
  /** 行走磨光幅度（仅 floor） */
  wear: number;
  /* ── R29 多尺度新增 ── */
  /** 基色多倍频噪声幅度（4 octave fbm，尺度 4→32 周期） */
  toneNoise: number;
  /** 同一份 fbm 叠进高度场的比例（让法线在多个尺度上都有内容） */
  reliefNoise: number;
  /** 竖向水痕幅度（沿墙面/柱身流下的雨痕） */
  streak: number;
  /** 苔痕/生物附着（低频斑块，走 tint 通道偏绿） */
  moss: number;
  /** 边角磨光幅度（棱边被雨水/人手磨亮、磨圆） */
  edgeWear: number;
  /** 缝口不齐（缝宽沿缝长方向的抖动幅度） */
  ragged: number;
  /** 缺棱掉角（逐块的缝宽缩放） */
  chip: number;
  /** 车辙磨损带（仅 floor） */
  rut: number;
  /* ── R30 极致细化新增层 ── */
  /**
   * 中频凿点（精切石 identity）：参考图双重析「精切石肌理」= 大板块 + 中频凿点 + 高频颗粒。
   * R29 只有 relief(单频 period16 砍凿面) + baseFbm，缺一层**各向异性凿点**。
   * 走高度场（法线真源）+ 轻微抬粗糙度；chiselPeriodX/Y 定凿点方向与密度。
   */
  chisel: number;
  chiselPeriodX: number;
  chiselPeriodY: number;
  /** 低频色斑（floor 石板天然色差 + 水渍矿斑）：叠加进 tone，不动基色 #413f3d */
  patch: number;
}

const MASONRY: Record<'ashlar' | 'wall', MasonryProfile> = {
  ashlar: {
    rows: 8,
    cols: 3,
    stagger: 0.5,
    jointPx: 1.8,
    bevelPx: 2.6,
    mortarShade: 0.82,
    blockTint: 0.16,
    faceRough: 0.8,
    jointRough: 0.93,
    normalStrength: 0.82,
    relief: 0.16,
    grain: 0.05,
    stain: 0.5,
    grime: 0.3,
    wear: 0,
    toneNoise: 0.62,
    reliefNoise: 0.55,
    streak: 0.16,
    moss: 0.1,
    edgeWear: 0.16,
    ragged: 0.3,
    chip: 0.28,
    rut: 0,
    // R30：中频凿点（水平凿道，8×32 各向异性 ⇒ 顺课程方向的精切石肌理）
    chisel: 0.05,
    chiselPeriodX: 8,
    chiselPeriodY: 32,
    patch: 0
  },
  wall: {
    rows: 5,
    cols: 3,
    stagger: 0.5,
    jointPx: 2.0,
    bevelPx: 2.8,
    mortarShade: 0.78,
    blockTint: 0.17,
    faceRough: 0.86,
    jointRough: 0.94,
    normalStrength: 0.52,
    relief: 0.17,
    grain: 0.06,
    stain: 0.46,
    grime: 0.36,
    wear: 0,
    toneNoise: 0.58,
    reliefNoise: 0.5,
    streak: 0.22,
    moss: 0.14,
    edgeWear: 0.13,
    ragged: 0.34,
    chip: 0.32,
    rut: 0,
    // R30：次级墙凿点更重（8×16，凿道更粗）
    chisel: 0.06,
    chiselPeriodX: 8,
    chiselPeriodY: 16,
    patch: 0
  }
};

/**
 * R30 路面**乱石板（crazy-paving）**参数表。据 `.qa/r29_vision.md` §2-D（置信度 H）：
 * 用户所说 StoneFloor 目标 = 不规则多边形石板、块间色差大、深色缝 ≈#222、2m 级板块、
 * 带法线凹凸、干面 —— 而非旧规则方板网格。形制由 prepFloor（抖动格 Voronoi）生成。
 * 基色仍锁 #413f3d（R29 吸色硬数据），块间色差在 #3A3A3A–#606060 一档游走。
 */
const CRAZY_PAVE = {
  /** 抖动格边数（cells×cells 个 Voronoi 心）；3×3 @ 7.2m/张 ⇒ ~2.4m 不规则板块 */
  cells: 3,
  /** 块间色差幅度（大！crazy-paving 的 identity）：tone ±0.30 ⇒ #3A3A3A↔#606060 */
  blockTint: 0.3,
  /** 低频色斑（板内天然色差/水渍矿斑） */
  patch: 0.12,
  grime: 0.22,
  /** 石面细凿点 + 颗粒 */
  chisel: 0.045,
  grain: 0.075,
  /** 磨光：块心被人/车磨亮（板间磨损变化） */
  wear: 0.24,
  /** 缝芯压暗目标（blend 到接近 dark，配 compose shade 出 #222 深缝） */
  seamTone: 0.06,
  faceRough: 0.44,
  jointRough: 0.84,
  normalStrength: 1.15,
  /** 缝底亮度比（compose shadeLo）⇒ 与 seamTone 共同定 #222 */
  mortarShade: 0.72
};

/** 屋面板岩 / 木板 / 铅条玻璃 / 大理石：结构不同，各自单独的参数表 */
const SHINGLE = {
  rows: 12,
  cols: 8,
  stagger: 0.5,
  jointPx: 1.6,
  bevelPx: 2.2,
  normalStrength: 1.15,
  relief: 0.1,
  grain: 0.05,
  stain: 0.4,
  moss: 0.22,
  streak: 0.24,
  ragged: 0.26,
  faceRough: 0.62,
  jointRough: 0.84
};

const PLANK = {
  cols: 4,
  jointPx: 3.0,
  bevelPx: 3.4,
  normalStrength: 0.55,
  /** 木纹：沿板长方向的细密纹理（x 高频 / y 低频 ⇒ 竖纹） */
  grainPeriodX: 96,
  grainPeriodY: 5,
  // R30：0.11 → 0.13（各向异性木纹更深，顺纹明暗对比更强）
  grainAmp: 0.13,
  knot: 0.35,
  relief: 0.06,
  grain: 0.08,
  stain: 0.4,
  streak: 0.3,
  faceRough: 0.72,
  jointRough: 0.88
};

const PANE = {
  rows: 3,
  cols: 2,
  jointPx: 3.4,
  bevelPx: 2.0,
  normalStrength: 0.35,
  relief: 0.03,
  waviness: 0.02,
  faceRough: 0.07,
  jointRough: 0.55
};

const VEIN = {
  normalStrength: 0.5,
  relief: 0.03,
  /** 脉络：x 低频 / y 高频 ⇒ 竖直拉长的脉 */
  periodX: 3,
  periodY: 12,
  octaves: 5,
  veinSharp: 0.62,
  faceRough: 0.18,
  veinRough: 0.3,
  grain: 0.022
};

/** 乱石坡面 / 鎏金的缝底亮度比 */
const ROCK_SHADE = 0.42;
const GOLD_SHADE = 0.62;
const SPARKLE: Record<StoneKind, number> = {
  ashlar: 0.12,
  wall: 0.05,
  floor: 0.06,
  rock: 0.03,
  gold: 0.16,
  roof: 0.08,
  wood: 0.02,
  glass: 0.2,
  marble: 0.06
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
  /** 生成耗时（ms） */
  elapsedMs: number;
  /** 输出实测统计（与 R29_REF 同口径，用于自证「细节确实变细了」） */
  stats: StoneStats;
}

/** 输出实测统计（口径与 tools/r29_tex_stats.py 对齐） */
export interface StoneStats {
  /** albedo 亮度均值（0..255，sRGB 码值口径） */
  lumMean: number;
  /** albedo 亮度标准差 */
  lumStd: number;
  /** albedo 亮度 p05 / p50 / p95（256 桶直方图近似） */
  lumP05: number;
  lumP50: number;
  lumP95: number;
  /** p95 − p05：对比度 */
  contrast: number;
  /** 3×3 高通残差 std：颗粒能量（越高 = 细节越细） */
  grain: number;
  /** 法线 |n.xy| 均值（抽样 1/16 像素） */
  normalMag: number;
  /** 等效倾角（deg） */
  normalTiltDeg: number;
  /** roughnessMap 均值 —— **material.roughness 必须按 1/g 反算**（铁律 34） */
  roughMean: number;
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
 * 可平铺 value noise：periodX/periodY **必须整除 res**（格点取模环绕 ⇒ 接缝天然对齐）。
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
 * 把噪声字段双线性放大到贴图分辨率（环绕采样），**可按行带 [y0,y1) 分片**。
 * R30：原 expandInto 的行循环版 —— 让「展开到 size²」也能按行带切片（热升级分片用）。
 * 为什么预展开：逐像素对低分辨率字段做双线性，内层循环单价高；先整表放大成 size²，
 * 内层循环就只剩一次数组读。srcRes===dstRes 时逐行拷贝（等价原 dst.set）。
 */
function expandIntoRows(src: Float32Array, srcRes: number, dst: Float32Array, dstRes: number, y0: number, y1: number): void {
  if (srcRes === dstRes) {
    for (let y = y0; y < y1; y += 1) {
      const off = y * srcRes;
      for (let x = 0; x < srcRes; x += 1) dst[off + x] = src[off + x];
    }
    return;
  }
  const k = dstRes / srcRes;
  const step = 1 / k;
  for (let y = y0; y < y1; y += 1) {
    const sy = y * step;
    const yy0 = Math.floor(sy);
    const yy1 = (yy0 + 1) % srcRes;
    const ty = sy - yy0;
    const row0 = yy0 * srcRes;
    const row1 = yy1 * srcRes;
    const dstRow = y * dstRes;
    let sx = 0;
    let x0 = 0;
    for (let x = 0; x < dstRes; x += 1) {
      const tx = sx - x0;
      const x1 = (x0 + 1) % srcRes;
      const top = src[row0 + x0] + (src[row0 + x1] - src[row0 + x0]) * tx;
      const bot = src[row1 + x0] + (src[row1 + x1] - src[row1 + x0]) * tx;
      dst[dstRow + x] = top + (bot - top) * ty;
      sx += step;
      if (sx - x0 >= 1) x0 += 1;
    }
  }
}

/** 空字段（振幅为 0 的层用它占位） */
const EMPTY: Float32Array = new Float32Array(0);

/**
 * R30 带状字段：持有小分辨率源噪声 + 目标分辨率（size 或 half）的展开缓冲。
 * `fill(y0,y1)` 只展开行带 [y0,y1) —— 每个字段行恰好被展开一次、只在所属行带被读取，
 * 因此分片与一次性全展开**数值完全一致**（shim 逐字节可证）。
 */
interface BandField {
  nf: NoiseField;
  res: number;
  out: Float32Array;
}

/** amp≤0 返回 null（对应旧 optField 的 EMPTY 分支）；否则建 BandField。 */
function makeField(amp: number, build: () => NoiseField, res: number): BandField | null {
  if (amp <= 0) return null;
  return { nf: build(), res, out: new Float32Array(res * res) };
}

function fillField(f: BandField | null, y0: number, y1: number): void {
  if (f) expandIntoRows(f.nf.data, f.nf.res, f.out, f.res, y0, y1);
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

/**
 * 质量档 → 贴图边长。high 只对「主角面」（ashlar 立面 / floor 地面）给 1024，
 * 其余族 512 —— 石材是**重复平铺**的，512² 已有 183 px/m，1024 对远景是纯浪费。
 */
export function stoneTextureSize(kind: StoneKind, tier: QualityTier): number {
  const hero = kind === 'ashlar' || kind === 'floor';
  if (tier === 'high') return hero ? 1024 : 512;
  if (tier === 'medium') return hero ? 512 : 256;
  return 256;
}

// ── 带状烘焙引擎 ──────────────────────────────────────────────────────

/**
 * 一次烘焙的全部状态 + 四个可分片阶段。同步/异步共用：
 *   build   写 height/tone/roughness(/moss) —— 行数 = buildRows
 *   expand  （仅 rock）half→full 放大        —— 行数 = expandRows（0 = 跳过）
 *   compose 写 albedo/normal/rough           —— 行数 = size
 *   finish  scatterSparkles + measureStats（一次性，~3-5ms）
 */
export interface StoneBake {
  readonly size: number;
  readonly buildRows: number;
  readonly expandRows: number;
  readonly albedo: Uint8ClampedArray;
  readonly normal: Uint8ClampedArray;
  readonly rough: Uint8ClampedArray;
  /** 每像素色相微调信号（−1..1，仅 glass 薄膜虹彩用；其余族 null）⇒ compose 做暖冷微移 */
  readonly tint: Float32Array | null;
  build(y0: number, y1: number): void;
  expand(y0: number, y1: number): void;
  compose(y0: number, y1: number): void;
  finish(): StoneStats;
}

// ── 各族的 prep + buildBand（per-pixel 公式与 R29 逐字一致）───────────

/** 砌体高度场（ashlar / wall / floor 共用）的 prep：建字段 + 逐块表 + 行带构建器 */
function prepMasonry(
  size: number,
  seed: number,
  weather: number,
  prof: MasonryProfile,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array,
  mossOut: Float32Array | null
): { build: (y0: number, y1: number) => void } {
  const rowH = size / prof.rows;
  const colW = size / prof.cols;
  const invColW = 1 / colW;
  const fres = Math.max(64, Math.min(256, size >> 1));

  const baseFbmF = makeField(Math.max(prof.toneNoise, prof.reliefNoise), () => fbmField(fres, 4, 4, 4, seed + 101), size);
  const stainF = makeField(prof.stain, () => fbmField(64, 4, 4, 3, seed + 11), size);
  const reliefF = makeField(prof.relief, () => noiseField(Math.min(256, size), 16, 16, seed + 37), size);
  const grimeF = makeField(prof.grime, () => fbmField(128, 2, 8, 2, seed + 83), size);
  const streakF = makeField(prof.streak, () => fbmField(128, 12, 3, 2, seed + 139), size);
  const mossF = makeField(prof.moss, () => fbmField(64, 3, 3, 2, seed + 157), size);
  const ragF = makeField(prof.ragged, () => noiseField(128, prof.cols * 4, prof.rows * 4, seed + 181), size);
  const wearF = makeField(prof.wear, () => noiseField(128, 2, 2, seed + 71), size);
  const rutF = makeField(prof.rut, () => noiseField(128, 3, 2, seed + 211), size);
  // R30 凿点（各向异性中频）+ 色斑（floor 低频天然色差）
  const chiselF = makeField(prof.chisel, () => noiseField(Math.min(256, size), prof.chiselPeriodX, prof.chiselPeriodY, seed + 227), size);
  const patchF = makeField(prof.patch, () => fbmField(96, 3, 3, 3, seed + 233), size);

  // 颗粒白噪按 2px 粒度预生成再查表
  const grainRes = Math.max(64, size >> 1);
  const grainStep = size / grainRes;
  const grainTable = new Float32Array(grainRes * grainRes);
  for (let gy = 0; gy < grainRes; gy += 1) {
    for (let gx = 0; gx < grainRes; gx += 1) grainTable[gy * grainRes + gx] = hash2(gx, gy, seed + 7) - 0.5;
  }
  const grainCol = new Int32Array(size);
  for (let x = 0; x < size; x += 1) grainCol[x] = Math.floor(x / grainStep);

  // 每块的色差/起伏/磨损/缝宽用 LCG 预生成（块数很少）
  const random = makeLcg(seed + 5);
  const blockCount = prof.rows * prof.cols;
  const blockTint = new Float32Array(blockCount);
  const blockRelief = new Float32Array(blockCount);
  const blockWear = new Float32Array(blockCount);
  const blockChip = new Float32Array(blockCount);
  for (let i = 0; i < blockCount; i += 1) {
    blockTint[i] = (random() - 0.5) * 2 * prof.blockTint;
    blockRelief[i] = random();
    blockWear[i] = 0.35 + 0.65 * random();
    blockChip[i] = 1 + (random() - 0.5) * 2 * prof.chip;
  }

  const halfJoint = prof.jointPx * 0.5;
  const bevelEnd = halfJoint + prof.bevelPx;
  const hasMoss = mossF !== null && mossOut !== null;
  const mossLo = 0.58 - 0.22 * weather;

  return {
    build(y0: number, y1: number): void {
      fillField(baseFbmF, y0, y1);
      fillField(stainF, y0, y1);
      fillField(reliefF, y0, y1);
      fillField(grimeF, y0, y1);
      fillField(streakF, y0, y1);
      fillField(mossF, y0, y1);
      fillField(ragF, y0, y1);
      fillField(wearF, y0, y1);
      fillField(rutF, y0, y1);
      fillField(chiselF, y0, y1);
      fillField(patchF, y0, y1);
      const baseFbm = baseFbmF ? baseFbmF.out : EMPTY;
      const stainField = stainF ? stainF.out : EMPTY;
      const reliefField = reliefF ? reliefF.out : EMPTY;
      const grimeField = grimeF ? grimeF.out : EMPTY;
      const streakField = streakF ? streakF.out : EMPTY;
      const mossField = mossF ? mossF.out : EMPTY;
      const ragField = ragF ? ragF.out : EMPTY;
      const wearField = wearF ? wearF.out : EMPTY;
      const rutField = rutF ? rutF.out : EMPTY;
      const chiselField = chiselF ? chiselF.out : EMPTY;
      const patchField = patchF ? patchF.out : EMPTY;

      for (let y = y0; y < y1; y += 1) {
        const row = Math.min(prof.rows - 1, Math.floor(y / rowH));
        const ly = y - row * rowH;
        const stagger = prof.stagger * (row % 2);
        const rowBase = row * prof.cols;
        const dstRow = y * size;
        const grainRow = Math.floor(y / grainStep) * grainRes;
        let fx = stagger;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const colRaw = Math.floor(fx);
          const lx = (fx - colRaw) * colW;
          const col = ((colRaw % prof.cols) + prof.cols) % prof.cols;
          const block = rowBase + col;

          const rag = ragField.length ? (ragField[index] - 0.5) * prof.ragged : 0;
          const jw = blockChip[block] * (1 + rag);
          const edge = Math.min(lx, colW - lx, ly, rowH - ly) / jw;
          const bevel = smoothstep(halfJoint, bevelEnd, edge);

          const base = baseFbm.length ? baseFbm[index] : 0.5;
          const reliefV = reliefField.length ? reliefField[index] : 0.5;
          const grain = grainTable[grainRow + grainCol[x]];
          const grime = grimeField.length ? grimeField[index] : 0.5;
          const streak = streakField.length ? streakField[index] : 0.5;
          const chiselV = chiselField.length ? chiselField[index] : 0.5;

          // —— 高度场（法线 / 缝阴影 / 粗糙度的唯一真源）——
          let h = 0.1 + 0.9 * bevel;
          h += (reliefV - 0.5) * prof.relief * (0.55 + 0.9 * blockRelief[block]) * bevel;
          h += (base - 0.5) * prof.relief * prof.reliefNoise * bevel;
          h += (chiselV - 0.5) * prof.chisel * bevel; // R30 中频凿点（精切石肌理）
          h += grain * prof.grain;
          height[index] = clamp01(h);

          // —— 明度（tone）——
          const edgeNear = 1 - smoothstep(halfJoint, bevelEnd * 2.2, edge);
          const wearEdge = edgeNear * blockWear[block] * prof.edgeWear;

          let t = 0.5;
          t += blockTint[block];
          t += (reliefV - 0.5) * 0.22;
          t += (base - 0.5) * prof.toneNoise;
          if (stainField.length) t += (stainField[index] - 0.5) * prof.stain * weather;
          if (patchField.length) t += (patchField[index] - 0.5) * prof.patch; // R30 低频色斑（floor）
          t -= (1 - bevel) * 0.12 * weather;
          t -= (grime - 0.42) * prof.grime * (0.55 + 0.45 * weather);
          t -= (streak - 0.45) * prof.streak * weather;
          t += grain * prof.grain * 1.6;
          t += wearEdge;

          let rough = prof.jointRough + (prof.faceRough - prof.jointRough) * smoothstep(0.42, 0.95, bevel);
          rough += (reliefV - 0.5) * 0.08 * weather;
          rough += Math.abs(chiselV - 0.5) * prof.chisel * 0.9; // R30 凿点处更哑
          rough += Math.max(0, grime - 0.42) * prof.grime * 0.35;
          rough -= wearEdge * 0.5;
          if (wearField.length) {
            const wear = smoothstep(0.45, 0.9, wearField[index]);
            rough -= wear * prof.wear * bevel;
            t -= wear * 0.05;
          }
          if (rutField.length) {
            const ru = Math.min(Math.abs(fx - 0.32), Math.abs(fx - 0.68));
            const rut = (1 - smoothstep(0.03, 0.11, ru)) * (0.55 + 0.45 * rutField[index]) * prof.rut;
            rough -= rut * 0.28 * bevel;
            t += rut * 0.05;
          }
          tone[index] = clamp01(t);
          roughness[index] = clamp01(rough);

          if (hasMoss) {
            mossOut![index] = smoothstep(mossLo, mossLo + 0.28, mossField[index]) * prof.moss * 3;
          }
          fx += invColW;
        }
      }
    }
  };
}

/**
 * R30 路面乱石板（crazy-paving）prep：抖动格 Voronoi ⇒ 不规则多边形石板。
 * 据 `.qa/r29_vision.md` §2-D（H）：不规则多边形、块间色差大、深色缝 #222、2m 级板块、法线凹凸、干面。
 * - cells×cells 个抖动格心（Voronoi 对格心环绕取样 ⇒ 天然可平铺）；
 * - 每像素求最近/次近格心 ⇒ 石板 id + 到缝距离 gap；
 * - 块间大色差(tint) + 板心微拱 + 缝口倒角(法线) + 深色缝(blend seamTone + compose shade ⇒ #222)
 *   + 细凿点/颗粒/磨光。确定性（makeLcg + hash），无 Math.random。
 */
function prepFloor(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): { build: (y0: number, y1: number) => void } {
  const P = CRAZY_PAVE;
  const cells = P.cells;
  const cellSize = size / cells;
  const random = makeLcg(seed + 3);
  const n = cells * cells;
  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const tint = new Float32Array(n);
  const wear = new Float32Array(n);
  for (let gy = 0; gy < cells; gy += 1) {
    for (let gx = 0; gx < cells; gx += 1) {
      const i = gy * cells + gx;
      // 格心在单元内 0.22..0.78 抖动 ⇒ 板块大小/形状不规则（crazy-paving identity）
      cx[i] = (gx + 0.22 + random() * 0.56) * cellSize;
      cy[i] = (gy + 0.22 + random() * 0.56) * cellSize;
      tint[i] = (random() - 0.5) * 2; // 块间大色差
      wear[i] = random();
    }
  }
  const patchF = makeField(1, () => fbmField(96, 3, 3, 3, seed + 233), size);
  const microF = makeField(1, () => noiseField(Math.min(256, size), 24, 24, seed + 37), size)!;
  const grimeF = makeField(1, () => fbmField(128, 2, 6, 2, seed + 83), size)!;
  const chiselF = makeField(1, () => noiseField(Math.min(256, size), 16, 16, seed + 227), size)!;

  const grainRes = Math.max(64, size >> 1);
  const grainStep = size / grainRes;
  const grainTable = new Float32Array(grainRes * grainRes);
  for (let gy = 0; gy < grainRes; gy += 1) {
    for (let gx = 0; gx < grainRes; gx += 1) grainTable[gy * grainRes + gx] = hash2(gx, gy, seed + 7) - 0.5;
  }
  const grainCol = new Int32Array(size);
  for (let x = 0; x < size; x += 1) grainCol[x] = Math.floor(x / grainStep);

  const seamHalf = cellSize * 0.05; // 缝芯半宽（深色 #222 区）
  const seamEnd = cellSize * 0.085; // 缝口倒角（法线凹凸过渡）

  return {
    build(y0: number, y1: number): void {
      fillField(patchF, y0, y1);
      fillField(microF, y0, y1);
      fillField(grimeF, y0, y1);
      fillField(chiselF, y0, y1);
      const patchA = patchF ? patchF.out : EMPTY;
      const microA = microF.out;
      const grimeA = grimeF.out;
      const chiselA = chiselF.out;
      for (let y = y0; y < y1; y += 1) {
        const cyi = Math.floor(y / cellSize);
        const dstRow = y * size;
        const grainRow = Math.floor(y / grainStep) * grainRes;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const cxi = Math.floor(x / cellSize);
          // 3×3 邻域 Voronoi（环绕）求最近/次近格心
          let best = Infinity;
          let second = Infinity;
          let bestId = 0;
          for (let oy = -1; oy <= 1; oy += 1) {
            for (let ox = -1; ox <= 1; ox += 1) {
              const gx = cxi + ox;
              const gy = cyi + oy;
              const wx = ((gx % cells) + cells) % cells;
              const wy = ((gy % cells) + cells) % cells;
              const cid = wy * cells + wx;
              const dx = cx[cid] - x;
              const dy = cy[cid] - y;
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
          const gap = Math.sqrt(second) - Math.sqrt(best);
          const bevel = smoothstep(seamHalf, seamEnd, gap);
          const dome = 1 - Math.min(1, Math.sqrt(best) / (cellSize * 0.95));
          const microV = microA[index];
          const grimeV = grimeA[index];
          const chiselV = chiselA[index];
          const grain = grainTable[grainRow + grainCol[x]];

          // 高度场：板心微拱 + 缝口低 + 微起伏 + 凿点 + 颗粒（法线真源）
          let h = 0.05 + 0.7 * bevel + dome * 0.14 * bevel;
          h += (microV - 0.5) * 0.06 * bevel;
          h += (chiselV - 0.5) * P.chisel * bevel;
          h += grain * P.grain;
          height[index] = clamp01(h);

          // 明度：块间大色差 + 板内斑 + 微起伏 + 污 + 颗粒 + 磨光（磨损变化）
          let t = 0.5 + tint[bestId] * P.blockTint;
          if (patchA.length) t += (patchA[index] - 0.5) * P.patch;
          t += (microV - 0.5) * 0.16;
          t += (grimeV - 0.42) * P.grime * weather;
          t += grain * P.grain * 1.6;
          t += smoothstep(0.45, 0.95, dome) * wear[bestId] * P.wear * 0.12;
          // 深色缝：blend 到 seamTone（≈dark），配 compose shade(mortarShade 0.72) ⇒ #222
          const seamMask = 1 - bevel;
          t = t * (1 - seamMask) + P.seamTone * seamMask;
          tone[index] = clamp01(t);

          // 粗糙度（pavement 不挂 roughnessMap、给均匀 0.9；此处仍算供 stats/备用）
          let rough = P.faceRough + (P.jointRough - P.faceRough) * (1 - bevel);
          rough += (microV - 0.5) * 0.06 * weather;
          rough -= smoothstep(0.45, 0.95, dome) * wear[bestId] * P.wear * 0.3; // 磨光处更滑
          roughness[index] = clamp01(rough);
        }
      }
    }
  };
}

/**
 * 乱石坡面 prep：抖动格 + Voronoi 求缝。build 在 half 分辨率跑，expand 把 half→full。
 * 只在「自分格 + 3×3 邻域」里找最近两块，平方距离比大小、只对两个赢家开方。
 */
function prepRock(
  res: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): { build: (y0: number, y1: number) => void; expand: (y0: number, y1: number) => void; buildRows: number; expandRows: number } {
  const cells = 4;
  const cellSize = res / cells;
  const size = Math.round(Math.sqrt(height.length));
  const random = makeLcg(seed + 3);
  const offsetX = new Float32Array(cells * cells);
  const offsetY = new Float32Array(cells * cells);
  const tint = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i += 1) {
    offsetX[i] = 0.16 + random() * 0.68;
    offsetY[i] = 0.16 + random() * 0.68;
    tint[i] = (random() - 0.5) * 2;
  }

  const reliefF = makeField(1, () => fbmField(res, 8, 8, 2, seed + 41), res);
  const stainF = makeField(1, () => fbmField(res >> 1, 4, 4, 2, seed + 53), res);
  const grainF = makeField(1, () => noiseField(res >> 1, 32, 32, seed + 61), res);
  const h2 = new Float32Array(res * res);
  const t2 = new Float32Array(res * res);
  const r2 = new Float32Array(res * res);

  const seamPx = cellSize * 0.075;

  return {
    buildRows: res,
    expandRows: size,
    build(y0: number, y1: number): void {
      fillField(reliefF, y0, y1);
      fillField(stainF, y0, y1);
      fillField(grainF, y0, y1);
      const reliefField = reliefF!.out;
      const stainField = stainF!.out;
      const grainField = grainF!.out;
      for (let y = y0; y < y1; y += 1) {
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
          const gap = Math.sqrt(second) - Math.sqrt(best);
          const bevel = smoothstep(seamPx * 0.35, seamPx, gap);
          const dome = 1 - Math.min(1, Math.sqrt(best) / (cellSize * 0.85));
          const reliefV = reliefField[index];
          const grain = grainField[index] - 0.5;

          let h = 0.18 + 0.62 * bevel + 0.2 * dome * bevel;
          h += (reliefV - 0.5) * 0.16 * bevel;
          h += grain * 0.05;
          h2[index] = clamp01(h);

          const stain = stainField[index];
          let t = 0.5 + tint[bestId] * 0.11 + (reliefV - 0.5) * 0.3 + (stain - 0.5) * 0.55 * weather;
          t -= (1 - bevel) * 0.22 * weather;
          t2[index] = clamp01(t);
          r2[index] = clamp01(0.95 - 0.09 * bevel + (stain - 0.5) * 0.06);
        }
      }
    },
    expand(y0: number, y1: number): void {
      expandIntoRows(h2, res, height, size, y0, y1);
      expandIntoRows(t2, res, tone, size, y0, y1);
      expandIntoRows(r2, res, roughness, size, y0, y1);
    }
  };
}

/**
 * 鎏金饰带 prep：沿 x 拉长的各向异性刷纹 + 低频氧化斑 + 铸造麻点 + 抛光高光斑。
 * 氧化斑同时压暗、抬粗糙度、压低高度 —— 三者同源。
 */
function prepGold(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): { build: (y0: number, y1: number) => void } {
  const brush = makeField(1, () => noiseField(256, 4, 128, seed + 13), size)!;
  const brushFine = makeField(1, () => noiseField(256, 8, 256, seed + 29), size)!;
  const ox = makeField(1, () => fbmField(128, 4, 4, 3, seed + 47), size)!;
  const grain = makeField(1, () => noiseField(size >> 1, 32, 32, seed + 67), size)!;
  const pit = makeField(1, () => noiseField(Math.min(512, size), 48, 48, seed + 89), size)!;
  const polish = makeField(1, () => fbmField(128, 3, 3, 2, seed + 97), size)!;
  // R30 划痕（做旧）：各向异性细丝（64×16 ⇒ 竖向细痕）取门限上段 = 稀疏划痕，露下方新金属
  const scratch = makeField(1, () => noiseField(Math.min(512, size), 64, 16, seed + 241), size)!;

  return {
    build(y0: number, y1: number): void {
      fillField(brush, y0, y1);
      fillField(brushFine, y0, y1);
      fillField(ox, y0, y1);
      fillField(grain, y0, y1);
      fillField(pit, y0, y1);
      fillField(polish, y0, y1);
      fillField(scratch, y0, y1);
      const b1a = brush.out;
      const b2a = brushFine.out;
      const oxa = ox.out;
      const graina = grain.out;
      const pita = pit.out;
      const polisha = polish.out;
      const scratcha = scratch.out;
      for (let y = y0; y < y1; y += 1) {
        const dstRow = y * size;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const b1 = b1a[index];
          const b2 = b2a[index];
          const oxv = oxa[index];
          const g = graina[index] - 0.5;
          const pitv = pita[index];
          const polishv = polisha[index];
          const oxidized = smoothstep(0.62 - 0.22 * weather, 0.9, oxv);
          const pits = smoothstep(0.72, 0.88, pitv) * (1 - oxidized) * weather;
          const shine = smoothstep(0.52, 0.8, polishv);
          const sc = smoothstep(0.7, 0.76, scratcha[index]); // R30 稀疏划痕

          let h = 0.58 + (b1 - 0.5) * 0.26 + (b2 - 0.5) * 0.13;
          h += g * 0.015;
          h -= oxidized * 0.16;
          h -= pits * 0.22;
          h -= sc * 0.03; // 划痕微凹
          height[index] = clamp01(h);

          let t = 0.5 + (b1 - 0.5) * 0.35 + (b2 - 0.5) * 0.2;
          t -= oxidized * 0.62;
          t -= pits * 0.1;
          t += g * 0.05;
          t += shine * 0.08;
          t += sc * 0.1; // 划痕露新金属（更亮）
          tone[index] = clamp01(t);

          let rough = 0.47 + (b2 - 0.5) * 0.16 + Math.abs(b1 - 0.5) * 0.1;
          rough += oxidized * 0.34;
          rough += pits * 0.2;
          rough -= shine * 0.14;
          rough += sc * 0.06; // 划痕边缘略糙
          roughness[index] = clamp01(rough);
        }
      }
    }
  };
}

/** 屋面板岩瓦 prep：12 皮 × 8 片、半片错缝；每片沿自身高度做单拱（瓦楞） */
function prepRoof(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array,
  mossOut: Float32Array | null
): { build: (y0: number, y1: number) => void } {
  const P = SHINGLE;
  const rowH = size / P.rows;
  const colW = size / P.cols;
  const invColW = 1 / colW;
  const relief = makeField(1, () => noiseField(Math.min(256, size), 24, 24, seed + 37), size)!;
  const stain = makeField(1, () => fbmField(64, 4, 4, 3, seed + 11), size)!;
  const mossF = makeField(P.moss, () => fbmField(64, 3, 3, 2, seed + 157), size);
  const streak = makeField(1, () => fbmField(128, 24, 3, 2, seed + 139), size)!;
  const rag = makeField(1, () => noiseField(128, P.cols * 4, P.rows * 4, seed + 181), size)!;
  // R30 板岩层理（foliation）：各向异性中频（8×32 顺瓦长），板岩劈分面的细层纹
  const slate = makeField(1, () => noiseField(Math.min(256, size), 8, 32, seed + 271), size)!;

  const grainRes = Math.max(64, size >> 1);
  const grainStep = size / grainRes;
  const grainTable = new Float32Array(grainRes * grainRes);
  for (let gy = 0; gy < grainRes; gy += 1) {
    for (let gx = 0; gx < grainRes; gx += 1) grainTable[gy * grainRes + gx] = hash2(gx, gy, seed + 7) - 0.5;
  }
  const grainCol = new Int32Array(size);
  for (let x = 0; x < size; x += 1) grainCol[x] = Math.floor(x / grainStep);

  const random = makeLcg(seed + 5);
  const blockCount = P.rows * P.cols;
  const blockTint = new Float32Array(blockCount);
  for (let i = 0; i < blockCount; i += 1) blockTint[i] = (random() - 0.5) * 2 * 0.14;

  const halfJoint = P.jointPx * 0.5;
  const bevelEnd = halfJoint + P.bevelPx;
  const mossLo = 0.56 - 0.2 * weather;

  return {
    build(y0: number, y1: number): void {
      fillField(relief, y0, y1);
      fillField(stain, y0, y1);
      fillField(mossF, y0, y1);
      fillField(streak, y0, y1);
      fillField(rag, y0, y1);
      fillField(slate, y0, y1);
      const reliefField = relief.out;
      const stainField = stain.out;
      const mossField = mossF ? mossF.out : EMPTY;
      const streakField = streak.out;
      const ragField = rag.out;
      const slateField = slate.out;
      for (let y = y0; y < y1; y += 1) {
        const row = Math.min(P.rows - 1, Math.floor(y / rowH));
        const ly = y - row * rowH;
        const rowBase = row * P.cols;
        const dstRow = y * size;
        const grainRow = Math.floor(y / grainStep) * grainRes;
        const lyN = ly / rowH;
        const arch = Math.sin(Math.PI * lyN);
        let fx = 0.5 * (row % 2);
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const colRaw = Math.floor(fx);
          const lx = (fx - colRaw) * colW;
          const col = ((colRaw % P.cols) + P.cols) % P.cols;
          const block = rowBase + col;
          const ragV = (ragField[index] - 0.5) * P.ragged;
          const edge = Math.min(lx, colW - lx, ly, rowH - ly) / (1 + ragV);
          const bevel = smoothstep(halfJoint, bevelEnd, edge);
          const reliefV = reliefField[index];
          const grain = grainTable[grainRow + grainCol[x]];
          const streakV = streakField[index];
          const slateV = slateField[index] - 0.5;

          let h = 0.1 + 0.9 * bevel;
          h += (0.35 + 0.65 * arch) * 0.16 * bevel;
          h += (reliefV - 0.5) * P.relief * bevel;
          h += slateV * 0.045 * bevel; // R30 板岩层理
          h += grain * P.grain;
          height[index] = clamp01(h);

          let t = 0.5 + blockTint[block] + (reliefV - 0.5) * 0.2;
          t += (stainField[index] - 0.5) * P.stain * weather;
          t -= (1 - bevel) * 0.2 * weather;
          t -= (streakV - 0.45) * P.streak * weather;
          t += grain * P.grain * 1.6;
          t += (arch - 0.5) * 0.06;
          t += slateV * 0.05; // R30 层理明暗
          tone[index] = clamp01(t);

          let rough = P.jointRough + (P.faceRough - P.jointRough) * smoothstep(0.42, 0.95, bevel);
          rough += (reliefV - 0.5) * 0.07 * weather;
          rough += Math.abs(slateV) * 0.05; // R30 层理处略哑
          roughness[index] = clamp01(rough);

          if (mossField.length && mossOut) {
            mossOut[index] = smoothstep(mossLo, mossLo + 0.26, mossField[index]) * P.moss * 3;
          }
          fx += invColW;
        }
      }
    }
  };
}

/** 木板 prep：4 块竖向板 + 深板缝；各向异性木纹 + 节疤 + 竖向水痕 */
function prepWood(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): { build: (y0: number, y1: number) => void } {
  const P = PLANK;
  const colW = size / P.cols;
  const invColW = 1 / colW;
  const grainF = makeField(1, () => noiseField(Math.min(512, size), P.grainPeriodX, P.grainPeriodY, seed + 23), size)!;
  const fineF = makeField(1, () => noiseField(Math.min(512, size), P.grainPeriodX * 2, P.grainPeriodY * 2, seed + 31), size)!;
  const knotF = makeField(1, () => fbmField(128, 4, 4, 2, seed + 43), size)!;
  const stainF = makeField(1, () => fbmField(64, 4, 4, 3, seed + 11), size)!;
  const streakF = makeField(1, () => fbmField(128, 16, 3, 2, seed + 139), size)!;
  const reliefF = makeField(1, () => noiseField(Math.min(256, size), 12, 12, seed + 37), size)!;

  const grainRes = Math.max(64, size >> 1);
  const grainStep = size / grainRes;
  const grainTable = new Float32Array(grainRes * grainRes);
  for (let gy = 0; gy < grainRes; gy += 1) {
    for (let gx = 0; gx < grainRes; gx += 1) grainTable[gy * grainRes + gx] = hash2(gx, gy, seed + 7) - 0.5;
  }
  const grainCol = new Int32Array(size);
  for (let x = 0; x < size; x += 1) grainCol[x] = Math.floor(x / grainStep);

  const random = makeLcg(seed + 5);
  const plankTint = new Float32Array(P.cols);
  for (let i = 0; i < P.cols; i += 1) plankTint[i] = (random() - 0.5) * 2 * 0.13;

  const halfJoint = P.jointPx * 0.5;
  const bevelEnd = halfJoint + P.bevelPx;

  return {
    build(y0: number, y1: number): void {
      fillField(grainF, y0, y1);
      fillField(fineF, y0, y1);
      fillField(knotF, y0, y1);
      fillField(stainF, y0, y1);
      fillField(streakF, y0, y1);
      fillField(reliefF, y0, y1);
      const grainField = grainF.out;
      const fineField = fineF.out;
      const knotField = knotF.out;
      const stainField = stainF.out;
      const streakField = streakF.out;
      const reliefField = reliefF.out;
      for (let y = y0; y < y1; y += 1) {
        const dstRow = y * size;
        const grainRow = Math.floor(y / grainStep) * grainRes;
        let fx = 0;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const colRaw = Math.floor(fx);
          const lx = (fx - colRaw) * colW;
          const col = ((colRaw % P.cols) + P.cols) % P.cols;
          const edge = Math.min(lx, colW - lx);
          const bevel = smoothstep(halfJoint, bevelEnd, edge);

          const g1 = grainField[index];
          const g2 = fineField[index];
          const knot = smoothstep(0.66, 0.86, knotField[index]);
          const reliefV = reliefField[index];
          const grain = grainTable[grainRow + grainCol[x]];
          const streakV = streakField[index];

          let h = 0.12 + 0.62 * bevel;
          h += (g1 - 0.5) * P.grainAmp * bevel;
          h += (g2 - 0.5) * P.grainAmp * 0.5 * bevel;
          h += knot * 0.1 * bevel;
          h += (reliefV - 0.5) * P.relief * bevel;
          h += grain * P.grain;
          height[index] = clamp01(h);

          let t = 0.5 + plankTint[col];
          t += (g1 - 0.5) * 0.3 + (g2 - 0.5) * 0.16;
          t += (stainField[index] - 0.5) * P.stain * weather;
          t -= (1 - bevel) * 0.24 * weather;
          t -= (streakV - 0.45) * P.streak * weather;
          t -= knot * P.knot * 0.5;
          t += grain * P.grain * 1.6;
          tone[index] = clamp01(t);

          let rough = P.jointRough + (P.faceRough - P.jointRough) * smoothstep(0.42, 0.95, bevel);
          rough += Math.abs(g1 - 0.5) * 0.1;
          rough += knot * 0.16;
          roughness[index] = clamp01(rough);
          fx += invColW;
        }
      }
    }
  };
}

/** 铅条窗玻璃 prep：3×2 铅条格 + 极平玻璃面（老玻璃波纹 + 微污 + R30 薄膜虹彩暗示） */
function prepGlass(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array,
  tintOut: Float32Array | null
): { build: (y0: number, y1: number) => void } {
  const P = PANE;
  const rowH = size / P.rows;
  const colW = size / P.cols;
  const invColW = 1 / colW;
  const wave = makeField(1, () => fbmField(128, 3, 3, 3, seed + 51), size)!;
  const dirt = makeField(1, () => fbmField(128, 2, 6, 2, seed + 59), size)!;
  // R30 薄膜虹彩：低频各向异性场（2×6 ⇒ 横向拉长的油膜带），仅供 compose 做暖冷微移
  const film = makeField(1, () => fbmField(96, 2, 6, 2, seed + 251), size)!;

  const halfJoint = P.jointPx * 0.5;
  const bevelEnd = halfJoint + P.bevelPx;

  return {
    build(y0: number, y1: number): void {
      fillField(wave, y0, y1);
      fillField(dirt, y0, y1);
      fillField(film, y0, y1);
      const waveA = wave.out;
      const dirtA = dirt.out;
      const filmA = film.out;
      for (let y = y0; y < y1; y += 1) {
        const row = Math.min(P.rows - 1, Math.floor(y / rowH));
        const ly = y - row * rowH;
        const dstRow = y * size;
        let fx = 0;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const colRaw = Math.floor(fx);
          const lx = (fx - colRaw) * colW;
          const edge = Math.min(lx, colW - lx, ly, rowH - ly);
          const bevel = smoothstep(halfJoint, bevelEnd, edge);
          const w = waveA[index];
          const d = dirtA[index];

          let h = 0.42 + 0.5 * bevel;
          h += (w - 0.5) * P.waviness * bevel;
          h += (1 - bevel) * 0.14;
          height[index] = clamp01(h);

          let t = 0.5 + (w - 0.5) * 0.34;
          t -= (1 - bevel) * 0.55;
          t -= (d - 0.45) * 0.2 * weather;
          tone[index] = clamp01(t);

          let rough = P.faceRough + (P.jointRough - P.faceRough) * (1 - smoothstep(0.4, 0.95, bevel));
          rough += Math.max(0, d - 0.45) * 0.3 * weather;
          roughness[index] = clamp01(rough);

          // 虹彩信号：玻璃面（高 bevel）上更强，铅条处收敛；靠 compose 的暖冷微移读出
          if (tintOut) tintOut[index] = (filmA[index] - 0.5) * 2 * smoothstep(0.5, 0.95, bevel);
          fx += invColW;
        }
      }
    }
  };
}

/** 大理石柱身/台基 prep：无块缝，脊化 fbm 出脉络（竖直拉长） */
function prepMarble(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): { build: (y0: number, y1: number) => void } {
  const V = VEIN;
  const fres = Math.max(64, Math.min(256, size >> 1));
  const vein = makeField(1, () => fbmField(fres, V.periodX, V.periodY, V.octaves, seed + 71), size)!;
  const fine = makeField(1, () => noiseField(Math.min(256, size), 24, 48, seed + 79), size)!;
  const cloud = makeField(1, () => fbmField(128, 4, 4, 3, seed + 87), size)!;
  // R30 矿物晶屑（高频各向异性亮点/暗点）：大理石的矿脉细节与晶粒
  const speck = makeField(1, () => noiseField(Math.min(256, size), 64, 32, seed + 263), size)!;

  const grainRes = Math.max(64, size >> 1);
  const grainStep = size / grainRes;
  const grainTable = new Float32Array(grainRes * grainRes);
  for (let gy = 0; gy < grainRes; gy += 1) {
    for (let gx = 0; gx < grainRes; gx += 1) grainTable[gy * grainRes + gx] = hash2(gx, gy, seed + 7) - 0.5;
  }
  const grainCol = new Int32Array(size);
  for (let x = 0; x < size; x += 1) grainCol[x] = Math.floor(x / grainStep);

  return {
    build(y0: number, y1: number): void {
      fillField(vein, y0, y1);
      fillField(fine, y0, y1);
      fillField(cloud, y0, y1);
      fillField(speck, y0, y1);
      const veinA = vein.out;
      const fineA = fine.out;
      const cloudA = cloud.out;
      const speckA = speck.out;
      for (let y = y0; y < y1; y += 1) {
        const dstRow = y * size;
        const grainRow = Math.floor(y / grainStep) * grainRes;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const v = veinA[index];
          const ridge = 1 - Math.abs(v * 2 - 1);
          const vm = smoothstep(V.veinSharp, 0.98, ridge);
          const c = cloudA[index];
          const f = fineA[index];
          const grain = grainTable[grainRow + grainCol[x]];
          const sp = speckA[index] - 0.5;

          let h = 0.62 + (f - 0.5) * V.relief + grain * V.grain;
          h -= vm * 0.12;
          h += sp * V.grain * 0.8; // R30 晶屑微起伏
          height[index] = clamp01(h);

          let t = 0.5 + (c - 0.5) * 0.3 * (0.5 + 0.5 * weather);
          t -= vm * 0.42;
          t += (f - 0.5) * 0.05;
          t += grain * V.grain * 2.2;
          t += sp * 0.05; // R30 晶屑明暗
          tone[index] = clamp01(t);

          let rough = V.faceRough + (V.veinRough - V.faceRough) * vm;
          rough += (c - 0.5) * 0.04 * weather;
          rough += Math.abs(sp) * 0.03; // R30 晶屑处略哑
          roughness[index] = clamp01(rough);
        }
      }
    }
  };
}

/**
 * 组装一次烘焙：分配缓冲 + 分派到对应族 prep + 包一层 compose/finish。
 * 高度场→三图在同一套 compose 里读同一份 height（同源验收线）。
 */
export function createStoneBake(kind: StoneKind, size: number, seed: number, weather: number): StoneBake {
  const count = size * size;
  const height = new Float32Array(count);
  const tone = new Float32Array(count);
  const roughness = new Float32Array(count);

  let build: (y0: number, y1: number) => void;
  let expand: (y0: number, y1: number) => void = () => {};
  let buildRows = size;
  let expandRows = 0;
  let moss: Float32Array | null = null;
  let tint: Float32Array | null = null;
  let normalStrength = MASONRY.ashlar.normalStrength;
  let mortarShade = MASONRY.ashlar.mortarShade;

  if (kind === 'rock') {
    // 乱石 3×3 最近邻在 512² 逐像素算太贵，改为 half 算完双线性放大（R29 口径）
    const half = Math.max(128, size >> 1);
    const plan = prepRock(half, seed, weather, height, tone, roughness);
    build = plan.build;
    expand = plan.expand;
    buildRows = half;
    expandRows = size;
    normalStrength = 1.0;
    mortarShade = ROCK_SHADE;
  } else if (kind === 'gold') {
    build = prepGold(size, seed, weather, height, tone, roughness).build;
    normalStrength = 0.72;
    mortarShade = GOLD_SHADE;
  } else if (kind === 'roof') {
    moss = new Float32Array(count);
    build = prepRoof(size, seed, weather, height, tone, roughness, moss).build;
    normalStrength = SHINGLE.normalStrength;
    mortarShade = 0.55;
  } else if (kind === 'wood') {
    build = prepWood(size, seed, weather, height, tone, roughness).build;
    normalStrength = PLANK.normalStrength;
    mortarShade = 0.42;
  } else if (kind === 'glass') {
    tint = new Float32Array(count);
    build = prepGlass(size, seed, weather, height, tone, roughness, tint).build;
    normalStrength = PANE.normalStrength;
    mortarShade = 0.62;
  } else if (kind === 'marble') {
    build = prepMarble(size, seed, weather, height, tone, roughness).build;
    normalStrength = VEIN.normalStrength;
    mortarShade = 0.9;
  } else if (kind === 'floor') {
    // R30 路面乱石板（crazy-paving，据 .qa/r29_vision.md §2-D）
    build = prepFloor(size, seed, weather, height, tone, roughness).build;
    normalStrength = CRAZY_PAVE.normalStrength;
    mortarShade = CRAZY_PAVE.mortarShade;
  } else {
    const prof = MASONRY[kind];
    if (prof.moss > 0) moss = new Float32Array(count);
    build = prepMasonry(size, seed, weather, prof, height, tone, roughness, moss).build;
    normalStrength = prof.normalStrength;
    mortarShade = prof.mortarShade;
  }

  const hex = STONE_HEX[kind];
  const base = hexToRgb(hex.base);
  const light = hexToRgb(hex.light);
  const dark = hexToRgb(hex.dark);
  const mossColor = hexToRgb('#5b6b3a');
  const sparkle = SPARKLE[kind];
  const albedo = new Uint8ClampedArray(count * 4);
  const normal = new Uint8ClampedArray(count * 4);
  const rough = new Uint8ClampedArray(count * 4);

  return {
    size,
    buildRows,
    expandRows,
    albedo,
    normal,
    rough,
    tint,
    build,
    expand,
    compose(y0: number, y1: number): void {
      const scale = normalStrength * 6;
      const shadeLo = mortarShade;
      const hasMoss = moss !== null;
      for (let y = y0; y < y1; y += 1) {
        const row = y * size;
        const up = ((y - 1 + size) % size) * size;
        const down = ((y + 1) % size) * size;
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
          let ar = r * shade;
          let ag = g * shade;
          let ab = b * shade;
          if (hasMoss) {
            const m = moss![index];
            if (m > 0.001) {
              ar += (mossColor.r - ar) * m;
              ag += (mossColor.g - ag) * m;
              ab += (mossColor.b - ab) * m;
            }
          }
          // R30 玻璃薄膜虹彩暗示：暖冷微移（r↑/b↓ ↔ 反向），绝不走 transmission（R12 铁律⑤）
          if (tint) {
            const hue = tint[index];
            if (hue !== 0) {
              ar *= 1 + hue * 0.05;
              ag *= 1 - hue * 0.02;
              ab *= 1 - hue * 0.05;
            }
          }
          albedo[offset] = ar * 255;
          albedo[offset + 1] = ag * 255;
          albedo[offset + 2] = ab * 255;
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
    },
    finish(): StoneStats {
      scatterSparkles(albedo, size, seed, sparkle);
      return measureStats(size, albedo, normal, rough);
    }
  };
}

/**
 * 稀疏亮点（白石晶体 / 金箔剥落 / 玻璃反光点）。按 LCG 抽 0.35% 像素点亮。
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
 * 输出统计（口径对齐 tools/r29_tex_stats.py）：
 * 亮度走 256 桶直方图取分位（不排序，O(n)），颗粒/法线抽样 1/16。
 */
function measureStats(
  size: number,
  albedo: Uint8ClampedArray,
  normal: Uint8ClampedArray,
  rough: Uint8ClampedArray
): StoneStats {
  const count = size * size;
  const hist = new Int32Array(256);
  let sum = 0;
  let sum2 = 0;
  let roughSum = 0;
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const l = 0.2126 * albedo[o] + 0.7152 * albedo[o + 1] + 0.0722 * albedo[o + 2];
    sum += l;
    sum2 += l * l;
    hist[Math.max(0, Math.min(255, l | 0))] += 1;
    roughSum += rough[o];
  }
  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
  const pick = (frac: number): number => {
    const target = count * frac;
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  const p05 = pick(0.05);
  const p50 = pick(0.5);
  const p95 = pick(0.95);

  let g2 = 0;
  let gn = 0;
  for (let y = 1; y < size - 1; y += 2) {
    for (let x = 1; x < size - 1; x += 2) {
      const o = (y * size + x) * 4;
      const l = 0.2126 * albedo[o] + 0.7152 * albedo[o + 1] + 0.0722 * albedo[o + 2];
      const lL = 0.2126 * albedo[o - 4] + 0.7152 * albedo[o - 3] + 0.0722 * albedo[o - 2];
      const lR = 0.2126 * albedo[o + 4] + 0.7152 * albedo[o + 5] + 0.0722 * albedo[o + 6];
      const lU = 0.2126 * albedo[o - size * 4] + 0.7152 * albedo[o - size * 4 + 1] + 0.0722 * albedo[o - size * 4 + 2];
      const lD = 0.2126 * albedo[o + size * 4] + 0.7152 * albedo[o + size * 4 + 1] + 0.0722 * albedo[o + size * 4 + 2];
      const hp = l - (lL + lR + lU + lD) * 0.25;
      g2 += hp * hp;
      gn += 1;
    }
  }
  const grain = gn > 0 ? Math.sqrt(g2 / gn) : 0;

  let m = 0;
  let mn = 0;
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      const o = (y * size + x) * 4;
      const nx = (normal[o] / 255) * 2 - 1;
      const ny = (normal[o + 1] / 255) * 2 - 1;
      m += Math.sqrt(nx * nx + ny * ny);
      mn += 1;
    }
  }
  const mag = mn > 0 ? m / mn : 0;
  return {
    lumMean: mean,
    lumStd: std,
    lumP05: p05,
    lumP50: p50,
    lumP95: p95,
    contrast: p95 - p05,
    grain,
    normalMag: mag,
    normalTiltDeg: (Math.atan2(mag, 1) * 180) / Math.PI,
    roughMean: roughSum / count / 255
  };
}

/**
 * DOM 无关的核心：算出三张图的像素。node / QA shim 可直接调用复算数值。
 * R30：内部走 createStoneBake，一个行带跑完（与异步分片**同一套公式**）。
 */
export function makeStonePixelSet(kind: StoneKind, opts: StoneOptions = {}): StonePixelSet {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const size = normalizeSize(opts.size);
  const seed = (opts.seed ?? DEFAULT_SEED[kind]) >>> 0;
  const weather = clamp01(opts.weather ?? 0.35);

  const bake = createStoneBake(kind, size, seed, weather);
  bake.build(0, bake.buildRows);
  if (bake.expandRows > 0) bake.expand(0, bake.expandRows);
  bake.compose(0, size);
  const stats = bake.finish();

  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { size, albedo: bake.albedo, normal: bake.normal, rough: bake.rough, elapsedMs: ended - started, stats };
}

// ── 异步分片重烘（B2 启动热升级）──────────────────────────────────────

/** 目标尺寸每行带预算（px）：~64k px ⇒ 1024² 每片 64 行、512² 每片 128 行（静默 ~3-5ms/片） */
function bandRowsFor(size: number): number {
  return Math.max(16, Math.min(size, Math.round(65536 / size)));
}

export type StoneSchedule = (cb: () => void) => void;

/** 浏览器默认调度：优先 requestIdleCallback（带 timeout 兜底，保证连续动画时也会跑），否则 setTimeout */
const defaultSchedule: StoneSchedule = (cb) => {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => cb(), { timeout: 2000 });
  } else {
    setTimeout(cb, 0);
  }
};

export interface StoneBakeOptions extends StoneOptions {
  /** idle 调度器（默认 requestIdleCallback/setTimeout）。node shim 传自定义 + autoStart:false 手动 pump。 */
  schedule?: StoneSchedule;
  /** 是否自动驱动调度循环（默认 true）。shim 传 false 用 pump() 手动分片。 */
  autoStart?: boolean;
}

export interface StoneBakeHandle {
  /** 完成后 resolve 出目标尺寸的三张贴图（与同步版逐字节一致） */
  readonly maps: Promise<StoneMaps>;
  /** 取消后续分片（已生成到 GPU 的纹理由调用方在 then/catch 里处置） */
  cancel(): void;
  /** 手动跑一个行带分片；返回 true = 已完成（shim / 自定义驱动用） */
  pump(): boolean;
  /** 总分片数（build/expand/compose/finish 合计） */
  readonly totalChunks: number;
  readonly doneChunks: number;
  /** 完成后是否已被取消（then 里据此决定 dispose 还是热替换） */
  readonly cancelled: boolean;
}

/**
 * 目标尺寸的**分片重烘**：与 makeStoneMaps 同一套 per-pixel 公式，但按行带让出主线程。
 * 设计要点（shim 可证）：产物与 makeStonePixelSet(kind,{size}) **逐字节一致** ——
 * 因为 build/expand/compose/finish 是同一批函数，只是把 [0,rows) 切成多段跑，
 * 而每段只写自己的行、只读本段行（字段展开按行带、法线邻行在 build 完成后才 compose）。
 */
export function bakeStoneMapsAsync(kind: StoneKind, opts: StoneBakeOptions = {}): StoneBakeHandle {
  const size = normalizeSize(opts.size);
  const seed = (opts.seed ?? DEFAULT_SEED[kind]) >>> 0;
  const weather = clamp01(opts.weather ?? 0.35);
  const repeat = opts.repeat ?? ([1, 1] as [number, number]);

  const bake = createStoneBake(kind, size, seed, weather);
  const band = bandRowsFor(size);

  let phase: 0 | 1 | 2 | 3 = 0; // 0=build 1=expand 2=compose 3=finish
  let y = 0;
  let done = 0;
  let cancelled = false;
  let finished = false;
  let stats: StoneStats | null = null;

  const buildChunks = Math.ceil(bake.buildRows / band);
  const expandChunks = bake.expandRows > 0 ? Math.ceil(bake.expandRows / band) : 0;
  const composeChunks = Math.ceil(size / band);
  const total = buildChunks + expandChunks + composeChunks + 1;

  let resolveMaps: (m: StoneMaps) => void;
  const promise = new Promise<StoneMaps>((res) => {
    resolveMaps = res;
  });

  const step = (): boolean => {
    if (phase === 0) {
      const end = Math.min(y + band, bake.buildRows);
      bake.build(y, end);
      y = end;
      done += 1;
      if (y >= bake.buildRows) {
        phase = bake.expandRows > 0 ? 1 : 2;
        y = 0;
      }
      return false;
    }
    if (phase === 1) {
      const end = Math.min(y + band, bake.expandRows);
      bake.expand(y, end);
      y = end;
      done += 1;
      if (y >= bake.expandRows) {
        phase = 2;
        y = 0;
      }
      return false;
    }
    if (phase === 2) {
      const end = Math.min(y + band, size);
      bake.compose(y, end);
      y = end;
      done += 1;
      if (y >= size) phase = 3;
      return false;
    }
    // phase 3: finish（一次性）
    stats = bake.finish();
    done += 1;
    return true;
  };

  const buildTextures = (): StoneMaps => ({
    map: toTexture(pixelCanvas(size, bake.albedo), THREE.SRGBColorSpace, repeat),
    normalMap: toTexture(pixelCanvas(size, bake.normal), THREE.NoColorSpace, repeat),
    roughnessMap: toTexture(pixelCanvas(size, bake.rough), THREE.NoColorSpace, repeat),
    stats: stats ?? bake.finish()
  });

  const handle: StoneBakeHandle = {
    maps: promise,
    cancel(): void {
      cancelled = true;
    },
    get cancelled(): boolean {
      return cancelled;
    },
    get totalChunks(): number {
      return total;
    },
    get doneChunks(): number {
      return done;
    },
    pump(): boolean {
      if (cancelled || finished) return true;
      const complete = step();
      if (complete) {
        finished = true;
        if (!cancelled) resolveMaps(buildTextures());
      }
      return complete || cancelled;
    }
  };

  if (opts.autoStart !== false) {
    const schedule = opts.schedule ?? defaultSchedule;
    const tick = (): void => {
      if (cancelled) return;
      if (handle.pump()) return;
      schedule(tick);
    };
    schedule(tick);
  }

  return handle;
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
  return tex;
}

/**
 * node（无 DOM）兜底：没有 canvas 就不画，返回 1×1 哑纹理。
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
    roughnessMap: make(THREE.NoColorSpace),
    stats: {
      lumMean: 0,
      lumStd: 0,
      lumP05: 0,
      lumP50: 0,
      lumP95: 0,
      contrast: 0,
      grain: 0,
      normalMag: 0,
      normalTiltDeg: 0,
      roughMean: 1
    }
  };
}

/**
 * 取石材三张贴图。同 kind + 同参数复用同一组纹理。
 * ⚠ R29：`size` 建议由 `stoneTextureSize(kind, tier)` 给（按质量档分尺寸）。
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
    roughnessMap: toTexture(pixelCanvas(pixels.size, pixels.rough), THREE.NoColorSpace, repeat),
    stats: pixels.stats
  };
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  buildCount += 1;
  console.info(
    `[stoneTexture] ${kind} ${size}² weather=${weather.toFixed(2)} 像素 ${pixels.elapsedMs.toFixed(1)}ms / 总 ${(ended - started).toFixed(1)}ms` +
      ` | L ${pixels.stats.lumMean.toFixed(0)}±${pixels.stats.lumStd.toFixed(0)} C ${pixels.stats.contrast.toFixed(0)}` +
      ` 颗粒 ${pixels.stats.grain.toFixed(2)} n|xy| ${pixels.stats.normalMag.toFixed(3)} roughMean ${pixels.stats.roughMean.toFixed(3)}（第 ${buildCount} 套）`
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
