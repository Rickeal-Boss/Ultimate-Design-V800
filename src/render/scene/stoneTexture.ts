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
 * 例：ashlar 的 1 张贴图 = 2.8m×2.8m（8 皮 × 4 块的开间），贴到 61m 长的教堂立面就传 [21.8, 1]。
 *
 * ⚠ 用法陷阱（R26h / 铁律 34）：three 的
 *   `effective roughness = material.roughness × roughnessMap.g`。
 *   本模块的 roughnessMap 写的是**绝对粗糙度**，所以使用方必须按 1/g 反算
 *   `material.roughness`（`StoneStats.roughMean` 就是给你反算用的）。写成
 *   `roughness: 0.62` 而贴图 g≈0.44 时实际是 0.27 —— 400m 长的水平面会被菲涅耳
 *   镜成「刚下过雨的湿沥青」（乘法语义，不是本贴图偏亮）。
 *   大面积水平面（路面/步道）另有专项处理，见 castle.ts 的 pavementMaterial 注释。
 *
 * ── R29 四条硬约束（生成器验收线，较 R26 收紧）─────────────────────────
 * 1) 同源高度场：albedo 的灰缝阴影、normalMap 的凹槽、roughnessMap 的缝/面分布全部由
 *    **同一份 h(x,y)** 派生；三者严格对齐，不可能错位。
 * 2) 可平铺：块排布用整除网格 + 每皮整数错缝；噪声在**格点索引**上取模环绕。
 *    逐像素白噪本身无结构，接缝不可见。
 * 3) 色彩空间：albedo = SRGBColorSpace；normal/roughness 是**数据**贴图 = NoColorSpace。
 * 4) **多尺度**（R29 新增，针对「贴图不够细」）：每个族 = 基色多倍频 fbm（≥4 octave）
 *    + 结构层（错缝 / 倒角 AO / 缝内暗化 / 缝口不齐 / 缺棱）+ 风化层（污渍、横带积灰、
 *    竖向水痕、苔痕、边角磨光、行走磨光）+ 高频颗粒层。**禁止一层噪声加个滤镜就交付。**
 *
 * 随机数一律走 makeLcg / hash2（可复现）；本文件**没有 Math.random**（否则每次刷新
 * 画面不一致，QA 没法比图）。
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
 * - **ashlar 2.8m**：8 皮（每皮 0.35m 高）× 4 块（每块 0.70m 长）错缝砌石；
 * - wall 7.2m：5 皮 × 3 块的次级大块灰白墙（皮高 1.44m，比主体更粗犷）；
 * - floor 4.8m：4×4 块 1.2m 方板（教堂石板地面）；
 * - rock 3.6m：4×4 乱石坡面（每块约 0.9m）；
 * - gold 1.2m：鎏金饰带的细腻刷纹；
 * - roof 2.4m：12 皮 × 8 片板岩瓦（每片 0.30m 高 × 0.30m 宽，搭接半片错缝）；
 * - wood 2.0m：4 块竖向木板（每块 0.5m 宽，通高）；
 * - glass 1.6m：3 行 × 2 列铅条窗格（每格 0.53m × 0.8m）；
 * - marble 3.2m：抛光石材的脉络尺度（无块缝，尺度大才读得出「整料」）。
 */
