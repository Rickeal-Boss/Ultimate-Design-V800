/**
 * refTextures.ts —— R15-2 参考图贴图接线（src/assets/ref/*.jpg → 车模材质）
 *
 * 背景：`.img2threejs` 侧长期执行「零外部资产」铁律，内饰一直是纯色 / 程序化 Canvas 贴图。
 * R15 用户指令明确要求接 6 张实拍参考图，本模块是这条指令的**唯一**落地口：
 *   1. 只认 `material.userData.sculptMaterial.id`（材质 id）与 `mesh.userData.sculptComponent.id`
 *      （组件 id）—— 两者**不是**同一个命名空间（leather-warm  MATERIAL 同时服务
 *      cabin-interior / seat-* / door-panel-* 三类组件），按材质一刀切会把整舱刷成绗缝。
 *   2. UV 全部**由世界坐标重建**（三平面 / 盒投影），绝不读既有图集 UV 做线性 remap ——
 *      既有 UV 是图集分区坐标（extrude 基元实测 u∈[-0.33,1.0]，圆角件 u∈[-0.5,0.5]、
 *      v∈[-0.5,1.0]），线性压进目标区必然越界串味（R3 一次 814 个三角形）。
 *      模块同时导出 `normalizeUVToRegion()`（= 适配器 remapUVToRegion 的同一语义：
 *      先测 mesh 自身 UV bbox 再归一压进目标区），供将来接入图集时使用。
 *   3. 输出 UV 一律落在自己声明的矩形内并 clamp —— 对「未预料 UV 范围」安全。
 *   4. 各向异性 ≤ 8x：平铺单元按图幅宽高比反算重复次数（见 `repeatsFor`），
 *      逐三角形实测 `distortion`（世界每 UV 的 u/v 比 ÷ 图幅宽高比），报告里给 max 值。
 *   5. 优雅降级：贴图加载失败 / 缺文件 / 无 DOM → 保持现有程序化贴图，不抛错不黑屏。
 *
 * 调用位置（硬契约）：必须在 V800Adapter 的「R12b 内饰材质纯化（终局覆盖）」**之后**、
 * `batchMergeStatic()` **之前**。纯化会撤掉 map；合批会把同材质 mesh 压成一个 ——
 * 之后再挂图就会「换一张图连带影响同组其他 mesh」。接线片段见 docs/wip-r15-reftex.md。
 */

import * as THREE from 'three';

import seatQuiltUrl from '../assets/ref/seat-quilt.jpg';
import seatCushionUrl from '../assets/ref/seat-cushion.jpg';
import leatherPlainUrl from '../assets/ref/leather-plain.jpg';
import headlinerStarUrl from '../assets/ref/headliner-star.jpg';
import screenCockpitUrl from '../assets/ref/screen-cockpit.jpg';
import tailLampUrl from '../assets/ref/tail-lamp.jpg';
import triScreenUiUrl from '../assets/ref/tri-screen-ui.jpg';

/* ================================================================
 * 0. 类型
 * ================================================================ */

export type RefImageId =
  | 'seat-quilt'
  | 'seat-cushion'
  | 'leather-plain'
  | 'headliner-star'
  | 'screen-cockpit'
  | 'tail-lamp'
  | 'tri-screen-ui';

export type RefTier = 'high' | 'medium' | 'low';

/** 挂载通道：albedo（map）与自发光（emissiveMap） */
export type RefChannel = 'map' | 'emissiveMap';

export interface RefTextureOptions {
  /** 质量档：决定长边上限与部分规则是否启用；默认 'high' */
  tier?: RefTier;
  /** 各向异性上限，硬钳 8（R12b 教训：>8 出方向性摩尔纹）；默认 8 */
  maxAnisotropy?: number;
  /** 贴图长边上限；默认按 tier（high 1024 / medium 768 / low 384） */
  maxSize?: number;
  /**
   * 组件 id 全缺失（= 已经在合批之后调用）时，是否允许退化为「按材质 id 一刀切」。
   * 默认 false —— 一刀切会把 cabin-interior 整舱刷成绗缝，是宁可跳过的缺陷。
   */
  allowMaterialFallback?: boolean;
  /** 控制台输出挂载清单；默认 false */
  verbose?: boolean;
}

export interface RefMeshReport {
  componentId: string;
  materialId: string;
  image: RefImageId;
  uv: 'triplanar' | 'planar';
  /** 世界包围盒尺寸 [x,y,z]（m） */
  bbox: [number, number, number];
  /** 平铺次数 [u,v] */
  repeat: [number, number];
  /** 写入后实际 UV 范围 [uMin,uMax,vMin,vMax]（应落在 [0,repeatU]×[0,repeatV] 内） */
  uvRange: [number, number, number, number];
  /** 世界每 UV 的 u/v 长度比（未计图幅宽高比） */
  uvAspect: number;
  /** ≥1：相对图幅宽高比的实际拉伸 = 各向异性需求（>8 判死） */
  distortion: number;
  /** 贴图是否已真正挂上（false = 等待加载） */
  attached: boolean;
}

export interface RefApplyReport {
  image: RefImageId;
  materialIds: string[];
  meshes: RefMeshReport[];
  status: 'attached' | 'pending' | 'failed' | 'no-target' | 'skipped-tier';
  reason?: string;
  note: string;
}

export interface UvAspectReport {
  triangles: number;
  /** 逐三角形最大 |dPdu|/|dPdv|（已按 imageAspect 归一，≥1） */
  maxAspect: number;
  /** 95 分位 */
  p95Aspect: number;
  /** distortion > 8 的三角形数 */
  over8: number;
}

/* ================================================================
 * 1. 资产元数据（尺寸为实测值，用于 repeat 反算与自检）
 * ================================================================ */

interface RefImageMeta {
  id: RefImageId;
  url: string;
  /** 实测像素宽（与文件一致；加载后会复核，不符仅 warn） */
  width: number;
  height: number;
}

