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
  /**
   * 阴影正交半径（texel 对齐 + 影子盒尺寸）。
   * R39：20 → **10**。texel = 2·ortho/mapSize 与 mapSize 同步减半 ⇒ 密度不变（0.0195m/texel）。
   * 依据：阴影 pass 的 caster 只有车模（13 DC / 19,536 tri，R38-P1-6 实证），
   * 接收面只有车周围路面 ⇒ 40m 见方的盒子对「只投一辆车」严重过剩。
   */
  shadowOrtho: number;
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
    /**
     * ══ R39：ortho 20 → **10**，mapSize 2048 → **1024**（同 texel 密度，光栅面积 1/4）══
     * 复算（texel = 2·ortho / mapSize，逐位相同 ⇒ 锐度零变化）：
     *   改前 2×20/2048 = **0.01953 m/texel**；改后 2×10/1024 = **0.01953 m/texel**。
     * 单次重绘成本 ∝ mapSize² ⇒ 1024²/2048² = **0.25，即 −75%**。
     * 为什么盒子可以收到 10：R38-P1-6 实证阴影 pass 的 caster **只有车模**
     *   （castle/Terrain/Road 全 castShadow=false；13 DC / 19,536 tri），接收面只有车周围
     *   路面 ⇒ 40m 见方的盒子对「只投一辆车」严重过剩。
     * 安全边界（投影体必须留在盒内才不会被裁）：
     *   · 盒的 left/right/top/bottom 只约束**投射体（车）**，不约束影子的落地范围 ——
     *     落地范围主要落在**深度轴**（near=1 / far=160，与 ortho 无关）。
     *     按 sunDir(−0.2531, 0.2079, −0.9448)（仰角 12°）复算：车高 1.9m 投出 8.9m 尾影，
     *     其远端在光照空间 basisY 上只偏离盒心 ≈1.8m；车自身半长 2.81m ⇒ 合计 4.6m，
     *     **ortho 10 有 2 倍余量**。
     *   · R39 起阴影**每帧重绘**（`Lighting` 不再节流）⇒ 没有任何「陈旧位移」，
     *     因此这条约束与帧率、车速都无关（旧方案要按 4 帧节流的 travel 额外留量）。
     * ⚠ 观感验收（必做）：高速段连拍 3 帧，确认车下阴影边界无「台阶」位移、
     *   且尾影远端未被盒边切平（`.qa/r39_perf` 有 texel 换算 + 出图脚本骨架）。
     */
    shadowMapSize: 1024,
    // R31：28 → 20；R39：20 → 10（理由同上：caster 只有车，且每帧重绘无陈旧位移）
    shadowOrtho: 10,
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
    // R31：1536 → 1024（面积 −55%）。R39：2048→1024 的同一规则 ⇒ 1024 → **512**，
    // ortho 10 ⇒ texel 2×10/512 = **0.0391 m**，与改前 2×20/1024 = 0.0391 **逐位相同**。
    shadowMapSize: 512,
    shadowOrtho: 10,
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
    // R31：1024 → 768（面积 −44%）。R39：按同规则 768 → **384**，ortho 10
    // ⇒ texel 2×10/384 = **0.0521 m**，与改前 2×20/768 = 0.0521 **逐位相同**。
    shadowMapSize: 384,
    shadowOrtho: 10,
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
 * - shadowMapSize 再降一档（R39：high 1024 → 核显 768，见函数体内注释）；
 *   ⚠ **R38-P1-6 账实校正**：这里原写「实测 **113 DC / 78k tri**」是**过期错值**。
 *     探针实证（`tools/r38_frameload.mjs`）：**castle / Terrain / Road 的 castShadow
 *     全为 0**（castle.ts addMesh 显式置 false）⇒ 阴影 pass 是**车模独占**，
 *     实测 **41 DC / 23,308 tri**（车模 184 mesh 中 41 个 castShadow；
 *     再经 R38-P1-5 E2 关掉 28 个 <500 tri 的小件后为 **13 DC / 19,536 tri**）。
 *     错因：113/78k 是 R31 之前「城堡还投影」时代的读数，几何与 shadow flag 都改过后
 *     未回填 —— 正是本项目最危险的失效类型（数字不跟着实物走）。
 *     R39 追加：R39 探针实测「单次阴影重绘的净成本」在 268ms 帧下已**低于噪声**
 *     （同桶内重绘帧 265.2ms vs 非重绘帧 270.4ms；两帧合并 536.5 vs 535.8）
 *     ⇒ 阴影早已不是帧时主项，降这一档只为「把每帧成本摊平」（见 quality 顶注）。
 * - 画布 antialias 关掉：最终呈现走 composer 的 RT，默认帧缓冲再开 MSAA 纯属白付带宽。
 */
function applyIntegratedBudget(s: QualitySettings): QualitySettings {
  if (s.tier !== 'high') return s;
  s.pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  s.msaaSamples = 2;
  s.bloomScale = 0.5;
  // R39：high 现默认 1024 → 核显 **768**（ortho 仍 10）⇒ texel 2×10/768 = 0.0260 m
  // （比 0.01953 略粗 33%，是「像素预算档」唯一允许的降质方向），
  // 单次重绘面积只剩改前的 0.14×；且每帧重绘 ⇒ 成本恒定、无重/轻帧交替。
  s.shadowMapSize = 768;
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
