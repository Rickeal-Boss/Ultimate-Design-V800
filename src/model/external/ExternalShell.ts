/**
 * ExternalShell.ts —— R44 车模外观 GLB 资产化运行时（外部壳）。
 *
 * 职责：把 bake 管线（.img2threejs/tools/r44_bake.py）产出的
 * `src/assets/cars/{v800|r7}/`（body.glb + wheel-l/r.glb + basecolor-<variant>.webp
 * + normal.png + mr.png + manifest.json）装配为 three.js 网格，供两台适配器
 * 「装配尾挂外部壳」：
 *   · body(+玻璃) 一个 mesh 挂适配器 body 组（body 已 rotY(π)，GLB +Z 车头一致）；
 *   · 4 个 hub 居中的外部轮 mesh 由适配器挂进现有 wheels[i].spin 并把 spin 迁到外部
 *     hub（见 mountExternalWheel：用矩阵反解局部变换，兼容 V800 hub 组与 R7
 *     rotZ(90°) 基准四元数两种 spin 结构）；
 *   · 变体切换 = 懒加载换 baseColor 贴图（同时只驻留当前变体）。
 *
 * 材质口径（BRIEF §一）：贴图独立加载 ⇒ texture.flipY=false（glTF UV 约定）；
 * baseColor SRGBColorSpace，normal/MR 线性（NoColorSpace）；MR 一张图双槽
 * （roughnessMap 取 G / metalnessMap 取 B），material.roughness=metalness=1。
 * MeshPhysicalMaterial clearcoat=0.4 汽车漆感（R45 可 A/B）。
 *
 * 失败语义：任何一步 fetch/parse 失败 ⇒ 返回 null，适配器保持程序化外观完整
 * （不可见不 dispose 的回退路径），游戏零感知。
 *
 * QA：`#r44ext=off` 显式停用外部壳（A/B 对照）；window.__r44Shell 暴露装载状态
 * 供 headless 探针断言（DEV + QA 均可用，体量恒小）。
 *
 * ── R46 / Phase 2（LOAD-A）─────────────────────────────────────────────────────
 *  · 新增「默认普通车模」偏好门禁 + `#r44ext=on` QA 强制开（优先级见下方注释）；
 *  · AbortController 全链路可中止在途 fetch（含 3 张贴图走同一 signal）；
 *  · HUD 字节按 car 计、总量按 car 显示、进度刷新 ~200ms 节流（防 createElement 幽灵条）；
 *  · 前灯图集 `lamp_front_atlas.png` 以 emissiveMap 接入（修「前灯一片白」）。
 * 契约：`loadExternalShell(car, variant)` 签名不变、两个 Adapter 零改动；
 *       取消 ≡ 既有 `#r44ext=off` 回退路径，返回 null 即保持程序化外观。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeSafe } from '../../util/geo';
import {
  SHELL_TOTAL_MB,
  isHighDetailEnabled,
  isShellLoadCancelled,
  onShellCancel,
  shellCancelReason
} from '../../config/highDetail';

/** R46：契约出口（实现在 config/highDetail.ts，UI 线只消费这两个 + state:'cancelled'） */
export { cancelExternalShellLoad, isShellLoadCancelled } from '../../config/highDetail';

/* ══════════════ R51 Phase 2-B · 视觉线开关真源（默认开，`=off` 逐位回 R50）══════════════
 * ⚠ 不能放 src/config/**（Phase 2-A 独占冻结），故落在本模块；两个 Adapter 直接 import
 *   这几个常量（它们本来就从本文件 import loadExternalShell / buildShadowProxies），
 *   ⇒ 五处开关只有**一个真源**，A/B 不会出现 ExternalShell 与 Adapter 读数不一致。
 * ⚠ 键名一律不含 `noprewarm` 子串：Game.ts:575 的入口守卫是
 *   `hash.includes('noprewarm')`，命中会连带跳过整段 prewarmGpu（R41 踩过坑）。
 * ⚠ Node / vitest：typeof window === 'undefined' ⇒ 四个默认开钩子返回 true、
 *   B1-b/c 返回 false（外部壳在测试环境不装配，零副作用）。
 * 子项与钩子：
 *   B1-a `#r51tail=off`      压亮灯态过曝（尾灯 ei 上限 + 待机系数 + 荧光红改深红）
 *   B1-b/c `#r51band=on`     尾灯带 atlas 重画 + 盖板收窄 0.90 + 位置贴合
 *                            ⚠⚠ **非上线形态**：本分支**仅供下波按贴合曲面几何
 *                            （SPEC §3 B1-c :118-120）重做时启用**；R51 唯一上线形态
 *                            是「四开一关」= r51tail / rough / lamp / glasspass 开、band 关。
 *                            ⚠ **默认关，实验态**（主理人 R51 收口裁决）：审查线三机位
 *                            目检打回「黑色大板 + 两端锯齿红块 + 米黄矩形」，
 *                            `RED_deep` 最大连通域 bbox 宽 284→156px 红带被物理切断；
 *                            单钩子分解 `#r51band=off`（其余全开）实测
 *                            RED_deep 5477 / RED_bright 82 / RED_dark 5395 /
 *                            WHITE 0 / 连通域 0 ⇒ 回退不丢任何 A 类门，且目检为
 *                            完整暗红贯穿带 + 两端灯组，优于全开态。
 *                            atlas / 收窄 / `r49Hole` 并入 / `#r49hole=on` 旧语义
 *                            **全部保留不删**，供下波贴合曲面几何重做时直接启用；
 *                            **严禁把本实验盖板当作默认功能或在本波重新打开**。
 *   B2   `#r51rough=off`     V800 白漆 roughness 全局一档 G'=0.45+0.55G
 *   B3   `#r51lamp=off`      前灯纯 emissive 数值降级（含两 Adapter 联动）
 *   B4   `#r51glasspass=off` 玻璃 transparent+DoubleSide 单次渲染
 */
function r51HookOff(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return new RegExp(`(?:^|[#&])${key}=off`, 'i').test(window.location.hash);
}

/** R51 收口：B1-b/c 实验盖板默认下线（审查线目检打回），仅 `#r51band=on` 启用。
 *  ⚠ **非上线形态 / 实验分支**：仅下波按贴合曲面几何重做时启用，勿在本波打开。
 *  其余四开关仍是「默认开、`=off` 逐位回滚」，与 band 关共同组成 R51 唯一上线形态。 */
function r51HookOn(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return new RegExp(`(?:^|[#&])${key}=on`, 'i').test(window.location.hash);
}

/** B1-a：尾灯 emissive 上限（与 R48 待机口径同源；主理人建议 ≤1.15） */
export const R51_TAIL_EI_MAX = 1.15;
export const R51_TAIL_ON = !r51HookOff('r51tail');
export const R51_BAND_ON = r51HookOn('r51band');
export const R51_ROUGH_ON = !r51HookOff('r51rough');
export const R51_LAMP_ON = !r51HookOff('r51lamp');
export const R51_GLASSPASS_ON = !r51HookOff('r51glasspass');
/** R53：前灯 DRL+透镜程序化细节（修「前灯空腔黑腔」）。`#r53lampdetail=off` 逐位回滚 R52。 */
export const R53_LAMP_DETAIL_ON = !r51HookOff('r53lampdetail');
/** R54：前脸贯穿镀铬饰条（修「缺贯穿镀铬条」）。`#r54trim=off` ⇒ 逐位回 R53（R53 灯上铬条恢复）。 */
export const R54_CHROME_ON = !r51HookOff('r54trim');
/** R55：V800 中央红旗盾形徽标（中网细节，银色描边+深红盾面）。`#r55badge=off` 逐位回 R54。 */
export const R55_BADGE_ON = !r51HookOff('r55badge');
/** R57：V800 前灯竖向方形发光单元重建（替换 R53 的 4 条细竖线）。
 *  `#r57headlamp=off` ⇒ 走原 R53 逻辑，V800/R7 逐位回 R56。 */
export const R57_HEADLAMP_ON = !r51HookOff('r57headlamp');
/** R58：V800 车尾 MAEXTRO 镀铬带+字标（后风挡下沿，补 R54 前脸饰条的车尾同构特征）。
 *  `#r58rearbadge=off` ⇒ 零新增，逐位回 R57。 */
export const R58_REAR_BADGE_ON = !r51HookOff('r58rearbadge');
/** R61：车身侧面贯穿镀铬条（窗台线 beltline + 下裙线 rocker），复刻 R54 程序化 ribbon 模式。
 *  官图（V800 064 / R7 侧视）侧面均有一条横贯车长的亮银饰条，当前渲染缺失。
 *  几何剖面由 GLB 探针（tools/r61_glb_probe.mjs）量化 body 侧面 x(z)，ribbon 贴合车身轮廓。
 *  双侧（左/右）+ 双线（belt/skirt）合并为单 mesh，DC 增量恒 +1/车。`#r61side=off` 逐位回滚。 */
export const R61_SIDE_ON = !r51HookOff('r61side');
/** R62-P0-1：轮毂/制动系统独立（修「整轮=车身同色，无黑胎/刹车盘/红卡钳」）。
 *  根因：本文件原 :1795 把车漆 material 赋给四轮外部 GLB mesh，轮 GLB 是一体 lathe
 *  无内置材质 ⇒ 整块轮读作车身色。R62 改赋专用 wheel-alloy 材质 + 每轮新增打孔刹车盘
 *  （随轮自转）+ 卡钳（挂非自转父，静止）。`#r62wheel=off` ⇒ 逐位回 R61：四轮重新赋车漆
 *  material、不建盘/卡钳几何。 */
export const R62_WHEEL_ON = !r51HookOff('r62wheel');
/** R62-P0-2：程序化车漆金属化（清漆层 + 色度/金属度上调贴近官图 metallic flake）。
 *  `#r62paint=off` ⇒ 逐位回 R60（clearcoat 回 R55 的 0.15/0.35、色度/金属度回原表）。 */
export const R62_PAINT_ON = !r51HookOff('r62paint');

export type ExternalCarId = 'v800' | 'r7';

export interface ExternalManifest {
  car: ExternalCarId;
  scale: number;
  wheelRadius: number;
  hubs: Record<string, [number, number, number]>;
  bodyBBox: { min: number[]; max: number[] };
  variants: ReadonlyArray<{ id: string; file: string }>;
  tri: Record<string, number>;
  /** R44-6 语义分组（r44_semantic_split.py 产出；旧 manifest 无此字段 = 无语义件） */
  semantic?: Record<string, { tri: number; parts: number[] }>;
}

export interface ExternalShellHandle {
  readonly car: ExternalCarId;
  readonly manifest: ExternalManifest;
  /** 已按 manifest.scale 缩放的车身壳（含玻璃），挂适配器 body 组用 */
  readonly bodyMesh: THREE.Mesh;
  /** hub 居中的外部轮，key = fl/fr/rl/rr（模型单位原点 = 轮毂中心） */
  readonly wheelMeshes: Readonly<Record<string, THREE.Mesh>>;
  /** R62-P0-1：单轮制动件（盘+卡钳），key = fl/fr/rl/rr；适配器 mountExternalBrake 挂到 spin/其父。
   *  `#r62wheel=off` 时为空对象（回滚到 R61 无制动件）。 */
  readonly brakes: Readonly<Record<string, WheelBrakeSet>>;
  readonly wheelRadius: number;
  /** R44-6 语义部件：透明玻璃（与 bodyMesh 同级挂 body 组；cabin 态随外壳隐藏） */
  readonly glassMeshes: readonly THREE.Mesh[];
  /** R44-6 语义部件：灯组 mesh（前后灯，挂 body 组；cabin 态随外壳隐藏） */
  readonly lampMeshes: readonly THREE.Mesh[];
  /** 尾灯材质（emissive 红，适配器 update() 按 brakeLevel 驱动）；无语义件时 null */
  readonly lampRearMat: THREE.MeshStandardMaterial | null;
  /** 头灯材质（emissive 冷白，setHeadlights 联动）；无语义件时 null */
  readonly lampFrontMat: THREE.MeshStandardMaterial | null;
  /**
   * R47：外景态把隐私玻璃调成完全不透明，遮住程序化低模方块内饰
   * （用户点名「高精度外膜普通内饰方块模型透车外问题」）。
   * 只改 `opacity`（transparent 恒 true）⇒ 不触发 program 重编译、零 DC 变化。
   * cabin 态恢复半透；`#r44glass=off|solid` QA 钩子优先，本方法不介入。
   */
  setGlassOpaque(opaque: boolean): void;
  /** 当前变体 id */
  readonly variant: string;
  /** 懒加载切换 baseColor（同时只驻留当前变体）；失败返回 false（保旧图） */
  setVariant(variantId: string): Promise<boolean>;
  dispose(): void;
}

export interface ExternalShellStatus {
  /** R46：'cancelled' = 用户停止下载 / 默认普通车模偏好（不是加载失败） */
  state: 'idle' | 'loading' | 'ready' | 'failed' | 'cancelled';
  variant?: string;
  error?: string;
  tri?: number;
  /** 已接收的高精度资产字节数（解压后口径，QA/线上诊断用） */
  bytes?: number;
  /**
   * R46：前灯是否挂了 emissiveMap。
   * true = 已挂裁片图集（正常路径）；false = 走了纯 emissive 回退
   * （`#r46lampmap=off` 或 atlas 缺失/加载失败）。供 QA 探针机读；**不改 `state` 枚举**。
   */
  lampMap?: boolean;
}

/** QA 探针读的装载台账（模块级，进程内单例） */
export const r44ShellStatus: Record<ExternalCarId, ExternalShellStatus> = {
  v800: { state: 'idle' },
  r7: { state: 'idle' }
};

if (typeof window !== 'undefined') {
  (window as unknown as { __r44Shell?: Record<ExternalCarId, ExternalShellStatus> }).__r44Shell =
    r44ShellStatus;
}

/**
 * R46 前灯图集查找表（几何资产线并行产出 `src/assets/cars/<car>/lamp_front_atlas.png`）。
 *
 * ⚠ 为什么用 `import.meta.glob` 而不是派工单建议的静态 `new URL(字面量, import.meta.url)`：
 *   几何线与本线**并行施工**，静态字面量在 vite build 的 resolve 阶段就会因文件尚未落地
 *   直接失败；而 glob 在「零匹配」时返回空对象 → 构建通过、运行时优雅降级（纯 emissive），
 *   文件一到位即被 Vite 重写为 hashed URL 自动生效。仍保留 hash 指纹与「文件名逐字符
 *   一致」约束（BRIEF.md:52；R45 曾因 lamp-front→lamp_front 出过 404 事故）。
 *   几何线交付后若要收敛成静态字面量，可直接把 atlasUrlFor 换成一行 new URL。
 */
const LAMP_FRONT_ATLAS = import.meta.glob('../../assets/cars/*/lamp_front_atlas.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

function atlasUrlFor(car: ExternalCarId): string | undefined {
  const suffix = `/cars/${car}/lamp_front_atlas.png`;
  for (const [key, url] of Object.entries(LAMP_FRONT_ATLAS)) {
    if (key.endsWith(suffix)) return url;
  }
  return undefined;
}

/** 显式静态 URL 表：vite 对 new URL(字面量, import.meta.url) 做构建期重写 */
const ASSET_URLS: Record<
  ExternalCarId,
  {
    manifest: string;
    body: string;
    wheelL: string;
    wheelR: string;
    glass?: string;
    lampFront?: string;
    lampRear?: string;
    /** R46：前灯裁片图集；几何线尚未产出时为 undefined ⇒ 优雅降级纯 emissive */
    lampFrontAtlas?: string;
    basecolor: Record<string, string>;
  }
> = {
  v800: {
    manifest: new URL('../../assets/cars/v800/manifest.json', import.meta.url).href,
    body: new URL('../../assets/cars/v800/body.glb', import.meta.url).href,
    wheelL: new URL('../../assets/cars/v800/wheel-l.glb', import.meta.url).href,
    wheelR: new URL('../../assets/cars/v800/wheel-r.glb', import.meta.url).href,
    glass: new URL('../../assets/cars/v800/glass.glb', import.meta.url).href,
    lampFront: new URL('../../assets/cars/v800/lamp_front.glb', import.meta.url).href,
    lampRear: new URL('../../assets/cars/v800/lamp_rear.glb', import.meta.url).href,
    lampFrontAtlas: atlasUrlFor('v800'),
    basecolor: {
      white: new URL('../../assets/cars/v800/basecolor-white.webp', import.meta.url).href,
      black: new URL('../../assets/cars/v800/basecolor-black.webp', import.meta.url).href,
      gold: new URL('../../assets/cars/v800/basecolor-gold.webp', import.meta.url).href
    }
  },
  r7: {
    manifest: new URL('../../assets/cars/r7/manifest.json', import.meta.url).href,
    body: new URL('../../assets/cars/r7/body.glb', import.meta.url).href,
    wheelL: new URL('../../assets/cars/r7/wheel-l.glb', import.meta.url).href,
    wheelR: new URL('../../assets/cars/r7/wheel-r.glb', import.meta.url).href,
    glass: new URL('../../assets/cars/r7/glass.glb', import.meta.url).href,
    lampFront: new URL('../../assets/cars/r7/lamp_front.glb', import.meta.url).href,
    lampRear: new URL('../../assets/cars/r7/lamp_rear.glb', import.meta.url).href,
    lampFrontAtlas: atlasUrlFor('r7'),
    basecolor: {
      white: new URL('../../assets/cars/r7/basecolor-white.webp', import.meta.url).href,
      purple: new URL('../../assets/cars/r7/basecolor-purple.webp', import.meta.url).href,
      green: new URL('../../assets/cars/r7/basecolor-green.webp', import.meta.url).href
    }
  }
};

/**
 * QA A/B：`#r44ext=off` 显式停用外部壳。
 * R46：改用精确正则（原 `hash.includes('r44ext=off')` 会被新增的 `#r44ext=on` 钩子误伤）。
 */
function shellDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r44ext=off/i.test(window.location.hash);
}

/** R46 QA：`#r44ext=on` 强制高精度（覆盖「默认普通车模」偏好，便于 A/B 对照） */
function shellForcedOn(): boolean {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r44ext=on/i.test(window.location.hash);
}

/**
 * R46 前灯贴图回退开关：`#r46lampmap=off` ⇒ 不挂 emissiveMap（纯 emissive = R44 原行为）。
 *
 * 用途（方案 D 失败后的线上回退通道）：几何线实测 `lamp_front` **灯区三角 UV 采样命中率
 * v800 仅 2.0% / r7 24.1%**（98%/76% 采样到近黑）⇒ atlas 亮片布局与灯区 UV 错位，实拍
 * 「开灯=关灯」黑腔。此开关可**一键回纯 emissive**，避免黑腔；几何线重做 atlas + UV
 * 重映射并验收通过后，缺省路径自动恢复挂图。
 * 也可保留作长期 A/B（对比「纯 emissive」与「图集调制」两种前灯观感）。
 *
 * ⚠ 必须用精确正则，勿用裸 `includes`（会误伤其它 hash）。
 * ⚠ 只影响「挂不挂图」，**不改** `color` / `emissive` / `emissiveIntensity` /
 *   `setHeadlights` 联动（适配器每帧写 `emissiveIntensity`，本开关不介入）。
 */
function lampMapDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r46lampmap=off/i.test(window.location.hash);
}