const REF_IMAGE_META: Record<RefImageId, RefImageMeta> = {
  'seat-quilt': { id: 'seat-quilt', url: seatQuiltUrl, width: 1024, height: 1024 },
  'seat-cushion': { id: 'seat-cushion', url: seatCushionUrl, width: 1024, height: 1024 },
  'leather-plain': { id: 'leather-plain', url: leatherPlainUrl, width: 512, height: 512 },
  'headliner-star': { id: 'headliner-star', url: headlinerStarUrl, width: 1024, height: 512 },
  'screen-cockpit': { id: 'screen-cockpit', url: screenCockpitUrl, width: 512, height: 256 },
  'tail-lamp': { id: 'tail-lamp', url: tailLampUrl, width: 256, height: 512 },
  // R17：真车三联屏正视裁剪（087Z 参考图屏体区域，790×110 ≈ 7.18:1 与 tri-screen
  // 1.52×0.212 的 7.17:1 同比）——整幅铺满一屏，forced repeat [1,1] 零拉伸。
  'tri-screen-ui': { id: 'tri-screen-ui', url: triScreenUiUrl, width: 790, height: 110 },
};

export const REF_IMAGE_IDS: readonly RefImageId[] = Object.keys(REF_IMAGE_META) as RefImageId[];

/** 图幅宽高比 w/h（声明值；加载后复核） */
function imageAspect(id: RefImageId): number {
  const m = REF_IMAGE_META[id];
  return m.height > 0 ? m.width / m.height : 1;
}

const TIER_MAX_SIZE: Record<RefTier, number> = { high: 1024, medium: 768, low: 384 };

/* ================================================================
 * 2. 规则表（改贴图落点只改这里）
 * ================================================================ */

interface RefRule {
  image: RefImageId;
  /**
   * 允许的**材质 id**（userData.sculptMaterial.id）。空数组 = 不限材质。
   * 注意这是 OR 过滤，不能区分「同 id 的多个克隆材质实例」——
   * 真正的主键是下面的 components。
   */
  materials: readonly string[];
  /** 组件 id 精确匹配（userData.sculptComponent.id）—— 唯一可靠主键 */
  components: readonly string[];
  /** UV 生成方式 */
  uv: 'triplanar' | 'planar';
  /** 目标平铺单元世界边长（m，几何平均口径；单元实际尺寸 = tile·√aspect × tile/√aspect） */
  tileWorld: number;
  /**
   * 三平面 UV 的锚点：
   *  · 'world'（默认）= 绝对世界坐标 —— 相邻件的纹样相位连续（座椅菱格要这个）；
   *  · 'local' = 减去自身包围盒原点 —— UV 落在 [0,n] 内，取图位置可预测（小件发光件要这个）。
   */
  anchor?: 'world' | 'local';
  /** 强制平铺次数（跳过自动反算） */
  repeat?: readonly [number, number];
  channels: readonly RefChannel[];
  /** 挂 emissiveMap 时是否把 emissive 置白（图本身决定发光颜色） */
  emissiveWhite?: boolean;
  emissiveIntensity?: number;
  /** 自动染色目标色（hex）：让照片的平均亮度回到策展色，避免整舱色调被照片带跑 */
  tintTarget?: string;
  /** 按材质 id 覆盖染色目标（同一规则服务多材质时用） */
  tintTargetByMaterial?: Record<string, string>;
  /** 哪些档位启用本规则 */
  tiers: readonly RefTier[];
  note: string;
}

/** R12b 纯化策展色（与本模块染色目标同源，改色请同步两边） */
const CURATED = {
  'leather-warm': '#6B4437',
  'leather-dark': '#2A211D',
  'leather-ivory': '#D6D0C4',
  'headliner-suede': '#6F6862',
  starlight: '#3A2A20',
} as const;

const SEAT_QUILT_COMPONENTS = [
  'seat-driver',
  'seat-driver-back',
  'seat-passenger',
  'seat-passenger-back',
  'seat-rear-l',
  'seat-rear-l-back',
  'seat-rear-r',
  'seat-rear-r-back',
  'seat-third-row',
  'seat-third-row-back',
] as const;

/** 细纹近景图给小件：头枕 / 腿托 / 扶手（与菱格分区，避免大件小件同密度） */
const SEAT_CUSHION_COMPONENTS = [
  'seat-driver-headrest',
  'seat-passenger-headrest',
  'seat-rear-l-headrest',
  'seat-rear-r-headrest',
  'seat-third-row-headrest',
  'seat-rear-l-legrest',
  'seat-rear-r-legrest',
  'seat-rear-l-armrest',
  'seat-rear-r-armrest',
] as const;

/** R7（智界R7）座椅坐垫/靠背 —— 菱格绗缝大件 */
const SEAT_QUILT_COMPONENTS_R7 = [
  'seat-driver-cushion',
  'seat-driver-back',
  'seat-passenger-cushion',
  'seat-passenger-back',
  'seat-rear-cushion',
  'seat-rear-back',
] as const;

/** R7 头枕（细纹近景件） */
const SEAT_CUSHION_COMPONENTS_R7 = [
  'seat-driver-headrest',
  'seat-passenger-headrest',
  'headrest-rear-l',
  'headrest-rear-r',
] as const;

