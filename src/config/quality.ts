/**
 * 质量档：high / medium / low + auto 检测（UA + 屏宽 + 帧率自适应降档）
 * 底子来自原版 zg() 的 UA+屏宽降级，扩展为三档 + 运行时自适应。
 */

export type QualityTier = 'high' | 'medium' | 'low';

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
  /** EffectComposer 渲染目标 MSAA 采样数 */
  msaaSamples: number;
  bloom: boolean;
  /** PMREM 环境贴图分辨率 */
  envMapSize: number;
  /** 车模程序化贴图边长（px）：high 1024 / medium 512 / low 256 */
  carTextureSize: number;
  isMobile: boolean;
}

/**
 * 程序化贴图边长分档。26 材质 × 5 通道同步生成，1024² 实测 ~24s，256² 只要 ~1.7s，
 * 因此低档必须显式降尺寸，否则中低端机首屏卡死。
 */
export function carTextureSizeFor(tier: QualityTier): number {
  return TIERS[tier].carTextureSize;
}

const TIERS: Record<QualityTier, Omit<QualitySettings, 'tier' | 'isMobile'>> = {
  high: {
    pixelRatio: Math.min(window.devicePixelRatio, 2),
    minPixelRatio: 1,
    antialias: true,
    shadowMapSize: 2048,
    shadowOrtho: 28,
    msaaSamples: 4,
    bloom: true,
    envMapSize: 900,
    carTextureSize: 1024
  },
  medium: {
    pixelRatio: Math.min(window.devicePixelRatio, 1.5),
    minPixelRatio: 1,
    antialias: true,
    shadowMapSize: 1536,
    shadowOrtho: 28,
    msaaSamples: 2,
    bloom: true,
    envMapSize: 512,
    carTextureSize: 512
  },
  low: {
    pixelRatio: 1,
    minPixelRatio: 0.75,
    antialias: false,
    shadowMapSize: 1024,
    shadowOrtho: 28,
    msaaSamples: 0,
    bloom: false,
    envMapSize: 256,
    carTextureSize: 256
  }
};

/** auto 检测：UA + 屏宽（原版口径），桌面高分屏归 high，中端归 medium */
export function detectQualityTier(): QualityTier {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 760;
  if (mobile) return 'medium';
  const cores = navigator.hardwareConcurrency ?? 8;
  return cores >= 4 ? 'high' : 'medium';
}

export function createQualitySettings(overrideTier?: QualityTier): QualitySettings {
  const tier = overrideTier ?? detectQualityTier();
  return { tier, ...TIERS[tier], isMobile: tier !== 'high' && window.innerWidth < 900 };
}

/**
 * 运行时自适应降档（原版 B_ 逻辑移植）：
 * 每 2s 统计帧率，<45 降 pixelRatio，连续 3 个窗口 >58 缓慢回升（不超过初始上限）。
 */
export class AdaptiveQuality {
  private frames = 0;
  private time = 0;
  private fastStreak = 0;
  private currentRatio: number;

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
    if (this.time < 2) return 0;
    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    const before = this.currentRatio;
    const floor = this.settings.minPixelRatio;
    if (fps < 45 && this.currentRatio > floor) {
      this.currentRatio = Math.max(floor, this.currentRatio - 0.25);
      this.fastStreak = 0;
    } else if (fps > 58 && this.currentRatio < this.settings.pixelRatio) {
      this.fastStreak++;
      if (this.fastStreak >= 3) {
        this.currentRatio = Math.min(this.settings.pixelRatio, this.currentRatio + 0.25);
        this.fastStreak = 0;
      }
    } else {
      this.fastStreak = 0;
    }
    return this.currentRatio - before;
  }
}