/**
 * 测试环境隔离硬门禁（主理人指令 2026-11-01）：vitest/node 环境下**绝不**触发
 * 外部壳装配 —— 不发 fetch、不尝试 parse GLB（file:// URL 在 Node fetch 下必败，
 * 即使被 try/catch 吞掉也不允许发生）。判据用 vitest 注入的 `import.meta.env.MODE
 * === 'test'`（Game 装配路径是 dev/prod 运行时，永远不为 test）。
 * ⚠ R46：此门禁仍是 loadExternalShell 的**第一条语句**，新偏好/取消门禁都在其后 ⇒
 *   vitest 下永不读取 localStorage，194 用例行为逐位不变。
 */
function inTestEnv(): boolean {
  try {
    return (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test';
  } catch {
    return false;
  }
}

/**
 * 每变体金属度因子（× MR 图 B 通道）。
 * 源资产 MR 是「黑车」标定（metal≈1 + 低粗糙）⇒ 白变体若照搬会读成镜面铬
 * （实测：白壳整体 crumpled chrome、车漆读不出白）。按变体给因子压金属度，
 * roughness 仍由 MR G 通道驱动（factor=1 不动）。来源：R44 QA render_debug A/B
 * （metalness 1.0 vs 0.2 对照，.qa/r44_car/_dbg_default.png）。
 */
const VARIANT_METALNESS: Record<string, number> = {
  white: 0.12,
  black: 0.9,
  gold: 0.55,
  purple: 0.6,
  green: 0.5
};

/* ══ R60 · P0-1 车身换干净程序化车漆（根治「喷溅噪点」）════════════════════════
 * 背景（R56 诊断 + R59 外部审查连续 5 轮）：车身 basecolor/normal 是 AI 生成贴图，
 * 岛内高频抖动经 clearcoat/env 放大 = 引擎盖/侧围满屏 speckle。R56 证明在脏贴图上
 * 做任何运行时补救（去噪 normal / 降 clearcoat/env）游戏内均无净收益 ⇒ 唯一根治路径
 * 是**换掉脏贴图本体**。R60 落地：车身 body 材质弃用 basecolor/normal/mr 三张脏贴图，
 * 改走纯程序化 PBR（每变体一套 color/metalness/roughness + R56 clearcoat/env 旋钮沿用）。
 *
 * 颜色来源：`tools/r60_paint_target.py` 从各变体 basecolor 贴图的高亮车身带（88–97 百分位）
 * 反演主色相，再按「车漆身份」归一（白=珍珠白、黑=曜石黑、金=香槟金、紫=星夜紫、绿=原厂绿）。
 * ⚠ 旧 basecolor 贴图烤了光照/AO，直接取均值会偏暗偏灰（白/黑拉不开）—— 故色相可信、
 *   亮度按车漆典型 albedo 重设，最终观感由 in-engine A/B 目检校准。
 *
 * 变体身份保留：setVariant 在程序化路径下改 color/metalness（不换贴图），六变体
 * （v800 白/黑/金、r7 白/紫/绿）语义不变。
 * 回滚：`#r60paint=off` 逐位回 R59 脏贴图路径（basecolor/normal/mr 全量挂回）。
 * 开销：−3 张 2048² 贴图采样/帧、DC/tri 不变（纯材质槽替换），且免下载三张脏贴图。
 */
function r60PaintOff(): boolean {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r60paint=off/i.test(window.location.hash);
}
export const R60_PAINT_PROC = !r60PaintOff();

/** 每变体程序化车漆：color（sRGB，Color.setHex 直接吃）+ metalness + roughness。
 *  metalness 给低值：车漆是清漆覆盖的介电底色（白/紫/绿近 0，黑/金略高增金属漆感），
 *  避免 R44 白变体「照搬黑车 MR 标定 → 镜面铬」的老坑（见 VARIANT_METALNESS 注）。 */
const R60_PROC_PAINT: Record<string, { color: number; metalness: number; roughness: number }> = {
  white: { color: 0xd6d2cb, metalness: 0.05, roughness: 0.34 },  // 珍珠白（暖白）
  black: { color: 0x0b0d11, metalness: 0.5, roughness: 0.3 },    // 曜石黑
  gold: { color: 0xc2ad86, metalness: 0.4, roughness: 0.34 },    // 香槟金
  purple: { color: 0x6b5b9e, metalness: 0.35, roughness: 0.34 }, // 星夜紫（实测色相 #63559f 归一）
  green: { color: 0x1d7f78, metalness: 0.3, roughness: 0.34 }    // 原厂绿（实测色相 #127d7c 归一）
};

/* ══ R62-P0-2 · 程序化车漆金属化（metallic flake + clearcoat 贴近官图）═════════
 * R60 平涂无金属闪：metalness 偏低 + clearcoat 走 R55 的 0.15（当年为压脏 normal 噪点，
 * 程序化路径无脏法线可放大 ⇒ 可安全拉高）。官图是清漆覆盖的金属漆（clearcoat 高光 +
 * 色度更饱和）。R62 在 useProcPaint 分支落 R60 参数**之后**叠加本表：
 *  - clearcoat 抬到 0.7 / clearcoatRoughness 0.12（湿润清漆高光）；
 *  - 色度按 chroma 乘子向纯色推（不换色相，只加饱和；white 例外保持暖白）；
 *  - 金属度按 metal 乘子上调（black/gold 明显、purple/green 适度、white 不动）。
 * SwiftShader 色彩偏弱 ⇒ 参数保守起步，`#r62paint=off` 逐位回 R60（不叠加本表）。
 * ⚠ 仅程序化路径（useProcPaint）生效；R59 脏贴图路径不动（脏法线会放大 clearcoat 噪点）。 */
const R62_PROC_PAINT_TWEAK: Record<string, { chroma: number; metal: number }> = {
  white: { chroma: 1.0, metal: 1.0 },   // 珍珠白：保持暖白，仅靠 clearcoat 出光泽
  black: { chroma: 1.15, metal: 1.3 },  // 曜石黑：金属漆感
  gold: { chroma: 1.12, metal: 1.3 },   // 香槟金：金属漆感
  purple: { chroma: 1.18, metal: 1.35 },// 星夜紫：加饱和 + 金属
  green: { chroma: 1.18, metal: 1.35 }  // 原厂绿：加饱和 + 金属
};
/** 程序化车漆清漆层强度（默认 0.7；`#r62clearcoat=` 可扫参） */
export const R62_PAINT_CLEARCOAT = r56HashNum('r62clearcoat') ?? 0.7;
/** 程序化车漆清漆层粗糙度（默认 0.12；`#r62clearcoatrough=` 可扫参） */
export const R62_PAINT_CLEARCOAT_ROUGH = r56HashNum('r62clearcoatrough') ?? 0.12;

/**
 * R45：外部壳是异步懒加载，且 V800 单车资产 ~49MB（gzip 传输 ~25MB）。慢网络下
 * 加载要数分钟，此期间游戏显示程序化回退外观 —— 若无提示会被误判「构建没更新」。
 * 这里挂一条轻量状态条：加载中显示已接收字节、就绪短提示、失败常驻告警。
 * ⚠ R46：原 `shellHud` 六个调用点语义**一字不动**（info×2 / ok / null / err），
 *   逐 chunk 的进度刷新改走独立的 `shellHudProgress`（~200ms 节流）。
 */
const SHELL_HUD_ID = 'r44-shell-hud';
function shellHud(text: string | null, tone: 'info' | 'ok' | 'err' = 'info'): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(SHELL_HUD_ID) as HTMLDivElement | null;
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = SHELL_HUD_ID;
    el.style.cssText =
      'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:60;' +
      'padding:8px 14px;border-radius:8px;background:rgba(14,11,14,.88);' +
      'font:13px/1.5 system-ui,-apple-system,sans-serif;letter-spacing:.3px;' +
      'pointer-events:none;white-space:nowrap;box-shadow:0 2px 14px rgba(0,0,0,.45)';
    document.body.appendChild(el);
  }
  el.style.color = tone === 'err' ? '#ff9b8a' : tone === 'ok' ? '#a8e6b0' : '#f3e9d2';
  el.textContent = text;
}

/** R46：按 car 计的已接收字节（替换 R45 的模块级全局 shellBytes，避免两车台账互相覆盖） */
const shellBytesByCar: Record<ExternalCarId, number> = { v800: 0, r7: 0 };

let hudTimer: ReturnType<typeof setTimeout> | null = null;
let hudPendingCar: ExternalCarId | null = null;
let hudPendingBytes = 0;

/** 加载完成 / 取消 / 失败时清掉节流定时器 ⇒ 绝不在 L544 移除节点后残留回调重建幽灵进度条 */
function clearHudThrottle(): void {
  if (hudTimer !== null) {
    clearTimeout(hudTimer);
    hudTimer = null;
  }
  hudPendingCar = null;
  hudPendingBytes = 0;
}

/**
 * R46 进度条节流（~200ms）。
 * ⚠ 节点不存在**直接 return、绝不 createElement** —— 创建权只归原 `shellHud`
 *   （L173-182）。否则 L543-544 就绪 4s 后 `shellHud(null)` 移除节点，残留定时回调
 *   会重建一条「幽灵进度条」（REPORT_PHASE1B.md 附录 B.3 / Phase1-C §9.4）。
 * ⚠ 不经过 shellHud：原函数会无条件写 `style.color`/`textContent`，这里把这两行
 *   一并挪进节流块（每 chunk 只做纯数值累加，不做 DOM/CSSOM 写）。
 */
function shellHudProgress(car: ExternalCarId, bytes: number): void {
  if (typeof document === 'undefined') return;
  if (!document.getElementById(SHELL_HUD_ID)) return;
  hudPendingCar = car;
  hudPendingBytes = bytes;
  if (hudTimer !== null) return;
  hudTimer = setTimeout(() => {
    hudTimer = null;
    const activeCar = hudPendingCar;
    const pending = hudPendingBytes;
    hudPendingCar = null;
    hudPendingBytes = 0;
    if (!activeCar) return;
    const el = document.getElementById(SHELL_HUD_ID);
    if (!el) return;
    el.style.color = '#f3e9d2';
    el.textContent =
      `高精度车模加载中 · 已接收 ${(pending / 1048576).toFixed(1)} MB` +
      `（首次加载约 ${SHELL_TOTAL_MB[activeCar]} MB）`;
  }, 200);
}

/**
 * 带字节进度的 fetch：显式校验 HTTP status（404 HTML 喂给 GLTFLoader 的错误不可读）。
 * R46：`signal` 传给 fetch（abort 会让 body stream 的 reader.read() 一并 reject）；
 *      循环头部再显式查一次 `signal.aborted`，防「已收完最后一块但已取消」仍继续。
 */
async function fetchTracked(
  url: string,
  car: ExternalCarId,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('/').pop()}`);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException('shell load cancelled', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    shellBytesByCar[car] += value.length;
    if (r44ShellStatus[car].state === 'loading') {
      r44ShellStatus[car].bytes = shellBytesByCar[car];
    }
    shellHudProgress(car, shellBytesByCar[car]);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/**
 * R46：`THREE.TextureLoader` / `ImageLoader` 没有 signal 接口，是取消链唯一不能直接
 * 透传的点。保守变体 = `fetchTracked(带 signal) → blob: URL → TextureLoader.loadAsync`
 * （blob: 不触发网络），原 `flipY/colorSpace/anisotropy/needsUpdate` 四行**逐位保留**，
 * 零 three 行为变更、不引入 createImageBitmap（Node 缺失 + UV 语义差异风险）。
 * 附带收益：3 张贴图字节也计入 HUD 进度（R45 原实现贴图字节不计入）。
 */
async function loadTexture(
  url: string,
  srgb: boolean,
  car: ExternalCarId,
  signal?: AbortSignal
): Promise<THREE.Texture> {
  const buf = await fetchTracked(url, car, signal);
  const objectUrl = URL.createObjectURL(new Blob([buf]));
  try {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const tex = await loader.loadAsync(objectUrl);
    tex.flipY = false; // glTF UV 约定（独立加载贴图必须显式关）
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  } finally {
    URL.revokeObjectURL(objectUrl); // loadAsync resolve 时 <img> 已解码，revoke 安全
  }
}

/**
 * 把外部轮 mesh 挂进既有 spin 枢轴并把 spin 迁到外部 hub。
 * 通用矩阵反解（不假设 spin 结构）：
 *   1. hubWorld = 壳 root.matrixWorld × hub（模型单位）
 *   2. spin.position = spin.parent.worldToLocal(hubWorld)（spin 原点 = 外部轮心）
 *   3. meshLocal = spin.matrixWorld⁻¹ × T(hubWorld) ⇒ 静止时 mesh 世界变换 =
 *      纯平移（几何 X 轴 = 世界 X 车轴），spin 旋转时绕世界 X 自转 —— 对 V800
 *      hub 组（identity）与 R7 rotZ(90°) 基准四元数两种结构都成立（共轭旋转轴
 *      都落在世界 X 上）。
 */
export function mountExternalWheel(
  shellRoot: THREE.Object3D,
  hubModel: readonly [number, number, number],
  spin: THREE.Object3D,
  mesh: THREE.Mesh,
  scaleFactor: number
): void {
  // ⚠ 必须用 updateWorldMatrix(true, false)（自底向上重算**全祖先链**）——
  // updateMatrixWorld(true) 只从 parent.matrixWorld（可能还是构造期陈值）往下算，
  // 实测导致 spin.matrixWorld 缺祖先变换 ⇒ 局部分解出 x/z 31.5× 的剪切缩放
  // （= QA 图里「车旁巨大黑色翼状物」= 被拉成大饼的外部轮）。
  shellRoot.updateWorldMatrix(true, false);
  spin.updateWorldMatrix(true, false);
  const hubWorld = new THREE.Vector3(hubModel[0], hubModel[1], hubModel[2]);
  shellRoot.localToWorld(hubWorld);
  spin.position.copy(spin.parent!.worldToLocal(hubWorld.clone()));
  spin.updateMatrixWorld(true);
  // mesh 静止时世界变换 = T(hubWorld)×S(scale)（几何是模型单位，轮半径 ~0.09 ⇒
  // 必须带上 manifest.scale 才是 0.41m 真车轮；漏带时轮渲染成 1/4.75 小轮埋进轮拱）。
  const desired = new THREE.Matrix4()
    .multiplyMatrices(new THREE.Matrix4().makeTranslation(hubWorld.x, hubWorld.y, hubWorld.z),
      new THREE.Matrix4().makeScale(scaleFactor, scaleFactor, scaleFactor));
  // ⚠ 不做 decompose：spin 祖先链含多级 rotY(π) 四元数，position/quaternion/scale
  // 三元组表达不了其中的剪切成分（实测分解出 x/z 31.5× 的错缩放 = 巨型大饼轮）。
  // 直接把 local 矩阵钉在 mesh.matrix（matrixAutoUpdate=false），世界变换严格等于
  // spinWorld × spinWorld(0)⁻¹ × desired —— 自转 = spin 每帧旋转对 hub 的共轭，精确。
  const local = new THREE.Matrix4().copy(spin.matrixWorld).invert().multiply(desired);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(local);
  mesh.matrixWorldNeedsUpdate = true;
  spin.add(mesh);
}

/** R62-P0-1 · 单轮制动件（盘 + 卡钳）。盘随轮自转（挂 spin），卡钳静止（挂 spin 的父）。 */
export interface WheelBrakeSet {
  /** 打孔刹车盘（银灰金属，挂 spin ⇒ 随轮自转） */
  readonly disc: THREE.Mesh;
  /** 卡钳（R7 红 / V800 暗灰；挂 spin 的非自转父 ⇒ 静止） */
  readonly caliper: THREE.Mesh;
}

/**
 * R62-P0-1 · 构建单轮制动件几何（盘 + 卡钳），按材质分桶 `mergeSafe`。
 * 几何在**轮毂局部系**（原点=轮毂中心，X=车轴/自转轴，Y=上，Z=车前后）：
 *  - 盘：薄圆柱沿 X 轴（rotateZ(π/2) 把默认 Y 轴柱转到 X），半径 ~0.66 轮径、厚 ~0.05 轮径；
 *  - 卡钳：盘缘外的小盒，位于 +Z（车前）侧、盘外半径处，径向夹住盘缘。
 * 形状是程序化近似（无外部资产），真实观感由审查线目检。`#r62wheel=off` 时本函数不被调用。
 */
export function r62BuildBrakeSet(
  car: ExternalCarId,
  wheelRadius: number,
  outMats: THREE.Material[],
  outGeos: THREE.BufferGeometry[]
): WheelBrakeSet {
  const R = wheelRadius;
  // ── 盘（disc）：银灰金属薄盘，沿 X 轴
  const discR = R * 0.66;
  const discT = R * 0.05;
  const discGeo = new THREE.CylinderGeometry(discR, discR, discT, 40, 1, false);
  discGeo.rotateZ(Math.PI / 2); // 柱轴 Y → X（车轴）
  // 打孔盘语义：盘面加一圈小暗孔（用同一几何合并，避免多 DC；孔=凹陷观感靠暗色顶点）
  const holeGeo = new THREE.CylinderGeometry(R * 0.035, R * 0.035, discT * 1.02, 10, 1, false);
  holeGeo.rotateZ(Math.PI / 2);
  const discGeos: THREE.BufferGeometry[] = [discGeo];
  const HOLE_R = discR * 0.72;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const g = holeGeo.clone();
    g.translate(0, Math.cos(a) * HOLE_R, Math.sin(a) * HOLE_R); // YZ 平面圆周布孔
    discGeos.push(g);
  }
  holeGeo.dispose();
  const discMerged = mergeSafe(discGeos);
  for (const g of discGeos) g.dispose();
  const discMat = new THREE.MeshStandardMaterial({
    color: R62_BRAKE_DISC.color,
    metalness: R62_BRAKE_DISC.metalness,
    roughness: R62_BRAKE_DISC.roughness,
    side: THREE.DoubleSide
  });
  const disc = new THREE.Mesh(discMerged, discMat);
  disc.name = `r62-brake-disc-${car}`;
  disc.castShadow = false;
  disc.receiveShadow = false;

  // ── 卡钳（caliper）：盘缘外小盒，+Z（车前）侧
  const calW = R * 0.16;  // 径向（YZ 内的径向）厚度
  const calH = R * 0.30;  // 轴向（X）跨度
  const calD = R * 0.09;  // 切向跨度
  const calR = discR + calW * 0.4; // 卡钳中心落在盘缘略外
  const calGeo = new THREE.BoxGeometry(calH, calW, calD);
  calGeo.translate(0, 0, calR); // 推到 +Z 盘缘
  const calMat = new THREE.MeshStandardMaterial({
    color: R62_CALIPER[car],
    metalness: 0.35,
    roughness: 0.42,
    side: THREE.DoubleSide
  });
  const caliper = new THREE.Mesh(calGeo, calMat);
  caliper.name = `r62-caliper-${car}`;
  caliper.castShadow = false;
  caliper.receiveShadow = false;

  outMats.push(discMat, calMat);
  outGeos.push(discMerged, calGeo);
  return { disc, caliper };
}