const REF_RULES: readonly RefRule[] = [
  {
    image: 'seat-quilt',
    materials: ['leather-warm', 'leather-ivory'],
    components: [...SEAT_QUILT_COMPONENTS, ...SEAT_QUILT_COMPONENTS_R7],
    uv: 'triplanar',
    // R17：密度不动（0.24 → 椅面单元格 ~2cm，实测与真车 087Z 参考同级）。
    // 原图「方块化」的病因是**对比度**：实拍被强光照渐变（边缘亮度 94→130）压制，
    // ~2px 细缝线在 mip 下糊成大平面块。已用 tools/r17_requilt.py 重 author 图源：
    // 平场（flat-field）去渐变 + unsharp 强化缝线，四边亮度差 35→9.3 可平铺。
    tileWorld: 0.24, // 座面 0.52m → ≈2.2 次（R12b 要求座椅 2~3 次）
    channels: ['map'],
    tintTarget: CURATED['leather-warm'],
    // R7 座椅是米白双色（参考图 6/8）：同一张菱格图，染色目标按材质分派，
    // 否则米白座椅会被染成 V800 的 Cognac 棕。
    tintTargetByMaterial: { 'leather-ivory': CURATED['leather-ivory'] },
    tiers: ['high', 'medium', 'low'],
    note: '焦糖菱格绗缝 → 座椅坐垫/靠背（大件）。三平面世界锚定，逐三角形各向同性。',
  },
  {
    image: 'seat-cushion',
    materials: ['leather-warm', 'leather-ivory'],
    components: [...SEAT_CUSHION_COMPONENTS, ...SEAT_CUSHION_COMPONENTS_R7],
    uv: 'triplanar',
    tileWorld: 0.13, // 头枕 0.26m → 2 次
    channels: ['map'],
    tintTarget: CURATED['leather-warm'],
    tintTargetByMaterial: { 'leather-ivory': CURATED['leather-ivory'] },
    tiers: ['high'],
    note: '皮面近景细纹 → 头枕/腿托/扶手（小件）。低档回退程序化贴图省一张 1024²。',
  },
  {
    image: 'leather-plain',
    materials: ['leather-warm', 'leather-dark', 'leather-ivory', 'leather-plum'],
    components: [
      'door-panel-fl',
      'door-panel-fr',
      'door-panel-rl',
      'door-panel-rr',
      'dash-upper',
      // R7（智界R7）门板 / 双色仪表台
      'door-card-front-l',
      'door-card-front-r',
      'door-card-rear-l',
      'door-card-rear-r',
      'door-trim-front-l',
      'door-trim-front-r',
      'door-trim-rear-l',
      'door-trim-rear-r',
      'dash-lower',
      'center-console',
    ],
    uv: 'triplanar',
    tileWorld: 0.6, // 图幅 1:1 → 门板 ≈2×1 个单元、仪表台 ≈3×1（盒投影实测薄侧面 5.5/13.2x，故走三平面）
    channels: ['map'],
    tintTarget: CURATED['leather-warm'],
    tintTargetByMaterial: {
      'leather-dark': CURATED['leather-dark'],
      'leather-ivory': CURATED['leather-ivory'],
      'leather-plum': '#6B4A6E',
    },
    tiers: ['high', 'medium', 'low'],
    note: '素皮革 → 门板内饰板 + 仪表台。R7 的紫灰上体（leather-plum）#6B4A6E 单独染色。',
  },
  {
    image: 'headliner-star',
    materials: ['starlight', 'headliner-suede', 'leather-ivory'],
    // R17：收紧范围 —— 原表含 headliner-rear（1.52×0.02×3.35 巨板，spec z -2.6~0.75，
    // world z -0.75~2.6），其**顶面** y1.726+0.02=1.746 是全车最高面，机盖相机
    // （hood，world (0,1.45,-1.45) 前俯）最先命中的就是它伸到风挡上沿的前缘条带
    // —— 星点图三平面世界锚定撒满整块板，机盖视角正上方就读出一片星（用户截图
    // 089Z「星空顶错位至引擎盖上方」）。星图只留顶棚本体两件；headliner-rear
    // 回归 R12b 素色（leather-ivory 策展底），车内后排顶棚为素面、机盖视角无星点外溢。
    components: ['starlight-headliner', 'headliner-front'],
    uv: 'triplanar',
    tileWorld: 1.05, // 图幅 2:1 → 单元 1.49×0.74m，顶棚 ≈1×2 个单元（盒投影薄侧面 5.4x，故走三平面）
    channels: ['map'],
    tintTarget: CURATED.starlight,
    tintTargetByMaterial: {
      'headliner-suede': CURATED['headliner-suede'],
      'leather-ivory': CURATED['leather-ivory'],
    },
    tiers: ['high', 'medium'],
    note: '星空顶 → 顶棚。只挂 albedo：starlight 的程序化 emissiveMap 星点阵保留做叠层发光。',
  },
  {
    // R17 三联屏专规：真车正视裁剪（tri-screen-ui.jpg，790×110）整幅铺满一块屏，
    // forced repeat [1,1]。旧 screen-cockpit 规则把 512×256 通用座舱截图 [3,1] 平铺
    // 三次 = 三段重复 UI + 竖向压扁（用户「三联屏贴图退化」）。tri-screen 从旧规则
    // 移除，只留后排/中控小屏继续用通用截图。
    image: 'tri-screen-ui',
    materials: ['screen-ui'],
    components: ['tri-screen'],
    uv: 'planar',
    tileWorld: 1.52, // 实际尺寸 1.52×0.212；repeat 强制 [1,1]，此值仅作 fallback
    repeat: [1, 1],
    channels: ['map', 'emissiveMap'],
    emissiveWhite: true,
    emissiveIntensity: 0.9,
    tintTarget: '#4A5568',
    tiers: ['high', 'medium', 'low'],
    note: '真车三联屏正视裁剪 → 三联屏整幅一图（零平铺零拉伸）。',
  },
  {
    image: 'screen-cockpit',
    materials: ['screen-ui'],
    // ⚠️ gauge-screen 刻意排除：适配器运行时用 CanvasTexture 逐帧画速度/踏板力，
    //    覆盖 map 会打死仪表（材质 gauge-ui，与本规则 screen-ui 不同 id）。
    // ⚠️ tri-screen 移交上面的 tri-screen-ui 专规（R17），本规则只管小屏。
    components: ['rear-control-screen', 'center-screen', 'rear-screen'],
    uv: 'planar',
    tileWorld: 0.45, // 小屏 0.24~0.345 宽 → [1,1] 单幅
    channels: ['map', 'emissiveMap'],
    emissiveWhite: true,
    emissiveIntensity: 0.85,
    tintTarget: '#4A5568',
    tiers: ['high', 'medium', 'low'],
    note: '中控/后排屏 UI 截屏 → 后排控制屏 + R7 中控/后排屏。albedo 压暗、emissive 承担亮屏观感。',
  },
  {
    image: 'tail-lamp',
    materials: ['lamp-red'],
    // rear-reflector-l/r 刻意排除：适配器已为后保反光条克隆专用材质，串图会毁掉反光条分段图案
    components: [
      'lantern-core-l',
      'lantern-core-r',
      'taillamp-bar-top-l',
      'taillamp-bar-top-r',
      'taillamp-bar-bottom-l',
      'taillamp-bar-bottom-r',
      // R7（智界R7）贯穿尾灯带 + 侧段
      'tail-light-bar',
      'tail-light-split-l',
      'tail-light-split-r',
      'tail-lamp-band',
    ],
    uv: 'triplanar',
    tileWorld: 0.05, // 图幅 1:2 → 单元 3.5×7.1cm，灯带 ≈2.4×0.4 个单元
    anchor: 'local', // 小件：UV 归到 [0,n]，取图位置可预测（world 锚点会落到 -80 这种任意相位）
    channels: ['map', 'emissiveMap'],
    emissiveWhite: true,
    emissiveIntensity: 1.2,
    tiers: ['high', 'medium', 'low'],
    note: '尾灯发光纹理 → 宫灯红芯 + 尾灯横带。图幅 1:2 竖图，单元按图幅反算保持纹素近正方。',
  },
];