export const STONE_TILE_METERS: Record<StoneKind, number> = {
  // 2.8 → **6.4**（R29 目检定罪）：2.8m/8 皮 = 皮高 0.35m ⇒ 88m 主殿立面上砌缝
  // 每 31 米重复一次，远看是"砖墙"而不是"教堂砌石"（verify/r29_check/hall_front.png
  // 与 inner_street.png 实拍）。参考图白石的块材是**大板块**：皮高 ≈0.8m、块长 ≈1.6m
  // ⇒ 8 皮 × 4 块 = 6.4m × 6.4m。缝宽占比不变（由生成器按块尺寸比例算）。
  ashlar: 6.4,
  // 5.0 → 7.2（R29）：次级墙 5 皮 × 3 块 ⇒ 皮高 1.44m、块长 2.4m（比主体更粗犷一档）
  wall: 7.2,
  // 4.8 → 3.6（R29）：castleKit 的 paveTile = floor×2 = 7.2m ⇒ 石板 1.8m，
  // 落进任务书「石板 1.2–1.8m」（原 9.6m/张 ⇒ 2.4m 石板，偏大）
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
 *   grain  = 高通残差径向功率谱主频（cycles/tile @1024 归一化网格）
 *   nxy    = 法线 |n.xy| 均值（等效倾角 deg 见 tilt）
 *   lowfreq= 低频方差占比（污渍/磨损的「大块不均匀」强度）
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
  /** 低频脏污幅度（横向拉长的雨水痕/积灰，尺度约 2 块宽 × 2~4 皮高） */
  grime: number;
  /** 行走磨光幅度（仅 floor） */
  wear: number;
  /* ── R29 多尺度新增 ── */
  /** 基色多倍频噪声幅度（4 octave fbm，尺度 4→32 周期） */
  toneNoise: number;
  /** 同一份 fbm 叠进高度场的比例（让法线在多个尺度上都有内容，不是只有缝） */
  reliefNoise: number;
  /** 竖向水痕幅度（沿墙面/柱身流下的雨痕；噪声 x 方向高频、y 方向低频） */
  streak: number;
  /** 苔痕/生物附着（低频斑块，走 tint 通道偏绿，只在背阴面积起来） */
  moss: number;
  /** 边角磨光幅度（棱边被雨水/人手磨亮、磨圆） */
  edgeWear: number;
  /** 缝口不齐（缝宽沿缝长方向的抖动幅度） */
  ragged: number;
  /** 缺棱掉角（逐块的缝宽缩放，让个别块的缝更宽/更窄） */
  chip: number;
  /** 车辙磨损带（仅 floor）：沿行驶方向的两条磨光带 */
  rut: number;
}

const MASONRY: Record<'ashlar' | 'wall' | 'floor', MasonryProfile> = {
  // 主体白石：8 皮/图（0.35m 皮高）× 4 块/皮（0.70m 块长），半块错缝。
  // R29 参数全部按 R29_REF.ashlar 复核：贴图对比目标 ≈124（渲染后塌到 ≈68），
  // 颗粒主尺度 146 cyc/tile，法线 |xy| 目标 0.19。
  ashlar: {
    rows: 8,
    // cols 4→3（R29）：块长 0.70m → 0.93m，落进任务书的「砌块 0.9–1.2m」；
    // 皮高保持 0.35m ⇒ 块长宽比 2.66（哥特 ashlar 常见 2.5~3:1，旧 2.0 偏方）
    cols: 3,
    stagger: 0.5,
    jointPx: 1.8,
    bevelPx: 2.6,
    mortarShade: 0.82,
    blockTint: 0.16,
    faceRough: 0.8,
    jointRough: 0.93,
    // R29 实测标定：1.05→0.218 / 0.88→0.202（参考 0.186）⇒ 0.82
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
    rut: 0
  },
  // 次级灰白墙：块更大（2.4m × 1.44m）更灰，风化重、缝更粗；
  // 目标对比 ≈80（R29_REF.wall），法线比白石**更平**（|xy| 0.11 ⇒ normalStrength 低一档）。
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
    // R29 实测标定：参考墙法线比白石平一半（0.112 vs 0.186）⇒ 0.72→0.52
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
    rut: 0
  },
  // 地面石板：4×4 方板（1.2m）通缝对齐。
  // **R29 本轮重点**：参考包实测 n|xy| 0.192 / 颗粒 210 cyc/tile / 对比 31.9 /
  // 低频占比 0.507 —— 而 R28 实测本模块只有 n|xy| 0.088 / 颗粒能量 0.84 / 对比 24，
  // 差 2 倍多 ⇒ 这就是「地面看着没贴图」的量化根因。
  // 于是：normalStrength 0.35→0.85、relief 0.035→0.11、颗粒 0.02→0.055、
  // 并新增 rut（车辙磨光带）+ toneNoise + streak（雨水冲沟）。
  // 基色必须落在深炭灰 #413f3d 一档（参考包中位即此值）。
  floor: {
    rows: 4,
    cols: 4,
    stagger: 0,
    jointPx: 2.4,
    bevelPx: 3.2,
    mortarShade: 0.72,
    blockTint: 0.115,
    faceRough: 0.44,
    jointRough: 0.78,
    // R29 实测标定：0.85→0.175 / 0.95→0.215（参考 0.192）⇒ 0.90
    normalStrength: 0.86,
    relief: 0.11,
    grain: 0.095,
    stain: 0.34,
    grime: 0.22,
    wear: 0.2,
    toneNoise: 0.74,
    reliefNoise: 0.7,
    streak: 0.1,
    moss: 0,
    edgeWear: 0.1,
    ragged: 0.3,
    chip: 0.3,
    rut: 0.34
  }
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
  grainAmp: 0.11,
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