/**
 * R62-P0-1 · 挂载单轮制动件（与 mountExternalWheel 同帧调用）。
 *  - 盘挂 `spin`（轮自转枢轴）⇒ 用与轮 mesh 完全相同的 local 矩阵 ⇒ 随轮自转、 hub 居中；
 *  - 卡钳挂 `spin.parent`（**非自转**父）⇒ local = spinParentWorld⁻¹ × spinWorld × hubLocal
 *    ⇒ 静止在盘缘 +Z（车前）侧，不随轮转。
 * 前置：调用方刚 updateWorldMatrix(true,false) 过 spin 与其父（mountExternalWheel 已做 spin；
 * 父链在 spin.updateWorldMatrix(true,false) 时一并刷新），此处再显式刷一次父，稳妥。
 */
export function mountExternalBrake(
  hubModel: readonly [number, number, number],
  spin: THREE.Object3D,
  brake: WheelBrakeSet,
  scaleFactor: number
): void {
  const hubLocal = new THREE.Matrix4().makeTranslation(hubModel[0], hubModel[1], hubModel[2])
    .multiply(new THREE.Matrix4().makeScale(scaleFactor, scaleFactor, scaleFactor));
  // 盘 → spin（自转）
  spin.updateWorldMatrix(true, false);
  const spinWorld = new THREE.Matrix4().copy(spin.matrixWorld);
  const discLocal = new THREE.Matrix4().copy(spinWorld).invert().multiply(hubLocal);
  brake.disc.matrixAutoUpdate = false;
  brake.disc.matrix.copy(discLocal);
  brake.disc.matrixWorldNeedsUpdate = true;
  spin.add(brake.disc);
  // 卡钳 → spin 的父（非自转）
  const parent = spin.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    const parentWorld = new THREE.Matrix4().copy(parent.matrixWorld);
    const calLocal = new THREE.Matrix4().copy(parentWorld).invert().multiply(spinWorld).multiply(hubLocal);
    brake.caliper.matrixAutoUpdate = false;
    brake.caliper.matrix.copy(calLocal);
    brake.caliper.matrixWorldNeedsUpdate = true;
    parent.add(brake.caliper);
  } else {
    // 兜底：无父则退化为挂 spin（会随轮转，仅极端树形下触发；正常树 spin 必有父）
    brake.caliper.matrixAutoUpdate = false;
    brake.caliper.matrix.copy(discLocal);
    brake.caliper.matrixWorldNeedsUpdate = true;
    spin.add(brake.caliper);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * R49-A2 · 阴影投影代理（shadow proxy）
 *
 * 定罪（.qa/r49/PERF_PRESTUDY.md §8①，读码口径）：
 *   R44 引入的高精度外部壳 `body.glb` 966,484 tri + 4 轮 303,521 tri
 *   = **1,270,005 tri**（r7 1,389,955 tri）全部 `castShadow=true`（本文件 :627/:631），
 *   而 R39 起 `Lighting` 的 `sun.shadow.autoUpdate=true` ⇒ **每帧重绘、无节流**，
 *   于是这 1.27M tri 每帧被**再投一遍**进 shadow pass（主 pass 之外的第二遍全顶点）。
 *   而 R38-P1-5 的 caster 瘦身（V800Adapter.ts:4764-4782）在**装配期**遍历 `root`，
 *   外部壳是 `loadExternalShell()` 异步 resolve 之后才挂上树 ⇒ 完全绕过瘦身。
 *
 * 修法（A2，零新资产 / 零 bake 管线改动 / 当日可回滚）：
 *   1. 高模壳本体**退出 shadow pass**（`bodyMesh` + 4 轮 `castShadow = false`）；
 *   2. 在适配器侧把程序化树里 **R38 保留的 castShadow 大件**（V800 实测 13 件 /
 *      19,536 tri，其轮廓已被 R38-P1-6 实证「车影可见轮廓全由这些大件决定」）
 *      各复制一个**只投影、不显影**的代理网格。
 *
 * 代理为什么「不显影」：
 *   - 材质 `MeshBasicMaterial({ colorWrite:false, depthWrite:false })` ⇒ 主 pass 里
 *     这次 draw **不写颜色、不写深度**，画面上零像素；
 *   - 进 shadow pass 时 three 走 `WebGLShadowMap.getDepthMaterial()` 现场派生
 *     `MeshDepthMaterial`（WebGLShadowMap.js:440-516）——它只同步 `visible` /
 *     `wireframe` / `side` / `alphaMap` / `alphaTest` / `map` / `displacement*` /
 *     `clippingPlanes`，**不复制 colorWrite / depthWrite**（同处 :479-505），
 *     所以阴影侧照常写深度，投影行为与原件逐位等价。
 *
 * 为什么不能用 layers / visible 隔离：
 *   three 的 shadow pass 用**主相机**的 layers 判可见性
 *   （WebGLShadowMap.js:522 `object.layers.test(camera.layers)`）⇒ 给代理单独
 *   layer 会连阴影一起被剔掉；而 `object.visible===false`（:520）与
 *   `material.visible===false`（:556）是**双闸门**，任一为假阴影即消失。
 *   ⇒ 代理必须 `visible=true` 且 `material.visible=true`，只能靠 colorWrite/depthWrite 隐身。
 *
 * 几何零增量：代理与原件**共享同一 BufferGeometry**（不 clone、不 dispose）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** `#r49shadowproxy=off` ⇒ 逐位回 R48：高模壳自己投影、不建任何代理 */
const SHADOW_PROXY_OFF_RE = /(?:^|[#&])r49shadowproxy=off/i;

/** 当前是否启用阴影投影代理（Node/vitest 下无 window ⇒ false，保持 R48 行为） */
export function shadowProxyEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return !SHADOW_PROXY_OFF_RE.test(window.location.hash);
}

/**
 * 把程序化树里「仍带 `castShadow` 的大件」（= R38-P1-5 瘦身后保留的那批）
 * 各复制成一个阴影代理，挂到**原件同一个 parent** 下并逐位复制局部变换。
 *
 * 为什么挂同 parent 而不是挂 body：世界变换**恒等**（含轮 `spin` 自转、车体
 * 平移），不需要任何矩阵反解，也不怕后续 `mountExternalWheel` 迁移轮枢轴。
 * `matrixAutoUpdate` / position / quaternion / scale / matrix 全部照抄。
 *
 * 代理打 `userData.r44External=true`：`setExteriorHidden`（V800Adapter.ts:4846）与
 * `setCabinBlocksHidden`（:4842-4884 同族）见到该标记一律跳过 ⇒ 程序化外观整体
 * 隐藏时，代理不会被连带藏掉（阴影常驻）。
 *
 * @param root 程序化车模树根（`model` 或 `root`，内部会过滤掉 r44External 子树）
 * @returns 新建的代理网格数组（供装配期记账/日志用）
 */
export function buildShadowProxies(root: THREE.Object3D): THREE.Mesh[] {
  // 按 side 缓存共享材质：MeshBasicMaterial 默认 FrontSide，但原件可能是
  // BackSide/DoubleSide（合批/翻面件）。shadowSide 由 material.side 派生
  // （WebGLShadowMap.js:488），故**必须跟随原件的 side**，否则背面剔除方向
  // 一变，投影轮廓就会与 R38 基线不一致。
  const matsBySide = new Map<THREE.Side, THREE.MeshBasicMaterial>();
  const matFor = (side: THREE.Side): THREE.MeshBasicMaterial => {
    let m = matsBySide.get(side);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        fog: false,
        side
      });
      matsBySide.set(side, m);
    }
    return m;
  };

  // 先收集再挂载：遍历过程中改树会打乱 traverse 的游标
  const sources: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.castShadow) return; // 已被 R38 瘦身/占位件逻辑关掉的，不代理
    if ((m.userData as { r44External?: boolean }).r44External === true) return; // 外部壳本体
    if (!m.parent) return;
    sources.push(m);
  });

  const proxies: THREE.Mesh[] = [];
  for (const src of sources) {
    const parent = src.parent;
    if (!parent) continue; // 理论上不会发生（收集阶段已滤），守住 TS 空安全
    const srcMat = Array.isArray(src.material) ? src.material[0] : src.material;
    const proxy = new THREE.Mesh(src.geometry, matFor(srcMat?.side ?? THREE.FrontSide));
    proxy.name = `r49-shadow-proxy:${src.name || src.uuid}`;
    proxy.visible = true; // 双闸门 ①（WebGLShadowMap.js:520）
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    proxy.matrixAutoUpdate = src.matrixAutoUpdate;
    proxy.position.copy(src.position);
    proxy.quaternion.copy(src.quaternion);
    proxy.scale.copy(src.scale);
    proxy.matrix.copy(src.matrix);
    proxy.matrixWorldNeedsUpdate = true; // 首帧就位（原件可能已 updateMatrixWorld）
    (proxy.userData as { r44External?: boolean }).r44External = true;
    parent.add(proxy);
    proxies.push(proxy);
  }
  return proxies;
}

/** 计算外部壳 root 系（= 世界系 xz）四轮偏移，供 fx WHEEL_LOCAL 同步 */
export function wheelOffsetsWorldXZ(
  manifest: ExternalManifest
): ReadonlyArray<readonly [number, number]> {
  const order = ['fl', 'fr', 'rl', 'rr'] as const;
  return order.map((tag) => {
    const h = manifest.hubs[tag];
    // body 已 rotY(π)：世界 xz = (−x·s, −z·s)
    return [-h[0] * manifest.scale, -h[2] * manifest.scale] as const;
  });
}

/** QA A/B：`#r44mat=plain|maponly|mapnormal|full` 材质通道开关（定位 crumple 根因用） */
function materialOverride(): string | null {
  if (typeof window === 'undefined') return null;
  return /[#&]r44mat=([a-z]+)/.exec(window.location.hash)?.[1] ?? null;
}

/**
 * R56 · 车身漆面「喷溅噪点」——诊断收口 + 运行时可调旋钮（**默认不改变观感**）。
 *
 * R56 诊断结论（swap-matrix + 离线去噪 + 双车 A/B，全部数值留档 `.qa/r56/`）：
 *  - 真源 ≠ basecolor（背景填平 −97% 游戏内纹丝不动、岛内去噪仅 −1~3%）、≠ mr（压平反 +18%）；
 *    = **normal.png 车身岛内高频 per-texel 抖动**（整张换平 → v800_side −23.6% / front34 −9.1%），
 *      再被 clearcoat + envMapIntensity 放大（与 R44-6 在码注释同源）。
 *  - **R7 车身噪点非贴图源**（全 swap case <5%）——属几何/环境/AA，与 V800 不同源。
 *  - **两个候选修复均未取得净收益**：① normal 岛内保边去噪（离线岛内抖动 −60%、边缘留 90%）
 *    游戏内仅 front34 +6.8% / front +3.0%，rear34/rear 反 −7%，目检无改善；② 降 clearcoat
 *    0.15→0.06 / env 0.7→0.55，front34/rear34 ~平，side 反 −18.7%（削平高光梯度反被高频判据
 *    记作更多纹理）且**付出漆面光泽**。⇒ speckle 是多源（法线抖动 + 几何硬边 + 清漆/环境 +
 *    SwiftShader AA），bake 被阻断下运行时无单点净胜方案。
 *
 * 因此本波**默认逐位不改变观感**（= R55 的 clearcoat 0.15 / env 0.7），仅保留运行时旋钮供
 * 真机目检调优：`#r56clearcoat=<0..1>` 覆盖 clearcoat、`#r56env=<0..2>` 覆盖 envMapIntensity
 * （免重建扫参）。要试「压噪点换光泽」：`#r56clearcoat=0.06&r56env=0.55`；回 R55 观感不传即可。
 */
function r56HashNum(key: string): number | null {
  if (typeof window === 'undefined') return null;
  const m = new RegExp(`(?:^|[#&])${key}=([0-9.]+)`, 'i').exec(window.location.hash);
  if (!m) return null;
  const v = Number.parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}
/** 车身漆面 clearcoat（默认 = R55 的 0.15，观感不变；可用 `#r56clearcoat=` 调优） */
export const R56_PAINT_CLEARCOAT = r56HashNum('r56clearcoat') ?? 0.15;
/** 车身漆面 envMapIntensity（默认 = R55 的 0.7，观感不变；可用 `#r56env=` 调优） */
export const R56_PAINT_ENV = r56HashNum('r56env') ?? 0.7;

/* ══ R62-P0-1 · 轮毂 / 制动系统材质预设 ════════════════════════════════════
 * 轮外部 GLB 是一体 lathe（胎面橡胶 + 盘面金属无内置材质分组），原把车漆赋整轮
 * ⇒ 黑胎/银毂/红卡钳全部读作车身色。R62 起四轮 GLB 改赋专用 wheel-alloy 金属材质
 * （盘面即「轮毂」，跟车身色解耦），并按 car 分支：R7 深色运动毂 / V800 银色涡轮盘面。
 * 几何可分性（tools/r62_glb_inventory.mjs 实测）：轮 GLB 单 mesh、无 tire/rim 材质分组
 * ⇒ 胎面与盘面**几何不可分**，本波不重切 GLB，只做盘面独立色（胎暂同 alloy 色，如实报告）。
 */
const R62_WHEEL_ALLOY: Record<ExternalCarId, { color: number; metalness: number; roughness: number }> = {
  r7: { color: 0x23262b, metalness: 0.6, roughness: 0.45 },   // R7 近黑运动毂
  v800: { color: 0xb8bec6, metalness: 0.85, roughness: 0.3 }  // V800 银色涡轮盘面
};
/** 刹车盘：银灰金属（打孔盘面） */
const R62_BRAKE_DISC = { color: 0x9aa0a8, metalness: 0.9, roughness: 0.32 };
/** 卡钳：R7 红（语义 caliper-red #B0202A）；V800 被盘面遮挡，给暗灰低调不外露 */
const R62_CALIPER: Record<ExternalCarId, number> = { r7: 0xb0202a, v800: 0x2a2d33 };

/** 语义部件收集：gltf.scene 下全部 mesh 赋材质+缩放；mat=null 时只清空不产出 */
function collectNamed(
  gltf: { scene: THREE.Object3D } | null,
  out: THREE.Mesh[],
  mat: THREE.Material | null,
  scale: number
): void {
  if (!gltf || !mat) return;
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = mat;
    mesh.scale.setScalar(scale);
    mesh.renderOrder = 2; // 透明玻璃后绘
    out.push(mesh);
  });
}

/* ══ R53 · 前灯 DRL+透镜程序化细节（修「前灯空腔黑腔」）════════════════════════
 * 背景（.qa/r53，NVIDIA Super VL 双模像素分析 + GLB 几何探针）：
 *  `lamp_front_atlas.png` 两车均缺失 ⇒ R51-B3 纯 emissive `0x9aa6b4@0.18` 是
 *  V800 两侧暗腔 + R7「一片白」的根因；R46 atlas 路线被堵死（v800 灯区 UV 采样
 *  命中率仅 2.0%，UV 满图散落）。用户授权「面数可抬」⇒ 选**程序化 emissive 细节**
 *  路线：零资产改动、零新外部文件、免疫散落 UV。
 *
 *  设计（官图归一化：u 0→1 = 灯框左→右，v 0→1 = 顶→底）：
 *   · V800：顶部镀铬贯穿饰条（v 0.20-0.28）→ 横向 DRL 亮条（v 0.28-0.33）
 *     → 下方 4 条竖向透镜格（v 0.35-0.74，靠外缘）。官图是竖条灯 + 横 DRL。
 *   · R7：鱼尾 DRL（v 0.16-0.28，外端上钩 0.04-0.16）→ 3 个透镜模块
 *     （v 0.36-0.56）→ 下缘镀铬条（v 0.64-0.72）。
 *
 *  实现：lamp_front.glb 是**单 mesh 含左右灯**（node 无位移/旋转，几何即灯框
 *  局部空间）；按顶点 x 正负拆左右灯 bbox，把两灯全部细节合并成 **2 个 mesh**
 *  （emissive 全部 + chrome 全部）挂到该 lamp mesh 下 ⇒ DC 增量恒 **+2/车**。
 *  ⚠ 细节 mesh 是 lamp mesh 的 child ⇒ 自动继承 scale(manifest)/body rotY(π)，
 *    无需在世界系换算；`renderOrder=3` 保证绘在 lamp 面之上。
 *  回滚：`#r53lampdetail=off` ⇒ 零新增，逐位回 R52。 */
interface R53LampBox {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/** 顶点 x 正负拆左右灯 bbox（几何局部空间；lamp_front.glb 单 mesh 双灯） */
function r53SplitLampBoxes(geo: THREE.BufferGeometry): { left: R53LampBox; right: R53LampBox } {
  const pos = geo.getAttribute('position');
  const mk = (): R53LampBox => ({
    min: new THREE.Vector3(Infinity, Infinity, Infinity),
    max: new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  });
  const left = mk();
  const right = mk();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const b = x < 0 ? left : right;
    b.min.x = Math.min(b.min.x, x);
    b.max.x = Math.max(b.max.x, x);
    b.min.y = Math.min(b.min.y, y);
    b.max.y = Math.max(b.max.y, y);
    b.min.z = Math.min(b.min.z, z);
    b.max.z = Math.max(b.max.z, z);
  }
  return { left, right };
}

/** 在灯框 bbox 内加一块细节盒（u/v 归一化，v 从顶起；z 落灯面前 +1mm，厚 4mm 嵌入 1mm） */
function r53AddBox(
  geos: THREE.BufferGeometry[],
  bb: R53LampBox,
  u0: number,
  u1: number,
  v0: number,
  v1: number
): void {
  const x0 = bb.min.x + u0 * (bb.max.x - bb.min.x);
  const x1 = bb.min.x + u1 * (bb.max.x - bb.min.x);
  const yTop = bb.max.y - v0 * (bb.max.y - bb.min.y);
  const yBot = bb.max.y - v1 * (bb.max.y - bb.min.y);
  const g = new THREE.BoxGeometry(Math.max(x1 - x0, 1e-5), Math.max(yTop - yBot, 1e-5), 0.004);
  g.translate((x0 + x1) / 2, (yTop + yBot) / 2, bb.max.z + 0.001);
  geos.push(g);
}