/* ================================================================
 * 3. 贴图加载（每图只加载一次并缓存；失败静默降级）
 * ================================================================ */

type LoadStatus = 'loading' | 'ready' | 'failed';

interface CacheEntry {
  status: LoadStatus;
  tex: THREE.Texture | null;
  maxSize: number;
  anisotropy: number;
}

const texCache = new Map<RefImageId, CacheEntry>();
/** 贴图就绪后补挂的任务（贴图未解码时不挂 material，避免 three 绑空纹理 = 黑屏）。
 *  R18 修复：任务带 image id，flush 只消费「本图已就绪」的任务并把其余留在队列 ——
 *  旧实现每次 load 回调都清空整队，7 张图并行加载时除第一张外全部丢任务
 *  （三联屏因此永远停在适配器图集上）。 */
const pendingWires: Array<{ image: RefImageId; run: () => boolean }> = [];
/** 已改造的材质实例（用于 dispose 与避免重复克隆） */
const wiredMaterials: Array<{
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  src: THREE.Material;
  image: RefImageId;
  channels: readonly RefChannel[];
  prev: {
    map: THREE.Texture | null;
    emissiveMap: THREE.Texture | null;
    emissive: THREE.Color;
    emissiveIntensity: number;
    color: THREE.Color;
  };
}> = [];
const cloneCache = new Map<THREE.Material, Map<RefImageId, THREE.MeshStandardMaterial>>();
let lastReport: RefApplyReport[] = [];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** hex → 线性亮度（0..1） */
function hexLinearLuma(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applyTextureSettings(tex: THREE.Texture, anisotropy: number): void {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = clamp(Math.round(anisotropy), 1, 8); // 硬上限 8
  tex.needsUpdate = true;
}

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
}

/** 超长边时缩到 maxSize（canvas 二次采样），保证显存 ≤ 6×(长边≤maxSize) */
function downscaleIfNeeded(tex: THREE.Texture, maxSize: number): THREE.Texture {
  const img = tex.image as { width?: number; height?: number } | null | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!hasDom() || w <= 0 || h <= 0) return tex;
  const long = Math.max(w, h);
  if (long <= maxSize) return tex;
  const k = maxSize / long;
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) return tex;
    ctx.drawImage(img as unknown as CanvasImageSource, 0, 0, tw, th);
    const out = new THREE.CanvasTexture(canvas);
    tex.dispose();
    return out;
  } catch {
    return tex;
  }
}

/**
 * 开始加载（幂等）。加载结果只写缓存，不直接改材质 —— 由 `applyReferenceTextures`
 * 决定挂不挂；未就绪的规则保持原程序化贴图，图到之后由 `pendingWires` 补挂。
 */
function ensureLoad(id: RefImageId, maxSize: number, anisotropy: number): void {
  if (texCache.has(id)) return;
  const entry: CacheEntry = { status: 'loading', tex: null, maxSize, anisotropy };
  texCache.set(id, entry);
  const url = REF_IMAGE_META[id].url;
  try {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        let out = downscaleIfNeeded(tex, maxSize);
        applyTextureSettings(out, anisotropy);
        // 尺寸复核：声明值只用来反算 repeat，实际图幅不符要出声（不阻断）
        const img = out.image as { width?: number; height?: number } | null | undefined;
        const aw = img?.width ?? 0;
        const ah = img?.height ?? 0;
        if (aw > 0 && ah > 0) {
          const declared = imageAspect(id);
          const actual = aw / ah;
          if (Math.abs(actual - declared) / declared > 0.02) {
            console.warn(
              `[refTextures] ${id} 图幅宽高比实测 ${actual.toFixed(3)} ≠ 声明 ${declared.toFixed(3)}，` +
                `repeat 反算会偏（distortion 约 ×${(actual / declared).toFixed(2)}）`
            );
          }
        }
        out.needsUpdate = true;
        entry.tex = out;
        entry.status = 'ready';
        flushPending();
      },
      undefined,
      () => {
        entry.status = 'failed';
        console.warn(`[refTextures] ${id} 加载失败，保持程序化贴图（优雅降级）`);
        flushPending();
      }
    );
  } catch {
    // 无 DOM / 无 fetch（Node 单测、SSR）：静默失败
    entry.status = 'failed';
  }
}

function flushPending(): void {
  const jobs = pendingWires.splice(0, pendingWires.length);
  for (const job of jobs) {
    // 本图未就绪 → 留在队列，等它自己的 load 回调再消费（R18 修复丢任务）
    if (!readyTexture(job.image)) {
      pendingWires.push(job);
      continue;
    }
    try {
      job.run();
    } catch {
      /* 单个补挂失败不影响其余 */
    }
  }
}

/** 已加载的贴图（未就绪返回 null） */
function readyTexture(id: RefImageId): THREE.Texture | null {
  const e = texCache.get(id);
  return e && e.status === 'ready' && e.tex ? e.tex : null;
}