/** 乱石坡面 / 鎏金的缝底亮度比与闪光幅度（结构不同，单独给） */
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
  /** albedo 亮度 p05 / p50 / p95（256 桶直方图近似，不排序，够用且便宜） */
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

/** 空字段（振幅为 0 的层用它占位，省掉一次 size² 的展开） */
const EMPTY: Float32Array = new Float32Array(0);

/** 振幅为 0 的层直接跳过（省一次 size² 展开 + 一次内循环读数） */
function optField(amp: number, build: () => NoiseField, size: number): Float32Array {
  return amp > 0 ? expandField(build(), size) : EMPTY;
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
 * 其余族 512 —— 理由：石材是**重复平铺**的（2.8m/张），512² 已有 183 px/m，
 * 1024 对远景是纯浪费（mip 一样会降采样），却要把启动耗时翻 4 倍。
 */
export function stoneTextureSize(kind: StoneKind, tier: QualityTier): number {
  const hero = kind === 'ashlar' || kind === 'floor';
  if (tier === 'high') return hero ? 1024 : 512;
  if (tier === 'medium') return hero ? 512 : 256;
  return 256;
}

// ── 高度场 ────────────────────────────────────────────────────────────

/**
 * 砌体高度场（ashlar / wall / floor 共用）。
 * 填 height（法线/颜色阴影/粗糙度的唯一真源）、tone（albedo 在 dark→light 上的位置）、
 * roughness、moss（苔痕遮罩，走 tint 通道）。
 *
 * ── R29 多尺度分层（每层的尺度与职责）─────────────────────────────────
 *   baseFbm  4 octave（周期 4→32）  基色/起伏的多尺度底噪 —— 「不是一层噪声加滤镜」的主力
 *   relief   单频（周期 16）        石面微起伏（砍凿面）
 *   stain    fbm 3 octave           污渍斑块（中频）
 *   grime    fbm 2 octave（2×8）    横向拉长的积灰/雨水痕带（跨多块连成一片）
 *   streak   fbm 2 octave（12×3）   竖向水痕（沿墙面流下）
 *   moss     fbm 2 octave（3×3）    苔痕斑块（低频，只压 tint 不压明度）
 *   rag      单频（4×块数）         缝口不齐 —— 缝宽沿缝长抖动
 *   wear     单频（2×2）            行走磨光带（大尺度低频）
 *   grain    2px 查表白噪            高频颗粒
 */
function buildMasonry(
  size: number,
  seed: number,
  weather: number,
  prof: MasonryProfile,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array,
  mossOut: Float32Array | null
): void {
  const rowH = size / prof.rows;
  const colW = size / prof.cols;
  const invColW = 1 / colW;
  const fres = Math.max(64, Math.min(256, size >> 1));

  const baseFbm = optField(Math.max(prof.toneNoise, prof.reliefNoise), () => fbmField(fres, 4, 4, 4, seed + 101), size);
  const stainField = optField(prof.stain, () => fbmField(64, 4, 4, 3, seed + 11), size);
  const reliefField = optField(prof.relief, () => noiseField(Math.min(256, size), 16, 16, seed + 37), size);
  const grimeField = optField(prof.grime, () => fbmField(128, 2, 8, 2, seed + 83), size);
  const streakField = optField(prof.streak, () => fbmField(128, 12, 3, 2, seed + 139), size);
  const mossField = optField(prof.moss, () => fbmField(64, 3, 3, 2, seed + 157), size);
  const ragField = optField(prof.ragged, () => noiseField(128, prof.cols * 4, prof.rows * 4, seed + 181), size);
  const wearField = prof.wear > 0 ? expandField(noiseField(128, 2, 2, seed + 71), size) : EMPTY;
  const rutField = prof.rut > 0 ? expandField(noiseField(128, 3, 2, seed + 211), size) : EMPTY;

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

  // 每块的色差/起伏/磨损/缝宽用 LCG 预生成（块数很少），逐像素只查表
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
  const hasMoss = mossField.length > 0 && mossOut !== null;
  const mossLo = 0.58 - 0.22 * weather;

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

      // 缝口不齐：缝的「有效边界」沿缝长抖动（rag），再叠逐块的缝宽缩放（chip）
      const rag = ragField.length ? (ragField[index] - 0.5) * prof.ragged : 0;
      const jw = blockChip[block] * (1 + rag);
      const edge = Math.min(lx, colW - lx, ly, rowH - ly) / jw;
      const bevel = smoothstep(halfJoint, bevelEnd, edge);

      const base = baseFbm.length ? baseFbm[index] : 0.5;
      const reliefV = reliefField.length ? reliefField[index] : 0.5;
      const grain = grainTable[grainRow + grainCol[x]];
      const grime = grimeField.length ? grimeField[index] : 0.5;
      const streak = streakField.length ? streakField[index] : 0.5;

      // —— 高度场（法线 / 缝阴影 / 粗糙度的唯一真源）——
      let h = 0.1 + 0.9 * bevel;
      h += (reliefV - 0.5) * prof.relief * (0.55 + 0.9 * blockRelief[block]) * bevel;
      h += (base - 0.5) * prof.relief * prof.reliefNoise * bevel; // 多尺度起伏
      h += grain * prof.grain;
      height[index] = clamp01(h);

      // —— 明度（tone）——
      // 边角磨光：离块边越近越亮（被雨水/人手磨亮），且逐块强度不同
      const edgeNear = 1 - smoothstep(halfJoint, bevelEnd * 2.2, edge);
      const wearEdge = edgeNear * blockWear[block] * prof.edgeWear;

      let t = 0.5;
      t += blockTint[block];
      t += (reliefV - 0.5) * 0.22;
      t += (base - 0.5) * prof.toneNoise; // 多倍频基色噪声（多尺度主力）
      if (stainField.length) t += (stainField[index] - 0.5) * prof.stain * weather;
      t -= (1 - bevel) * 0.12 * weather; // 缝口先积灰：凹处比块面脏得快
      t -= (grime - 0.42) * prof.grime * (0.55 + 0.45 * weather);
      t -= (streak - 0.45) * prof.streak * weather; // 竖向水痕
      t += grain * prof.grain * 1.6; // 高频颗粒直进 albedo（绕开 shade 饱和）
      t += wearEdge;

      let rough = prof.jointRough + (prof.faceRough - prof.jointRough) * smoothstep(0.42, 0.95, bevel);
      rough += (reliefV - 0.5) * 0.08 * weather;
      rough += Math.max(0, grime - 0.42) * prof.grime * 0.35; // 积灰处更哑
      rough -= wearEdge * 0.5; // 磨光处更亮更滑（同源：提亮+变滑才读得像被摸过）
      if (wearField.length) {
        // 石板被踩出的磨光带：大尺度低频，压低 roughness 才读得出「抛光」
        const wear = smoothstep(0.45, 0.9, wearField[index]);
        rough -= wear * prof.wear * bevel;
        t -= wear * 0.05;
      }
      if (rutField.length) {
        // 车辙：沿 x 的两条固定磨光带（|x−0.32| / |x−0.68|），带内磨亮 + 压粗糙度。
        // 车行带是 400m 长的水平面，这两条带是唯一能读出「这是条路不是块场地」的线索。
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
 * 鎏金饰带：沿 x 拉长的各向异性刷纹 + 低频氧化斑 + **铸造麻点** + **抛光高光斑**。
 * 氧化斑同时压暗、抬粗糙度、压低高度 —— 三者同源，才不会被读成「贴上去的脏点」。
 * R29：参考包 Details_* 实测 metalness 0.789、gloss⇒roughness 0.524、R−B +118、
 * 对比 143 ⇒ 金是**高对比**族（不是均匀黄），但 albedo 即反射色，**不能做脏**。
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
  // R29 新增：铸造麻点（低频斑块内的一簇小凹坑）+ 抛光高光斑（被人摸亮的大块区域）
  const pitField = expandField(noiseField(Math.min(512, size), 48, 48, seed + 89), size);
  const polishField = expandField(fbmField(128, 3, 3, 2, seed + 97), size);

  for (let y = 0; y < size; y += 1) {
    const dstRow = y * size;
    for (let x = 0; x < size; x += 1) {
      const index = dstRow + x;
      const b1 = brush[index];
      const b2 = brushFine[index];
      const ox = oxField[index];
      const grain = grainField[index] - 0.5;
      const pit = pitField[index];
      const polish = polishField[index];
      // 氧化：低频斑块取门限上段，weather 越高斑越多
      const oxidized = smoothstep(0.62 - 0.22 * weather, 0.9, ox);
      // 麻点：只在「未被氧化」的金属面上可见（氧化层把麻点填平了）
      const pits = smoothstep(0.72, 0.88, pit) * (1 - oxidized) * weather;
      // 抛光斑：大尺度低频，压粗糙度 ⇒ 环境反射上出现一块块亮斑
      const shine = smoothstep(0.52, 0.8, polish);

      let h = 0.58 + (b1 - 0.5) * 0.26 + (b2 - 0.5) * 0.13;
      h += grain * 0.015;
      h -= oxidized * 0.16;
      h -= pits * 0.22; // 麻点是凹的
      height[index] = clamp01(h);

      let t = 0.5 + (b1 - 0.5) * 0.35 + (b2 - 0.5) * 0.2;
      t -= oxidized * 0.62; // 氧化斑压到暗金 #39301f 一带
      t -= pits * 0.1; // 麻点底部积垢
      t += grain * 0.05;
      t += shine * 0.08; // 抛光斑更亮（不是更黄）
      tone[index] = clamp01(t);

      // 抛光面 0.47（R29：参考 gloss 反解 roughness 0.524，旧 0.34 太镜面 ⇒ 磨砂金）；
      // 刷纹沟槽略高；氧化斑明显发哑（+0.34）
      let rough = 0.47 + (b2 - 0.5) * 0.16 + Math.abs(b1 - 0.5) * 0.1;
      rough += oxidized * 0.34;
      rough += pits * 0.2; // 麻点底是哑的
      rough -= shine * 0.14; // 抛光斑更滑 ⇒ 亮
      roughness[index] = clamp01(rough);
    }
  }
}

/**
 * 屋面板岩瓦（R29 新增）：12 皮 × 8 片、半片错缝的搭接板岩。
 * 每片沿自身高度做**单拱**（sin 半周期）⇒ 掠光下一排排瓦楞；片间缝是深缝（板岩薄、搭接暗）。
 * 风化：苔痕（moss 最大）、竖向水痕、锈斑靠 stain 承担。
 */
function buildRoof(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array,
  mossOut: Float32Array | null
): void {
  const P = SHINGLE;
  const rowH = size / P.rows;
  const colW = size / P.cols;
  const invColW = 1 / colW;
  const reliefField = expandField(noiseField(Math.min(256, size), 24, 24, seed + 37), size);
  const stainField = expandField(fbmField(64, 4, 4, 3, seed + 11), size);
  const mossField = P.moss > 0 ? expandField(fbmField(64, 3, 3, 2, seed + 157), size) : EMPTY;
  const streakField = expandField(fbmField(128, 24, 3, 2, seed + 139), size);
  const ragField = expandField(noiseField(128, P.cols * 4, P.rows * 4, seed + 181), size);

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

  for (let y = 0; y < size; y += 1) {
    const row = Math.min(P.rows - 1, Math.floor(y / rowH));
    const ly = y - row * rowH;
    const rowBase = row * P.cols;
    const dstRow = y * size;
    const grainRow = Math.floor(y / grainStep) * grainRes;
    // 片内归一化高度 → 单拱：拱顶在片中部，上下缘落低 ⇒ 瓦楞
    const lyN = ly / rowH;
    const arch = Math.sin(Math.PI * lyN);
    let fx = 0.5 * (row % 2);
    for (let x = 0; x < size; x += 1) {
      const index = dstRow + x;
      const colRaw = Math.floor(fx);
      const lx = (fx - colRaw) * colW;
      const col = ((colRaw % P.cols) + P.cols) % P.cols;
      const block = rowBase + col;
      const rag = (ragField[index] - 0.5) * P.ragged;
      const edge = Math.min(lx, colW - lx, ly, rowH - ly) / (1 + rag);
      const bevel = smoothstep(halfJoint, bevelEnd, edge);
      const reliefV = reliefField[index];
      const grain = grainTable[grainRow + grainCol[x]];
      const streak = streakField[index];

      let h = 0.1 + 0.9 * bevel;
      h += (0.35 + 0.65 * arch) * 0.16 * bevel; // 单拱（瓦楞）
      h += (reliefV - 0.5) * P.relief * bevel;
      h += grain * P.grain;
      height[index] = clamp01(h);

      let t = 0.5 + blockTint[block] + (reliefV - 0.5) * 0.2;
      t += (stainField[index] - 0.5) * P.stain * weather;
      t -= (1 - bevel) * 0.2 * weather; // 搭接缝里最暗
      t -= (streak - 0.45) * P.streak * weather;
      t += grain * P.grain * 1.6; // 同上：颗粒直进 albedo
      t += (arch - 0.5) * 0.06; // 拱顶受光更亮（不是靠法线，靠积灰少）
      tone[index] = clamp01(t);

      let rough = P.jointRough + (P.faceRough - P.jointRough) * smoothstep(0.42, 0.95, bevel);
      rough += (reliefV - 0.5) * 0.07 * weather;
      roughness[index] = clamp01(rough);

      if (mossField.length && mossOut) {
        mossOut[index] = smoothstep(mossLo, mossLo + 0.26, mossField[index]) * P.moss * 3;
      }
      fx += invColW;
    }
  }
}

/**
 * 木板（R29 新增）：4 块竖向板 + 深板缝；**各向异性木纹**（x 高频 / y 低频 ⇒ 顺板长竖纹）
 * + 节疤（低频斑块，压暗 + 抬粗糙 + 局部拱起）+ 竖向水痕（老木门被雨淋的竖黑条）。
 */
function buildWood(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): void {
  const P = PLANK;
  const colW = size / P.cols;
  const invColW = 1 / colW;
  const grainField = expandField(noiseField(Math.min(512, size), P.grainPeriodX, P.grainPeriodY, seed + 23), size);
  const fineField = expandField(noiseField(Math.min(512, size), P.grainPeriodX * 2, P.grainPeriodY * 2, seed + 31), size);
  const knotField = expandField(fbmField(128, 4, 4, 2, seed + 43), size);
  const stainField = expandField(fbmField(64, 4, 4, 3, seed + 11), size);
  const streakField = expandField(fbmField(128, 16, 3, 2, seed + 139), size);
  const reliefField = expandField(noiseField(Math.min(256, size), 12, 12, seed + 37), size);

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

  for (let y = 0; y < size; y += 1) {
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
      const streak = streakField[index];

      // 木纹在法线上也要出现（顺纹的细沟），否则侧面掠光时是块塑料板
      // 0.88→0.62：块面 h 从 1.0（shade 饱和、颗粒看不见）降回 0.74
      let h = 0.12 + 0.62 * bevel;
      h += (g1 - 0.5) * P.grainAmp * bevel;
      h += (g2 - 0.5) * P.grainAmp * 0.5 * bevel;
      h += knot * 0.1 * bevel; // 节疤拱起
      h += (reliefV - 0.5) * P.relief * bevel;
      h += grain * P.grain;
      height[index] = clamp01(h);

      let t = 0.5 + plankTint[col];
      t += (g1 - 0.5) * 0.3 + (g2 - 0.5) * 0.16; // 顺纹明暗
      t += (stainField[index] - 0.5) * P.stain * weather;
      t -= (1 - bevel) * 0.24 * weather; // 板缝最暗
      t -= (streak - 0.45) * P.streak * weather;
      t -= knot * P.knot * 0.5; // 节疤是深色的
      t += grain * P.grain * 1.6; // 同上：颗粒直进 albedo
      tone[index] = clamp01(t);

      let rough = P.jointRough + (P.faceRough - P.jointRough) * smoothstep(0.42, 0.95, bevel);
      rough += Math.abs(g1 - 0.5) * 0.1; // 纹沟更哑
      rough += knot * 0.16;
      roughness[index] = clamp01(rough);
      fx += invColW;
    }
  }
}

/**
 * 铅条窗玻璃（R29 新增）：3×2 铅条格 + **极平**的玻璃面（只有老玻璃的极缓波纹）。
 * ⚠ 走**不透明**路径（metalness 低 + roughness 极低 + 高 envMapIntensity），
 *   **不开 transmission** —— R12 铁律⑤：透射 pass 会让整场景重绘（DC 244 的根因）。
 * 铅条：更暗、更粗糙；玻璃：亮、极滑 ⇒ 掠光下铅条是暗格、玻璃是亮的反射面。
 */
function buildGlass(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): void {
  const P = PANE;
  const rowH = size / P.rows;
  const colW = size / P.cols;
  const invColW = 1 / colW;
  const wave = expandField(fbmField(128, 3, 3, 3, seed + 51), size);
  const dirt = expandField(fbmField(128, 2, 6, 2, seed + 59), size);

  const halfJoint = P.jointPx * 0.5;
  const bevelEnd = halfJoint + P.bevelPx;

  for (let y = 0; y < size; y += 1) {
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
      const w = wave[index];
      const d = dirt[index];

      // 铅条是凸起的（能摸到），玻璃面有极缓的波纹
      let h = 0.42 + 0.5 * bevel;
      h += (w - 0.5) * P.waviness * bevel;
      h += (1 - bevel) * 0.14; // 铅条高于玻璃
      height[index] = clamp01(h);

      let t = 0.5 + (w - 0.5) * 0.34; // 玻璃厚薄不匀 ⇒ 明度不匀
      t -= (1 - bevel) * 0.55; // 铅条深色
      t -= (d - 0.45) * 0.2 * weather; // 积尘（横向拉长，窗下沿更脏）
      tone[index] = clamp01(t);

      // 玻璃极滑（0.07），铅条哑（0.55）；积尘处略抬
      let rough = P.faceRough + (P.jointRough - P.faceRough) * (1 - smoothstep(0.4, 0.95, bevel));
      rough += Math.max(0, d - 0.45) * 0.3 * weather;
      roughness[index] = clamp01(rough);
      fx += invColW;
    }
  }
}