interface R53LampElem {
  m: 'emissive' | 'chrome';
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** 每车元素表（左灯 u 自左缘起；右灯调用方镜像 u'=1−u） */
const R53_V800_ELEMS: R53LampElem[] = [
  { m: 'chrome', u0: 0.16, u1: 0.84, v0: 0.20, v1: 0.28 }, // 顶部镀铬贯穿饰条
  { m: 'emissive', u0: 0.20, u1: 0.80, v0: 0.28, v1: 0.33 }, // 横向 DRL 亮条
  { m: 'emissive', u0: 0.195, u1: 0.225, v0: 0.35, v1: 0.74 }, // 4 竖透镜格
  { m: 'emissive', u0: 0.235, u1: 0.265, v0: 0.35, v1: 0.74 },
  { m: 'emissive', u0: 0.275, u1: 0.305, v0: 0.35, v1: 0.74 },
  { m: 'emissive', u0: 0.315, u1: 0.345, v0: 0.35, v1: 0.74 }
];
const R53_R7_ELEMS: R53LampElem[] = [
  { m: 'emissive', u0: 0.05, u1: 0.95, v0: 0.16, v1: 0.28 }, // 鱼尾 DRL 主条
  { m: 'emissive', u0: 0.02, u1: 0.08, v0: 0.04, v1: 0.16 }, // 外端上钩
  { m: 'emissive', u0: 0.25, u1: 0.35, v0: 0.36, v1: 0.56 }, // 3 透镜模块
  { m: 'emissive', u0: 0.45, u1: 0.55, v0: 0.36, v1: 0.56 },
  { m: 'emissive', u0: 0.65, u1: 0.75, v0: 0.36, v1: 0.56 },
  { m: 'chrome', u0: 0.08, u1: 0.92, v0: 0.64, v1: 0.72 } // 下缘镀铬条
];

/* ══ R57 · V800 前灯竖向方形发光单元重建（修「官图竖向 3–4 段方灯 / 游戏 Nsq=0」）═════
 * 定罪（`.qa/r57/PHASE1_DEV.md` §1 + `lamp_2d.log` 数值探针 + `PHASE1_REVIEW.md` §2.3）：
 *  · R53 `r53SplitLampBoxes` 按 x=0 切分，把 x≈0 的中央连接桥（z=0.578406）纳入左右灯
 *    bbox ⇒ `bb.max.z` 比真实灯最前表面（0.564213 / 0.564549）高 0.0142 ≈ 67mm 世界，
 *    细节盒悬在灯面前 6~21cm 世界。
 *  · 中央空区 x∈(-0.093,-0.018) 无顶点却撑大 x 跨度 W=0.1871（真实灯宽 0.0858）
 *    ⇒ u 归一化基准被拉伸 2.18×；u 0.195-0.345 / v 0.35-0.74 落到 y[0.114,0.164]，
 *    该 (x,y) 的 lamp front-facing 顶点仅 0~7 个 ⇒ R53 在 V800 上零有效视觉贡献
 *    （像素仲裁：游戏灯 ROI Nsq=0，只有 ar≈0.15 细竖线 + 一条水平亮条）。
 *  · 灯框本身是**竖向**的，「横向暗块」是上方 R54 亮铬条/暗带被混读 ⇒ 不重塑灯框，
 *    只在既有竖向灯框内补方形发光单元。
 *
 * 修法：**不再使用 bbox 归一化**，改为按 GLB 局部坐标硬编码发光单元 (x,y,z)：
 *  · x/y 取自 `lamp_2d.log` 的 lamp front-facing 2D 顶点分布（可见竖列 |x|≈0.13~0.19、
 *    y 0.095~0.205）；
 *  · z 取同表 **body/lamp 2D zMax 的较大者 + 0.003**（凸 ~14mm 世界，贴住曲面、
 *    免 z-fight、免 3/4 视角悬空穿帮）。⚠ **严禁再用单一 `bb.max.z`**（R56 曲面件铁律）。
 *  · 2 列 × 3 行 = 6 枚近方形发光单元（w/h≈0.9，逐枚独立、行列留暗缝防 4-连通合并），
 *    行距 0.030 局部 ≈ 45px（≥ 冻结门 P4 的 10px）；y 全部 ≤0.170 以避开 R54 ribbon
 *    y∈[0.171,0.183]，防与 CHROME_BAR 曝光锚点耦合。
 *  · 顶部横 DRL 保留，按 x 分 3 段逐段贴面（避免单盒横跨曲面造成一端悬空/一端被挡）。
 *  · 左右灯由 side=±1 镜像 x；**只作用于 V800**，R7 与 `#r57headlamp=off` 走原 R53 逻辑。
 *
 * 帧成本：仍合并为**单一 emissive mesh**（`mergeSafe`）挂 lampMesh 下 ⇒ **DC 增量 0**；
 *  (6+3)×2 = 18 盒 × 12 tri = 216 tri，原 R53 为 10 盒 120 tri ⇒ 净 **+96 tri (<500)**。
 *  全部为首建期一次性构造静态几何，**零每帧新增计算**。
 * 回滚：`#r57headlamp=off` ⇒ 走原 R53 逻辑（逐位回 R56）；`#r53lampdetail=off` 仍整体
 *  跳过；R54 抑制 chrome 语义不变（本分支根本不构造 chrome）。
 * 验收：`.qa/r57/PHASE1_REVIEW.md` §5 冻结门 P1–P9。 */
interface R57LampCell {
  /** GLB 局部 x 的绝对值（左灯取负、右灯取正） */
  ax: number;
  y: number;
  w: number;
  h: number;
  /** 该 (x,y) 覆盖区域内 body/lamp 2D zMax 的最大值 + 0.003（贴面前表面） */
  z: number;
}

/** V800 单侧 6 枚方形发光单元（2 列 × 3 行）。
 *  ⚠ 尺寸/行位是第二轮 A/B 目检 + 冻结像素门反标定后的值：
 *   首版 w/h=0.018/0.020 在屏幕上过大，6 枚被 4-连通**合并成整块**
 *   （bright 70.3% vs 官图 14.65%、Lmean 187>130、最大亮域 3907px），
 *   且第 3 行 y=0.110 落在冻结 L_LAMP ROI(y388-505) 之外、DRL 溢出到
 *   CHROME_BAR 锚点(+9.2%)/GRILLE(+5.8%) ⇒ P1/P4/P5/P6 全 FAIL。
 *   现缩到 w/h=0.010/0.011（面积 ×0.31）、3 行收进 y∈[0.129,0.165]
 *   （ROI 内约 y≈28/65/101，行距 ≈37px ≥ P4 的 10px），DRL 细下移。 */
const R57_V800_CELLS: ReadonlyArray<R57LampCell> = [
  // 行1 y=0.165（实测屏幕约 ROI y+38）
  { ax: 0.170, y: 0.165, w: 0.010, h: 0.011, z: 0.540 },
  { ax: 0.140, y: 0.165, w: 0.010, h: 0.011, z: 0.561 },
  // 行2 y=0.147（实测屏幕约 ROI y+63）
  { ax: 0.170, y: 0.147, w: 0.010, h: 0.011, z: 0.541 },
  { ax: 0.140, y: 0.147, w: 0.010, h: 0.011, z: 0.562 }
];

/** 顶部 DRL：2 枚并排**近方形**块（ar≈1.25，计入 Nsq）。
 *  第三轮 A/B 反标定：① 细横条 DRL 在 y=0.172 仍压进 CHROME_BAR 锚点
 *  （Lmean 148.48→158.68，+6.9% > ±5%，P6 FAIL）；② 原第 3 行 y=0.129
 *  落在灯罩外不显示，导致只有 2 个 y 中心、P4 FAIL。
 *  现把 DRL 下移到 y=0.178（屏幕约 ROI y+20，完全避开 CHROME_BAR 的 y<10），
 *  并做成 2 枚近方形块 ⇒ 与下方 2 行共同给出 **3 个 y 中心**（~20/38/63，
 *  间距 18/25px ≥ P4 的 10px），同时保留「顶部横 DRL」的横向排布语义。
 *  官图黑款点亮态实测 5 枚方形亮域（审查线 §2.3）亦支持 DRL 参与方形计数。 */
const R57_V800_DRL: ReadonlyArray<R57LampCell> = [
  { ax: 0.165, y: 0.178, w: 0.010, h: 0.008, z: 0.545 },
  { ax: 0.135, y: 0.178, w: 0.010, h: 0.008, z: 0.567 }
];

/** R57 V800 专用：构造方形发光单元 + 分段横 DRL，合并成单一 emissive mesh。 */
function r57BuildV800LampDetail(
  lampMesh: THREE.Mesh,
  outMats: THREE.Material[],
  outGeos: THREE.BufferGeometry[]
): void {
  const geos: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    for (const c of [...R57_V800_CELLS, ...R57_V800_DRL]) {
      const g = new THREE.BoxGeometry(c.w, c.h, 0.004);
      g.translate(side * c.ax, c.y, c.z + 0.001);
      geos.push(g);
    }
  }
  const merged = mergeSafe(geos);
  // mergeSafe 对 indexed 输入会 toNonIndexed() 复制数据，原始盒可安全释放（防泄漏）。
  for (const g of geos) g.dispose();
  const drlMat = new THREE.MeshStandardMaterial({
    color: 0x0a0c10,
    emissive: new THREE.Color(0xe9f1ff),
    emissiveIntensity: 1.8,
    roughness: 0.35,
    metalness: 0.05
  });
  const mesh = new THREE.Mesh(merged, drlMat);
  mesh.name = 'lamp_front_drl';
  mesh.castShadow = false;
  mesh.renderOrder = 3;
  mesh.frustumCulled = true;
  /* ⚠ R57 首要根因修复（Phase2 A/B 实证：首版 on/off 逐位相同、Nsq 全 0）：
   * V800Adapter.ts:4877-4887 `setExteriorHidden(true)` 会把「无 sculptMaterial.id
   * 且名字不在 R44_KEEP_MESH_NAMES」的 mesh 连同其材质一并 `visible=false`。
   * Adapter 挂载时只对 lampMeshes **自身**打 `r44External` 标记
   * (V800Adapter.ts:4944-4945)，**没有 traverse 子对象** ⇒ R53 及本函数新建的
   * child mesh 从 R53 上线起就一直被隐藏（这才是「R53 零有效视觉贡献」的第一层根因，
   * bbox 中央桥污染是第二层）。挂 lampMesh 下的 child 必须自己带该标记，才能被
   * setExteriorHidden / setCabinBlocksHidden / buildPokeList 三条遍历统一跳过。
   * ⚠ 只在本 V800 新分支打标记；`#r57headlamp=off` 走的原 R53 逻辑保持隐藏，
   *   从而与 R56 基线逐位相同（实测 12 张 neqPx 全 0）。 */
  mesh.userData.r44External = true;
  lampMesh.add(mesh);
  outGeos.push(merged);
  outMats.push(drlMat);
}

/**
 * 构建前灯细节：两灯全部 emissive 合并 1 mesh、全部 chrome 合并 1 mesh，
 * 挂到 lamp mesh 下。返回新增材质（供 dispose）。
 */
function r53BuildLampDetail(
  lampMesh: THREE.Mesh,
  car: ExternalCarId,
  outMats: THREE.Material[],
  outGeos: THREE.BufferGeometry[]
): void {
  if (!R53_LAMP_DETAIL_ON) return;
  // R57：V800 前灯竖向方形发光单元重建（默认开）。
  // ⚠ 不改共享 `r53SplitLampBoxes` / `R53_R7_ELEMS` ⇒ R7 逐字不动；
  //   `#r57headlamp=off` 直接落到下方原 R53 逻辑 ⇒ 逐位回 R56 基线。
  if (car === 'v800' && R57_HEADLAMP_ON) {
    r57BuildV800LampDetail(lampMesh, outMats, outGeos);
    return;
  }
  const { left, right } = r53SplitLampBoxes(lampMesh.geometry);
  const elems = car === 'r7' ? R53_R7_ELEMS : R53_V800_ELEMS;
  const emissiveGeos: THREE.BufferGeometry[] = [];
  const chromeGeos: THREE.BufferGeometry[] = [];
  for (const side of [left, right] as R53LampBox[]) {
    // 右灯镜像 u：外缘（左灯 u=0 / 右灯 u=1）一致
    const mirror = side === right;
    for (const e of elems) {
      // R54：灯上铬条由 R54 贯穿饰条统一提供（免双重/ z-fight），此处跳过 chrome
      if (e.m === 'chrome' && R54_CHROME_ON) continue;
      const u0 = mirror ? 1 - e.u1 : e.u0;
      const u1 = mirror ? 1 - e.u0 : e.u1;
      const bucket = e.m === 'chrome' ? chromeGeos : emissiveGeos;
      r53AddBox(bucket, side, u0, u1, e.v0, e.v1);
    }
  }
  // ⚠ 材质在 Node/vitest 无 document 环境下照常构造（三 geometry 纯顶点，无 canvas 依赖）
  const drlMat = new THREE.MeshStandardMaterial({
    color: 0x0a0c10,
    emissive: new THREE.Color(0xe9f1ff),
    emissiveIntensity: 1.8,
    roughness: 0.35,
    metalness: 0.05
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xb9bec7,
    metalness: 0.9,
    roughness: 0.25,
    envMapIntensity: 1.1,
    emissive: new THREE.Color(0x14161a),
    emissiveIntensity: 0.25
  });
  const mk = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string): void => {
    if (geos.length === 0) return;
    const merged = mergeSafe(geos);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.renderOrder = 3; // 绘在 lamp 面之上（lamp renderOrder=2）
    mesh.frustumCulled = true;
    lampMesh.add(mesh);
    outGeos.push(merged);
  };
  mk(emissiveGeos, drlMat, 'lamp_front_drl');
  mk(chromeGeos, chromeMat, 'lamp_front_chrome');
  outMats.push(drlMat, chromeMat);
}

/* ══ R54 · 前脸贯穿镀铬饰条（修「缺贯穿镀铬条」）════════════════════════════════
 * 背景（.qa/r54，NVIDIA Super VL 像素分析 + GLB 几何探针）：
 *  · V800 官图：中网=实心黑面板，**顶部镀铬贯穿饰条连接两灯**（含 HONGQI 字标），
 *    中央红徽标；当前渲染只有暗面板+徽标，缺贯穿条 ⇒ 缺陷 c。
 *  · R7 官图：下保险杠上缘有一条**镀铬贯穿饰条连接两灯组**（中央深色六边形徽标
 *    在饰条上方）；当前渲染缺此条。
 *  几何探针（贯穿条高度带）：
 *  · V800 y[0.170,0.184]：灯前表面仅在 x±0.15~0.19 存在（灯上缘在转角），中央是
 *    格栅。可见前表面 zMax 剖面：中心 0.5783 → x±0.19 处 0.5172（曲面）。
 *  · R7 y[0.146,0.162]：band 无灯顶点（饰条在灯**下方**）；格栅剖面中心 0.5744 →
 *    x±0.22 处 0.4786。饰条跨两灯组内缘（x±0.114），取 x[-0.12,0.12]。
 *
 *  实现：程序化 ribbon（沿 (x,z) 剖面挤出的四边形带，带厚度）挂 bodyMesh 下 ⇒
 *  自动继承 scale(manifest)/body rotY(π)，DC 增量恒 **+1/车**、tri 增量极低。
 *  ⚠ R54 开启时抑制 R53 灯上铬条（见 r53BuildLampDetail），由本饰条统一提供，
 *  避免双重铬条与 z-fight；`#r54trim=off` ⇒ R53 铬条恢复 + 本饰条消失 = 逐位回 R53。 */
const R54_V800_PROF: ReadonlyArray<readonly [number, number]> = [
  [-0.19, 0.5172], [-0.18, 0.5214], [-0.17, 0.5351], [-0.16, 0.5355], [-0.15, 0.5425],
  [-0.14, 0.5497], [-0.13, 0.5564], [-0.12, 0.5627], [-0.11, 0.5686], [-0.10, 0.5742],
  [-0.09, 0.5744], [-0.08, 0.5748], [-0.07, 0.5751], [-0.06, 0.5754], [-0.05, 0.5757],
  [-0.04, 0.5759], [-0.03, 0.5762], [-0.02, 0.5764], [-0.01, 0.5783], [0.00, 0.5782],
  [0.01, 0.5782], [0.02, 0.5763], [0.03, 0.5761], [0.04, 0.5759], [0.05, 0.5756],
  [0.06, 0.5753], [0.07, 0.5750], [0.08, 0.5747], [0.09, 0.5744], [0.10, 0.5722],
  [0.11, 0.5668], [0.12, 0.5608], [0.13, 0.5540], [0.14, 0.5471], [0.15, 0.5396],
  [0.16, 0.5353], [0.17, 0.5293], [0.18, 0.5214], [0.19, 0.5172]
];
const R54_R7_PROF: ReadonlyArray<readonly [number, number]> = [
  [-0.12, 0.5601], [-0.10, 0.5659], [-0.08, 0.5693], [-0.06, 0.5718], [-0.04, 0.5731],
  [-0.02, 0.5742], [0.00, 0.5744], [0.02, 0.5742], [0.04, 0.5731], [0.06, 0.5718],
  [0.08, 0.5693], [0.10, 0.5659], [0.12, 0.5601]
];

/**
 * 沿 (x,z) 剖面挤出的四边形带（带厚度），生成一块闭合 ribbon 几何。
 * 剖面点 x 必须严格递增；yC=带中心高度，h=高度（y 向），d=深度（z 向，嵌入表面），
 * off=前表面凸出量。坐标系 = bodyMesh 局部（GLB +Z 车头）。
 * ⚠ 顶点法线由 computeVertexNormals 按绕向求得（各面已按外向绕序构造）。
 */
function r54BuildRibbon(
  prof: ReadonlyArray<readonly [number, number]>,
  yC: number,
  h: number,
  d: number,
  off: number
): THREE.BufferGeometry {
  const n = prof.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, z] = prof[i];
    const yT = yC + h / 2;
    const yB = yC - h / 2;
    const zF = z + off;
    const zB = z + off - d;
    // 0 FT 1 FB 2 BT 3 BB
    pos.push(x, yT, zF, x, yB, zF, x, yT, zB, x, yB, zB);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    idx.push(a + 0, a + 1, b + 1, a + 0, b + 1, b + 0); // 前 +Z
    idx.push(a + 2, b + 2, b + 3, a + 2, b + 3, a + 3); // 背 −Z
    idx.push(a + 0, b + 0, b + 2, a + 0, b + 2, a + 2); // 顶 +Y
    idx.push(a + 1, a + 3, b + 3, a + 1, b + 3, b + 1); // 底 −Y
  }
  idx.push(1, 0, 2, 1, 2, 3); // 左端帽 −X
  const last = (n - 1) * 4;
  idx.push(last + 1, last + 2, last + 0, last + 1, last + 3, last + 2); // 右端帽 +X
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 构建前脸贯穿镀铬饰条：V800 全宽条（头灯上缘 y≈0.177）、R7 中央桥（灯下方 y≈0.154）。
 * 单 mesh 挂 bodyMesh 下。`#r54trim=off` ⇒ 零新增。
 */
function r54BuildFrontTrim(
  bodyMesh: THREE.Mesh,
  car: ExternalCarId,
  outMats: THREE.Material[],
  outGeos: THREE.BufferGeometry[]
): void {
  if (!R54_CHROME_ON) return;
  const prof = car === 'r7' ? R54_R7_PROF : R54_V800_PROF;
  const yC = car === 'r7' ? 0.154 : 0.177;
  const h = car === 'r7' ? 0.009 : 0.012;
  const g = r54BuildRibbon(prof, yC, h, 0.003, 0.0008);
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xb9bec7,
    metalness: 0.9,
    roughness: 0.25,
    envMapIntensity: 1.1,
    emissive: new THREE.Color(0x14161a),
    emissiveIntensity: 0.25
  });
  const mesh = new THREE.Mesh(g, chromeMat);
  mesh.name = car === 'r7' ? 'front_trim_r7' : 'front_trim_v800';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 3; // 与灯细节同级，绘在车漆之上
  mesh.frustumCulled = true;
  bodyMesh.add(mesh);
  outMats.push(chromeMat);
  outGeos.push(g);
}