/**
 * 预加载全部参考图。V800Adapter 是同步装配，无法 await —— 但调用方若能 await，
 * 先跑这个再调 `applyReferenceTextures` 即可让全部材质在返回前真正挂上。
 */
export function preloadReferenceTextures(opts: RefTextureOptions = {}): Promise<void> {
  const tier = opts.tier ?? 'high';
  const maxSize = opts.maxSize ?? TIER_MAX_SIZE[tier];
  const anisotropy = clamp(opts.maxAnisotropy ?? 8, 1, 8);
  const waits: Array<Promise<void>> = [];
  for (const id of REF_IMAGE_IDS) {
    ensureLoad(id, maxSize, anisotropy);
    const entry = texCache.get(id);
    if (!entry) continue;
    waits.push(
      new Promise<void>((resolve) => {
        const tick = (): void => {
          if (entry.status === 'ready' || entry.status === 'failed') resolve();
          else setTimeout(tick, 16);
        };
        tick();
      })
    );
  }
  return Promise.all(waits).then(() => undefined);
}

/** 供适配器把贴图并入 ownedTextures 统一 dispose */
export function getReferenceTextures(): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const id of REF_IMAGE_IDS) {
    const t = readyTexture(id);
    if (t) out.push(t);
  }
  return out;
}

/**
 * 仅用于 Node / 单测：直接注入一张「已就绪」贴图，跳过网络与 DOM。
 * 生产路径不要调用。传 null 表示模拟加载失败。
 */
export function _injectReferenceTexture(id: RefImageId, tex: THREE.Texture | null): void {
  texCache.set(id, {
    status: tex ? 'ready' : 'failed',
    tex,
    maxSize: TIER_MAX_SIZE.high,
    anisotropy: 8,
  });
  flushPending();
}

/* ================================================================
 * 4. 场景遍历 / 识别
 * ================================================================ */

interface MeshInfo {
  mesh: THREE.Mesh;
  componentId: string;
  materialId: string;
  mat: THREE.MeshStandardMaterial;
}

function componentIdOf(obj: THREE.Object3D): string | undefined {
  const ud = obj.userData as
    | {
        sculptComponent?: { id?: unknown };
        component?: { id?: unknown };
        sculptComponentId?: unknown;
        componentId?: unknown;
      }
    | undefined;
  const raw =
    ud?.sculptComponent?.id ?? ud?.component?.id ?? ud?.sculptComponentId ?? ud?.componentId;
  return typeof raw === 'string' ? raw : undefined;
}

function materialIdOf(mat: THREE.Material): string | undefined {
  const ud = mat.userData as { sculptMaterial?: { id?: unknown } } | undefined;
  const raw = ud?.sculptMaterial?.id;
  return typeof raw === 'string' ? raw : undefined;
}

function collectMeshes(root: THREE.Object3D): MeshInfo[] {
  const out: MeshInfo[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const componentId = componentIdOf(mesh);
    if (!componentId) return;
    const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!src) return;
    const materialId = materialIdOf(src);
    if (!materialId) return;
    out.push({
      mesh,
      componentId,
      materialId,
      mat: src as unknown as THREE.MeshStandardMaterial,
    });
  });
  return out;
}

/* ================================================================
 * 5. UV 生成
 * ================================================================ */

/**
 * normalizeUVToRegion —— 与适配器 remapUVToRegion 同一语义：
 * **先测 mesh 自身 UV bbox，再归一压进目标区**。
 * 禁止线性 remap 的原因见文件头（既有 UV 可能是图集分区坐标，含负值 / 越界）。
 * 本模块的主路径不读既有 UV，但接入图集时必须走这里。
 */
export function normalizeUVToRegion(
  mesh: THREE.Mesh,
  u0: number,
  u1: number,
  v0: number,
  v1: number
): void {
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
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
}

/** 世界坐标点列（count×3） */
function worldPoints(mesh: THREE.Mesh): Float32Array {
  const pos = mesh.geometry.getAttribute('position');
  const n = pos.count;
  const pts = new Float32Array(n * 3);
  const m = mesh.matrixWorld;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    pts[i * 3] = v.x;
    pts[i * 3 + 1] = v.y;
    pts[i * 3 + 2] = v.z;
  }
  return pts;
}

interface Aabb {
  min: [number, number, number];
  size: [number, number, number];
}

