/**
 * 质量档：high / medium / low + auto 检测（UA + 屏宽 + GPU 类别 + 帧率自适应降档）
 * 底子来自原版 zg() 的 UA+屏宽降级，扩展为三档 + 运行时自适应。
 */

export type QualityTier = 'high' | 'medium' | 'low';
/** GPU 类别：决定像素预算（同一档位下集显吃不下独显的分辨率/采样） */
export type GpuClass = 'discrete' | 'integrated' | 'software' | 'unknown';

export interface QualitySettings {
  tier: QualityTier;
  /** 初始像素比上限（自适应只能降不能升过此值） */
  pixelRatio: number;
  /** 自适应像素比下限 */
  minPixelRatio: number;
  antialias: boolean;
  shadowMapSize: number;
  /** 阴影正交半径（texel 对齐用） */
  shadowOrtho: number;
  /**
   * R31 阴影贴图**更新间隔（帧）**：1 = 每帧重绘，N = 每 N 帧重绘一次。
   * 冻结阴影更新后帧时降约 60%（.qa/r31_test/baseline.md §5.3）⇒ 2048² 阴影每帧重绘
   * 是当前最大单项帧成本。节流让阴影贴图从「每帧全量重绘」变成「每 N 帧重绘一次」，
   * 中间帧直接复用上一张贴图（three 的 `shadow.autoUpdate=false` + `needsUpdate` 门控）。
   * 焦点跳变（>1.5m，如复位/换场景）与首次 update 强制刷新，避免换场景后阴影错位。
   */
  shadowUpdateInterval: number;
  /** EffectComposer 渲染目标 MSAA 采样数 */
  msaaSamples: number;
  bloom: boolean;
  /**
   * Bloom 渲染分辨率系数（1 = 与主 pass 同尺寸）。
   * UnrealBloomPass 本身已按 1/2 起算，0.5 表示在 1/2 基础上再减半（常驻 1/16 面积）。
   * perf-r14：核显上 bloom 的 5 级 mip 全屏 blur 是纯填充开销，减半肉眼几乎无差。
   */
  bloomScale: number;
  /** PMREM 环境贴图分辨率 */
  envMapSize: number;
  /** 车模程序化贴图边长（px）：high 1024 / medium 512 / low 256 */
  carTextureSize: number;
  /**
   * R30 城堡贴图**同步上架**边长（px）。构造 Castle 时所有石材族先用这个小尺寸同步生成
   * （保证 high 档启动同步段不被打满），首帧后再按 `stoneTextureSize(kind,tier)` 的
   * **目标尺寸**分片重烘 + 热替换（见 stoneTexture.bakeStoneMapsAsync / castle.ts）。
   * 256² 全族同步合计 ~50ms，是「先上架后升级」策略的同步档口径。
   */
  castleTexSyncSize: number;
  isMobile: boolean;
  gpuClass: GpuClass;
}

/**
 * 程序化贴图边长分档。26 材质 × 5 通道同步生成，1024² 实测 ~24s，256² 只要 ~1.7s，
 * 因此低档必须显式降尺寸，否则中低端机首屏卡死。
 */
export function carTextureSizeFor(tier: QualityTier): number {
  return TIERS[tier].carTextureSize;
}

