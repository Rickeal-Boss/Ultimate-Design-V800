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
 *
 * ── R32 波次（贴图极致细化 + 材料丰富度，2026-10-25）─────────────────────
 * 依据 `.qa/r32_brief.md` §1 参考图成片像素级判读 + `.qa/r32_tmp_texture/tex_stats.json`
 * （ref_palette/r29_tex_stats 重跑 45 张，只出标量不入图）：
 * 1) 石材冷白化（ashlar base/dark R−B +13/+24 → +6/+2；wall/marble 同步）；
 * 2) 砌块节拍定案 0.3m 世界尺度（ashlar 4×4 @ 1.2m，R31 的 8×3 长条砖已修正）；
 * 3) 各族新增层：masonry 风化凹坑（0.01–0.03m，固定 res 256 世界尺度跨尺寸一致）、
 *    rock 水平岩层 + relief 3 octaves、gold 竖向氧化痕 + 剥落 5–10%、roof 檐口搭接
 *    阴影带、wood 旧化灰斑、glass 窗台积灰 + 竖向流痕、marble 细脉 + 抛光斑块
 *    （roughness 分层）、floor 浅色勾缝（seamTone 0.06→0.62）。
 * 4) 契约不动：tex 总数 14、族种类 9、UV 重映射、异步/同步逐字节一致（shim 可证）。
 *
 * ── R34 波次（B 线：贴图极致细化 + 内部材质底子，2026-10）───────────────────
 * 1) 石墙族（ashlar / wall）逐项补齐参考图判读：
 *    · **灰缝有颜色了**：缝芯 blend 到「深灰（STONE_HEX.mortar）↔ 浅褐（MORTAR_WARM）」
 *      双色带，低频在两端之间游走 —— 旧实现只压暗不改色相，缝永远是「更暗的白石」；
 *    · 缝内微凹陷：缝芯高度 0.1 → 0.08（albedo 阴影 / 法线凹槽 / 粗糙度同源 h 派生）；
 *    · 砌块边缘磨损：`edgeNick` 沿缝口做粗颗粒抖动（缺棱 / 磨蚀 ⇒ 缝不是直边）；
 *    · 雨水渍：`seep` = 贴竖向灰缝 × 竖向拉长低频斑（淡黄-灰褐 SEEP_TINT），走独立通道。
 * 2) 内部材质族底子：新增 `STONE_VARIANTS`（inner-stone / inner-wood / gilded-aged /
 *    pave-damp）—— **全部复用既有图集**（同 kind+size+seed+weather+repeat ⇒ 命中
 *    makeStoneMaps 缓存），只改材质侧 color/rough/metal/env/normalScale ⇒ **贴图 0 新增**。
 * 3) 底图细化：wood 木纹节奏（ringWarp 弦切弯纹 + ringBand 早晚材带 + vessel 导管细线）、
 *    gold 做旧加量（氧化窗口放宽 + 剥落加深 + 刷脊抛光；**色相档不动**，R30b 决策）、
 *    floor 微湿低频斑（damp：albedo 压暗 + roughness 洼地；floor 现为 'noRough'，
 *    故 roughness 洼地在生产上不生效 —— 这是**刻意**的，见 CRAZY_PAVE.damp 注释）。
 * 4) ⚠ 平铺红线（本轮最重要的判据）：所有族走 RepeatWrapping 平铺，**任何「底部更脏」
 *    类的世界空间梯度都会在每 1 个 tile（ashlar 1.2m）重复一次 ⇒ 横向接缝带**。故
 *    「污渍集中在底部墙面 / 窗洞下方」**不在贴图内实现**（应由 A 线走顶点色或世界空间
 *    渍片），只做可平铺的「沿竖向灰缝渗出」版本。
 * 5) 契约不动：StoneKind 仍 9 族（castle.ts / castleKit.ts 的 `Record<StoneKind,…>` 依赖
 *    它，扩族会直接编译红），贴图张数 0 变化，异步/同步逐字节一致（shim 可证）。
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
  /** 非全通道族（glass/wood 等）可为 null：该族只产 albedo，不挂法线/粗糙图 */
  normalMap: THREE.CanvasTexture | null;
  /** 非全通道族（roof/marble/floor 等）可为 null：该族 roughness 由 material 直接给定 */
  roughnessMap: THREE.CanvasTexture | null;
  /** 生成实测统计（给使用方反算 material.roughness / 自检用） */
  stats: StoneStats;
}

/**
 * R31 贴图数量治理③：每族的**通道预算**（castle.ts 按族下发，见 STONE_CHANNELS）。
 * - 'full'      ：map + normalMap + roughnessMap（ashlar / gold 主体）
 * - 'noRough'   ：map + normalMap（roof / marble / floor：rough 由 material 直接给定）
 * - 'albedoOnly'：仅 map（glass / wood：只留 albedo，法线/粗糙由其它通道承载观感）
 * 默认值 'full' ⇒ 既有调用方（car / Terrain）零改动。
 */
export type StoneChannels = 'full' | 'noRough' | 'albedoOnly';