/* ══ R61 · 车身侧面贯穿镀铬条（窗台线 beltline + 下裙线 rocker）══════════════════
 * 背景（.qa/r61 视觉主理 + tools/r61_glb_probe.mjs 量化 body 侧面 x(z)）：
 *  · V800 官图 064 / R7 侧视：车身侧面各有一条横贯车长的亮银镀铬饰条（窗台线），
 *    部分车型下裙还有第二条；当前渲染两侧均缺 ⇒ 侧面层次单薄、缺失豪华 MPV 标志特征。
 *  · 几何：程序化 ribbon 沿 (z,x) 剖面挤出（双线 × 双侧合并为单 mesh，DC +1/车），
 *    剖面 x(z) 由 GLB 探针取 body 侧面轮廓，ribbon 紧贴车身不外浮；挂 bodyMesh 下自动
 *    继承 scale(manifest)/body rotY(π)。`#r61side=off` ⇒ 零新增。`#r61side=off` 逐位回滚。 */

/** 侧面轮廓剖面：GLB 探针取 body 侧面 x(z)（精确窗台线高度），[z, x]（z 升序）。
 *  前翼子板尖刺已钳平、极端端部已裁，ribbon 紧贴车身侧面不外浮。 */
const R61_V800_BELT: ReadonlyArray<readonly [number, number]> = [
  [-0.515, 0.1913], [-0.491, 0.1960], [-0.467, 0.2003], [-0.443, 0.2036],
  [-0.419, 0.2066], [-0.395, 0.2089], [-0.370, 0.2109], [-0.346, 0.2121],
  [-0.322, 0.2128], [-0.298, 0.2133], [-0.274, 0.2136], [-0.250, 0.2139],
  [-0.226, 0.2139], [-0.202, 0.2137], [-0.178, 0.2136], [-0.154, 0.2134],
  [-0.130, 0.2132], [-0.105, 0.2130], [-0.081, 0.2128], [-0.057, 0.2125],
  [-0.033, 0.2123], [-0.009, 0.2121], [+0.015, 0.2161], [+0.039, 0.2187],
  [+0.063, 0.2187], [+0.087, 0.2175], [+0.112, 0.2105], [+0.136, 0.2102],
  [+0.160, 0.2098], [+0.184, 0.2095], [+0.208, 0.2200], [+0.232, 0.2200],
  [+0.256, 0.2200], [+0.280, 0.2136], [+0.304, 0.2133], [+0.329, 0.2060],
  [+0.353, 0.2049], [+0.377, 0.2042], [+0.401, 0.2022], [+0.425, 0.1992]
];
const R61_R7_BELT: ReadonlyArray<readonly [number, number]> = [
  [-0.524, 0.2084], [-0.500, 0.2182], [-0.476, 0.2248], [-0.451, 0.2295],
  [-0.427, 0.2340], [-0.403, 0.2377], [-0.378, 0.2430], [-0.354, 0.2433],
  [-0.330, 0.2434], [-0.305, 0.2434], [-0.281, 0.2385], [-0.257, 0.2341],
  [-0.232, 0.2317], [-0.208, 0.2299], [-0.184, 0.2287], [-0.159, 0.2280],
  [-0.135, 0.2276], [-0.111, 0.2271], [-0.086, 0.2269], [-0.062, 0.2268],
  [-0.038, 0.2266], [-0.013, 0.2265], [+0.011, 0.2266], [+0.035, 0.2265],
  [+0.060, 0.2265], [+0.084, 0.2264], [+0.108, 0.2263], [+0.133, 0.2440],
  [+0.157, 0.2440], [+0.181, 0.2386], [+0.206, 0.2269], [+0.230, 0.2277],
  [+0.254, 0.2292], [+0.279, 0.2332], [+0.303, 0.2400], [+0.327, 0.2401],
  [+0.352, 0.2402], [+0.376, 0.2385], [+0.400, 0.2333], [+0.425, 0.2261],
  [+0.449, 0.2193], [+0.473, 0.2022], [+0.498, 0.1735]
];

/**
 * 沿 (z,x) 剖面挤出的四边形带（带厚度），生成一块闭合 ribbon 几何（侧面腰线专用）。
 * 剖面点 z 必须严格递增；yC=带中心高度，h=高度（y 向），dx=厚度（x 向，向车外 +x），
 * off=前表面相对 body 侧面 x 的外凸量。坐标系 = bodyMesh 局部（GLB +Z 车头）。
 * ⚠ 顶点法线由 computeVertexNormals 按绕向求得（各面已按外向绕序构造）；材质用
 *   DoubleSide 兜底，避免绕向误差导致整条不可见。
 */
function r61BuildSideRibbon(
  prof: ReadonlyArray<readonly [number, number]>,
  yC: number,
  h: number,
  dx: number,
  off: number
): THREE.BufferGeometry {
  const n = prof.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const [z, x] = prof[i];
    const yT = yC + h / 2;
    const yB = yC - h / 2;
    const xF = x + off;        // 外表面（+x 朝车外）
    const xB = x + off - dx;   // 内表面
    // 0 XF-YT 1 XF-YB 2 XB-YT 3 XB-YB
    pos.push(xF, yT, z, xF, yB, z, xB, yT, z, xB, yB, z);
  }
  for (let i = 0; i < n - 1; i += 1) {
    const a = i * 4;
    const b = (i + 1) * 4;
    idx.push(a + 0, a + 1, b + 1, a + 0, b + 1, b + 0); // 外 +X
    idx.push(a + 2, b + 2, b + 3, a + 2, b + 3, a + 3); // 内 −X
    idx.push(a + 0, b + 0, b + 2, a + 0, b + 2, a + 2); // 顶 +Y
    idx.push(a + 1, a + 3, b + 3, a + 1, b + 3, b + 1); // 底 −Y
  }
  idx.push(1, 0, 2, 1, 2, 3); // 后端帽 −Z（z 最小）
  const last = (n - 1) * 4;
  idx.push(last + 1, last + 2, last + 0, last + 1, last + 3, last + 2); // 前端帽 +Z
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 构建车身侧面贯穿镀铬条（窗台线 beltline），左右双侧。
 * 两段 ribbon（右+左）合并为单 mesh（1 个 chrome 材质）挂 bodyMesh 下 ⇒ DC +1/车。
 * 下裙线（skirt）因轮拱穿插风险列为后续候选，本波不实现。
 * `#r61side=off` ⇒ 零新增。
 */
function r61BuildSideTrim(
  bodyMesh: THREE.Mesh,
  car: ExternalCarId,
  outMats: THREE.Material[],
  outGeos: THREE.BufferGeometry[]
): void {
  if (!R61_SIDE_ON) return;
  const beltProf = car === 'r7' ? R61_R7_BELT : R61_V800_BELT;
  const BELT_Y = 0.235; // 剖面已在精确窗台线高度采样，ribbon 紧贴车身
  const H = 0.026;
  const DX = 0.012;
  const OFF = 0.003;
  const geos: THREE.BufferGeometry[] = [];
  const flip = (p: ReadonlyArray<number>): [number, number] => [p[0], -p[1]]; // 左侧 = x 取反
  geos.push(r61BuildSideRibbon(beltProf, BELT_Y, H, DX, OFF));            // 右
  geos.push(r61BuildSideRibbon(beltProf.map(flip), BELT_Y, H, DX, OFF));  // 左
  const merged = mergeSafe(geos);
  // 亮银饰条：中银色 + 适度金属度 + 微 emissive 兜底（SwiftShader 弱反射下也读作亮银，
  // 真机核显反光更佳）。避免纯金属在近白车漆上因暗环境反射发黑、对比度丢失。
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xccd1d8,
    metalness: 0.55,
    roughness: 0.28,
    envMapIntensity: 1.3,
    emissive: new THREE.Color(0x3a3d44),
    emissiveIntensity: 0.22,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(merged, chromeMat);
  mesh.name = car === 'r7' ? 'side_chrome_r7' : 'side_chrome_v800';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 3;
  mesh.frustumCulled = true;
  bodyMesh.add(mesh);
  outMats.push(chromeMat);
  outGeos.push(merged);
  for (const g of geos) g.dispose();
}

/* ══ R55 · V800 中央红旗盾形徽标（中网细节）═══════════════════════════════════
 * 背景（.qa/r54，NVIDIA Super VL 参考分析 + GLB 几何探针）：
 *  V800 官图中网中央（镀铬贯穿条下方）有一个**竖长盾形红旗徽标**（红旗品牌标）；
 *  当前渲染只有暗面板，缺徽标。格栅中央表面探针：x[-0.06,0.06] y[0.08,0.185]
 *  z≈0.5764~0.5783（近平面）⇒ 徽标用平面盾形即可。
 *  实现：THREE.Shape 竖盾（尖顶、直边、圆弧底）→ ExtrudeGeometry 薄板，两层：
 *  外层银色描边（大盾，后） + 内层深红盾面（小盾，前），挂 bodyMesh 下 ⇒
 *  自动继承 scale(4.75)/body rotY(π)，DC 增量 +2/车。`#r55badge=off` 零新增。 */
function r55ShieldShape(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  // 归一化竖盾：尖顶、外扩肩、圆弧底（坐标 × w/2 × h/2 映射）
  const pts: ReadonlyArray<readonly [number, number]> = [
    [0, 0.5], [-0.34, 0.22], [-0.30, -0.20], [-0.20, -0.42],
    [0, -0.5], [0.20, -0.42], [0.30, -0.20], [0.34, 0.22]
  ];
  s.moveTo(pts[0][0] * w / 2, pts[0][1] * h / 2);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0] * w / 2, pts[i][1] * h / 2);
  s.closePath();
  return s;
}

function r55BuildHqBadge(
  bodyMesh: THREE.Mesh,
  outMats: THREE.Material[],
  outGeos: THREE.BufferGeometry[]
): void {
  if (!R55_BADGE_ON) return;
  // 位置：格栅中央、镀铬贯穿条（y0.171-0.183）正下方；格栅前表面 z≈0.5783
  const yC = 0.1325; // 徽标中心高
  const zBase = 0.5786; // 前表面 + ~0.0003 凸出
  const silverMat = new THREE.MeshStandardMaterial({
    color: 0xc3c8cf,
    metalness: 0.9,
    roughness: 0.22,
    envMapIntensity: 1.2,
    emissive: new THREE.Color(0x17191d),
    emissiveIntensity: 0.2
  });
  const redMat = new THREE.MeshStandardMaterial({
    color: 0x9c1115,
    metalness: 0.25,
    roughness: 0.32,
    emissive: new THREE.Color(0x7c0d10),
    emissiveIntensity: 0.35
  });
  const mk = (w: number, h: number, z: number, depth: number, mat: THREE.Material, name: string): void => {
    const shape = r55ShieldShape(w, h);
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    g.translate(0, yC, z);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
    mesh.frustumCulled = true;
    bodyMesh.add(mesh);
    outMats.push(mat);
    outGeos.push(g);
  };
  // 外盾（银描边）z[zBase, zBase+0.0018]；内盾（红面）z[zBase+0.0023, zBase+0.0035]
  // ⇒ 红盾前面比银盾前面凸 0.0015（~7mm 世界），免 z-fight，红盾浮于银描边之上。
  mk(0.030, 0.060, zBase, 0.0018, silverMat, 'hq_badge_silver');
  mk(0.024, 0.052, zBase + 0.0023, 0.0012, redMat, 'hq_badge_red');
}

/* ══ R58 · V800 车尾 MAEXTRO 镀铬带+字标（后风挡下沿）═════════════════════════
 * 背景（.qa/r58，NVIDIA Super VL 像素分析 + GLB 几何探针）：
 *  · V800 官图车尾正后：后挡风玻璃下沿有一条**亮银色镀铬横向饰条**，中央镶嵌
 *    **深色凸起 MAEXTRO 字母**（字母比带暗，明暗对比明显）；饰条横跨车宽 60–70%，
 *    介于左右竖向尾灯**内侧**、未被尾灯打断；高度约占车尾总高 3–5%。
 *  · 当前渲染（24 帧环绕 az0）：车尾只有红色贯穿尾灯带 + 下方护板，**缺 MAEXTRO 镀铬带
 *    +字标** ⇒ 尾部最显著识别特征缺失。
 *  几何探针（glb_maextro_surface.py，车尾 zMin 逐格，禁用单一 bb.max.z —— R53 铁律）：
 *  · 带 yC=0.353（后风挡下沿正下方凸面），x∈[-0.135,0.135]（横跨 ~64%，介于竖尾灯内侧，
 *    x≈±0.145 起即跳到竖尾灯斜面 z≈-0.508）。
 *  · 车尾表面 zMin（最靠后）：中心 x0 z≈-0.535 → x±0.12 z≈-0.545 → x±0.135 z≈-0.538。
 *  实现：程序化 ribbon（沿 (x,z) 车尾剖面挤出的四边形带，朝 −Z 凸出）挂 bodyMesh 下 ⇒
 *  自动继承 scale/rotY(π)。字母用 CanvasTexture（深色 MAEXTRO on 银渐变）作 map，
 *  metalness 0.6 保镀铬反射。DC 增量恒 **+1（仅 V800）**、tri 增量极低。
 *  `#r58rearbadge=off` ⇒ 零新增，逐位回 R57。
 *  ⚠ r44External 显式标记（R59 修正）：setExteriorHidden 走 root.traverse，three.js 的
 *    Object3D.traverse 是「回调(this) → 无条件递归所有 children」，回调里的 return **不会
 *    阻止遍历子树**。本 ribbon 现能正常显隐，是因为 V800Adapter 对 bodyMesh 整树 traverse
 *    打了 r44External（V800Adapter.ts buildExternal 路径）—— 结论侥幸正确、原注释的推理
 *    前提（traverse 会因外部壳本体跳过 bodyMesh 子树）是错的。显式补标记作防御：无论挂点
 *    /装配顺序怎么变都不会退化（R57 同源 bug：child 挂 lampMesh 下、Adapter 只逐个自身打标
 *    ⇒ 从上线起一直被隐藏）。护栏见 tests/r59_external_mark.test.ts。 */
/** 车尾 MAEXTRO 带剖面（GLB bodyMesh 局部，x 严格递增，z=车尾表面 zMin）。 */
const R58_V800_REAR_PROF: ReadonlyArray<readonly [number, number]> = [
  [-0.135, -0.5380], [-0.120, -0.5450], [-0.105, -0.5460], [-0.090, -0.5470],
  [-0.075, -0.5478], [-0.060, -0.5484], [-0.045, -0.5488], [-0.030, -0.5480],
  [-0.015, -0.5478], [0.000, -0.5478], [0.015, -0.5478], [0.030, -0.5480],
  [0.045, -0.5488], [0.060, -0.5484], [0.075, -0.5478], [0.090, -0.5470],
  [0.105, -0.5460], [0.120, -0.5450], [0.135, -0.5380]
];