const TIERS: Record<QualityTier, Omit<QualitySettings, 'tier' | 'isMobile' | 'gpuClass'>> = {
  high: {
    pixelRatio: Math.min(window.devicePixelRatio, 2),
    minPixelRatio: 1,
    antialias: true,
    // 构建无限制 ⇒ 2048² 保留（texel 更细）；运行时靠 shadowUpdateInterval 节流，不靠缩尺寸。
    shadowMapSize: 2048,
    // R31：28 → 20。texel 0.027m → 0.019m（更细），同时阴影视锥里的 caster 数下降。
    shadowOrtho: 20,
    shadowUpdateInterval: 2,
    msaaSamples: 4,
    bloom: true,
    bloomScale: 1,
    envMapSize: 900,
    carTextureSize: 1024,
    castleTexSyncSize: 256
  },
  medium: {
    pixelRatio: Math.min(window.devicePixelRatio, 1.5),
    minPixelRatio: 1,
    antialias: true,
    // R31：1536 → 1024（面积 −55%）；节流间隔 3 帧。
    shadowMapSize: 1024,
    shadowOrtho: 20,
    shadowUpdateInterval: 3,
    msaaSamples: 2,
    bloom: true,
    bloomScale: 0.5,
    envMapSize: 512,
    carTextureSize: 512,
    castleTexSyncSize: 256
  },
  low: {
    pixelRatio: 1,
    minPixelRatio: 0.75,
    antialias: false,
    // R31：1024 → 768（面积 −44%）；节流间隔 4 帧。
    shadowMapSize: 768,
    shadowOrtho: 20,
    shadowUpdateInterval: 4,
    msaaSamples: 0,
    bloom: false,
    bloomScale: 0.5,
    envMapSize: 256,
    carTextureSize: 256,
    castleTexSyncSize: 256
  }
};

/**
 * GPU 类别探测（perf-r14）：
 * 「桌面核显」被 UA+核数启发式判成 high 是本轮主诉（掉帧+抽搐）的结构性前提 ——
 * 核显跑 2× DPR + MSAA4 + 全屏 bloom，帧时必然越过 vsync 预算。
 * 用 WEBGL_debug_renderer_info 读真实 GPU 名（Edge/Chrome 仍可用，取不到就退回
 * gl.RENDERER，再取不到返回 unknown ⇒ 不改档，避免误降高端机）。
 */
export function detectGpuClass(): GpuClass {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { antialias: false }) as WebGLRenderingContext | null;
    if (!gl) return 'unknown';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : String(gl.getParameter(gl.RENDERER) ?? '');
    // 不主动 loseContext：临时 context 交由 GC（主动 lose 在部分驱动上会连带
    // 影响随后创建的主 context，表现为页面直接崩溃，得不偿失）
    const name = raw.toLowerCase();
    if (!name) return 'unknown';
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(name)) return 'software';
    // Intel 核显（Iris/UHD/HD）；Arc 是独显，不算
    if (name.includes('intel') && !name.includes('arc')) return 'integrated';
    // AMD APU：Radeon(TM) Graphics / Vega 8 / Radeon 780M 之类；RX/Navi/Pro 是独显
    if (
      /(radeon|amd)/.test(name) &&
      /(graphics|vega \d|\d+m\b)/.test(name) &&
      !/(rx \d|navi|pro w|firepro|instinct)/.test(name)
    ) {
      return 'integrated';
    }
    return 'discrete';
  } catch {
    return 'unknown';
  }
}

/** auto 检测：软件渲染→low；核显→medium 预算；其余按 UA/屏宽/核数（原版口径） */
export function detectQualityTier(gpu: GpuClass = 'unknown'): QualityTier {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 760;
  if (mobile) return 'medium';
  if (gpu === 'software') return 'low';
  const cores = navigator.hardwareConcurrency ?? 8;
  return cores >= 4 ? 'high' : 'medium';
}

/**
 * perf-r14 集显像素预算：**保留 high 的材质/贴图/环境（观感主体），只砍像素成本**。
 * - pixelRatio 2 → 1.5：1080p@2x 是 8.3M 像素，1.5x 只要 4.7M（−44% 填充）；
 * - msaaSamples 4 → 2：MSAA 的 resolve 带宽与显存减半（4x 在核显上收益递减）；
 * - bloomScale 1 → 0.5：bloom 的 5 级 mip blur 面积降到 1/4；
 * - shadowMapSize 2048 → 1536：2048² 阴影每帧全场景重绘（实测 113 DC / 78k tri）是核显第二大固定开销；
 * - 画布 antialias 关掉：最终呈现走 composer 的 RT，默认帧缓冲再开 MSAA 纯属白付带宽。
 */
function applyIntegratedBudget(s: QualitySettings): QualitySettings {
  if (s.tier !== 'high') return s;
  s.pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  s.msaaSamples = 2;
  s.bloomScale = 0.5;
  s.shadowMapSize = 1536;
  s.antialias = false;
  return s;
}