/**
 * 大理石柱身/台基（R29 新增）：无块缝，靠**脊化噪声**（ridged fbm）出脉络。
 * 竖直拉长（x 低频 / y 高频）⇒ 顺柱身的脉；抛光面（roughness 0.18）只在脉上略哑。
 * 高度场几乎平（抛光石材），所以 normalStrength 给得很低 —— 强行做法线会读成塑料。
 */
function buildMarble(
  size: number,
  seed: number,
  weather: number,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array
): void {
  const V = VEIN;
  const fres = Math.max(64, Math.min(256, size >> 1));
  const vein = expandField(fbmField(fres, V.periodX, V.periodY, V.octaves, seed + 71), size);
  const fine = expandField(noiseField(Math.min(256, size), 24, 48, seed + 79), size);
  const cloud = expandField(fbmField(128, 4, 4, 3, seed + 87), size);

  const grainRes = Math.max(64, size >> 1);
  const grainStep = size / grainRes;
  const grainTable = new Float32Array(grainRes * grainRes);
  for (let gy = 0; gy < grainRes; gy += 1) {
    for (let gx = 0; gx < grainRes; gx += 1) grainTable[gy * grainRes + gx] = hash2(gx, gy, seed + 7) - 0.5;
  }
  const grainCol = new Int32Array(size);
  for (let x = 0; x < size; x += 1) grainCol[x] = Math.floor(x / grainStep);

  for (let y = 0; y < size; y += 1) {
    const dstRow = y * size;
    const grainRow = Math.floor(y / grainStep) * grainRes;
    for (let x = 0; x < size; x += 1) {
      const index = dstRow + x;
      const v = vein[index];
      // 脊化：|2v−1| 取反 ⇒ 在 fbm 的等值线上出现细脉
      const ridge = 1 - Math.abs(v * 2 - 1);
      const vm = smoothstep(V.veinSharp, 0.98, ridge);
      const c = cloud[index];
      const f = fine[index];
      const grain = grainTable[grainRow + grainCol[x]];

      let h = 0.62 + (f - 0.5) * V.relief + grain * V.grain;
      h -= vm * 0.12; // 脉比基体略凹（软脉被磨掉一点）
      height[index] = clamp01(h);

      let t = 0.5 + (c - 0.5) * 0.3 * (0.5 + 0.5 * weather);
      t -= vm * 0.42; // 脉是灰的
      t += (f - 0.5) * 0.05;
      t += grain * V.grain * 2.2; // 同上：颗粒直进 albedo
      tone[index] = clamp01(t);

      let rough = V.faceRough + (V.veinRough - V.faceRough) * vm;
      rough += (c - 0.5) * 0.04 * weather;
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
  /** 苔痕遮罩（0..1）+ 苔色，走 tint 通道压进 albedo */
  moss: Float32Array | null;
  mossColor: Rgb;
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
  const { size, seed, base, light, dark, height, tone, roughness, moss, mossColor } = build;
  const count = size * size;
  const albedo = new Uint8ClampedArray(count * 4);
  const normal = new Uint8ClampedArray(count * 4);
  const rough = new Uint8ClampedArray(count * 4);
  const scale = build.normalStrength * 6;
  const shadeLo = build.mortarShade;
  const hasMoss = moss !== null;

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
      // ⚠ 饱和陷阱（R29 实测踩到）：h > 0.9 之后 smoothstep 饱和 ⇒ 高频颗粒**进不了**
      //   albedo（木/大理石块面 h≈1.0，加了 grain 也看不出来）。所以每个族都另外把
      //   grain 直接加进 tone（见各 builder 的 `t += grain * …`），双重保险。
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

  scatterSparkles(albedo, size, seed, build.sparkle);
  return { albedo, normal, rough };
}

/**
 * 稀疏亮点（白石晶体 / 金箔剥落 / 玻璃反光点）。
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
 * 输出统计（口径对齐 tools/r29_tex_stats.py）：
 * 亮度走 256 桶直方图取分位（不排序，O(n)），颗粒/法线抽样 1/16 —— 全部 O(n)，
 * 1024² 上约 3~5ms，比排序取分位便宜一个数量级。
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

  // 颗粒能量：3×3 高通残差 std（抽样步长 2 ⇒ 1/4 像素）
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

  // 法线 |xy| 均值（抽样 1/16）
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
  let moss: Float32Array | null = null;
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
    // R29 实测标定：0.5→0.069 / 1.15→0.277（参考 0.159）⇒ 0.72
    normalStrength = 0.72;
    mortarShade = GOLD_SHADE;
  } else if (kind === 'roof') {
    moss = new Float32Array(count);
    buildRoof(size, seed, weather, height, tone, roughness, moss);
    normalStrength = SHINGLE.normalStrength;
    mortarShade = 0.55;
  } else if (kind === 'wood') {
    buildWood(size, seed, weather, height, tone, roughness);
    normalStrength = PLANK.normalStrength;
    mortarShade = 0.42;
  } else if (kind === 'glass') {
    buildGlass(size, seed, weather, height, tone, roughness);
    normalStrength = PANE.normalStrength;
    mortarShade = 0.62;
  } else if (kind === 'marble') {
    buildMarble(size, seed, weather, height, tone, roughness);
    normalStrength = VEIN.normalStrength;
    mortarShade = 0.9;
  } else {
    const prof = MASONRY[kind];
    if (prof.moss > 0) moss = new Float32Array(count);
    buildMasonry(size, seed, weather, prof, height, tone, roughness, moss);
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
    moss,
    mossColor: hexToRgb('#5b6b3a'),
    mortarShade,
    sparkle: SPARKLE[kind],
    normalStrength
  });
  const stats = measureStats(size, maps.albedo, maps.normal, maps.rough);

  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { size, albedo: maps.albedo, normal: maps.normal, rough: maps.rough, elapsedMs: ended - started, stats };
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
 * 取石材三张贴图。同 kind + 同参数复用同一组纹理：教堂立面上几十个构件共用一个色族，
 * 重复生成几十次会直接吃掉首屏时间。
 *
 * ⚠ R29：`size` 建议由 `stoneTextureSize(kind, tier)` 给（按质量档分尺寸）；
 *   不传则回落到 512（与 R28 一致）。
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
  // 只在新生成时打印一次：缓存命中保持安静，否则每次取图都刷一行
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