export interface StoneOptions {
  /** 贴图边长（2 的幂，默认 512） */
  size?: number;
  /** UV 重复次数（默认 [1,1]）；应按 STONE_TILE_METERS 换算后传入 */
  repeat?: [number, number];
  seed?: number;
  /** 0..1 风化：污渍 + 块间色差（默认 0.35） */
  weather?: number;
  /** R31 贴图数量治理③：该族产哪些通道（默认 'full'，见 StoneChannels） */
  channels?: StoneChannels;
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
 *
 * ── R32 冷白化（简报 §1 参考图成片像素级判读，2026-10-25）─────────────────
 * 图A：石材 RGB≈(220,220,215) 冷白 / 阴影面 (180,180,175)；图B：石材偏冷白
 * (200,205,215)、阴影 (110,115,125)。**与 R29 Fab 贴图统计（castle 族 warmRB
 * 中位 +53.6，且被 1_1/3_1 两张金饰纹理拉偏）有意分岔**：R32 读数是成片渲染值，
 * 按「渲染匹配参考」方法论（R30b 金饰同款）把 ashlar base/dark 的 R−B 从
 * +13/+24 收到 +6/+2；wall/marble 同步收冷。本场景天光 sky 0x8fa0bd 亦偏冷，
 * 若成片仍偏暖，优先动 Lighting/C 线而不是回退这里。
 */
/**
 * 色族四档色 + **灰缝色**。
 * ⚠ R34：`mortar` 从「死字段」变成**真消费**（旧实现只是压暗、不改色相，缝永远是
 * 「更暗的白石」；参考图判读要求灰缝是「深灰至浅褐」）。缝色带的两端：
 *   `mortar`（深灰端） ← 低频 `MORTAR_WARM` 混合 → `MORTAR_WARM`（浅褐端）。
 * 明度校准（sRGB 码值口径，stone 面 ashlar L≈219）：
 *   ashlar 缝 = 深灰 148×0.90≈133（0.61×）↔ 浅褐 189×0.90≈170（0.78×）；
 *   wall   缝 = 深灰 126×0.88≈111（0.60×）↔ 浅褐 168×0.88≈148（0.80×）。
 */
export const STONE_HEX: Record<StoneKind, { base: string; light: string; dark: string; mortar: string }> = {
  ashlar: { base: '#dcdcd6', light: '#f3f2ee', dark: '#b2b4b0', mortar: '#97948c' },
  wall: { base: '#bcbcb8', light: '#d6d6d2', dark: '#7f817d', mortar: '#807d75' },
  // R32 图B 路面 (60,55,50)：与 R29 StoneFloor 中位 #413f3d 同源，取中值 #3e3b37
  floor: { base: '#3e3b37', light: '#5c5954', dark: '#282624', mortar: '#1c1b1a' },
  // R32 图B 远山：大气透视偏浅灰褐（hue 30–40° / V 50–60%）。Fab 岩石贴图是**近景
  // 崖壁**（L mean 100.8，无空气衰减），远山按参考成片提亮 ~25%（V 40%→55%，hue 36° 保持）
  rock: { base: '#8c7c64', light: '#a89880', dark: '#5f5546', mortar: '#463d31' },
  // R30b 金色调饱和（铁律 31 ACES 反演）：FBX albedo 实测 R−B +118 是 **tonemap 前**
  // 的源值；参考全景 7cd7329c 成片金饰实测 R−B 仅 +66（哑光古铜）。旧色 #c9a227
  // 直填导致成片金饰 R−B +122（verify/r30_phase3 量化），比参考艳一倍 → 全面褪金
  // 降饱和（B 通道 +45），ACES 后成片 R−B ≈ +70 落进参考带。
  // ⚠ R32 简报图A/B 又给金 (210,180,80)/(220,180,90)（R−B +130）——与 R30b 实测
  //   +66 冲突（疑为亮部采样 vs 全域平均之差）。本幅保持 R30b 已验证档位不动色，
  //   做旧细节（氧化暗痕/剥落/划痕）在 prepGold 里加量；R32 读数落在本贴图刷纹
  //   高段 (≈#d3b265) 范围内，不构成二次偏离。
  gold: { base: '#bb9a55', light: '#ecd9a0', dark: '#6f5c39', mortar: '#39301f' },
  // 屋面板岩（冷灰，与白石立面拉开冷暖对比）
  roof: { base: '#50545a', light: '#70757b', dark: '#2d3033', mortar: '#1f2124' },
  // 城门木（旧橡木，暖褐）
  wood: { base: '#4a3527', light: '#6a5340', dark: '#2b1f15', mortar: '#1c1410' },
  // 窗玻璃（冷调铅条窗，低粗糙度靠环境反射出「玻璃感」，不走 transmission —— R12 铁律⑤）
  glass: { base: '#9db9c2', light: '#d9e8ec', dark: '#5f7c86', mortar: '#39464c' },
  // R32 柱身/台基大理石（主殿/祭坛）：冷白 + 冷灰脉络（dark R−B +14→+6）
  marble: { base: '#dcdcd6', light: '#f0efe9', dark: '#a4a49e', mortar: '#7c7a74' }
};

/**
 * 1 张贴图代表的真实边长（米）。改这里之前先看贴图规格：
 * - **ashlar 1.2m（R31：6.4 → 1.2）**：R29 的 6.4m「大板块弱缝」是**判错的**。
 *   R31 参考图放大细读：墙 = 小砌块 + 逐块明度抖动 + 明显灰缝 + 块面倒角高光。
 *   **R32 定案**（简报 §1 图A 硬读数：块 ~0.3m、缝 ~0.02m）：1.2m/tile ÷ 4×4 块
 *   = **0.3m 见方**（MASONRY.ashlar.rows/cols = 4×4；R31 悬案「0.45m 则改 1.8/4×4」
 *   经 R32 复核不取——0.45m 偏大，0.3m 才是参考成片的缝节奏）。
 *   ⚠ 砌块在 UV 上是方的（castleKit.planarUV 用同一个 tile 除 u/v），
 *   所以 **rows 必须等于 cols**，否则砌块会被拉成长条（R31 的 8×3 在 1.2m 下就是
 *   0.15m×0.4m 的砖，R32 已修正为 4×4）。
 * - wall 2.4m（7.2 → 2.4）：次级墙同步改成小砌块（R32：5×5 块 ⇒ 0.48m 见方）。
 *   ⚠ 本族当前在生产上**不走自己的族**（castle.ts FAMILY_ALIAS 把 wall 并进 ashlar），
 *   这里保留是为了独立调用（QA/bench）与未来解绑。
 * - floor 3.6m：**乱石板 crazy-paving**（3×3 抖动格 Voronoi，~2.4m 不规则板块；castleKit
 *   paveTile = 本值×2 = 7.2m/张，据 r29_vision §2-D，非旧规则方板）。**R31 不动**：
 *   它是 makePaving 的 UV 口径，改它会连带改路面缝距。
 * - rock 3.6m：4×4 乱石坡面；
 * - gold 1.2m：鎏金饰带的细腻刷纹；
 * - roof 1.6m（2.4 → 1.6）：12 皮 × 8 片 ⇒ 每片板岩 0.13×0.2m（真板岩尺度）；
 * - wood 1.6m（2.0 → 1.6）：4 块竖向木板 ⇒ 板宽 0.4m（真门板尺度）；
 * - glass 1.6m：3 行 × 2 列铅条窗格；
 * - marble 2.4m（3.2 → 2.4）：细磨石的脉络尺度（无块缝，竖脉）。
 *
 * ⚠ 铁律 35：改本表前先 grep 消费点 —— `castleKit.ts` 在模块初始化时快照了
 * `{...STONE_TILE_METERS}`（TILE），`castleDetail.ts` 直接读 `STONE_TILE_METERS.*`
 * 做 UV，`makePaving` 用 `STONE_TILE_METERS.floor * 2` 定铺装缝距。
 * 改 ashlar/wall 会连带改全城 UV 密度（本轮正是要它更密）。
 */
export const STONE_TILE_METERS: Record<StoneKind, number> = {
  ashlar: 1.2,
  wall: 2.4,
  floor: 3.6,
  rock: 3.6,
  gold: 1.2,
  roof: 1.6,
  wood: 1.6,
  glass: 1.6,
  marble: 2.4
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
  /* ── R32 极致细化新增层 ── */
  /**
   * 风化凹坑（简报 §1 图A：0.01–0.03m）：固定 res 256 的 fbm ⇒ **世界尺度跨贴图
   * 尺寸一致**（256² 同步代与 1024² 目标代同尺度）。走高度场（法线真源）+ 压暗 +
   * 抬粗糙度；pitPeriod 定坑的基准周期（32 ⇒ 8px@256 ≈ 0.019m@1.2m/tile）。
   */
  pit: number;
  pitPeriod: number;
  /* ── R34 极致细化新增层 ── */
  /**
   * 灰缝**上色**强度（0..1）：缝芯 blend 到灰缝色的比例（缝色带 = 深灰↔浅褐）。
   * 旧实现只有「压暗」、不改色相 ⇒ 缝永远是「更暗的白石」；参考图判读要求灰缝是
   * **深灰至浅褐**。通道值 = 缝芯遮罩 × 本值，compose 只做一次 lerp，成本固定。
   */
  jointTint: number;
  /** 缝色在「深灰端 ↔ 浅褐端」之间的低频游走幅度（0..1；0.9 ⇒ 权重 ≈0.23..0.77） */
  jointWarm: number;
  /** 灰缝自身亮度系数（乘在灰缝色上；与 stone 的 shadeLo 分开，便于单独调缝的深浅） */
  jointShade: number;
  /**
   * 雨水渍幅度（沿竖向灰缝渗出，淡黄-灰褐 SEEP_TINT）。
   * ⚠ 只做**可平铺**的版本（贴竖向缝 × 竖向拉长低频斑）；「污渍集中在底部墙面 /
   * 窗洞下方」是**世界空间**梯度，平铺下每 1.2m 重复一次 ⇒ 横向接缝带，禁止在贴图内做
   * （见头注 R34 §4，遗留项交由 A 线走顶点色 / 世界空间渍片）。
   */
  seep: number;
  /**
   * 砌块边缘磨损（缺棱 / 磨蚀）：沿缝口做**粗颗粒**抖动（cell ≈8px@512 ≈ 0.019m），
   * 让缝不是尺子画的直边。乘在 edge 距离上（±），不动缝芯宽度 ⇒ 不削弱缝的清晰度
   * （R31 的「缝必须更清晰」判据仍成立）。
   */
  edgeNick: number;
}

const MASONRY: Record<'ashlar' | 'wall', MasonryProfile> = {
  ashlar: {
    // R32：4×4 @ 1.2m/tile = 0.3m 见方砌块（简报 §1 图A：块 ~0.3m、缝 ~0.02m）
    rows: 4,
    cols: 4,
    stagger: 0.5,
    jointPx: 3.2,
    bevelPx: 3.8,
    mortarShade: 0.78,
    blockTint: 0.14,
    faceRough: 0.8,
    jointRough: 0.93,
    normalStrength: 0.82,
    relief: 0.16,
    grain: 0.055,
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
    // R32：色斑/水渍上墙（图A 风化判读的「色斑」项）
    patch: 0.12,
    // R32：风化凹坑 0.01–0.03m（固定 res 256 ⇒ 世界尺度跨尺寸一致）
    pit: 0.055,
    pitPeriod: 32,
    // R34：灰缝上色（深灰 #97948c ↔ 浅褐 #d0bb99），缝自身亮度 0.90
    jointTint: 0.88,
    jointWarm: 0.9,
    jointShade: 0.9,
    // R34：沿竖向灰缝渗出的淡黄-灰褐雨水渍（0.85 经覆盖度实测标定 ⇒ >0.15 覆盖 ≈10%）
    seep: 0.85,
    // R34：砌块边缘磨损/缺棱（粗颗粒抖动 ±12%）
    edgeNick: 0.12
  },
  wall: {
    // R32：5×5 @ 2.4m/tile = 0.48m 见方（rows==cols，勿拉成长条）
    rows: 5,
    cols: 5,
    stagger: 0.5,
    jointPx: 2.6,
    bevelPx: 3.4,
    mortarShade: 0.76,
    blockTint: 0.15,
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
    patch: 0.12,
    pit: 0.05,
    pitPeriod: 32,
    // R34：次级墙缝更深更脏（深灰 #807d75 ↔ 浅褐 #bda684），渍更重
    jointTint: 0.85,
    jointWarm: 0.85,
    jointShade: 0.88,
    seep: 0.9,
    edgeNick: 0.14
  }
};

/**
 * R34 灰缝「浅褐」端 + 雨水渍色（只有砌体族 ashlar / wall 有，其余族不产缝色通道）。
 * - `MORTAR_WARM`：与 `STONE_HEX.mortar`（深灰）构成「**深灰 → 浅褐**」缝色带的两端，
 *   逐像素的混合权重由低频 `jointWarm` 通道给出（≈0.23..0.77，两端都够得到但不打满）；
 * - `SEEP_TINT`：**淡黄-灰褐**雨水渍。比石材基色暗一档、色相偏黄褐 ⇒ blend 后读作
 *   「脏」而不是「阴影」（纯压暗会被当成法线阴影，参考图里渍是暖的）。
 */
const MORTAR_WARM: Partial<Record<StoneKind, string>> = {
  ashlar: '#d0bb99',
  wall: '#bda684'
};
const SEEP_TINT: Partial<Record<StoneKind, string>> = {
  ashlar: '#bdae90',
  wall: '#aea084'
};
/** 渍色 blend 强度上限（乘在 seep 通道值 0..1 上） */
const SEEP_BLEND = 0.5;

/**
 * R30 路面**乱石板（crazy-paving）**参数表。据 `.qa/r29_vision.md` §2-D（置信度 H）：
 * 用户所说 StoneFloor 目标 = 不规则多边形石板、块间色差大、2m 级板块、
 * 带法线凹凸、干面 —— 而非旧规则方板网格。形制由 prepFloor（抖动格 Voronoi）生成。
 * 基色仍锁 #413f3d（R29 吸色硬数据），块间色差在 #3A3A3A–#606060 一档游走。
 *
 * R32 缝色改判（简报 §1 图B：桥面 (60,55,50) 深色 + **浅色勾缝**）：R29 §2-D 的
 * 「深色缝 ≈#222」是近景特写判读；R32 参考成片里桥面石板是深色、勾缝偏浅（积灰/
 * 磨亮的水泥质）。seamTone 0.06→0.62 + mortarShade 0.72→0.82 ⇒ 缝 ≈ #3b3a38，
 * 在深色半区石块上明确读作「浅勾缝」，又保留缝的几何暗部（h 低 ⇒ shade 仍压）。
 */
const CRAZY_PAVE = {
  /** 抖动格边数（cells×cells 个 Voronoi 心）；3×3 @ 7.2m/张 ⇒ ~2.4m 不规则板块 */
  cells: 3,
  /** 块间色差幅度（大！crazy-paving 的 identity）：tone ±0.30 ⇒ #3A3A3A↔#606060 */
  blockTint: 0.3,
  /** 低频色斑（板内天然色差/水渍矿斑） */
  patch: 0.14,
  grime: 0.22,
  /** 石面细凿点 + 颗粒 */
  chisel: 0.045,
  grain: 0.075,
  /** 磨光：块心被人/车磨亮（板间磨损变化） */
  wear: 0.24,
  /** 缝芯亮度目标（R32 浅色勾缝：blend 到 base 略上方，配 compose shade 出浅灰缝） */
  seamTone: 0.62,
  faceRough: 0.44,
  jointRough: 0.84,
  normalStrength: 1.15,
  /** 缝底亮度比（compose shadeLo）⇒ 与 seamTone 共同定勾缝明度 */
  mortarShade: 0.82,
  /**
   * R34 微湿感（低频水渍斑，周期 4 ⇒ ≈1.8m@7.2m/张）：湿处 albedo 压暗 + roughness 洼地。
   * ⚠ **历史坑（R26h / 铁律 34 的孪生陷阱）**：three 的 effective roughness =
   *   material.roughness × roughnessMap.g。本族 faceRough 0.44 / jointRough 0.84 ⇒
   *   ḡ≈0.5，若把 floor 从 'noRough' 切成 'full'，`inverseRoughness(0.9, 0.5)` 会被
   *   clamp 到 1 ⇒ effective 掉到 0.5（哑光石面被乘亮/乘滑）—— 正是「哑光石面别挂会
   *   乘低 roughness 的 roughnessMap」那条。故本族**保持 noRough**，微湿感只走 albedo
   *   （+ 仍然算进 roughness 数组，供 stats / 未来若改口径时校验用）。
   */
  damp: 0.3
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
  grain: 0.055,
  stain: 0.4,
  moss: 0.22,
  streak: 0.24,
  ragged: 0.26,
  /** R32 檐口/搭接阴影：每皮瓦顶部被上一皮覆盖 ⇒ 课程顶缘阴影带（简报 §1 檐口判读） */
  lapShadow: 0.26,
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
  stain: 0.46,
  streak: 0.3,
  /** R32 旧化灰斑（材料丰富度）：低频斑块脱色（压暗 + 抬粗糙），木楼板/廊柱的岁月感 */
  grayWeather: 0.12,
  faceRough: 0.78,
  jointRough: 0.88,
  /* ── R34 木纹节奏细化 ── */
  /**
   * 弦切弯纹（cathedral figure）：用低频场把木纹的 **x 采样坐标整体平移** ⇒ 原本笔直的
   * 竖向纹被掰成弓形（真实弦切板就是这种「拱形年轮」）。平移按整像素取模环绕 ⇒
   * 仍严格可平铺，且**只读同一行** ⇒ 行带分片与整幅逐字节一致。
   * 数值 = 平移幅度占贴图边长的比例（0.12 ⇒ ±15px@512 ≈ 3 个木纹细胞，弓形才读得出）。
   */
  ringWarp: 0.12,
  /** 早晚材带（年轮疏密）：低频调制木纹对比度，让纹路有「密一段 / 疏一段」的节奏 */
  ringBand: 0.35,
  /** 导管细线（比 grain 更细一档的竖线，periodX 128 > grain 96 ⇒ 更密） */
  vessel: 0.04,
  vesselPeriodX: 128,
  vesselPeriodY: 3
};

const PANE = {
  rows: 3,
  cols: 2,
  jointPx: 3.4,
  bevelPx: 2.0,
  normalStrength: 0.35,
  relief: 0.03,
  waviness: 0.02,
  /** R32 窗玻璃微污（材料丰富度）：窗台积灰（每扇底缘）+ 竖向脏痕（雨水流痕）；
   *  内透光由灯光/自辉负责（castle.ts FAMILY_EMISSIVE），贴图只做表面 */
  sillDust: 0.18,
  smear: 0.12,
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
  grain: 0.022,
  /** R32 细纹（第二组脉，8×32 各向异性，门限更高 ⇒ 更细更稀）与抛光差异
   *  （低频斑块局部更光：roughness 分层，简报 §1「抛光差异」项） */
  fineVeinAmp: 0.5,
  finePeriodX: 8,
  finePeriodY: 32,
  polish: 0.06
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
  /**
   * R34 缝芯遮罩 × jointTint（0..255，仅砌体族 ashlar/wall；其余族 null）。
   * compose 用它把缝色（深灰↔浅褐）blend 上去 —— **贴图新增字段，向后兼容**（只读）。
   */
  readonly joint: Uint8ClampedArray | null;
  /** R34 缝色「深灰端(0) ↔ 浅褐端(255)」低频权重（仅砌体族；其余族 null） */
  readonly jointWarm: Uint8ClampedArray | null;
  /** R34 雨水渍遮罩（0..255，沿竖向灰缝渗出的淡黄-灰褐渍；仅砌体族；其余族 null） */
  readonly seep: Uint8ClampedArray | null;
  build(y0: number, y1: number): void;
  expand(y0: number, y1: number): void;
  compose(y0: number, y1: number): void;
  finish(): StoneStats;
}

// ── 各族的 prep + buildBand（per-pixel 公式与 R29 逐字一致）───────────

/**
 * 砌体高度场（ashlar / wall）的 prep：建字段 + 逐块表 + 行带构建器。
 * R34 新增三个**输出通道**（都是 null 容忍 ⇒ 其余族零开销）：
 *   jointOut    缝芯遮罩 × jointTint（compose 把缝色 blend 上去）
 *   jointWarmOut 缝色在「深灰↔浅褐」之间的低频权重
 *   seepOut     雨水渍遮罩（贴竖向缝 + 竖向拉长低频斑）
 */
function prepMasonry(
  size: number,
  seed: number,
  weather: number,
  prof: MasonryProfile,
  height: Float32Array,
  tone: Float32Array,
  roughness: Float32Array,
  mossOut: Float32Array | null,
  jointOut: Uint8ClampedArray | null,
  jointWarmOut: Uint8ClampedArray | null,
  seepOut: Uint8ClampedArray | null
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
  // R32 风化凹坑（固定 res 256 ⇒ 世界尺度 0.01–0.03m 跨尺寸一致；pitPeriod 32 ⇒ 坑 ≈0.019m）
  const pitF = makeField(prof.pit, () => fbmField(256, prof.pitPeriod, prof.pitPeriod, 2, seed + 239), size);
  /* ── R34 三个新通道的驱动场 ── */
  // 缝色「深灰↔浅褐」低频权重（2×3 ⇒ 大块斑，一条缝上走得慢 ⇒ 同一段缝同色）
  const mortarVarF = makeField(prof.jointWarm, () => fbmField(64, 2, 3, 2, seed + 307), size);
  // 雨水渍：6×2 ⇒ 沿 x 快变（窄竖条 ≈0.2m 间距）、沿 y 慢变（0.6m 长竖向拖尾）
  const seepF = makeField(prof.seep, () => fbmField(128, 6, 2, 2, seed + 311), size);
  // 边缘磨损：粗颗粒（cell ≈8px@512 ≈0.019m）⇒ 缝口呈啃噬状而非尺画直边
  const nickF = makeField(prof.edgeNick, () => noiseField(Math.min(256, size), 64, 64, seed + 313), size);

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
      fillField(pitF, y0, y1);
      fillField(mortarVarF, y0, y1);
      fillField(seepF, y0, y1);
      fillField(nickF, y0, y1);
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
      const pitField = pitF ? pitF.out : EMPTY;
      const mortarVarField = mortarVarF ? mortarVarF.out : EMPTY;
      const seepField = seepF ? seepF.out : EMPTY;
      const nickField = nickF ? nickF.out : EMPTY;

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
          // R34 边缘磨损/缺棱：缝口沿缝长方向做粗颗粒抖动（±edgeNick），缝芯宽度不动
          const nick = nickField.length ? (nickField[index] - 0.5) * 2 * prof.edgeNick : 0;
          const edge = (Math.min(lx, colW - lx, ly, rowH - ly) / jw) * (1 + nick);
          const bevel = smoothstep(halfJoint, bevelEnd, edge);

          const base = baseFbm.length ? baseFbm[index] : 0.5;
          const reliefV = reliefField.length ? reliefField[index] : 0.5;
          const grain = grainTable[grainRow + grainCol[x]];
          const grime = grimeField.length ? grimeField[index] : 0.5;
          const streak = streakField.length ? streakField[index] : 0.5;
          const chiselV = chiselField.length ? chiselField[index] : 0.5;
          // R32 风化凹坑：门限经分布标定（0.64→0.80 ⇒ 实心覆盖 ≈9%，见
          // .qa/r32_tmp_texture/flake_threshold_calib.mjs：bilinear 值噪声极少触顶）
          const pitMask = pitField.length ? smoothstep(0.64, 0.8, pitField[index]) : 0;

          // R34 雨水渍：**贴竖向灰缝** × 竖向拉长低频斑。
          // 竖向缝邻近度用「到最近竖缝的距离 / 缝宽」量 ⇒ 与贴图尺寸无关（世界尺度一致）；
          // 1→18 缝宽单位 ≈ ±0.068m@1.2m/tile ⇒ 渍带 ≈13.5cm 宽（真实 runoff 量级）。
          // ⚠ 两个门限都是**实测标定**的：fbm 值天然向 0.5 集中（2 octave 上尤甚），
          //   按 0.42/0.78 这类「名义门限」取门限会得到 ≈0 的覆盖（实测 see .qa/r34_tmp_texture）。
          const dvx = Math.min(lx, colW - lx) / jw;
          const vJoint = 1 - smoothstep(1, 18, dvx);
          const seepRaw = seepField.length ? smoothstep(0.38, 0.58, seepField[index]) : 0;
          const seepMask = vJoint * seepRaw * prof.seep * (0.55 + 0.45 * weather);

          // —— 高度场（法线 / 缝阴影 / 粗糙度的唯一真源）——
          // R34：缝芯 0.1 → 0.08（缝内微凹陷，法线凹槽与 albedo 暗部同源加深）
          let h = 0.08 + 0.92 * bevel;
          h += (reliefV - 0.5) * prof.relief * (0.55 + 0.9 * blockRelief[block]) * bevel;
          h += (base - 0.5) * prof.relief * prof.reliefNoise * bevel;
          h += (chiselV - 0.5) * prof.chisel * bevel; // R30 中频凿点（精切石肌理）
          h -= pitMask * prof.pit * bevel; // R32 凹坑压低石面（法线真源）
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
          t -= pitMask * 0.1 * weather; // R32 坑内积水/积灰更暗
          t -= seepMask * 0.16 * weather; // R34 雨水渍压暗（渍色由 compose blend 上去）
          t += grain * prof.grain * 1.6;
          t += wearEdge;

          let rough = prof.jointRough + (prof.faceRough - prof.jointRough) * smoothstep(0.42, 0.95, bevel);
          rough += (reliefV - 0.5) * 0.08 * weather;
          rough += Math.abs(chiselV - 0.5) * prof.chisel * 0.9; // R30 凿点处更哑
          rough += pitMask * 0.12; // R32 坑内更哑（风化石）
          rough += Math.max(0, grime - 0.42) * prof.grime * 0.35;
          rough += seepMask * 0.1; // R34 渍带略哑（积灰的雨水痕）
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
          // —— R34 三个输出通道（null ⇒ 该族不产，零开销）——
          if (jointOut) {
            // 缝芯遮罩（1 - bevel：缝芯 1 → 倒角过渡 → 块面 0）× 上色强度
            jointOut[index] = (1 - bevel) * prof.jointTint * 255;
            // 缝色权重：低频在「深灰端(0) ↔ 浅褐端(1)」之间游走。
            // ⚠ 必须先做**对比拉伸**：fbm 值向 0.5 集中（实测 jointWarm 原分位 51/137/180
            //   ⇒ 两端根本够不到），拉伸后再乘 jointWarm ⇒ 分位落进 ≈13..242。
            const wv = mortarVarField.length ? smoothstep(0.34, 0.66, mortarVarField[index]) : 0.5;
            jointWarmOut![index] = clamp01(0.5 + (wv - 0.5) * prof.jointWarm) * 255;
          }
          if (seepOut) seepOut[index] = clamp01(seepMask) * 255;
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
  // R34 微湿低频斑（4×4 @7.2m/张 ⇒ ≈1.8m 水渍）：湿处压暗 + roughness 洼地
  const dampF = makeField(1, () => fbmField(96, 4, 4, 2, seed + 337), size)!;

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
  /**
   * R34 **可平铺性缺陷修复**（实测证据 .qa/r34_tmp_texture/r34_seam_check.mjs）：
   * 乱石板 Voronoi 原来直接用 `cx[cid] − x` 求距离，而 `cx[]` 全部落在 [0,size) ⇒
   * **从不考虑邻贴图的复制格**。于是靠近贴图边界的像素会把「隔壁那块石板」算成
   * 512−Δ 之远（真值 Δ）⇒ 最近/次近格心判错、gap 虚高 ⇒ 平铺接缝处**每 7.2m 一条硬缝**
   * （实测：边界列差 17.63 vs 内部相邻列最大 2.74，超出一个量级）。
   * 修法 = **最小镜像距离**（把 dx/dy 折回 [−size/2, size/2]，与无限平铺的真实距离一致）。
   * 注：`prepRock` 用 `(gx + offset) * cellSize`（gx 可取 −1 / cells）天然落在界外，
   * 等价已考虑复制格 ⇒ 它没这个病（实测 rock 接缝 1.55 / 内部 p95 3.14 = OK）。
   */
  const halfSpan = size * 0.5;

  return {
    build(y0: number, y1: number): void {
      fillField(patchF, y0, y1);
      fillField(microF, y0, y1);
      fillField(grimeF, y0, y1);
      fillField(chiselF, y0, y1);
      fillField(dampF, y0, y1);
      const patchA = patchF ? patchF.out : EMPTY;
      const microA = microF.out;
      const grimeA = grimeF.out;
      const chiselA = chiselF.out;
      const dampA = dampF.out;
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
              // R34 最小镜像距离（可平铺性修复，见 halfSpan 处注释）
              let dx = cx[cid] - x;
              let dy = cy[cid] - y;
              if (dx > halfSpan) dx -= size;
              else if (dx < -halfSpan) dx += size;
              if (dy > halfSpan) dy -= size;
              else if (dy < -halfSpan) dy += size;
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
          // R34 微湿低频斑：只取 fbm 上段 ⇒ 稀疏水渍（≈15% 覆盖），不是全局变暗
          const damp = smoothstep(0.55, 0.88, dampA[index]) * P.damp;

          // 高度场：板心微拱 + 缝口低 + 微起伏 + 凿点 + 颗粒（法线真源）
          let h = 0.05 + 0.7 * bevel + dome * 0.14 * bevel;
          h += (microV - 0.5) * 0.06 * bevel;
          h += (chiselV - 0.5) * P.chisel * bevel;
          h -= damp * 0.02 * bevel; // R34 湿处微凹（水膜压平感）
          h += grain * P.grain;
          height[index] = clamp01(h);

          // 明度：块间大色差 + 板内斑 + 微起伏 + 污 + 颗粒 + 磨光（磨损变化）
          let t = 0.5 + tint[bestId] * P.blockTint;
          if (patchA.length) t += (patchA[index] - 0.5) * P.patch;
          t += (microV - 0.5) * 0.16;
          t += (grimeV - 0.42) * P.grime * weather;
          t += grain * P.grain * 1.6;
          t += smoothstep(0.45, 0.95, dome) * wear[bestId] * P.wear * 0.12;
          t -= damp * 0.1; // R34 湿处压暗（深色石板 + 水渍的「深色」读数）
          // 深色缝：blend 到 seamTone（≈dark），配 compose shade(mortarShade 0.72) ⇒ #222
          const seamMask = 1 - bevel;
          t = t * (1 - seamMask) + P.seamTone * seamMask;
          tone[index] = clamp01(t);

          // 粗糙度（pavement 不挂 roughnessMap、给均匀 0.9；此处仍算供 stats/备用）
          // ⚠ 见 CRAZY_PAVE.damp 的「历史坑」注释：本族保持 noRough，下面的洼地不入管线。
          let rough = P.faceRough + (P.jointRough - P.faceRough) * (1 - bevel);
          rough += (microV - 0.5) * 0.06 * weather;
          rough -= smoothstep(0.45, 0.95, dome) * wear[bestId] * P.wear * 0.3; // 磨光处更滑
          rough -= damp * 0.28; // R34 湿处更滑（微湿感的真身；生产上暂不挂 roughMap）
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

  // R32：relief 2→3 octaves（远山也要多尺度细节）；新增水平岩层（strata：4×64 ⇒ 沿 x
  // 慢变、沿 y 快变 ⇒ 水平层理，cellY 4px@half ≈ 0.22m@3.6m/tile）与细颗粒层
  const reliefF = makeField(1, () => fbmField(res, 8, 8, 3, seed + 41), res);
  const stainF = makeField(1, () => fbmField(res >> 1, 4, 4, 2, seed + 53), res);
  const grainF = makeField(1, () => noiseField(res >> 1, 32, 32, seed + 61), res);
  const strataF = makeField(1, () => noiseField(res, 4, 64, seed + 73), res);
  const grainFineF = makeField(1, () => noiseField(res >> 1, 64, 64, seed + 79), res);
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
      fillField(strataF, y0, y1);
      fillField(grainFineF, y0, y1);
      const reliefField = reliefF!.out;
      const stainField = stainF!.out;
      const grainField = grainF!.out;
      const strataField = strataF!.out;
      const grainFineField = grainFineF!.out;
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
          const strataV = strataField[index] - 0.5;
          const grainFine = grainFineField[index] - 0.5;

          let h = 0.18 + 0.62 * bevel + 0.2 * dome * bevel;
          h += (reliefV - 0.5) * 0.16 * bevel;
          h += strataV * 0.08 * bevel; // R32 岩层微起伏（崖壁层理）
          h += grain * 0.05;
          h += grainFine * 0.035; // R32 细颗粒
          h2[index] = clamp01(h);

          const stain = stainField[index];
          let t = 0.5 + tint[bestId] * 0.11 + (reliefV - 0.5) * 0.3 + (stain - 0.5) * 0.55 * weather;
          t += strataV * 0.16; // R32 岩层明暗（远山剪影的横向节奏）
          t += grainFine * 0.05;
          t -= (1 - bevel) * 0.22 * weather;
          t2[index] = clamp01(t);
          r2[index] = clamp01(0.95 - 0.09 * bevel + (stain - 0.5) * 0.06 + Math.abs(strataV) * 0.04);
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
 * R32（简报 §1 图A：哑光古铜 (210,180,80) + 氧化痕 (150,120,50) + 剥落 5–10%）：
 * - 氧化改为「斑 + 竖向痕」双组分（痕 = 16×2 各向异性 ⇒ 沿金条流下的氧化线）；
 * - 新增**剥落层**（32px@res256 ≈ 0.075m@1.2m 稀疏斑块，门限 0.80→0.88 ⇒ 覆盖 ≈7%，
 *   门限经分布标定见 .qa/r32_tmp_texture/flake_threshold_calib.mjs）：露下方暗基底
 *   （tone 压向 dark + 粗糙度飙升 + 高度凹入），做旧但可读。
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
  // R32 竖向氧化痕（16×2 ⇒ 沿 y 慢变、沿 x 快变 ⇒ 竖痕；cellX 8px@128）
  const oxStreak = makeField(1, () => fbmField(128, 16, 2, 2, seed + 257), size)!;
  const grain = makeField(1, () => noiseField(size >> 1, 32, 32, seed + 67), size)!;
  const pit = makeField(1, () => noiseField(Math.min(512, size), 48, 48, seed + 89), size)!;
  const polish = makeField(1, () => fbmField(128, 3, 3, 2, seed + 97), size)!;
  // R30 划痕（做旧）：各向异性细丝（64×16 ⇒ 竖向细痕）取门限上段 = 稀疏划痕，露下方新金属
  const scratch = makeField(1, () => noiseField(Math.min(512, size), 64, 16, seed + 241), size)!;
  // R32 剥落（固定 res 256 ⇒ 世界尺度跨尺寸一致；门限 0.80→0.88 经分布标定 ⇒ 覆盖 ≈7%）
  const flake = makeField(1, () => noiseField(256, 32, 32, seed + 263), size)!;

  return {
    build(y0: number, y1: number): void {
      fillField(brush, y0, y1);
      fillField(brushFine, y0, y1);
      fillField(ox, y0, y1);
      fillField(oxStreak, y0, y1);
      fillField(grain, y0, y1);
      fillField(pit, y0, y1);
      fillField(polish, y0, y1);
      fillField(scratch, y0, y1);
      fillField(flake, y0, y1);
      const b1a = brush.out;
      const b2a = brushFine.out;
      const oxa = ox.out;
      const oxsa = oxStreak.out;
      const graina = grain.out;
      const pita = pit.out;
      const polisha = polish.out;
      const scratcha = scratch.out;
      const flakea = flake.out;
      for (let y = y0; y < y1; y += 1) {
        const dstRow = y * size;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const b1 = b1a[index];
          const b2 = b2a[index];
          // R32 氧化 = 斑(0.68) + 竖痕(0.32) 双组分
          const oxv = oxa[index] * 0.68 + oxsa[index] * 0.32;
          const g = graina[index] - 0.5;
          const pitv = pita[index];
          const polishv = polisha[index];
          // R34 做旧加量：氧化窗口整体下移（0.62→0.58 起、0.9→0.87 满）⇒ 覆盖更广、更暗。
          // ⚠ 只动**明度/粗糙度**，不动色调：金饰色相档是 R30b 已验证决策（成片 R−B ≈ +70），
          //   氧化只把 tone 推向 dark #6f5c39（同色系更深），不引入绿锈等异色相。
          const oxidized = smoothstep(0.58 - 0.22 * weather, 0.87, oxv);
          const pits = smoothstep(0.7, 0.87, pitv) * (1 - oxidized) * weather; // R34 麻点略多
          const shine = smoothstep(0.52, 0.8, polishv);
          const sc = smoothstep(0.7, 0.76, scratcha[index]); // R30 稀疏划痕
          const flakeMask = smoothstep(0.8, 0.88, flakea[index]); // R32 剥落（标定覆盖 mask>0.5 ≈6.8%，落 5–10% 带）

          let h = 0.58 + (b1 - 0.5) * 0.26 + (b2 - 0.5) * 0.13;
          h += g * 0.015;
          h -= oxidized * 0.18; // R34 0.16 → 0.18（氧化处更凹）
          h -= pits * 0.22;
          h -= sc * 0.03; // 划痕微凹
          h -= flakeMask * 0.24; // R34 0.20 → 0.24（剥落更深地凹入）
          height[index] = clamp01(h);
          // R34 刷脊抛光：刷纹凸起处被人手/雨水磨亮 ⇒ 做旧但仍有可读的高光（金属 identity）
          const ridge = smoothstep(0.62, 0.9, h);

          let t = 0.5 + (b1 - 0.5) * 0.35 + (b2 - 0.5) * 0.2;
          t -= oxidized * 0.66; // R34 0.62 → 0.66（暗金做旧：氧化更沉）
          t -= pits * 0.1;
          t += g * 0.05;
          t += shine * 0.08;
          t += sc * 0.1; // 划痕露新金属（更亮）
          t += ridge * 0.07; // R34 刷脊抛光（凸处更亮 ⇒ 做旧仍有高光）
          t -= flakeMask * 0.34; // R34 0.30 → 0.34（剥落露更暗的基底）
          tone[index] = clamp01(t);

          let rough = 0.47 + (b2 - 0.5) * 0.16 + Math.abs(b1 - 0.5) * 0.1;
          rough += oxidized * 0.36; // R34 0.34 → 0.36
          rough += pits * 0.2;
          rough -= shine * 0.14;
          rough -= ridge * 0.12; // R34 刷脊更滑（抛光）
          rough += sc * 0.06; // 划痕边缘略糙
          rough += flakeMask * 0.32; // R34 0.28 → 0.32（剥落边缘极哑）
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
          // R32 檐口/搭接阴影：每皮瓦顶缘被上一皮覆盖 ⇒ 课程顶部 16% 是阴影带
          // （lyN=0 在图像顶部 = v 高 = 屋坡高处，正是被上一皮压住的那一条）
          const lap = 1 - smoothstep(0, 0.16, lyN);

          let h = 0.1 + 0.9 * bevel;
          h += (0.35 + 0.65 * arch) * 0.16 * bevel;
          h += (reliefV - 0.5) * P.relief * bevel;
          h += slateV * 0.045 * bevel; // R30 板岩层理
          h -= lap * 0.06 * bevel; // R32 搭接阴影带微凹
          h += grain * P.grain;
          height[index] = clamp01(h);

          let t = 0.5 + blockTint[block] + (reliefV - 0.5) * 0.2;
          t += (stainField[index] - 0.5) * P.stain * weather;
          t -= (1 - bevel) * 0.2 * weather;
          t -= (streakV - 0.45) * P.streak * weather;
          t -= lap * P.lapShadow * weather; // R32 檐口阴影带压暗
          t += grain * P.grain * 1.6;
          t += (arch - 0.5) * 0.06;
          t += slateV * 0.05; // R30 层理明暗
          tone[index] = clamp01(t);

          let rough = P.jointRough + (P.faceRough - P.jointRough) * smoothstep(0.42, 0.95, bevel);
          rough += (reliefV - 0.5) * 0.07 * weather;
          rough += Math.abs(slateV) * 0.05; // R30 层理处略哑
          rough += lap * 0.08; // R32 阴影带积尘更哑
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
  // R32 旧化灰斑（4×8 ⇒ 横向拉长的脱色斑；只取上半段 ⇒ 斑块状风化而非全局变暗）
  const grayF = makeField(P.grayWeather, () => fbmField(128, 4, 8, 2, seed + 293), size);
  /* ── R34 木纹节奏细化：三个新驱动场 ── */
  // 弦切弯纹 warp（3×2 极低频 ⇒ 木纹被整体掰成弓形，而不是尺子画的直竖纹）
  const warpF = makeField(P.ringWarp, () => fbmField(128, 3, 2, 2, seed + 317), size);
  // 早晚材带（4×2 ⇒ 竖向拉长的低频带 ⇒ 年轮「密一段 / 疏一段」的节奏）
  const bandF = makeField(P.ringBand, () => fbmField(128, 4, 2, 2, seed + 331), size);
  // 导管细线（比 grain 更细一档；只取门限上段 ⇒ 稀疏深色细线）
  const vesselF = makeField(P.vessel, () => noiseField(Math.min(512, size), P.vesselPeriodX, P.vesselPeriodY, seed + 347), size);

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
      fillField(grayF, y0, y1);
      fillField(warpF, y0, y1);
      fillField(bandF, y0, y1);
      fillField(vesselF, y0, y1);
      const grainField = grainF.out;
      const fineField = fineF.out;
      const knotField = knotF.out;
      const stainField = stainF.out;
      const streakField = streakF.out;
      const reliefField = reliefF.out;
      const grayField = grayF ? grayF.out : EMPTY;
      const warpField = warpF ? warpF.out : EMPTY;
      const bandField = bandF ? bandF.out : EMPTY;
      const vesselField = vesselF ? vesselF.out : EMPTY;
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

          // R34 弦切弯纹：把木纹的 x 采样坐标按低频场**整像素平移**（只读同一行 ⇒
          // 行带分片与整幅逐字节一致；取模环绕 ⇒ 仍严格可平铺）。
          const warpV = warpField.length ? warpField[index] - 0.5 : 0;
          const shift = warpField.length ? Math.round(warpV * P.ringWarp * size) : 0;
          const gx = shift === 0 ? x : (x + shift + size) % size;
          const gIdx = dstRow + gx;
          const g1 = grainField[gIdx];
          const g2 = fineField[gIdx];
          // R34 早晚材带：低频调制木纹对比度（年轮疏密节奏，不是均匀条纹）
          const bandV = bandField.length ? bandField[index] : 0.5;
          const grainK = 1 + (bandV - 0.5) * 2 * P.ringBand;
          // R34 导管细线：比 grain 更细一档的竖线，只取门限上段 ⇒ 稀疏深色细线
          const vesselV = vesselField.length ? Math.max(0, vesselField[gIdx] - 0.68) * 3.1 : 0;
          const knot = smoothstep(0.66, 0.86, knotField[index]);
          const reliefV = reliefField[index];
          const grain = grainTable[grainRow + grainCol[x]];
          const streakV = streakField[index];
          // R32 旧化灰斑：取 fbm 上半段 ⇒ 稀疏脱色斑（压暗 + 抬粗糙）
          const grayV = grayField.length ? Math.max(0, grayField[index] - 0.5) * 2 : 0;

          let h = 0.12 + 0.62 * bevel;
          h += (g1 - 0.5) * P.grainAmp * grainK * bevel;
          h += (g2 - 0.5) * P.grainAmp * 0.5 * grainK * bevel;
          h += knot * 0.1 * bevel;
          h += (reliefV - 0.5) * P.relief * bevel;
          h -= grayV * 0.03 * bevel; // R32 灰斑处木面微蚀
          h += grain * P.grain;
          height[index] = clamp01(h);

          let t = 0.5 + plankTint[col];
          t += ((g1 - 0.5) * 0.3 + (g2 - 0.5) * 0.16) * grainK;
          t += (stainField[index] - 0.5) * P.stain * weather;
          t -= (1 - bevel) * 0.24 * weather;
          t -= (streakV - 0.45) * P.streak * weather;
          t -= knot * P.knot * 0.5;
          t -= grayV * 0.16; // R32 旧化灰斑压暗
          t -= vesselV * P.vessel; // R34 导管细线（深色）
          t += grain * P.grain * 1.6;
          tone[index] = clamp01(t);

          let rough = P.jointRough + (P.faceRough - P.jointRough) * smoothstep(0.42, 0.95, bevel);
          rough += Math.abs(g1 - 0.5) * 0.1;
          rough += knot * 0.16;
          rough += grayV * 0.22; // R32 灰斑处木纤毛化（更哑）
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
  // R32 竖向脏痕（8×2 ⇒ 沿 y 慢变、沿 x 快变 ⇒ 雨水流痕；cellX 16px@128）
  const smearF = makeField(P.smear, () => fbmField(128, 8, 2, 2, seed + 281), size);
  // R30 薄膜虹彩：低频各向异性场（2×6 ⇒ 横向拉长的油膜带），仅供 compose 做暖冷微移
  const film = makeField(1, () => fbmField(96, 2, 6, 2, seed + 251), size)!;

  const halfJoint = P.jointPx * 0.5;
  const bevelEnd = halfJoint + P.bevelPx;

  return {
    build(y0: number, y1: number): void {
      fillField(wave, y0, y1);
      fillField(dirt, y0, y1);
      fillField(smearF, y0, y1);
      fillField(film, y0, y1);
      const waveA = wave.out;
      const dirtA = dirt.out;
      const smearA = smearF ? smearF.out : EMPTY;
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
          // R32 窗台积灰（每扇底缘 lyN→1 = 图像底部 = 窗台处）+ 竖向流痕
          const sill = smoothstep(0.8, 1, ly / rowH) * P.sillDust;
          const smear = smearA.length ? Math.max(0, smearA[index] - 0.5) * 2 * P.smear : 0;

          let h = 0.42 + 0.5 * bevel;
          h += (w - 0.5) * P.waviness * bevel;
          h += (1 - bevel) * 0.14;
          h -= (sill + smear) * 0.02 * bevel; // R32 污渍微遮（老玻璃的起伏感）
          height[index] = clamp01(h);

          let t = 0.5 + (w - 0.5) * 0.34;
          t -= (1 - bevel) * 0.55;
          t -= (d - 0.45) * 0.2 * weather;
          t -= (sill * 0.3 + smear * 0.22) * weather; // R32 积灰/流痕压暗
          tone[index] = clamp01(t);

          let rough = P.faceRough + (P.jointRough - P.faceRough) * (1 - smoothstep(0.4, 0.95, bevel));
          rough += Math.max(0, d - 0.45) * 0.3 * weather;
          rough += (sill * 0.25 + smear * 0.18) * weather; // R32 污渍处发雾
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
  // R32 细纹（第二组脉：8×32 各向异性 + 3 octaves，门限更高 ⇒ 更细更稀的支脉）
  const fineVein = makeField(V.fineVeinAmp, () => fbmField(fres, V.finePeriodX, V.finePeriodY, 3, seed + 83), size);
  // R32 抛光差异（低频斑块局部更光 ⇒ roughness 分层：镜面台基 vs 哑光柱身的石板差异）
  const polishF = makeField(1, () => fbmField(128, 4, 4, 2, seed + 101), size)!;

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
      fillField(fineVein, y0, y1);
      fillField(polishF, y0, y1);
      const veinA = vein.out;
      const fineA = fine.out;
      const cloudA = cloud.out;
      const speckA = speck.out;
      const fineVeinA = fineVein ? fineVein.out : EMPTY;
      const polishA = polishF.out;
      for (let y = y0; y < y1; y += 1) {
        const dstRow = y * size;
        const grainRow = Math.floor(y / grainStep) * grainRes;
        for (let x = 0; x < size; x += 1) {
          const index = dstRow + x;
          const v = veinA[index];
          const ridge = 1 - Math.abs(v * 2 - 1);
          const vm = smoothstep(V.veinSharp, 0.98, ridge);
          // R32 细纹支脉（门限 +0.08 ⇒ 更细更稀）
          const fm = fineVeinA.length ? smoothstep(V.veinSharp + 0.08, 0.98, 1 - Math.abs(fineVeinA[index] * 2 - 1)) : 0;
          const c = cloudA[index];
          const f = fineA[index];
          const grain = grainTable[grainRow + grainCol[x]];
          const sp = speckA[index] - 0.5;
          const pol = smoothstep(0.55, 0.85, polishA[index]); // R32 抛光斑块

          let h = 0.62 + (f - 0.5) * V.relief + grain * V.grain;
          h -= vm * 0.12;
          h -= fm * 0.05; // R32 细脉微凹
          h += sp * V.grain * 0.8; // R30 晶屑微起伏
          height[index] = clamp01(h);

          let t = 0.5 + (c - 0.5) * 0.3 * (0.5 + 0.5 * weather);
          t -= vm * 0.42;
          t -= fm * 0.2; // R32 细脉灰
          t += (f - 0.5) * 0.05;
          t += grain * V.grain * 2.2;
          t += sp * 0.05; // R30 晶屑明暗
          t += pol * 0.03; // R32 抛光处更亮
          tone[index] = clamp01(t);

          let rough = V.faceRough + (V.veinRough - V.faceRough) * vm;
          rough += (c - 0.5) * 0.04 * weather;
          rough += Math.abs(sp) * 0.03; // R30 晶屑处略哑
          rough += fm * 0.06; // R32 细脉处略哑
          rough -= pol * V.polish; // R32 抛光斑块更滑（roughness 分层）
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
  /* ── R34 三个新输出通道（仅砌体族分配，其余族保持 null ⇒ 零开销）── */
  let joint: Uint8ClampedArray | null = null;
  let jointWarm: Uint8ClampedArray | null = null;
  let seep: Uint8ClampedArray | null = null;
  /** 灰缝自身亮度系数（仅砌体族有意义） */
  let jointShade = 1;
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
    if (prof.jointTint > 0) {
      joint = new Uint8ClampedArray(count);
      jointWarm = new Uint8ClampedArray(count);
    }
    if (prof.seep > 0) seep = new Uint8ClampedArray(count);
    build = prepMasonry(size, seed, weather, prof, height, tone, roughness, moss, joint, jointWarm, seep).build;
    normalStrength = prof.normalStrength;
    mortarShade = prof.mortarShade;
    jointShade = prof.jointShade;
  }

  const hex = STONE_HEX[kind];
  const base = hexToRgb(hex.base);
  const light = hexToRgb(hex.light);
  const dark = hexToRgb(hex.dark);
  const mossColor = hexToRgb('#5b6b3a');
  // R34 灰缝色带两端（深灰 = STONE_HEX.mortar；浅褐 = MORTAR_WARM）+ 雨水渍色
  const mortarCool = hexToRgb(hex.mortar);
  const mortarWarm = hexToRgb(MORTAR_WARM[kind] ?? hex.mortar);
  const seepColor = hexToRgb(SEEP_TINT[kind] ?? hex.base);
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
    /** R34 缝芯遮罩 × jointTint（仅砌体族；其余族 null） */
    joint,
    /** R34 缝色「深灰↔浅褐」低频权重（仅砌体族；其余族 null） */
    jointWarm,
    /** R34 雨水渍遮罩（仅砌体族；其余族 null） */
    seep,
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
          // —— R34 灰缝上色：缝芯按低频权重在「深灰 ↔ 浅褐」之间取色 ——
          // 旧实现只有压暗 ⇒ 缝永远是「更暗的白石」；现在缝有**自己的颜色**。
          // 缝色不吃 stone 的 shade（缝是另一种材料），只吃 jointShade ⇒ 可单独调深浅。
          if (joint) {
            const jm = joint[index] / 255;
            if (jm > 0.004) {
              const w = jointWarm ? jointWarm[index] / 255 : 0.5;
              const mr = mortarCool.r + (mortarWarm.r - mortarCool.r) * w;
              const mg = mortarCool.g + (mortarWarm.g - mortarCool.g) * w;
              const mb = mortarCool.b + (mortarWarm.b - mortarCool.b) * w;
              ar += (mr * jointShade - ar) * jm;
              ag += (mg * jointShade - ag) * jm;
              ab += (mb * jointShade - ab) * jm;
            }
          }
          // —— R34 雨水渍（淡黄-灰褐）：沿用本像素的 shade ⇒ 渍会随缝口阴影一起沉下去 ——
          if (seep) {
            const sm = (seep[index] / 255) * SEEP_BLEND;
            if (sm > 0.004) {
              ar += (seepColor.r * shade - ar) * sm;
              ag += (seepColor.g * shade - ag) * sm;
              ab += (seepColor.b * shade - ab) * sm;
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
  const channels = opts.channels ?? 'full';

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

  const buildTextures = (): StoneMaps =>
    assembleStoneMaps(size, bake.albedo, bake.normal, bake.rough, repeat, stats ?? bake.finish(), channels);

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
 * R31 贴图数量治理③：把三张像素图按 `channels` 预算装配成 StoneMaps。
 * 'albedoOnly' 只产 albedo（normal/rough 为 null）；'noRough' 产 albedo + normal；
 * 'full' 三张全产。像素计算（makeStonePixelSet）始终全算（stats 需要），
 * 仅**跳过不挂的 CanvasTexture 创建** —— 这才是 GPU/内存真正省下的部分。
 */
function assembleStoneMaps(
  size: number,
  albedo: Uint8ClampedArray,
  normal: Uint8ClampedArray,
  rough: Uint8ClampedArray,
  repeat: [number, number],
  stats: StoneStats,
  channels: StoneChannels
): StoneMaps {
  return {
    map: toTexture(pixelCanvas(size, albedo), THREE.SRGBColorSpace, repeat),
    normalMap: channels === 'albedoOnly' ? null : toTexture(pixelCanvas(size, normal), THREE.NoColorSpace, repeat),
    roughnessMap: channels === 'full' ? toTexture(pixelCanvas(size, rough), THREE.NoColorSpace, repeat) : null,
    stats
  };
}

/**
 * node（无 DOM）兜底：没有 canvas 就不画，返回 1×1 哑纹理。
 */
function makeFallbackMaps(repeat: [number, number], channels: StoneChannels = 'full'): StoneMaps {
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
    normalMap: channels === 'albedoOnly' ? null : make(THREE.NoColorSpace),
    roughnessMap: channels === 'full' ? make(THREE.NoColorSpace) : null,
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
  const channels = opts.channels ?? 'full';
  const key = `${kind}|${size}|${seed}|${weather.toFixed(3)}|${repeat[0]}x${repeat[1]}|${channels}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (typeof document === 'undefined') {
    const fallback = makeFallbackMaps(repeat, channels);
    cache.set(key, fallback);
    return fallback;
  }

  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pixels = makeStonePixelSet(kind, { size, seed, weather });
  const maps = assembleStoneMaps(size, pixels.albedo, pixels.normal, pixels.rough, repeat, pixels.stats, channels);
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  buildCount += 1;
  console.info(
    `[stoneTexture] ${kind} ${size}² weather=${weather.toFixed(2)} channels=${channels} 像素 ${pixels.elapsedMs.toFixed(1)}ms / 总 ${(ended - started).toFixed(1)}ms` +
      ` | L ${pixels.stats.lumMean.toFixed(0)}±${pixels.stats.lumStd.toFixed(0)} C ${pixels.stats.contrast.toFixed(0)}` +
      ` 颗粒 ${pixels.stats.grain.toFixed(2)} n|xy| ${pixels.stats.normalMag.toFixed(3)} roughMean ${pixels.stats.roughMean.toFixed(3)}（第 ${buildCount} 套）`
  );
  cache.set(key, maps);
  return maps;
}

// ── R34 内部材质族（共享图集 ⇒ **贴图张数 0 变化**）───────────────────

/**
 * R34 **内部材质族 id**（供 A 线「内部丰富度」消费的材质底子）。
 *
 * ⚠ 为什么不是新 `StoneKind`：`castle.ts` 的 `TARGET_ROUGH / FAMILY_METAL / FAMILY_ENV /
 * FAMILY_NORMAL_SCALE / FAMILY_WEATHER / STONE_CHANNELS` 与 `castleKit.ts` 的 `TILE`
 * 都是 `Record<StoneKind, …>`，**扩族会直接编译红**，且新 kind 会多产 2~3 张贴图
 * （`castleTexCount` 稳态 14/16 → 涨）。故本轮走「**同族共享图集 + 材质侧分身**」：
 * 变体只改 `color / roughness / metalness / envMapIntensity / normalScale`，
 * **贴图实例完全复用** ⇒ 稳态张数**不涨**。
 *
 * ⚠ 三条使用铁律（违反即「张数暗涨」）：
 * 1. 变体**不得**改 `size / seed / weather / repeat / channels` —— 这些是
 *    `makeStoneMaps` 的缓存键组成部分，任何一项不同都会**另起一整套贴图**；
 *    变体只能改材质侧参数（几何 UV 由 A 线自己按世界尺度给）。
 * 2. 变体**不得** `texture.clone()` —— three 按 Texture 实例上传 GPU，clone 会多占一份
 *    显存（等于偷偷加一张）。
 * 3. 若多 mesh 共享同一张图集且需**分区取图**，UV 必须走
 *    `remapUVToRegion`（按 mesh 自身 UV bbox 归一，禁线性 remap —— R3 曾 814 三角串味）；
 *    本模块的族都是**可平铺单块**（RepeatWrapping），分区取图会破坏平铺，
 *    故推荐路径是「整幅共享 + 材质分身」，不是分区。
 */
export type StoneVariantId = 'inner-stone' | 'inner-wood' | 'gilded-aged' | 'pave-damp';

export interface StoneVariantSpec {
  /** 复用的图集族（= `makeStoneMaps(texKind, …)` 的族；贴图张数 0 变化的关键） */
  texKind: StoneKind;
  /** 中文名（QA / 审查对接用） */
  label: string;
  /** 材质 color 乘子（sRGB 写法；THREE 内部按线性相乘） */
  color: number;
  /** **目标有效粗糙度**（= material.roughness × roughnessMap.g；无 roughMap 时即 material.roughness） */
  rough: number;
  metalness: number;
  /** envMapIntensity（内部件照不到天光 ⇒ 比同族外装低） */
  env: number;
  /** normalScale */
  normalScale: number;
  /** 用途备注（写清「比原族差在哪」，便于审查核对） */
  note: string;
}

export const STONE_VARIANTS: Record<StoneVariantId, StoneVariantSpec> = {
  // a) 内壁暗石：复用 ashlar 图集（0.3m 砌块节拍一致 ⇒ 室内外缝节奏同源），
  //    乘子偏冷（R−B −16）且压暗到 ~0.68 ⇒ 比外墙更冷更暗，但不改砌块形制。
  'inner-stone': {
    texKind: 'ashlar',
    label: '内壁暗石',
    color: 0x8e979e,
    rough: 0.92,
    metalness: 0,
    env: 0.45,
    normalScale: 0.8,
    note: 'ashlar 图集 + 冷暗乘子；内壁照不到天光 ⇒ env 0.85→0.45、rough 0.86→0.92'
  },
  // b) 木门/木梁：复用 wood 图集（本轮已细化木纹节奏：弦切弯纹 + 早晚材带 + 导管细线）。
  //    wood 是 'noRough' ⇒ 无 roughnessMap，rough 直接给常数（铁律 34 的 ḡ 反算不适用）。
  'inner-wood': {
    texKind: 'wood',
    label: '木门/木梁',
    color: 0xab9a86,
    rough: 0.82,
    metalness: 0,
    env: 0.35,
    normalScale: 1.0,
    note: 'wood 图集 + 暖灰压暗；室内木作比城门木更干更旧'
  },
  // c) 金属暗金做旧：复用 gold 图集（本轮已加氧化/剥落/刷脊抛光，色相档未动）。
  //    乘子走**近中性压暗**（R−B +14）⇒ 只降明度不动 R30b 已验证的色相档。
  'gilded-aged': {
    texKind: 'gold',
    label: '暗金做旧',
    color: 0xd2cec4,
    rough: 0.55,
    metalness: 0.8,
    env: 0.85,
    normalScale: 0.7,
    note: 'gold 图集 + 近中性压暗；保 R30b 色相档，只降明度/抬粗糙度（env 1.4→0.85）'
  },
  // d) 桥面/地面深色石板：复用 floor 图集（本轮新增 damp 微湿低频斑）。
  //    ⚠ 微湿感**只走 albedo**：floor 是 'noRough'，挂 roughnessMap 会因 ḡ≈0.5 让
  //    inverseRoughness clamp 到 1 ⇒ effective 掉到 0.5（哑光石面被乘滑，历史坑）。
  'pave-damp': {
    texKind: 'floor',
    label: '桥面深色石板',
    color: 0x8b9094,
    rough: 0.8,
    metalness: 0,
    env: 0.25,
    normalScale: 0.85,
    note: 'floor 图集 + 冷暗乘子；微湿感走 damp 低频水渍（albedo），rough 0.9→0.8'
  }
};

/**
 * 变体的 material.roughness 反算（与 `castle.ts inverseRoughness` 同口径，铁律 34）：
 * 挂了 roughnessMap ⇒ 必须按 1/ḡ 反算，否则 effective 被 ḡ 乘低。
 */
function variantRoughness(target: number, roughMean: number, hasRoughMap: boolean): number {
  if (!hasRoughMap) return target;
  if (!Number.isFinite(roughMean) || roughMean <= 0.01) return target;
  return Math.min(1, Math.max(0.05, target / roughMean));
}

/**
 * 按变体规格造一个 MeshStandardMaterial（图集**直接复用传入的 maps**，不 clone）。
 * A 线也可以只读 `STONE_VARIANTS` 自己造材质 —— 这里只是把「反算 + 通道挂载」封好，
 * 避免各自实现时漏掉铁律 34 的 1/ḡ 反算。
 */
export function makeStoneVariantMaterial(id: StoneVariantId, maps: StoneMaps): THREE.MeshStandardMaterial {
  const v = STONE_VARIANTS[id];
  const mat = new THREE.MeshStandardMaterial({
    color: v.color,
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    metalness: v.metalness,
    roughness: variantRoughness(v.rough, maps.stats.roughMean, maps.roughnessMap !== null)
  });
  mat.envMapIntensity = v.env;
  if (maps.normalMap) mat.normalScale.setScalar(v.normalScale);
  mat.name = `stone-variant:${id}`;
  return mat;
}

/** 全清缓存（换场景/关卡时调用），三张纹理各自 dispose */
export function disposeStoneCache(): void {
  for (const maps of cache.values()) {
    maps.map.dispose();
    maps.normalMap?.dispose();
    maps.roughnessMap?.dispose();
  }
  cache.clear();
}

/**
 * R31 贴图数量治理：某族「同步代」被目标代接手后，立即从缓存摘掉并释放三张贴图。
 * 调用方（castle.ts）已确认该族所有材质槽都指向目标代、同步代零引用，故安全。
 * 只摘 `makeStoneMaps` 默认 seed + repeat 1x1 的键（castle 走的就是这条），不碰其它键。
 */
export function retireStoneMaps(kind: StoneKind, size: number, weather: number, channels: StoneChannels = 'full'): void {
  const seed = DEFAULT_SEED[kind] >>> 0;
  const key = `${kind}|${size}|${seed}|${weather.toFixed(3)}|1x1|${channels}`;
  const maps = cache.get(key);
  if (!maps) return;
  // 避免 disposeStoneCache 之后二次 dispose（它只清仍挂在 cache 的条目）
  maps.map.dispose();
  maps.normalMap?.dispose();
  maps.roughnessMap?.dispose();
  cache.delete(key);
}