function aabbOf(pts: Float32Array): Aabb {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = pts[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return {
    min,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/**
 * 平铺次数反算：让「一个平铺单元的世界尺寸比」≈ 图幅宽高比 → 纹素近正方，
 * 各向异性需求 = 单元长宽比 ÷ 图幅比，逐三角形实测可验证 ≤8x。
 *   su = sizeU/nU ≈ tileWorld·√aspect， sv = sizeV/nV ≈ tileWorld/√aspect
 */
function repeatsFor(
  sizeU: number,
  sizeV: number,
  tileWorld: number,
  aspect: number
): [number, number] {
  const a = clamp(aspect, 0.05, 20);
  const sq = Math.sqrt(a);
  const nU = clamp(Math.round(sizeU / (tileWorld * sq)), 1, 16);
  const nV = clamp(Math.round(sizeV / (tileWorld / sq)), 1, 16);
  return [nU, nV];
}

interface UvWriteResult {
  repeat: [number, number];
  bbox: [number, number, number];
  /** 投影实际使用的两轴世界尺寸（u 向、v 向），repeat 与之对应 */
  sizeU: number;
  sizeV: number;
}

/**
 * 盒投影 UV：取包围盒最大的两轴作 u/v，归一后乘平铺次数。
 * 输出 UV ⊆ [0,nU]×[0,nV]（逐点 clamp），对退化尺寸安全。
 */
function writePlanarUV(
  mesh: THREE.Mesh,
  tileWorld: number,
  aspect: number,
  forced?: readonly [number, number]
): UvWriteResult {
  const pts = worldPoints(mesh);
  const box = aabbOf(pts);
  const axes = [0, 1, 2].sort((a, b) => box.size[b] - box.size[a]);
  const uAxis = axes[0];
  const vAxis = axes[1];
  const su = box.size[uAxis];
  const sv = box.size[vAxis];
  let nU = 1;
  let nV = 1;
  if (su > 1e-6 && sv > 1e-6) {
    const auto = repeatsFor(su, sv, tileWorld, aspect);
    nU = forced ? forced[0] : auto[0];
    nV = forced ? forced[1] : auto[1];
  }
  const uvAttr =
    (mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined) ??
    (() => {
      const a = new THREE.BufferAttribute(new Float32Array(pts.length / 3 * 2), 2);
      mesh.geometry.setAttribute('uv', a);
      return a;
    })();
  const n = Math.min(uvAttr.count, pts.length / 3);
  for (let i = 0; i < n; i++) {
    const pu = su > 1e-6 ? clamp((pts[i * 3 + uAxis] - box.min[uAxis]) / su, 0, 1) : 0;
    const pv = sv > 1e-6 ? clamp((pts[i * 3 + vAxis] - box.min[vAxis]) / sv, 0, 1) : 0;
    uvAttr.setXY(i, clamp(pu * nU, 0, nU), clamp(pv * nV, 0, nV));
  }
  uvAttr.needsUpdate = true;
  return { repeat: [nU, nV], bbox: box.size, sizeU: su, sizeV: sv };
}

/**
 * 三平面（逐三角形）世界锚定 UV：u = 世界坐标÷tileU， v = 世界坐标÷tileV。
 *
 * 为什么不用盒投影：单盒投影把**所有面**（含垂直于投影面的薄棱面）压到同一对轴上，
 * 实测 dash-upper（1.78×0.197×0.469）薄侧面被拉到 13.2x、门板 5.5x —— 直接踩
 * 「各向异性 ≤8x」红线（与 R12b 绗缝 34.7x 同一病根）。改逐三角形按面法线主轴选
 * 投影平面（伪三平面）后每个面都近等距。
 *
 * tileU/tileV 按图幅宽高比反算（tileU/tileV = aspect）→ 平铺单元的形状与图幅一致，
 * 纹素近正方，distortion → 1.0（残余仅为主轴投影误差 ≤1.73x）。
 * 需要逐三角形独立顶点，故先 toNonIndexed（三角面数不变，顶点数上升）。
 */
function writeTriplanarUV(
  mesh: THREE.Mesh,
  tileU: number,
  tileV: number,
  anchor: 'world' | 'local'
): UvWriteResult {
  let geo = mesh.geometry;
  if (geo.index) {
    const old = geo;
    geo = geo.toNonIndexed();
    mesh.geometry = geo;
    old.dispose();
  }
  const pts = worldPoints(mesh);
  const box = aabbOf(pts);
  const uvAttr =
    (geo.getAttribute('uv') as THREE.BufferAttribute | undefined) ??
    (() => {
      const a = new THREE.BufferAttribute(new Float32Array((pts.length / 3) * 2), 2);
      geo.setAttribute('uv', a);
      return a;
    })();
  const invU = 1 / Math.max(tileU, 1e-4);
  const invV = 1 / Math.max(tileV, 1e-4);
  const count = Math.min(uvAttr.count, pts.length / 3);
  for (let t = 0; t + 2 < count; t += 3) {
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
      const base1 = anchor === 'local' ? box.min[a1] : 0;
      const base2 = anchor === 'local' ? box.min[a2] : 0;
      uvAttr.setXY(i, (pts[i * 3 + a1] - base1) * invU, (pts[i * 3 + a2] - base2) * invV);
    }
  }
  uvAttr.needsUpdate = true;
  const sorted = [box.size[0], box.size[1], box.size[2]].sort((x, y) => y - x);
  const sizeU = sorted[0];
  const sizeV = sorted[1];
  return {
    repeat: [Math.max(1, Math.round(sizeU * invU)), Math.max(1, Math.round(sizeV * invV))],
    bbox: box.size,
    sizeU,
    sizeV,
  };
}

/* ================================================================
 * 6. 各向异性自检
 * ================================================================ */

/**
 * 逐三角形实测 UV 拉伸：解 2×2 雅可比 [du1 dv1; du2 dv2]·[dPdu; dPdv] = [E1; E2]，
 * 取 |dPdu|/|dPdv| 再按图幅宽高比归一 → ≥1 的实际各向异性需求。
 * imageAspect 传 1 时返回原始 u/v 世界密度比。
 */
export function computeUvAspect(mesh: THREE.Mesh, imageAspectValue = 1): UvAspectReport {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const empty: UvAspectReport = { triangles: 0, maxAspect: 1, p95Aspect: 1, over8: 0 };
  if (!pos || !uv || pos.count < 3 || uv.count < 3) return empty;
  const index = geo.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const samples: number[] = [];
  const stride = Math.max(1, Math.floor(triCount / 4000)); // 抽样上限 4000 个三角形
  const a = Math.max(0.05, imageAspectValue);
  let maxAspect = 1;
  let over8 = 0;
  for (let t = 0; t < triCount; t += stride) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const p0x = pos.getX(i0);
    const p0y = pos.getY(i0);
    const p0z = pos.getZ(i0);
    const e1x = pos.getX(i1) - p0x;
    const e1y = pos.getY(i1) - p0y;
    const e1z = pos.getZ(i1) - p0z;
    const e2x = pos.getX(i2) - p0x;
    const e2y = pos.getY(i2) - p0y;
    const e2z = pos.getZ(i2) - p0z;
    const du1 = uv.getX(i1) - uv.getX(i0);
    const dv1 = uv.getY(i1) - uv.getY(i0);
    const du2 = uv.getX(i2) - uv.getX(i0);
    const dv2 = uv.getY(i2) - uv.getY(i0);
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const dux = (dv2 * e1x - dv1 * e2x) / det;
    const duy = (dv2 * e1y - dv1 * e2y) / det;
    const duz = (dv2 * e1z - dv1 * e2z) / det;
    const dvx = (-du2 * e1x + du1 * e2x) / det;
    const dvy = (-du2 * e1y + du1 * e2y) / det;
    const dvz = (-du2 * e1z + du1 * e2z) / det;
    const lu = Math.hypot(dux, duy, duz);
    const lv = Math.hypot(dvx, dvy, dvz);
    if (lu < 1e-12 || lv < 1e-12) continue;
    const raw = lu / lv / a;
    const aspect = raw >= 1 ? raw : 1 / raw;
    if (aspect > maxAspect) maxAspect = aspect;
    if (aspect > 8) over8++;
    samples.push(aspect);
  }
  if (samples.length === 0) return empty;
  samples.sort((x, y) => x - y);
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  return {
    triangles: samples.length,
    maxAspect,
    p95Aspect: p95,
    over8,
  };
}

function uvRangeOf(mesh: THREE.Mesh): [number, number, number, number] {
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv || uv.count === 0) return [0, 0, 0, 0];
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
  return [uMin, uMax, vMin, vMax];
}