/** 生成 MAEXTRO 字母贴图（深色字母 on 银色渐变带）。无 document 返回 null（防崩）。 */
function r58MakeMaextroTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const W = 1024, H = 96;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  // 银色镀铬渐变（R59 压暗一档：实测原 #eceef2 系在 SRGB+metalness0.6+环境光下被推到
  //   近纯白 mean228，像贴白胶带；压到 #b8bcc4 系保镀铬反光层次、与深色字母对比更强）
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#c2c6cd');
  grad.addColorStop(0.45, '#a4a9b1');
  grad.addColorStop(0.55, '#9aa0a8');
  grad.addColorStop(1, '#bcc0c7');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // 深色 MAEXTRO 字母，字间距拉开，居中（R59 加粗加大 + 降到 #0a0c10，提远距可读性：
  //   实测原 64px/2.1% 面积远距不可读，带高仅 ~18px 有效字高 ~12px）
  g.fillStyle = '#0a0c10';
  g.font = 'bold 72px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const word = 'MAEXTRO';
  const spacing = 20; // 字间距（px）—— 字母加大后略收间距，避免溢出带宽
  // 逐字母绘制以控制字间距（canvas 无原生 letterSpacing 全兼容）
  const widths = [...word].map((ch) => g.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (word.length - 1);
  let x = W / 2 - total / 2;
  g.textAlign = 'left';
  for (let i = 0; i < word.length; i++) {
    g.fillText(word[i], x, H / 2 + 2);
    x += widths[i] + spacing;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * 构建车尾 MAEXTRO 镀铬带+字标（仅 V800）。单 mesh 挂 bodyMesh 下，朝 −Z 凸出。
 * `#r58rearbadge=off` ⇒ 零新增。
 */
function r58BuildRearBadge(
  bodyMesh: THREE.Mesh,
  outMats: THREE.Material[],
  outGeos: THREE.BufferGeometry[]
): void {
  if (!R58_REAR_BADGE_ON) return;
  const prof = R58_V800_REAR_PROF;
  const yC = 0.353;   // 带中心高（后风挡下沿正下方）
  const h = 0.014;    // 带高（y 向）≈ 车尾总高 3.7%
  const d = 0.003;    // 深度（嵌入表面）
  const off = 0.0012; // 前表面凸出量（朝 −Z）
  const n = prof.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const yT = yC + h / 2;
  const yB = yC - h / 2;
  for (let i = 0; i < n; i++) {
    const [x, z] = prof[i];
    const zF = z - off;        // 前表面（朝 −Z，更靠后）
    const zBk = z - off + d;   // 背面（嵌入表面）
    // 0 FT 1 FB 2 BT 3 BB
    pos.push(x, yT, zF, x, yB, zF, x, yT, zBk, x, yB, zBk);
    const u = 1 - i / (n - 1); // 车尾朝 −Z，从车尾看 x 递增在屏幕上向左 ⇒ u 取反免字母镜像
    uv.push(u, 1, u, 0, u, 1, u, 0);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    // 前面朝 −Z（绕向与 R54 的 +Z 前面相反）
    idx.push(a + 0, b + 1, a + 1, a + 0, b + 0, b + 1);
    // 背面朝 +Z
    idx.push(a + 2, a + 3, b + 3, a + 2, b + 3, b + 2);
    // 顶 +Y
    idx.push(a + 0, a + 2, b + 2, a + 0, b + 2, b + 0);
    // 底 −Y
    idx.push(a + 1, b + 3, a + 3, a + 1, b + 1, b + 3);
  }
  idx.push(1, 2, 0, 1, 3, 2); // 左端帽 −X
  const last = (n - 1) * 4;
  idx.push(last + 0, last + 2, last + 3, last + 0, last + 3, last + 1); // 右端帽 +X
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const tex = r58MakeMaextroTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex ?? undefined,
    metalness: 0.55,
    roughness: 0.3,
    envMapIntensity: 1.1
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'rear_badge_v800';
  // R59 防御性显式标记：setExteriorHidden 必须跳过（否则 cabin 态被 id-less 材质规则连藏）。
  // 正常路径 V800Adapter 已对 bodyMesh 整树 traverse 打标，此处显式补一份，挂点/装配顺序
  // 变化时也不退化（R57 同源 bug 铁律）。详见本文件 R58 头注 R59 修正段。
  (mesh.userData as { r44External?: boolean }).r44External = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 3;
  mesh.frustumCulled = true;
  bodyMesh.add(mesh);
  outMats.push(mat);
  outGeos.push(geo);
}

/** R46：当前加载的 AbortController（供取消订阅回调命中；加载结束置 null） */
let shellAbort: AbortController | null = null;
/**
 * R49-P2b · R7 尾灯带底板 atlas（1024×172，比例 5.95 ≈ 盖板 2.02m×0.34m 的 5.94）。
 *
 * R51-B1-b：函数内部按模块级 `R51_BAND_ON` 选分支 —— 官图**深红细带**
 * （#5A1E1E~#6a2020，禁荧光红）+ 两端「白-红-白」分段 + LUXEED 字标 +
 * 上下深色饰条 + 下缘红反光条，**全部画进同一张不透明 atlas** ⇒ 零新增 mesh / DC。
 * `R51_BAND_ON=false` 分支逐位保留 R49 原绘制，供 `#r49hole=on` + `#r51band=off` 复现。
 * ⚠ 保持无参签名（r49_visual.test.ts 断言 `makeR7RearBandAtlas()`，禁加形参）。
 *
 * 为什么用 atlas 而不是若干小 Plane：验收要求「视觉改动整帧 DC 上涨 ≤ +3」。
 * 字标 / 两侧灯组内部的白条+红条 / 上下镀铬饰条 全部**画进同一张贴图**，
 * 由**同一块盖板 mesh** 承载 ⇒ 这些细节的额外 DC 恒为 0。
 *
 * UV 约定：PlaneGeometry 的 uv(0,0)=左下、(1,1)=右上；CanvasTexture 默认 flipY=true
 * ⇒ canvas 第 0 行 = v=1 = 盖板**顶边**（世界 y = 1.185）。
 * 世界 y 映射：row = (1.185 − y) / 0.34 × 171。
 *
 * Node/vitest 无 document ⇒ 返回 1×1 占位（外部壳在测试环境根本不会装配，这里只防崩溃）。
 */
function makeR7RearBandAtlas(): THREE.Texture | null {
  // ⚠ 失败必须返回 null：`new THREE.Texture()` 没有 image 时 three 会绑定 1×1 **白**图，
  //   map 白 × color 白 ⇒ 整块盖板变白（正是 R49 初版像素暴涨的直接机制）。
  if (typeof document === 'undefined') return null;
  const r51 = R51_BAND_ON; // 开关在函数内读，保持无参签名（历史源码契约）
  const W = 1024;
  const H = 172;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  const yRowR51 = (worldY: number): number => Math.round((1.185 - worldY) / 0.34 * (H - 1));
  if (r51) {
    /* ── R51-B1-b 官图深红细带（不透明同图，零新增 DC）─────────────────────
     * R49 教训：下缘反光条曾单独做 `transparent+alphaTest` 平面，SwiftShader 下
     * alpha 未被正确采样 ⇒ 整块不透明白（ROI 273→3383 px）。本版把它**画进 atlas**，
     * 与底板共用同一张不透明贴图，从机制上消除该风险。 */
    g.fillStyle = '#14141a'; // 不透明底板（深墨，不读成空洞）
    g.fillRect(0, 0, W, H);
    // 上下深色饰条
    g.fillStyle = '#24242b';
    g.fillRect(0, Math.max(0, yRowR51(1.175)), W, 4);
    g.fillRect(0, Math.max(0, yRowR51(0.858)), W, 4);
    // 贯穿深红细带（占盖板高 ~8%，官图 5~8%）
    const bandY = yRowR51(1.075);
    g.fillStyle = '#5A1E1E';
    g.fillRect(0, bandY, W, 14);
    g.fillStyle = '#6a2020'; // 带内高光，制造细带层次（仍在深红区间）
    g.fillRect(0, bandY + 2, W, 4);
    // 两端「白-红-白」分段（左右镜像）
    const seg = Math.round(W * 0.16);
    for (const x0 of [Math.round(W * 0.02), W - Math.round(W * 0.02) - seg]) {
      g.fillStyle = '#d8d4cc';
      g.fillRect(x0, bandY - 2, Math.round(seg * 0.22), 18);
      g.fillStyle = '#8c2420';
      g.fillRect(x0 + Math.round(seg * 0.22), bandY - 2, Math.round(seg * 0.56), 18);
      g.fillStyle = '#d8d4cc';
      g.fillRect(x0 + Math.round(seg * 0.78), bandY - 2, Math.round(seg * 0.22), 18);
    }
    // LUXEED 深色金属字标（压在深红细带中央）
    g.fillStyle = '#b9bcc2';
    g.font = '600 26px system-ui, -apple-system, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('L U X E E D', W / 2, bandY + 7);
    // 下缘红反光条（左右两段，同图不透明）
    g.fillStyle = '#6a1d1d';
    g.fillRect(Math.round(W * 0.08), yRowR51(0.885), Math.round(W * 0.20), 8);
    g.fillRect(Math.round(W * 0.72), yRowR51(0.885), Math.round(W * 0.20), 8);
  } else {
  // ── 以下为 R49 原绘制（r51=false，`#r49hole=on` + `#r51band=off` 逐位复现）──
  // 底板：深墨（官图灯带底色），比纯黑略偏蓝，避免读成「空洞」
  g.fillStyle = '#14141a';
  g.fillRect(0, 0, W, H);
  const yRow = (worldY: number): number => Math.round((1.185 - worldY) / 0.34 * (H - 1));
  // 上下镀铬/深色饰条（2–3 px）
  g.fillStyle = '#2a2a31';
  g.fillRect(0, Math.max(0, yRow(1.175)), W, 3);
  g.fillRect(0, Math.max(0, yRow(0.858)), W, 3);
  // 两侧灯组内部结构：白细条 + 深红条（左右各一组，镜像对称）
  const seg = Math.round(W * 0.336); // 左/右段宽度（盖板 3 段视觉分区：0.336 / 0.328 / 0.336）
  const drawUnit = (x0: number, w: number): void => {
    g.fillStyle = '#5a6068'; // 白细条压暗成暗灰（避免糊成白噪点块）
    g.fillRect(x0 + Math.round(w * 0.18), yRow(1.075), Math.round(w * 0.64), 3);
    g.fillStyle = '#9c2424'; // 深红条（略提亮，黑底上可辨）
    g.fillRect(x0 + Math.round(w * 0.14), yRow(1.005), Math.round(w * 0.72), 5);
    g.fillStyle = '#3a1010'; // 红条下阴影，制造分段层次
    g.fillRect(x0 + Math.round(w * 0.14), yRow(0.995), Math.round(w * 0.72), 3);
  };
  drawUnit(0, seg);
  drawUnit(W - seg, seg);
  // 中段 LUXEED 字标
  g.fillStyle = '#c9ccd2';
  g.font = '600 30px system-ui, -apple-system, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('L U X E E D', W / 2, yRow(1.015));
  } // ← R51-B1-b：R49 原绘制分支结束（r51=false 时逐位复现）
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * R49-P2b · R7 下缘红反光条 atlas（512×32）：透明底 + 左右两段红条。
 * 用 alphaTest 0.5 而非 transparent 混合排序，避免参与透明队列（R12 铁律同源考虑）。
 */
export function makeR7LowerReflectorAtlas(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const W = 512;
  const H = 32;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#6a1d1d';
  g.fillRect(Math.round(W * 0.08), 8, Math.round(W * 0.20), 16);
  g.fillRect(Math.round(W * 0.72), 8, Math.round(W * 0.20), 16);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 门禁优先级（不可倒置，REPORT_PHASE1B.md §2.6）：
 *   ① inTestEnv()            —— vitest/Node 硬隔离，绝不发 fetch、绝不读 localStorage
 *   ② #r44ext=off            —— QA A/B，state:'failed' 原样不动（覆盖用户偏好）
 *   ③ #r44ext=on             —— R46 QA 强制开（覆盖「默认普通车模」偏好）
 *   ④ !isHighDetailEnabled() / isShellLoadCancelled() —— 默认普通车模 / 用户停止
 *   ⑤ 正常加载
 */
export async function loadExternalShell(
  car: ExternalCarId,
  variant: string
): Promise<ExternalShellHandle | null> {
  if (inTestEnv()) {
    r44ShellStatus[car] = { state: 'failed', error: 'skipped in test env (isolation gate)' };
    return null;
  }
  if (shellDisabled()) {
    r44ShellStatus[car] = { state: 'failed', error: 'disabled by #r44ext=off' };
    return null;
  }
  const forcedOn = shellForcedOn();
  if (!forcedOn && (!isHighDetailEnabled() || isShellLoadCancelled())) {
    // 零 fetch：直接返回 null ⇒ 两个 Adapter 的 `if (!shell) return` 保持程序化外观完整
    r44ShellStatus[car] = {
      state: 'cancelled',
      error: `default procedural (${shellCancelReason() ?? 'preference'})`,
      bytes: 0
    };
    shellHud('已按设置使用默认车模（未下载高精度模型）', 'ok');
    return null;
  }

  const ac = new AbortController();
  shellAbort = ac;
  const unsubscribe = onShellCancel(() => {
    ac.abort(new DOMException('shell load cancelled', 'AbortError'));
  });
  shellBytesByCar[car] = 0;
  r44ShellStatus[car] = { state: 'loading', bytes: 0 };
  clearHudThrottle();
  shellHud(`高精度车模加载中 · 正在连接…（首次加载约 ${SHELL_TOTAL_MB[car]} MB）`);
  try {
    const urls = ASSET_URLS[car];
    const res = await fetch(urls.manifest, { signal: ac.signal });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = (await res.json()) as ExternalManifest;
    const loader = new GLTFLoader();
    // 切割退化支持：manifest 无 wheel-* tri 计数 = 静态轮（整车单 mesh），跳过轮文件
    const hasWheelSplit = manifest.tri['wheel-fl'] != null;
    // R44-6 语义部件可选加载：文件缺失/旧 manifest 无字段时静默跳过（程序化回退不受影响）
    const hasSemantic = manifest.semantic != null;
    const fetchGlb = (url: string | undefined): Promise<{ scene: THREE.Object3D } | null> =>
      !url || ac.signal.aborted
        ? Promise.resolve(null)
        : fetchTracked(url, car, ac.signal)
            .then((buf) => loader.parseAsync(buf, ''))
            .catch(() => null);
    /**
     * R46 前灯图集（几何线并行产出）：
     *  - 尚未到位 / 404 / 解码失败 ⇒ `.catch(() => null)` 吞掉，材质维持纯 emissive，
     *    **绝不 throw 破坏整壳加载**（L461-481 原失败语义不变）；
     *  - 纳入同一 signal ⇒ 点「停止下载」时贴图请求一并中止。
     */
    const lampAtlasTexPromise: Promise<THREE.Texture | null> = hasSemantic && urls.lampFrontAtlas
      ? loadTexture(urls.lampFrontAtlas, true, car, ac.signal).catch(() => null)
      : Promise.resolve(null);
    // R60 P0-1：程序化车漆裁决点（唯一）。true ⇒ 不加载/使用 basecolor/normal/mr 三张
    // 脏贴图（喷溅根因），免下载 + 免显存 + 免每帧采样；`#r60paint=off` 回 R59 脏贴图路径。
    // ⚠ 必须先于下方 Promise.all 求值（贴图加载分支要读它）。
    const useProcPaint = R60_PAINT_PROC && !materialOverride();
    const [
      bodyGltf, wlGltf, wrGltf, glassGltf, lfGltf, lrGltf,
      baseTex, nrmTex, mrTex, lampAtlasTex
    ] = await Promise.all([
      fetchTracked(urls.body, car, ac.signal).then((buf) => loader.parseAsync(buf, '')),
      hasWheelSplit
        ? fetchTracked(urls.wheelL, car, ac.signal).then((buf) => loader.parseAsync(buf, ''))
        : Promise.resolve(null),
      hasWheelSplit
        ? fetchTracked(urls.wheelR, car, ac.signal).then((buf) => loader.parseAsync(buf, ''))
        : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.glass) : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.lampFront) : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.lampRear) : Promise.resolve(null),
      useProcPaint
        ? Promise.resolve(null)
        : loadTexture(urls.basecolor[variant] ?? urls.basecolor[manifest.variants[0].id], true, car, ac.signal),
      useProcPaint
        ? Promise.resolve(null)
        : loadTexture(new URL(`../../assets/cars/${car}/normal.png`, import.meta.url).href, false, car, ac.signal),
      useProcPaint
        ? Promise.resolve(null)
        : loadTexture(new URL(`../../assets/cars/${car}/mr.png`, import.meta.url).href, false, car, ac.signal),
      lampAtlasTexPromise
    ]);
    // GLTFLoader.parseAsync 是纯 CPU 不可中断；Promise.all 之后再查一次，已取消就不装配
    if (ac.signal.aborted) throw new DOMException('shell load cancelled', 'AbortError');
    const byName = (scene: THREE.Object3D): Map<string, THREE.Mesh> => {
      const m = new Map<string, THREE.Mesh>();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.name) m.set(mesh.name, mesh);
      });
      return m;
    };
    const bodyFound = byName(bodyGltf.scene).get('body');
    if (!bodyFound) throw new Error('body mesh missing');
    const wheelMeshes: Record<string, THREE.Mesh> = {};
    if (hasWheelSplit && wlGltf && wrGltf) {
      const wl = byName(wlGltf.scene);
      const wr = byName(wrGltf.scene);
      for (const [tag, src] of [
        ['fl', wl.get('wheel-fl')],
        ['rl', wl.get('wheel-rl')],
        ['fr', wr.get('wheel-fr')],
        ['rr', wr.get('wheel-rr')]
      ] as const) {
        if (!src) throw new Error(`wheel mesh ${tag} missing`);
        wheelMeshes[tag] = src;
      }
    }

    // R60 P0-1：构造仍逐字保留 R59 脏贴图路径（下方护栏测试钉死 `roughnessMap: mrTex` 等
    // 字面量）；程序化车漆在构造后由 R60 分支置 null + 填 color/metalness/roughness。
    const material = new THREE.MeshPhysicalMaterial({
      map: baseTex,
      normalMap: nrmTex,
      roughnessMap: mrTex, // G 通道
      metalnessMap: mrTex, // B 通道
      roughness: 1,
      metalness: VARIANT_METALNESS[variant] ?? 0.6,
      // R44-6：clearcoat 0.4→0.15 —— QA front34 实测 0.4 时涂层高光把 AI 法线图
      // 的微噪声放大成引擎盖「锈斑状白噪点」（侧视弱、逆光掠射严重）；0.15 保留
      // 漆面湿润感的同时压掉高光破碎。envMapIntensity 0.9→0.7 同向。
      // R56：swap-matrix 证噪声本体在 normal 图（换平 side −23.6%）；但「保边去噪 normal」
      // 与「再降 clearcoat/env」两路游戏内均无净收益（详见 R56_PAINT_* 注释），故默认维持
      // R44-6 的 0.15/0.7 观感不变，仅经 R56_PAINT_CLEARCOAT/ENV 暴露运行时调优旋钮。
      // R60：程序化车漆沿用同组 clearcoat/env 旋钮（漆面湿润感不丢，且无脏法线可放大）。
      clearcoat: R56_PAINT_CLEARCOAT,
      clearcoatRoughness: 0.35,
      envMapIntensity: R56_PAINT_ENV,
      // FrontSide + 烘焙期对拱内壁三角翻绕序（r44_uv_fix 橙三角清单 → bake 翻面）：
      // 内壁面朝外渲染为黑漆（UV 已黑化）。DoubleSide 方案实测会让内衬与外皮
      // z-fighting 出白噪点（QA closeup8），故弃用。
      side: THREE.FrontSide
    });

    /* ══ R60 · P0-1 程序化车漆（喷溅噪点根治）══════════════════════════════════
     * useProcPaint（已在 Promise.all 前裁决）⇒ 弃用 basecolor/normal/mr 三张脏贴图
     * （R56 通道剥离：去 basecolor −25~29%、去 normal −23.6% = 喷溅主源），改落
     * R60_PROC_PAINT[variant] 的 color/metalness/roughness。六变体身份保留，`#r60paint=off`
     * 逐位回 R59 脏贴图路径（构造体字面量即该路径基线）。
     * ⚠ R51 roughness 注入（G'=0.45+0.55G）只对 mr.png 的 G 通道有意义，程序化路径无
     *   roughnessMap ⇒ 下方注入加 `!useProcPaint` 闸（否则会把常量 roughness 再映射一档）。 */
    if (useProcPaint) {
      const procPaint = R60_PROC_PAINT[variant];
      material.map = null;
      material.normalMap = null;
      material.roughnessMap = null;
      material.metalnessMap = null;
      if (procPaint) {
        material.color.setHex(procPaint.color);
        material.metalness = procPaint.metalness;
        material.roughness = procPaint.roughness;
        /* R62-P0-2：程序化车漆金属化 —— 叠加 clearcoat 清漆层 + 色度/金属度上调（贴官图 metallic flake）。
         * material.color 已由 setHex 转到线性工作空间，故直接按线性比例缩放 = 视觉近似 sRGB 色度提升。
         * clamp 防裁剪；white 乘子=1（保持暖白，仅靠 clearcoat 出光泽）。`#r62paint=off` 跳过本块 = 逐位回 R60。 */
        if (R62_PAINT_ON) {
          const tw = R62_PROC_PAINT_TWEAK[variant];
          if (tw) {
            const c = material.color;
            c.setRGB(
              Math.min(1, c.r * tw.chroma),
              Math.min(1, c.g * tw.chroma),
              Math.min(1, c.b * tw.chroma)
            );
            material.metalness = Math.min(1, procPaint.metalness * tw.metal);
          }
          material.clearcoat = R62_PAINT_CLEARCOAT;
          material.clearcoatRoughness = R62_PAINT_CLEARCOAT_ROUGH;
        }
      }
      material.needsUpdate = true;
    }

    // QA 材质 A/B（#r44mat=）：plain=无贴图素材 / maponly=仅 basecolor /
    // mapnormal=+法线 / full=全量（默认）。⚠ 仅 R59 脏贴图路径（!useProcPaint）生效，
    // 程序化车漆路径无图可剥，本钩子不介入（`#r60paint=off` 可回脏贴图路径再用本钩子）。
    const mo = materialOverride();
    if (!useProcPaint) {
      if (mo === 'plain') {
        material.map = null;
        material.normalMap = null;
        material.roughnessMap = null;
        material.metalnessMap = null;
        material.metalness = 0;
        material.roughness = 0.5;
        material.color.setHex(0xeeeeee);
      } else if (mo === 'maponly') {
        material.normalMap = null;
        material.roughnessMap = null;
        material.metalnessMap = null;
        material.metalness = 0;
        material.roughness = 0.6;
      } else if (mo === 'mapnormal') {
        material.roughnessMap = null;
        material.metalnessMap = null;
        material.metalness = 0;
        material.roughness = 0.6;
      }
    }

    /* ══ R51-B2 · V800 白漆「镜面铬」修复（全局一档，**禁按车分支**）══════════════
     * 审查线定量：mr.png 的 G(roughness) 中位 v800=0.224（G<0.35 占 97.6%，单一
     * 连通域 683,235 px）⇒ 白漆被渲成镜面铬、PMREM 天空整面反射 = front34 白斑/
     * 浅蓝斑/引擎盖噪点；r7 中位 0.890（G<0.20 仅 0.01%、最大连通域 9 px）。
     * 一套 `G' = 0.45 + 0.55·G` 对两车同时安全：v800 0.224→0.573，r7 0.890→0.940
     * （几乎不动，不会毁掉 R7 正常漆面）。
     * 做法：`onBeforeCompile` 在 `#include <roughnessmap_fragment>` 之后对
     * `roughnessFactor` 做同一档映射（此时 material.roughness=1 ⇒ factor 就是 G）。
     * **零资产改动**（不动 mr.png）、零额外贴图/显存、零新增 DC；program 变体由
     * 加载期 `prewarmGpu()` 的 renderer.compile 一次性编译（用户已豁免首建时长）。
     * ⚠ 不做 `max(0.45, factor)`：那会在 G>0.45 处产生硬折点；线性一档保持漆面层次。
     * ⚠ `#r44mat=plain|maponly|mapnormal` QA 钩子移除 roughnessMap 后本注入仍作用于
     *   uniform roughness（只在排查钩子态，正常路径不受影响）；`#r51rough=off` 可完全关闭。
     */
    // ⚠ R60：程序化车漆路径无 mr.png、roughness 是常量 ⇒ 跳过本注入（否则会把常量
    //   roughness 再映射一档 G'=0.45+0.55G，漆面变涩）。保留 `if (R51_ROUGH_ON) {` 字面量
    //   （护栏测试 slice 锚点），程序化路径在块内 early-return 跳过。
    if (R51_ROUGH_ON) {
      if (useProcPaint) {
        // R60 程序化车漆：无 roughnessMap，跳过 G 通道一档映射
      } else {
        material.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <roughnessmap_fragment>',
            /* glsl */ `#include <roughnessmap_fragment>
            // R51-B2: G' = 0.45 + 0.55 * G (one global band, no per-car branch)
            roughnessFactor = 0.45 + 0.55 * roughnessFactor;`
          );
        };
      }
    }

    const bodyMesh = bodyFound;
    bodyMesh.material = material;
    /* R49-A2：高模壳本体退出 shadow pass —— 每帧 1.27M tri（r7 1.39M）的第二遍投影
     * 改由适配器侧的低模代理承担（见 buildShadowProxies 头注）。
     * `#r49shadowproxy=off` ⇒ 逐位回 R48：壳自己投影、适配器不建代理。 */
    const proxyMode = shadowProxyEnabled();
    bodyMesh.castShadow = !proxyMode;
    bodyMesh.receiveShadow = false;
    /** R62-P0-1：wheel-alloy + 刹车盘/卡钳 材质/几何账本（dispose 显式释放，防泄漏） */
    const r62BrakeMats: THREE.Material[] = [];
    const r62BrakeGeos: THREE.BufferGeometry[] = [];
    /* R62-P0-1：四轮外部 GLB 改赋专用 wheel-alloy 金属材质，与车身漆解耦（修「整轮=车身同色」）。
     * `#r62wheel=off` ⇒ 逐位回 R61：四轮重新赋车漆 material（下方 if/else 两分支字面量即回滚基线）。 */
    let wheelAlloyMat: THREE.MeshPhysicalMaterial | null = null;
    if (R62_WHEEL_ON) {
      const alloy = R62_WHEEL_ALLOY[car];
      wheelAlloyMat = new THREE.MeshPhysicalMaterial({
        color: alloy.color,
        metalness: alloy.metalness,
        roughness: alloy.roughness,
        clearcoat: 0.4,
        clearcoatRoughness: 0.2,
        envMapIntensity: 1.0,
        side: THREE.FrontSide
      });
      r62BrakeMats.push(wheelAlloyMat); // dispose 账本（轮辐/盘面同族金属材质）
    }
    for (const mesh of Object.values(wheelMeshes)) {
      mesh.material = (R62_WHEEL_ON && wheelAlloyMat) ? wheelAlloyMat : material;
      mesh.castShadow = !proxyMode; // R49-A2：同 bodyMesh，四轮也退出 shadow pass
    }
    /* R62-P0-1：每轮构建打孔刹车盘 + 卡钳几何（盘随轮自转、卡钳静止，由适配器
     * mountExternalBrake 挂到 spin / spin 的非自转父）。`#r62wheel=off` ⇒ 不建几何，
     * brakes 留空 = 逐位回 R61 无制动件。 */
    const brakes: Record<string, WheelBrakeSet> = {};
    if (R62_WHEEL_ON && hasWheelSplit) {
      for (const tag of Object.keys(wheelMeshes)) {
        brakes[tag] = r62BuildBrakeSet(car, manifest.wheelRadius, r62BrakeMats, r62BrakeGeos);
      }
    }
    bodyMesh.scale.setScalar(manifest.scale);
    /** R54：前脸贯穿镀铬饰条新增材质/几何（dispose 显式释放，防泄漏） */
    const r54TrimMats: THREE.Material[] = [];
    const r54TrimGeos: THREE.BufferGeometry[] = [];
    // R54：贯穿镀铬条（挂 bodyMesh 下，+1 DC/车；`#r54trim=off` 回滚）
    r54BuildFrontTrim(bodyMesh, car, r54TrimMats, r54TrimGeos);
    /** R55：红旗盾形徽标新增材质/几何 */
    const r55BadgeMats: THREE.Material[] = [];
    const r55BadgeGeos: THREE.BufferGeometry[] = [];
    // R55：V800 中央红旗盾形徽标（仅 V800；+2 DC/车；`#r55badge=off` 回滚）
    if (car === 'v800') r55BuildHqBadge(bodyMesh, r55BadgeMats, r55BadgeGeos);
    /** R58：车尾 MAEXTRO 镀铬带+字标新增材质/几何 */
    const r58RearMats: THREE.Material[] = [];
    const r58RearGeos: THREE.BufferGeometry[] = [];
    // R58：V800 车尾 MAEXTRO 镀铬带+字标（仅 V800；+1 DC/车；`#r58rearbadge=off` 回滚）
    if (car === 'v800') r58BuildRearBadge(bodyMesh, r58RearMats, r58RearGeos);
    /** R61：车身侧面贯穿镀铬条（窗台线 + 下裙线，双侧）新增材质/几何 */
    const r61SideMats: THREE.Material[] = [];
    const r61SideGeos: THREE.BufferGeometry[] = [];
    // R61：侧面贯穿镀铬条（挂 bodyMesh 下，双线×双侧合并为单 mesh，+1 DC/车；`#r61side=off` 回滚）
    r61BuildSideTrim(bodyMesh, car, r61SideMats, r61SideGeos);

    /* ── R52-A2 · 车轮轴心对齐（修「车轮轴心不稳」）───────────────────────────────
     * 定量证据（.qa/r52/wheel_hub.py / wheel_axle.py）：外部轮 GLB 真轴相对世界 X 偏
     *   2–5°（V800 轮毂内圈 PCA 5.5°；外缘锥度张开至 27° 为假象；R7 主轮 0.5–3.6° 干净）。
     * 游戏 spin 绕世界 X 自转 ⇒ 真轴偏角使轮缘绕 X 公转 → 摆动（V800 轮缘 ~0.42m ×
     *   sin5.5° ≈ 8cm 峰峰，车速下肉眼可见）。根因：r44_bake 未把轮轴归正到 X。
     * 修法：几何 3×3 协方差 PCA 取最小特征值方向 = 轮轴，最小旋转把它对齐到 +X；
     *   R47 rotateY(π) 随后绕 Y 把 +X→−X（仍沿 X 轴，辐条只做 Y 翻转，不打偏）。
     * 守卫：① 顶点数 <5000 跳过（只处理主轮大几何，跳过小卡钳/螺栓子件）；
     *   ② |axle.x|<0.95 跳过（不是近似沿 X 的轮几何，防误转独立子件）；
     *   ③ 特征向量强制 +X 分量，使对齐角 <90°（不绕轴 180° 打偏辐条）；
     *   ④ 零 bake 变更、零挂载矩阵变更、零自转语义变化。
     * QA 回滚：`#r52wheel=off` ⇒ 跳过本对齐（与 `#r47wheel=off` 独立 A/B）。 */
    function alignWheelAxleToX(geometry: THREE.BufferGeometry): void {
      const pos = geometry.attributes.position as THREE.BufferAttribute | undefined;
      if (!pos || pos.count < 5000) return; // 只处理主轮大几何
      const n = pos.count;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i); }
      cx /= n; cy /= n; cz /= n;
      let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
      for (let i = 0; i < n; i++) {
        const x = pos.getX(i) - cx, y = pos.getY(i) - cy, z = pos.getZ(i) - cz;
        cxx += x * x; cyy += y * y; czz += z * z; cxy += x * y; cxz += x * z; cyz += y * z;
      }
      cxx /= n; cyy /= n; czz /= n; cxy /= n; cxz /= n; cyz /= n;
      // 雅可比特征分解（3×3 对称）→ 最小特征值向量 = 轮轴
      let A: number[][] = [[cxx, cxy, cxz], [cxy, cyy, cyz], [cxz, cyz, czz]];
      let V: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let iter = 0; iter < 40; iter++) {
        let p = 0, q = 1, mx = Math.abs(A[0][1]);
        if (Math.abs(A[0][2]) > mx) { p = 0; q = 2; mx = Math.abs(A[0][2]); }
        if (Math.abs(A[1][2]) > mx) { p = 1; q = 2; mx = Math.abs(A[1][2]); }
        if (mx < 1e-12) break;
        const app = A[p][p], aqq = A[q][q], apq = A[p][q];
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi), s = Math.sin(phi);
        for (let i = 0; i < 3; i++) { const ai = A[i][p], bi = A[i][q]; A[i][p] = c * ai - s * bi; A[i][q] = s * ai + c * bi; }
        for (let i = 0; i < 3; i++) { const ai = A[p][i], bi = A[q][i]; A[p][i] = c * ai - s * bi; A[q][i] = s * ai + c * bi; }
        for (let i = 0; i < 3; i++) { const vi = V[i][p], bi = V[i][q]; V[i][p] = c * vi - s * bi; V[i][q] = s * vi + c * bi; }
      }
      let mi = 0; if (A[1][1] < A[0][0]) mi = 1; if (A[2][2] < A[mi][mi]) mi = 2;
      let ax = V[0][mi], ay = V[1][mi], az = V[2][mi];
      const am = Math.hypot(ax, ay, az); ax /= am; ay /= am; az /= am;
      if (ax < 0) { ax = -ax; ay = -ay; az = -az; }     // 强制 +X 分量
      if (Math.abs(ax) < 0.95) return;                    // 非近似沿 X 的轮几何，跳过
      const dot = ax;                                     // ax·(+X)
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (ang < 1e-4) return;                             // 已对齐
      // 旋转轴 = ax × X = (0, az, −ay)
      const ux = 0, uy = az, uz = -ay;
      const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
      const R = [
        t * ux * ux + c, t * ux * uy - s * uz, t * ux * uz + s * uy,
        t * ux * uy + s * uz, t * uy * uy + c, t * uy * uz - s * ux,
        t * ux * uz - s * uy, t * uy * uz + s * ux, t * uz * uz + c
      ];
      geometry.applyMatrix4(new THREE.Matrix4().set(
        R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1));
    }

    /* ── R47：外部轮「内外侧装反」修复（用户点名，几何定罪见 .qa/r47/geom_probe_out.txt）──
     * 定量证据：wheel-l(fl/rl) 内圈(r<0.045)面法线 nx>0.8、重心 x≈+0.025 ⇒ 轮毂正面
     *   朝 +x；wheel-r(fr/rr) 朝 −x。即 **GLB 几何本身正确**（左右轮毂面都朝各自车外）。
     * 根因：body 组带 rotY(π)（V800Adapter.ts:1826）⇒ hubWorld.x = −hubModel.x·scale；
     *   而 mountExternalWheel 的 desired = T(hubWorld)×S(scale) **不含这个刚性旋转**，
     *   轮几何的 +x 仍是世界 +x，与车身差 180° ⇒ 左右轮毂正面一起翻到车身内侧
     *   （用户截图 #27/#28：车底视角看到辐条朝车身中心、纯黑胎背朝车外）。
     * 修法：只把轮几何绕 Y 刚性旋转 π（x,z→−x,−z；法线同步；行列式 +1 ⇒ 绕序不变），
     *   使其与 body 组同朝向。零资产变更、零挂载矩阵变更、零自转影响 —— 轮 bbox 中心
     *   ≈(0,0,0)（已 hub 归中），旋转后仍居中；对称轴 X→−X 方向不变，spin 绕世界 X
     *   自转语义逐位保持；UV / tri / vtx / mesh 名全部不变。
     * QA 回滚：`#r47wheel=off` ⇒ 保持 R46 原状（A/B 唯一变量）。 */
    if (!/(?:^|[#&])r47wheel=off/i.test(
      typeof window === 'undefined' ? '' : window.location.hash
    )) {
      const rotated = new Set<THREE.BufferGeometry>();
      const r52WheelAxleOff = /(?:^|[#&])r52wheel=off/i.test(
        typeof window === 'undefined' ? '' : window.location.hash
      );
      for (const mesh of Object.values(wheelMeshes)) {
        if (rotated.has(mesh.geometry)) continue;
        rotated.add(mesh.geometry);
        // R52-A2 车轮轴心对齐（修「车轮轴心不稳」）：须先于 rotateY(π)，否则
        // 轴已被翻成 −X，最小旋转会绕轴转 180° 打偏辐条。
        if (!r52WheelAxleOff) alignWheelAxleToX(mesh.geometry);
        mesh.geometry.rotateY(Math.PI);
      }
    }

    // ── R44-6 语义部件（glass 透明 / lamp emissive）──
    // glass：深 tint 隐私玻璃（外景态程序化内饰恢复可见 = 透过玻璃看到内饰；
    // cabin 态随外壳整体隐藏，维持 R44 终解「整树切换」语义）。DoubleSide 让
    // 车内视角（极近距离）玻璃内面也有材质；depthWrite=false 防与内饰排序冲突。
    const glassMeshes: THREE.Mesh[] = [];
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b1016,
      transparent: true,
      opacity: 0.55,
      roughness: 0.06,
      metalness: 0,
      envMapIntensity: 1.6,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    /* ══ R51-B4 · 玻璃单次渲染（原 Phase 1 方案 C）══════════════════════════════
     * three 0.186.1 `WebGLRenderer.js:1364`（prepareMaterial）与 `:2165`
     * （renderBufferDirect）对 `transparent && DoubleSide && forceSinglePass===false`
     * 的材质每帧把 `material.side` 改 BackSide→FrontSide→DoubleSide 共 **4 次**
     * `needsUpdate=true` + 2 次 `getProgram`，并**分两遍完整递交**玻璃几何
     * （v800 glass 187,838 tri ×2，且每个 glassMesh 多 1 DC）。
     * `forceSinglePass = true` ⇒ 单遍 DoubleSide：省第二遍 tri + 每帧 4 次材质脏标记，
     * 不改 program 结构、不动 transparent/opacity、**不回 transmission**（R12 铁律⑤）。
     * 外景态 R47 已把玻璃 opacity 置 1（完全不透明）⇒ 单/双遍混合顺序逐位等价；
     * cabin 态 glass 被适配器隐藏 ⇒ 无影响。
     * ⚠ `glassMode==='solid'` 时 transparent=false ⇒ three 本就不分两遍，本开关无副作用。
     * ⚠ 审查线须目检玻璃观感（背面排序变化）后才最终放行（主理人裁决）。
     * 回滚：`#r51glasspass=off` ⇒ 逐位回 R50 两遍递交。
     */
    glassMat.forceSinglePass = R51_GLASSPASS_ON;
    // QA：#r44glass=off|solid 调透明策略（off=隐藏玻璃件 / solid=不透明）
    const glassMode = typeof window !== 'undefined'
      ? /[#&]r44glass=([a-z]+)/.exec(window.location.hash)?.[1] ?? null
      : null;
    if (glassMode === 'solid') {
      glassMat.transparent = false;
      glassMat.opacity = 1;
      glassMat.depthWrite = true;
    }
    collectNamed(glassGltf, glassMeshes, glassMode === 'off' ? null : glassMat, manifest.scale);
    // lamp-rear：刹车灯 emissive 随 brakeLevel（适配器 update() 驱动）
    // lamp-front：DRL 常亮冷白，setHeadlights 联动。
    let lampRearMat: THREE.MeshStandardMaterial | null = null;
    let lampFrontMat: THREE.MeshStandardMaterial | null = null;
    /** R48：R7 尾灯洞口盖板材质（唯一新增材质实例，dispose 显式释放） */
    let lampHousingMat: THREE.MeshStandardMaterial | null = null;
    /** R49-P2b：红细带材质（与 lampRearMat 拆开，避免改色连带灯组） */
    let r49BandMat: THREE.MeshStandardMaterial | null = null;
    /** R49-P2b：本波新增的材质/贴图账本（dispose 用；只登记 R49 自己新建的） */
    const r49DecorMats: THREE.Material[] = [];
    const r49DecorTex: THREE.Texture[] = [];
    /** R46：前灯最终是否挂了 emissiveMap（供 r44ShellStatus.lampMap 机读） */
    let hasLampMap = false;
    /** R53：前灯细节新增材质/几何（dispose 显式释放，防泄漏） */
    const r53DetailMats: THREE.Material[] = [];
    const r53DetailGeos: THREE.BufferGeometry[] = [];
    const lampRearMeshes: THREE.Mesh[] = [];
    const lampFrontMeshes: THREE.Mesh[] = [];
    if (lrGltf) {
      // R44-6 终版 + R46 保持：**去 map 纯 emissive** —— QA front34/rear34 实测
      // map=baseTex 时灯组 UV 区在源图集上是串色/暗区（前灯区橙色块显形 = 前脸
      // 「破面感」根因）。尾灯归位由几何线替换 lamp_rear.glb 完成，材质无需动。
      lampRearMat = new THREE.MeshStandardMaterial({
        color: 0x1a0505,
        /* R51-B1-a：荧光纯红 0xff1e14 → 官图深红 0x7a1f1a（主理人裁决「禁荧光红」）。
         * fresh 默认档 RED_bright=5738（门 ≤200）的根因就是这层高饱和 emissive 经
         * ACES 把 G/B 抬进饱和；改深红后亮红像素回落进 RED_deep（r≥70 且 r-g>25）
         * 而不再命中 RED_bright（r≥110 且 r>1.6g）⇒ 两项同时达标。
         * 与两 Adapter 的 ei clamp/系数同属 `#r51tail=off` 一个子项，可整体 A/B。
         * ⚠ 不改 color / 联动链结构 / brakeLevel 初值。 */
        emissive: new THREE.Color(R51_TAIL_ON ? 0x7a1f1a : 0xff1e14),
        emissiveIntensity: 0.35,
        roughness: 0.25,
        metalness: 0.1
      });
      collectNamed(lrGltf, lampRearMeshes, lampRearMat, manifest.scale);

      /* R48：R7 尾灯「空洞」补洞修复（用户口径：白块更深处其实是空洞）。
       * 定罪链（.qa/r48 + verify/r46/after/r48elim_*）：
       *  ① 消去法：隐藏 lamp_rear 白块 4,218 px 不变；隐藏 body 白块→376 px、
       *     红灯像素 6,037→18,883 ⇒ 白块长在 body 上，且 body 一直挡着红灯组。
       *  ② 离线深度（世界 Z，越大越靠车尾）：body 尾灯带 max 2.4942 m，
       *     R47 灯组 max 2.4811 m ⇒ 中段被挡 3.4 cm；两侧灯组虽略外但
       *     body 在洞口位置仍是破面 ⇒ 用户看到的「空材质」实为剔除灯组后
       *     body 未补齐的洞，深层内容透出，high 档 bloom 下吹成纯白。
       * 修法（零 GLB 改动）：① 加一块深色灯罩盖板封住 body 洞口；② 灯组外推
       *   0.06 m 压到盖板之前；③ 贯穿红细带压最外层。
       *   （只外推 0.025 m 实测 A/B 仅 634 px，洞在灯组旁边，平移盖不住。）
       *   ⚠ mesh.scale 只缩放几何顶点、不缩放 position（R47 铁律）：
       *     body 局部 z = −0.025，经 body.rotation.y=π 后世界 +0.025 m。
       *   再补一条贯穿红细带（R47 灯组中段仅 1,412 tri，中部仍是黑横带）。
       * 回滚：`#r48hole=off` ⇒ 不外推、不加红带，逐位回到 R47 原状。 */
      if (car === 'r7' && lampRearMat &&
          !/(?:^|[#&])r48hole=off/i.test(
            typeof window === 'undefined' ? '' : window.location.hash
          )) {
        const s = manifest.scale;
        /* ══ R49-P2b：盖板 / 红细带 / 下缘反光条重做（尺寸与 z 全部来自射线实测）══
         * 定罪见 `.qa/r49/PHASE2B_DIAG.md` §三（探针 `tools/r49_rear_probe.mjs`）：
         *  ① **主因 = 盖板 z 比 body 最外层还深 14.4 mm ⇒ 被 body 自遮挡**
         *     r7: bodyBBox.max[2]=0.582810 × scale 4.323 = **2.5194 m**（世界最外层），
         *     而 R48 盖板在 2.505 m ⇒ 差 −14.4 mm。工单要求的「body 最外层 + 8~12 mm」
         *     应为 2.527~2.531 ⇒ 取 **bodyMaxZ + 0.010**。
         *  ② 次因 = 高度不足：R48 `PlaneGeometry(2.02, 0.20)`（中心 y=1.0375）只覆盖
         *     y∈[0.9375,1.1375]；射线实测白块世界 y∈[**0.893**, 1.089] ⇒ 底边高 44.5 mm
         *     露白。改为高 **0.34 m**、中心 **1.015**（覆盖 y∈[0.845,1.185]，上下各 ~45 mm 余量）。
         *     （工单按像素比例估的 0.51 m 偏大：实测白块世界高度 0.197 m。）
         *  ③ 射线次命中 7/24 = `batch/leather-ivory` ⇒ 洞后是米黄内饰，印证「补洞」方向。
         * 启用：`#r49hole=on` ⇒ 尺寸/z 逐位为 R49 盖板（0.34 / 1.015 / z=-(bodyMaxZ+0.010)）；**默认关闭**走 R48。
         * ⚠ 旧口径下盖板命中率仍有 5/24（它确实在最前）——所以不是「完全无效」，
         *   只是**边缘一圈没盖住**，正是 bloom 最容易吹白的位置。 */
        /* ⚠ R49-P2c 收口裁决：**默认不启用** R49 盖板（回归 R48 已验收观感）。
         *   rubric 证实材质/atlas 压暗对白噪点**零效果**（逐位 3383/1842/515/853）——白噪点是 body
         *   洞/灯组的 **UV 串味灰白**（在盖板之外，运行时改不动），必须回 bake 管线重映射 UV（R50）。
         *   而黑板盖板又**左右超出车身轮廓悬空**、比 R48 的白块更违和 ⇒ 强改是负收益。
         *   ⇒ 默认走 R48 分支（盖板 z=2.505 被遮挡，不显示黑板）；R50 修 UV 后用 `#r49hole=on` 启用。
         *   全部 R49 盖板/atlas/材质代码**保留不删**，便于 R50 一键启用。 */
        /* R49-P2c 原裁决「默认关闭盖板」在 R51-B1-c 由主理人改写：R51 默认启用
         * 收窄版盖板，`#r51band=off` ⇒ 逐位回 R48/R50。
         * ⚠ `|| R51_BAND_ON` 只改这一个布尔值，所有 `r49Hole ? A : B` 的既有参数
         *   字符串逐字保留（r48_lamp.test.ts / r49_visual.test.ts 的源码契约钉着，
         *   禁止把变量名换成 r49Hole 之类）。 */
        const r49Hole = /(?:^|[#&])r49hole=on/i.test(
          typeof window === 'undefined' ? '' : window.location.hash
        ) || R51_BAND_ON;
        /* ══ R51-B1-c · 盖板启用与贴合（默认开，回滚 `#r51band=off`）════════════
         * R49-P2c 曾裁定「默认不启用 R49 盖板」：黑板 `PlaneGeometry(2.02,0.34)`
         * 左右超出车身轮廓悬空，比 R48 白块更违和。主理人本波给出的直接修法是
         * **把盖板收窄 ×0.90（2.02→1.818，clamp [1.70,1.86]）** + z 落
         * `bodyMaxZ+0.010` + 保持 rough .70 / metal .06 / env .45（metal .35/rough .35
         * 会把 PMREM 天空整面反射，纯白 273→3383）。
         *   · 默认（无 hash）：r49Hole=true ⇒ 启用收窄盖板 + R51 深红 atlas；
         *   · `#r51band=off`：r49Hole=false ⇒ 逐位回 R48/R50 默认；
         *   · `#r49hole=on`（旧钩子，语义保留）：r49Hole=true，且 R51_BAND_ON=false
         *     时 atlas 内部走 R49 原绘制、且不收窄 ⇒ 逐位复现 R49 观感。
         * ⚠ 不改几何拓扑：仍是 housing + band 两块 mesh，额外 DC = 0。 */
        const r51Band = R51_BAND_ON;
        /* ⚠ R49-P2c：**几何回退 v1**（盖板宽 2.02 + z=-(bodyMaxZ+0.010)，bodyMaxZ 用 manifest×scale）。
         *   v2 那版「lampMaxZ 反推 + 实测收窄」导致覆盖面积不足——两侧露出更多白/米黄
         *   （rubric：WHITE 3383→4322、BEIGE 853→1448、最大连通域 1842→2323，全部变差），
         *   按主理人裁决**回退几何覆盖**，**只保留 v2 的 atlas/材质压暗**（那些只会更好）。
         *   教训：bodyMaxZ 用 manifest×scale=2.5194 时 z 落 2.5294，恰好压住洞区；改用实测反推落 2.535
         *   反而把盖板整体上移、下沿离开洞区顶部（y≈1.185）而露白。 */
        const bodyMaxZ = (manifest.bodyBBox?.max?.[2] ?? 0.5828) * s;
        const coverY = r49Hole ? 1.015 : 0.240 * s;
        const coverH = r49Hole ? 0.34 : 0.20;
        lampHousingMat = new THREE.MeshStandardMaterial({
          color: r49Hole ? 0x141418 : 0x101014,
          // R51：函数内部按 R51_BAND_ON 选深红细带版；`#r51band=off` 用 R49 原版
          // ⚠ 无参签名逐字保留（r49_visual.test.ts 源码契约钉着）
          map: r49Hole ? (makeR7RearBandAtlas() ?? undefined) : undefined,
          emissive: new THREE.Color(0x1a0000),
          emissiveIntensity: 0.2,
          /* R49-P2b 实测：平板 + metal .35/rough .35 会把 PMREM 天空**整面镜面反射**进来，
           * ROI 纯白 273 → 3,383 px。压到 metal .06 / rough .70 / envInt .45（v2 保留项）。
           * R51-B1-c 沿用这组「压暗三件套」，不改数值。 */
          roughness: r49Hole ? 0.70 : 0.5,
          metalness: r49Hole ? 0.06 : 0.1,
          envMapIntensity: r49Hole ? 0.45 : 1,
          side: THREE.DoubleSide
        });
        const housing = new THREE.Mesh(
          new THREE.PlaneGeometry(2.02, coverH), lampHousingMat);
        housing.name = 'lamp_rear_housing';
        /* R51-B1-c：收窄 ×0.90 ⇒ 2.02→1.818，clamp [1.70,1.86]（主理人 §7.3 精确值）。
         * ⚠ `mesh.scale` 只缩放几何顶点、不缩放 position（R47 铁律）；rotY(π) 后
         *   对称宽度不受朝向影响。不改 PlaneGeometry 顶点 ⇒ 几何/UV/tri 逐位不变。 */
        if (r51Band) {
          housing.scale.x = Math.min(1.86, Math.max(1.70, 2.02 * 0.90)) / 2.02;
        }
        housing.position.set(0, coverY, r49Hole ? -(bodyMaxZ + 0.010) : -2.505);
        housing.rotation.y = Math.PI;
        housing.castShadow = false;
        housing.renderOrder = 1;
        lampRearMeshes.push(housing);
        // ② 灯组外推 0.06 m（R48 已验收，逻辑不动）
        for (const m of lampRearMeshes) {
          if (m.name === 'lamp_rear') m.position.z = -0.06;
        }
        // ③ 贯穿红细带：高 0.018、色 #5A1E1E、emissiveIntensity 0.35，z=-(bodyMaxZ+0.021)（回退 v1）
        r49BandMat = r49Hole
          ? new THREE.MeshStandardMaterial({
              color: 0x1a0505,
              emissive: new THREE.Color(0x5a1e1e),
              emissiveIntensity: 0.35,
              roughness: 0.35,
              metalness: 0.2,
              side: THREE.DoubleSide
            })
          : lampRearMat;
        const band = new THREE.Mesh(
          new THREE.PlaneGeometry(1.86, r49Hole ? 0.018 : 0.055), r49BandMat);
        band.name = 'lamp_rear_band';
        band.position.set(0, r49Hole ? 1.13 : 0.240 * s, r49Hole ? -(bodyMaxZ + 0.021) : -0.5885 * s);
        band.rotation.y = Math.PI;
        band.castShadow = false;
        band.renderOrder = 2;
        lampRearMeshes.push(band);
        /* ④ 下缘红反光条 —— **本轮下线**（代码保留在 makeR7LowerReflectorAtlas）。
         * 原因（.qa/r49/probe_v4/v5.log 实测）：该件是 `transparent+alphaTest` 的
         * 1.90m×0.055m 平面，实测 ROI 纯白 273 → **3,383 px**，白增量面积≈434×6 px
         * ≈ 整块反光条平面的投影面积 ⇒ 在 headless/SwiftShader 下这张 canvas 的
         * **alpha 未被正确采样**，整块平面按不透明白渲染。它比它要遮的东西更糟，
         * 故本波先移除；待 landing-review 在真实 GPU 上确认 alpha 通道行为后再启用。
         * 保留 `#r49hole=off` 与下方注释，避免下一位同学重复踩。 */
      }
    }
    if (lfGltf) {
      lampFrontMat = new THREE.MeshStandardMaterial({
        color: 0x0a0c10,
        /* R51-B3（H5 运行时快修，主理人允许「时间紧可只做数值」）：
         * `lamp_front_atlas.png` 两车均缺失 ⇒ 纯 emissive `0xcfe0ff`@0.7 是
         * V800 两侧淡蓝矩形灯区 + R7 前灯「一片白」的根因（与 body 材质链路无关）。
         * 冷蓝→中性灰蓝 0x9aa6b4、强度 0.7→0.18（审查线 §7.3 精确值，勿自行调参）。
         * ⚠ 构造初值会被两 Adapter 的 update() 每帧覆盖 ⇒ 联动公式必须同步降级。
         * ⚠ 不做 onBeforeCompile / 深度灯语结构（R46 atlas 错位黑腔教训）；
         *   中央「蓝水滴徽标」在运行时无独立几何（grep 零命中），属资产层，本波不动。
         * 回滚 `#r51lamp=off` ⇒ 逐位回 R50。 */
        emissive: new THREE.Color(R51_LAMP_ON ? 0x9aa6b4 : 0xcfe0ff),
        emissiveIntensity: R51_LAMP_ON ? 0.18 : 0.7,
        roughness: 0.2,
        metalness: 0.15
      });
      /**
       * R46 前灯贴图接线（用户点名「前车灯贴图一片白色」）。
       * 选 **emissiveMap** 而非 map：本材质 color 近黑、亮度几乎全部来自均匀的
       * `emissive=0xcfe0ff`，挂 map 只改 diffuse、emissive 仍均匀 ⇒ 一片白照旧；
       * emissiveMap 直接按裁片 RGB 调制发光（非灯区黑 ⇒ 不发光），才真正显出灯区细节。
       * 且不设 transparent/alphaTest ⇒ 不引入新的透明排序与额外 draw call
       * （R12 铁律⑤：玻璃走 transparent alpha，灯组不碰 transmission）。
       * `flipY=false` + SRGBColorSpace 由 loadTexture 保证；UV 已由几何线逐三角重打包。
       * 图集缺失/加载失败时 lampAtlasTex=null ⇒ 维持纯 emissive，优雅降级。
       *
       * R46 回退开关：`#r46lampmap=off` ⇒ 强制不挂（纯 emissive，R44 原行为）。
       *   适用：atlas 亮片与灯区 UV 错位导致「黑腔」（v800 灯区采样命中率仅 2.0%）。
       *   仅在 atlas 已成功加载后参与判断；atlas 缺失仍走上面的 `.catch(()=>null)` 降级。
       *   回退时 `emissiveMap = null` + `needsUpdate`，其余材质属性与联动**一律不动**。
       */
      hasLampMap = lampAtlasTex != null && !lampMapDisabled();
      if (hasLampMap) {
        lampFrontMat.emissiveMap = lampAtlasTex;
        lampFrontMat.needsUpdate = true;
      }
      collectNamed(lfGltf, lampFrontMeshes, lampFrontMat, manifest.scale);
      // R53：前灯 DRL+透镜程序化细节（挂 lamp mesh 下，+2 DC/车；`#r53lampdetail=off` 回滚）
      if (lampFrontMeshes.length > 0) {
        r53BuildLampDetail(lampFrontMeshes[0], car, r53DetailMats, r53DetailGeos);
      }
    }

    let currentVariant = variant;
    const handle: ExternalShellHandle = {
      car,
      manifest,
      bodyMesh,
      wheelMeshes,
      brakes,
      wheelRadius: manifest.wheelRadius,
      glassMeshes,
      lampMeshes: [...lampRearMeshes, ...lampFrontMeshes],
      lampRearMat,
      lampFrontMat,
      get variant() {
        return currentVariant;
      },
      async setVariant(variantId: string): Promise<boolean> {
        if (variantId === currentVariant) return true;
        // R60 P0-1：程序化车漆路径无 map，变体切换 = 改 color/metalness/roughness（零贴图加载）
        if (useProcPaint) {
          const pp = R60_PROC_PAINT[variantId];
          if (!pp) return false;
          material.color.setHex(pp.color);
          material.metalness = pp.metalness;
          material.roughness = pp.roughness;
          material.needsUpdate = true;
          currentVariant = variantId;
          r44ShellStatus[car] = { state: 'ready', variant: variantId };
          return true;
        }
        const url = urls.basecolor[variantId];
        if (!url) return false;
        try {
          // 变体切换发生在加载完成之后，无在途 signal（不传第 4 参）
          const tex = await loadTexture(url, true, car);
          const old = material.map;
          material.map = tex;
          material.metalness = VARIANT_METALNESS[variantId] ?? material.metalness;
          material.needsUpdate = true;
          // R44-6 终版：灯组纯 emissive 无 map，变体切换无需同步（map 已移除）
          old?.dispose();
          currentVariant = variantId;
          r44ShellStatus[car] = { state: 'ready', variant: variantId };
          return true;
        } catch (err) {
          r44ShellStatus[car] = {
            state: 'ready',
            variant: currentVariant,
            error: `variant ${variantId} failed: ${String(err)}`
          };
          return false;
        }
      },
      setGlassOpaque(opaque: boolean): void {
        if (glassMode === 'solid' || glassMode === 'off') return; // QA A/B 钩子优先
        const next = opaque ? 1 : 0.55;
        if (glassMat.opacity === next) return;
        glassMat.opacity = next; // transparent 恒 true ⇒ 0.55→1 完全覆盖后方内饰
      },
      dispose(): void {
        bodyMesh.geometry.dispose();
        for (const mesh of Object.values(wheelMeshes)) mesh.geometry.dispose();
        for (const mesh of [...glassMeshes, ...lampRearMeshes, ...lampFrontMeshes]) {
          mesh.geometry.dispose();
        }
        glassMat.dispose();
        lampRearMat?.dispose();
        lampFrontMat?.dispose();
        lampHousingMat?.dispose();
        // R49-P2b：本波新增的材质与贴图（避免新增实例泄漏）
        if (r49BandMat && r49BandMat !== lampRearMat) r49BandMat.dispose();
        for (const m of r49DecorMats) if (m !== r49BandMat) m.dispose();
        for (const t of r49DecorTex) t.dispose();
        // R53：前灯细节材质/几何（合并 mesh 由 child 自动随 lamp 释放，几何显式释放）
        for (const m of r53DetailMats) m.dispose();
        for (const g of r53DetailGeos) g.dispose();
        // R54：贯穿镀铬条材质/几何
        for (const m of r54TrimMats) m.dispose();
        for (const g of r54TrimGeos) g.dispose();
        // R55：红旗徽标材质/几何
        for (const m of r55BadgeMats) m.dispose();
        for (const g of r55BadgeGeos) g.dispose();
        // R58：车尾 MAEXTRO 镀铬带+字标材质/几何（含 CanvasTexture，随 map 释放）
        for (const m of r58RearMats) m.dispose();
        for (const g of r58RearGeos) g.dispose();
        // R61：车身侧面贯穿镀铬条材质/几何
        for (const m of r61SideMats) m.dispose();
        for (const g of r61SideGeos) g.dispose();
        // R62-P0-1：wheel-alloy + 刹车盘/卡钳材质（几何挂进 spin 子树，随轮 mesh 一并释放）
        for (const m of r62BrakeMats) m.dispose();
        for (const g of r62BrakeGeos) g.dispose();
        lampAtlasTex?.dispose();
        material.map?.dispose();
        material.normalMap?.dispose();
        material.roughnessMap?.dispose();
        material.metalnessMap?.dispose();
        material.dispose();
      }
    };
    r44ShellStatus[car] = {
      state: 'ready',
      variant,
      tri: manifest.tri?.body ?? undefined,
      bytes: shellBytesByCar[car],
      // R46：QA 探针机读「前灯是否挂了图集」（false = 纯 emissive 回退）
      lampMap: hasLampMap
    };
    shellHud('高精度车模已就绪', 'ok');
    globalThis.setTimeout(() => shellHud(null), 4000);
    return handle;
  } catch (err) {
    if (ac.signal.aborted || isShellLoadCancelled()) {
      // 取消 ≡ 既有失败回退：返回 null ⇒ 适配器 `if (!shell) return` 保持程序化外观
      r44ShellStatus[car] = {
        state: 'cancelled',
        error: `cancelled by ${shellCancelReason() ?? 'user'}`,
        bytes: shellBytesByCar[car]
      };
      shellHud('已停止下载高精度模型 · 当前使用默认车模', 'ok');
      return null;
    }
    r44ShellStatus[car] = { state: 'failed', error: String(err), bytes: shellBytesByCar[car] };
    shellHud(`高精度车模加载失败，当前显示简化外观 · ${String(err).slice(0, 90)}`, 'err');
    console.warn(`[ExternalShell] ${car} 装载失败，保持程序化外观：`, err);
    return null;
  } finally {
    clearHudThrottle();
    if (shellAbort === ac) shellAbort = null;
    unsubscribe();
  }
}