/**
 * QA 钩子（仅 DEV，构建产物为死代码）：
 * `#quality=high|medium|low` 强制档位；`#gpufake=integrated|discrete|software` 强制 GPU 类别。
 * 用途：同一台机器上 A/B「像素预算」，以及 mock 核显复现用户机行为。
 */
function hashOverride(key: string): string | null {
  if (!import.meta.env.DEV) return null;
  const m = window.location.hash.match(new RegExp(`${key}=([a-z]+)`));
  return m ? m[1] : null;
}

export function createQualitySettings(overrideTier?: QualityTier): QualitySettings {
  const faked = hashOverride('gpufake') as GpuClass | null;
  const gpuClass = faked ?? detectGpuClass();
  const forced = hashOverride('quality') as QualityTier | null;
  const tier = forced ?? overrideTier ?? detectQualityTier(gpuClass);
  const s: QualitySettings = {
    tier,
    ...TIERS[tier],
    isMobile: tier !== 'high' && window.innerWidth < 900,
    gpuClass
  };
  return gpuClass === 'integrated' ? applyIntegratedBudget(s) : s;
}

/**
 * 运行时自适应降档（原版 B_ 逻辑移植）：
 * 每 2s 统计帧率，<42 降 pixelRatio，连续 3 个窗口 >58 缓慢回升（不超过初始上限）。
 *
 * perf-r13 迟滞改造（2026-10-18，治「加速段顿挫」）：
 * 每次变更 pixelRatio 都触发 renderer+composer 全部 RT 重建（一次性大 hitch）
 * 并伴随肉眼可辨的分辨率跳变。原实现在 45~58 无死区保护下，核显机加速段
 * 负载升高会 2s 一档连降到下限（1.5→1.25→1.0 只隔 2s，两连 hitch 落在加速段内），
 * 负载回落又 2 窗一档升回 —— 仿真实测 54s 内 8 次 RT 重建且与加速段强相关，
 * 表现为周期性顿挫 + 画面清晰度泵动。加固三道闸：
 * 1. 降档阈值 45 → 42：45~58 之间本就是「不动」死区，收紧后进一步避开 vsync 失步抖动带；
 * 2. 任何变更后 8s 冷却（4 个统计窗）：强制把 RT 重建 hitch 拉开，杜绝级联连跳与快速震荡；
 * 3. 回升条件不变（>58 且连续 3 窗），同样受冷却约束 —— 只会影响回升速度，不影响收敛方向。
 *
 * perf-r14 追加：降档步长 0.25 → 0.125（pixelRatio），把单次 RT 重建的画面跳变减半；
 * 冷却保持 8s，最多 4 次即到底（1.5→1.0），总 hitch 次数不变。
 */
export class AdaptiveQuality {
  private frames = 0;
  private time = 0;
  private fastStreak = 0;
  private currentRatio: number;
  /** 距上次 pixelRatio 变更的冷却计时（s） */
  private cooldown = 0;

  constructor(private settings: QualitySettings) {
    this.currentRatio = settings.pixelRatio;
  }

  get pixelRatio(): number {
    return this.currentRatio;
  }

  /** 每渲染帧调用；返回像素比变化值（0 = 无变化） */
  update(dt: number): number {
    this.frames++;
    this.time += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.time < 2) return 0;
    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    const before = this.currentRatio;
    const floor = this.settings.minPixelRatio;
    if (this.cooldown > 0) return 0; // 冷却期内不做任何变更（RT 重建 hitch 代价高，必须拉开间隔）
    if (fps < 42 && this.currentRatio > floor) {
      this.currentRatio = Math.max(floor, this.currentRatio - 0.125);
      this.cooldown = 8;
      this.fastStreak = 0;
    } else if (fps > 58 && this.currentRatio < this.settings.pixelRatio) {
      this.fastStreak++;
      if (this.fastStreak >= 3) {
        this.currentRatio = Math.min(this.settings.pixelRatio, this.currentRatio + 0.125);
        this.cooldown = 8;
        this.fastStreak = 0;
      }
    } else {
      this.fastStreak = 0;
    }
    return this.currentRatio - before;
  }
}