/* ================================================================
 * 7. 材质改造（克隆 / 染色 / 挂载）
 * ================================================================ */

/** 照片平均线性亮度（32×32 降采样估算）；不可测返回 null */
function meanLinearLuma(tex: THREE.Texture): number | null {
  const img = tex.image as { width?: number; height?: number } | null | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!hasDom() || w <= 0 || h <= 0) return null;
  try {
    const S = 32;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img as unknown as CanvasImageSource, 0, 0, S, S);
    const data = ctx.getImageData(0, 0, S, S).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum +=
        0.2126 * srgbToLinear(data[i] / 255) +
        0.7152 * srgbToLinear(data[i + 1] / 255) +
        0.0722 * srgbToLinear(data[i + 2] / 255);
    }
    return sum / (data.length / 4);
  } catch {
    return null;
  }
}

/**
 * 自动染色：照片承载纹样，材质 color 把平均亮度拉回策展色 ——
 * 既拿到真实纹理，又不让整舱色调被某一张照片的曝光带跑。
 * 返回 1 = 不染色（照片亮度即策展亮度，或无法测量）。
 */
function tintFor(tex: THREE.Texture | null, rule: RefRule, materialId: string): number {
  const hex = rule.tintTargetByMaterial?.[materialId] ?? rule.tintTarget;
  if (!hex || !tex) return 1;
  const target = hexLinearLuma(hex);
  const photo = meanLinearLuma(tex);
  if (!photo || photo < 1e-4) return 1;
  return clamp(target / photo, 0.15, 4);
}

function ensureClone(
  info: MeshInfo,
  rule: RefRule
): { mat: THREE.MeshStandardMaterial; fresh: boolean } {
  let perSrc = cloneCache.get(info.mat);
  if (!perSrc) {
    perSrc = new Map<RefImageId, THREE.MeshStandardMaterial>();
    cloneCache.set(info.mat, perSrc);
  }
  const hit = perSrc.get(rule.image);
  if (hit) return { mat: hit, fresh: false };
  const mat = info.mat.clone() as unknown as THREE.MeshStandardMaterial;
  // 克隆保 sculptMaterial（Material.copy 深拷 userData）→ 灯光链路 / 合批分组仍按同 id 工作
  mat.userData.refTexture = { image: rule.image, channels: [...rule.channels] };
  perSrc.set(rule.image, mat);
  return { mat, fresh: true };
}

function attachChannels(mat: THREE.MeshStandardMaterial, rule: RefRule, tex: THREE.Texture, materialId: string): void {
  const tint = tintFor(tex, rule, materialId);
  for (const ch of rule.channels) {
    if (ch === 'map') mat.map = tex;
    else mat.emissiveMap = tex;
  }
  if (rule.channels.includes('map')) mat.color.setRGB(tint, tint, tint);
  if (rule.emissiveWhite && rule.channels.includes('emissiveMap')) {
    mat.emissive.setRGB(1, 1, 1);
    if (rule.emissiveIntensity !== undefined) mat.emissiveIntensity = rule.emissiveIntensity;
  }
  mat.needsUpdate = true;
}

/* ================================================================
 * 8. 主入口
 * ================================================================ */

/**
 * 在车模装配完成、**内饰材质纯化之后**调用（且必须在 batchMergeStatic 之前）。
 * 返回实际承载参考图贴图的材质 id 列表（去重、排序），便于 QA 断言。
 *
 * 贴图未解码时不会把空纹理绑到材质上（会黑屏）—— 改走 pendingWires，图到即补挂，
 * 期间保持原程序化贴图。想同步拿到全绿，先 `await preloadReferenceTextures()`。
 */
export function applyReferenceTextures(
  root: THREE.Object3D,
  opts: RefTextureOptions = {}
): string[] {
  const tier: RefTier = opts.tier ?? 'high';
  const maxSize = opts.maxSize ?? TIER_MAX_SIZE[tier];
  const anisotropy = clamp(opts.maxAnisotropy ?? 8, 1, 8);
  const verbose = opts.verbose ?? false;
  const report: RefApplyReport[] = [];
  lastReport = report;
  if (!root) return [];

  root.updateMatrixWorld(true);
  const meshes = collectMeshes(root);
  if (meshes.length === 0) {
    // 组件 id 全缺失 = 大概率在合批之后调用。默认宁可不动。
    if (!opts.allowMaterialFallback) {
      console.warn(
        '[refTextures] 场景内没有带 sculptComponent.id 的 mesh —— 多半是在 batchMergeStatic ' +
          '之后调用了。按契约应放在「内饰纯化之后 / 合批之前」。已跳过（保持程序化贴图）。'
      );
    }
  }
  const byComponent = new Map<string, MeshInfo[]>();
  for (const m of meshes) {
    const arr = byComponent.get(m.componentId);
    if (arr) arr.push(m);
    else byComponent.set(m.componentId, [m]);
  }

  const mounted = new Set<string>();

  for (const rule of REF_RULES) {
    if (!rule.tiers.includes(tier)) {
      report.push({
        image: rule.image,
        materialIds: [],
        meshes: [],
        status: 'skipped-tier',
        reason: `tier=${tier} 未启用`,
        note: rule.note,
      });
      continue;
    }
    ensureLoad(rule.image, maxSize, anisotropy);
    const entry = texCache.get(rule.image);
    const tex = readyTexture(rule.image);

    const targets: MeshInfo[] = [];
    for (const cid of rule.components) {
      const arr = byComponent.get(cid);
      if (!arr) continue;
      for (const info of arr) {
        if (rule.materials.length > 0 && !rule.materials.includes(info.materialId)) continue;
        targets.push(info);
      }
    }
    if (targets.length === 0) {
      report.push({
        image: rule.image,
        materialIds: [],
        meshes: [],
        status: 'no-target',
        reason: '按组件 id 未命中任何 mesh',
        note: rule.note,
      });
      continue;
    }

    const meshReports: RefMeshReport[] = [];
    const asp = imageAspect(rule.image);
    let attachedNow = false;

    for (const info of targets) {
      const { mat, fresh } = ensureClone(info, rule);
      if (fresh) {
        wiredMaterials.push({
          mesh: info.mesh,
          mat,
          src: info.mat as unknown as THREE.Material,
          image: rule.image,
          channels: rule.channels,
          prev: {
            map: mat.map,
            emissiveMap: mat.emissiveMap,
            emissive: mat.emissive.clone(),
            emissiveIntensity: mat.emissiveIntensity,
            color: mat.color.clone(),
          },
        });
      }
      if (info.mesh.material !== mat) info.mesh.material = mat as unknown as THREE.Material;

      // 三平面单元按图幅宽高比反算（tileU/tileV = aspect）；盒投影直接用包围盒两轴
      const written =
        rule.uv === 'triplanar'
          ? writeTriplanarUV(
              info.mesh,
              rule.tileWorld * Math.sqrt(asp),
              rule.tileWorld / Math.sqrt(asp),
              rule.anchor ?? 'world'
            )
          : writePlanarUV(info.mesh, rule.tileWorld, asp, rule.repeat);
      const aspectReport = computeUvAspect(info.mesh, asp);
      const uvRange = uvRangeOf(info.mesh);
      // 单元世界尺寸比 ÷ 图幅宽高比 = 实际各向异性需求（>8 判死）
      const unitAspect =
        written.repeat[0] > 0 && written.repeat[1] > 0 && written.sizeV > 1e-6
          ? (written.sizeU / written.repeat[0]) / (written.sizeV / written.repeat[1])
          : 1;
      const distortion = Math.max(
        Math.max(unitAspect / asp, asp / unitAspect),
        aspectReport.maxAspect
      );

      let attached = false;
      if (tex) {
        attachChannels(mat, rule, tex, info.materialId);
        attached = true;
        attachedNow = true;
      } else if (entry && entry.status === 'loading') {
        const capturedMat = mat;
        const capturedId = info.materialId;
        pendingWires.push({
          image: rule.image,
          run: () => {
            const t = readyTexture(rule.image);
            if (!t) return false;
            attachChannels(capturedMat, rule, t, capturedId);
            return true;
          }
        });
      }
      if (attached || entry?.status === 'loading') mounted.add(info.materialId);

      meshReports.push({
        componentId: info.componentId,
        materialId: info.materialId,
        image: rule.image,
        uv: rule.uv,
        bbox: written.bbox,
        repeat: written.repeat,
        uvRange,
        uvAspect: unitAspect,
        distortion,
        attached,
      });
    }

    const materialIds = [...new Set(meshReports.map((m) => m.materialId))].sort();
    const pending = !tex && entry?.status === 'loading';
    // 只有「已挂上」或「等待补挂」才计入返回列表；加载失败 = 保持程序化贴图，不计入
    if (tex || pending) for (const id of materialIds) mounted.add(id);
    report.push({
      image: rule.image,
      materialIds: tex || pending ? materialIds : [],
      meshes: meshReports,
      status: tex ? 'attached' : entry?.status === 'failed' ? 'failed' : 'pending',
      reason: tex ? undefined : entry?.status === 'failed' ? '贴图加载失败' : '贴图尚未解码',
      note: rule.note,
    });
    if (verbose) {
      const worst = meshReports.reduce((a, b) => (b.distortion > a ? b.distortion : a), 1);
      console.info(
        `[refTextures] ${rule.image} → ${materialIds.join(',')} · ${meshReports.length} mesh · ` +
          `最大拉伸 ${worst.toFixed(2)}x · ${attachedNow ? '已挂载' : '待贴图'}`
      );
    }
  }

  return [...mounted].sort();
}

/** 最近一次 applyReferenceTextures 的完整报告（QA / 文档用） */
export function getReferenceTextureReport(): readonly RefApplyReport[] {
  return lastReport;
}

/** 显存估算（字节）：Σ(w·h·4·1.33mip) */
export function estimateReferenceVramBytes(): number {
  let bytes = 0;
  for (const id of REF_IMAGE_IDS) {
    const tex = readyTexture(id);
    const img = tex?.image as { width?: number; height?: number } | null | undefined;
    const w = img?.width ?? REF_IMAGE_META[id].width;
    const h = img?.height ?? REF_IMAGE_META[id].height;
    bytes += w * h * 4 * 1.33;
  }
  return Math.round(bytes);
}

/** 卸载：恢复原材质 / 原通道值，释放贴图与克隆材质 */
export function disposeReferenceTextures(): void {
  pendingWires.length = 0;
  for (const w of wiredMaterials) {
    w.mat.map = w.prev.map;
    w.mat.emissiveMap = w.prev.emissiveMap;
    w.mat.emissive.copy(w.prev.emissive);
    w.mat.emissiveIntensity = w.prev.emissiveIntensity;
    w.mat.color.copy(w.prev.color);
    w.mat.needsUpdate = true;
    if (w.mesh.material === (w.mat as unknown as THREE.Material)) {
      w.mesh.material = w.src;
    }
    w.mat.dispose();
  }
  wiredMaterials.length = 0;
  cloneCache.clear();
  for (const id of REF_IMAGE_IDS) {
    const e = texCache.get(id);
    if (e?.tex) e.tex.dispose();
  }
  texCache.clear();
  lastReport = [];
}
