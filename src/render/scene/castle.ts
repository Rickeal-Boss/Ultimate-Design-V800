/**
 * 白城堡（哥特式白石大教堂）+ **可行驶御桥** 场景装配层 —— 材质 + 安放 + 预算统计。
 *
 * ── R27 架构（2026-10-23，依据 FBX 实测 `.qa/r27_measure.md` + 三张官方渲染图）──────
 * R26 版是「尖拱拱廊长廊 + 双侧大教堂 + 远景塔尖」的旧设想，与外包交付参考图不同。
 * R27 按实测重建：① 御桥（24 跨双心尖拱 + 2.2m 金顶栏板 + 火盆灯柱 + 三带铺装）；
 * ② 城门楼（20×30 尖拱门洞 + 双塔墩 + 三层金券 + 金饰圆盘）；③ 城内大街。
 * 全部构件在 castleKit.ts 里**直接产世界坐标几何**，本类只做：按材质族归桶 →
 * 每族 merge 成 1 mesh -> 统计。
 *
 * ── DC 策略（R32 C-4 核对：实测 27 / 设计上限 28 ≤ castleDc 32）────────────────
 *   分区合批后每「非空区」1 DC：ashlar ≤6 + wall ≤3 + gold ≤6 + dark ≤6（dark z0
 *   实测空：门洞暗件全在 z1 以深）+ flame 1 + 四可选桶 ≤4 + 铺装 2 = **27**。
 *   ⚠ R31 头注「ashlar/wall/gold/dark/flame 各 1 ⇒ 7 DC」与「gold/dark/flame 各 1
 *     ⇒ 18」都是**过期读数**：R29 点亮四可选桶、R31「治理①延伸」把 gold/dark 也改为
 *     6 区合批后均未回填头注。逐 mesh 实证清单见 `.qa/r32_tmp_audit/dc_audit.md`；
 *     代码侧逻辑（splitByZone/emptyBuckets 语义）本身正确，本轮只修注释。
 *
 * ── R31 运行时治理①：按世界 z 分区合批（「700m 长条永不被剔除」的根治）──────
 *   改前：每族 merge 成 **1 个**横跨 z=+60..−1430 的巨 mesh ⇒ 包围球直径 700m，
 *   行车时几乎恒与视锥相交 ⇒ 视锥剔除完全失效，全城几何每帧都提交（整帧 321k tri）。
 *   改后：ashlar/gold/dark 分 6 区、wall 分 3 区（见 ZONE_EDGES_*），每区一个 mesh；
 *   量小的 flame/四可选桶保持全局 1 个（铺装是道路本体，必须全段可见）。
 *   ⇒ castle 静态 DC 7 → **27**（四桶全亮 + gold/dark 分区后，设计上限 28），
 *   但**可见 tri 大降**（剔除生效）。
 *   这是「用少量 DC 换大量顶点/填充」的交易，判据是可见 tri 而不是静态 DC
 *   （R31_BUDGET.castleDc 已按分区后口径抬到 32）。
 *   跨区几何按 **bbox z 中值**归区，不切割单个几何（A 线构件基本都落在单区内）。
 *
 * ── R32 运行时治理③：远档 LOD（C-5 主项：同 mesh 换 geometry，DC 不变）────────
 *   距离显隐（治理②）只能整区摘除，摘不掉「前方 2~3 个区」的高档几何 ⇒ 中段可见
 *   tri 曾达 318k（同树治理前实测，目标 ≤120k 诉求 / ≥25% 降幅硬指标）。R32 给
 *   zone mesh 加远档：
 *   · 近区（<LOD_NEAR_DIST 400m）用 high 全装饰几何；远区换 low「只主体」几何
 *     （铁律 33：low 只降装饰密度；400m 处高低档差异已降到亚像素 ⇒ 换档不可见）；
 *   · 远档几何由**第二遍工厂重跑**（setDetailLevel(true)）按同套 ZONE_EDGES 分区
 *     merge 产出（buildFarTier），high 档才建（low 档城堡无二变体收益）；
 *   · **同一 mesh 换 geometry 引用** ⇒ 不新增 mesh、静态 DC 仍 27、全显口径
 *     （getCastleStats.tris）仍按高档计（两档互斥不同画，见 r31Budget.ts 台账①）；
 *   · 换档带 20m 滞回（LOD_HYSTERESIS），与观看者滞回带同量级，边界不抖。
 *   实测（六点采样，.qa/r32_tmp_audit/visibletri_audit.md）：治理前（同树）
 *   222k/222k/318k/266k/178k/83k ⇒ 治理后 98k/160k/181k/181k/172k/83k。
 *
 * ── R30 纹理热升级（B2 / 启动阻塞 N1）────────────────────────────────────
 * 构造期所有石材族用 `castleTexSyncSize`（256²）**同步上架**（high 档实测同步段
 * ~300ms，其中贴图仅 ~50ms），`scene.add` 后按 `stoneTextureSize(kind,tier)` 的
 * **目标尺寸**发起 requestIdleCallback 分片重烘；完成后**热替换**三张贴图 +
 * 按目标尺寸 roughMean 重算 material.roughness（铁律 34：effective≈target 不漂）。
 * 材质对象 / mesh / DC 全程不变；同步代与目标代两代纹理都在 dispose 时释放。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { makeStoneMaps, stoneTextureSize, bakeStoneMapsAsync, disposeStoneCache, retireStoneMaps } from './stoneTexture';
import type { StoneKind, StoneMaps, StoneBakeHandle, StoneChannels } from './stoneTexture';
import type { QualitySettings } from '../../config/quality';
import {
  setDetailLevel,
  makeViaduct,
  makeParapet,
  makePaving,
  makeLamps,
  makeGate,
  makeTowerGroup,
  makeMainHall,
  makeInnerCity
} from './castleKit';
import type { StoneBuckets } from './castleKit';

/** QA 口径：tri 按已装配几何计；dc 按"每个 mesh 一次"计 */
export interface CastleStats {
  tris: number;
  dc: number;
}

function triCount(geo: THREE.BufferGeometry): number {
  const index = geo.getIndex();
  return (index ? index.count : geo.getAttribute('position').count) / 3;
}

/**
 * R32 C-4：该几何是否**值得一枚 draw call**（≥1 个三角面）。
 * 为什么要有它：建桶语义是「空区不占 DC」（`addMerged` / `addMergedByZone` 的
 * `parts.length === 0` 早退 + `zones[i].length === 0` 跳过），但那只挡了「零个几何」
 * 这一种空；还有第二种空 —— 区里有几何、merge 后却是**零面**（退化 BufferGeometry
 * 或全被密度开关裁净）。改前第二种会产出「看不见却占一个静态 DC」的幽灵 mesh，
 * 还会把不存在的东西算进 `getCastleStats().dc`，让注释与实测再次分家（正是 C-4
 * 这次审计的根因类型）。
 * 当前 tree 无此情形（`.qa/r32_tmp_audit/dc_audit.md` 逐 mesh 实测最小面数 =
 * pave-walk 4 > 0）⇒ 本判定为**只读护栏**，不改变现有数字，由
 * `tests/r32_zone.test.ts` 的「castle 下每个 mesh tri > 0」断言盯住。
 */
function isDrawable(geo: THREE.BufferGeometry): boolean {
  return triCount(geo) > 0;
}

/** 释放一套三张贴图（热升级退役代 / 取消代共用） */
function disposeMaps(maps: StoneMaps): void {
  maps.map.dispose();
  maps.normalMap?.dispose();
  maps.roughnessMap?.dispose();
}

/* ─────────────────────── 材质 ─────────────────────── */

/**
 * R29 新族桶（roof / wood / glass / marble）。
 * `castleKit.ts` 归环境线（本轮白名单外，只读），故按**可选键**防御式读取：
 * castleKit 一旦补上 `b.roof.push(...)`，下一帧自动点亮；补桶前桶空 ⇒ 不建 mesh、不占 DC。
 */
const EXTRA_BUCKETS = ['roof', 'wood', 'glass', 'marble'] as const;
type ExtraBucket = (typeof EXTRA_BUCKETS)[number];

/* ─────────────────── R31 z 分区合批 ─────────────────── */

/**
 * 分区边界（**降序**；n+1 个边界 ⇒ n 个区）。世界坐标，工厂车头 +Z。
 * 取值依据 R31 基线地形与建筑分布（.qa/r31_test/r31_geo_probe.json）：
 *   御桥/门楼 z≈+60..−340（桥 24 跨 + 门楼塔群）｜内城大街 −340..−1470（每街区 80m 一拍）
 * 6 区按「每区 ≈2~4 个街区」切，单区跨度 ≤300m ⇒ 行车时后方 2~3 个区可被剔除。
 */
const ZONE_EDGES_6 = [60, -340, -460, -760, -1060, -1290, -1470] as const;
/** wall 桶只有 3 区（远景剪影带是整条长盒，切太碎没有收益，反增 DC） */
const ZONE_EDGES_3 = [60, -460, -1060, -1470] as const;
type ZoneEdges = readonly number[];

/**
 * R31 运行时治理②：分区 mesh 的**观看距离显隐**。
 * 为什么需要它：御桥大道是一条 1500m 直线走廊，chase/cabin 机位沿长轴看向 −Z，
 * 真实相机 far=12000 ⇒ 正前方整条走廊恒在视锥内，视锥剔除只能剔「已驶过」的区
 * （B 线实测：入口/中段可见 tri = 全城 356k，只有深段 −1300 才降到 78k）。
 * 按观看者 z 与各区中心的距离整体开关区 mesh：
 *   · 阈值触发（观看者移动 <20m 不重算）⇒ 每帧仅一次减法+比较，零遍历开销；
 *   · 只动 visible，不销毁几何 ⇒ 驶近无重建成本、无 GC 抖动；
 *   · 区显隐**不参与** getCastleStats（装配期口径）⇒ 预算测试不受动摇；
 *   · 非分区 mesh（铺装/火盆/extras）不受影响 —— 铺装是道路本体，必须全段可见。
 * R32 C-5：750 → **650**（门楼可见性已评估，见下）。650m 依据：
 *   · 城门楼（z≈−358.5）+ 塔群（clockH 98）在 z0/z1：从起步（cam≈+8，距门楼
 *     中心 ≈410m）到驶过门楼 650m 全程在带内；驶过 650m 后门楼在车后 ⇒ 视锥外，
 *     无观感损失。⇒ 门楼可见性不受影响（曾评估的 650 风险点排除）。
 *   · 弹入点随之内移 100m（主殿 z5 中心 −1373：−623 → −723 处弹入）。这是
 *     650 制的净成本：主殿（130m 高）弹入时张角 ≈11°，滞回 20m 只防闪烁、
 *     不防弹入本身。取舍依据：R31 的 750 制本就接受同级弹入（750m 处 ≈10°），
 *     且雾极轻（FogExp2 12e-5 ⇒ 650m 处仅 0.6%）不提供遮蔽；不收紧则中段 −500
 *     降幅只有 17~18%（R=750+LOD400 实测 208k），达不到 C-5 的 ≥25% 硬指标。
 *   · 弹入顺序保持「由近及远」连贯：z4（−523 弹入）先于 z5（−723），街道剖面
 *     不会出现「远处主殿可见、中间街区开天窗」的断裂。
 */
const ZONE_VIEW_RANGE = 650;
/** 观看者 z 滞回带：少于该位移不重算显隐（机位微抖/环绕摆动不触发闪烁） */
const ZONE_VIEW_HYSTERESIS = 20;

/**
 * R32 C-5：远档 LOD 的**近/远切换距离**（区中心 ↔ 观看者）。
 * 400m 依据：low 档裁掉的是卷叶（≈0.3m）/窗棂/子拱/立像/瓶柱密度这类「纯装饰」，
 * 0.3m 物体在 400m 处 ≈0.43px（1080p / fov55° 下 19.6px每度）⇒ 高低档差异在切换
 * 点已降到亚像素，换档本身不可见；主体几何（墙身/拱/塔/金带 ≥0.5m）两档都保留。
 * ⚠ 再压低（<350m）中段收益不变（近区仍须高档）而边界处差异开始可辨，不取。
 */
const LOD_NEAR_DIST = 400;
/** 档位滞回：> D+20 才换远档、< D−20 才换近档，380~420 带内保持原档（防摇摆） */
const LOD_HYSTERESIS = 20;

/**
 * 几何归区：**世界 bbox 的 z 中值**（跨区几何按中心点归区，不切割单个几何）。
 * 越界的极端值夹到首尾区（NaN/空几何一律回 0 区）。
 */
export function zoneIndexOf(geo: THREE.BufferGeometry, edges: ZoneEdges): number {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return 0;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  if (!Number.isFinite(cz)) return 0;
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (cz <= edges[i] && cz > edges[i + 1]) return i;
  }
  return cz > edges[0] ? 0 : edges.length - 2;
}

/** 把一批几何按 z 摊进各区的桶里（空区不建 mesh、不占 DC） */
function splitByZone(parts: THREE.BufferGeometry[], edges: ZoneEdges): THREE.BufferGeometry[][] {
  const zones: THREE.BufferGeometry[][] = [];
  for (let i = 0; i < edges.length - 1; i += 1) zones.push([]);
  for (const g of parts) zones[zoneIndexOf(g, edges)].push(g);
  return zones;
}

/**
 * 各族的**目标有效粗糙度**（effective = material.roughness × roughnessMap.g）。
 * ⚠ 铁律 34：贴图里写的是绝对粗糙度，material.roughness 必须按 `target / ḡ` 反算。
 */
const TARGET_ROUGH: Record<StoneKind, number> = {
  ashlar: 0.86,
  wall: 0.9,
  floor: 0.9,
  rock: 0.95,
  gold: 0.42,
  roof: 0.7,
  wood: 0.78,
  glass: 0.12,
  marble: 0.24
};

/** 各族的 metalness / envMapIntensity / 额外开关 */
const FAMILY_METAL: Record<StoneKind, number> = {
  ashlar: 0,
  wall: 0,
  floor: 0,
  rock: 0,
  gold: 0.85,
  roof: 0,
  wood: 0,
  // R31：0.06 → 0。玻璃是电介质，three 的 PBR 对 dielectric 已给 F0=0.04 的菲涅耳，
  // 再叠 metalness 会把 albedo 染色（metal 的 F0 走 albedo），彩窗会发灰。
  // 掠射角的「玻璃感」交给 envMapIntensity 1.7 + roughness 0.12 的锐利环境反射。
  glass: 0,
  marble: 0
};

const FAMILY_ENV: Record<StoneKind, number> = {
  ashlar: 0.85,
  wall: 0.75,
  floor: 0.15,
  rock: 0.7,
  gold: 1.4,
  roof: 0.7,
  wood: 0.5,
  glass: 1.7,
  marble: 0.9
};

/**
 * R31 各族的 **法线强度**（material.normalScale）。
 * R29 给 0.55 是因为当时判「缝深了 = 深雕砖墙」。R31 参考图复判：墙是 **0.45m 小砌块 +
 * 明显灰缝**，审查线实测缝梯度 p95 0.16~0.23 vs 基线 0.136（−40%）⇒ 缝必须更清晰。
 * 故砌体族抬回 0.85（砌块小了，缝在屏幕上更密，法线再压就是糊成一片）。
 * 抛光族（marble/玻璃）本来就是平的，normalScale 走 1.0 也只是把细微浮雕托出来。
 */
const FAMILY_NORMAL_SCALE: Record<StoneKind, number> = {
  ashlar: 0.85,
  wall: 0.85,
  floor: 0.8,
  rock: 0.9,
  gold: 0.7,
  roof: 1.0,
  wood: 1.0,
  glass: 1.0,
  marble: 1.0
};

/**
 * R31 各族的 **风化度（weather）**，取用前先归并到 ≤3 档（WEATHER_STEPS）。
 * ⚠ 改这里之前先看铁律 35：weather 是 `makeStoneMaps` 缓存键的一部分
 * （kind|size|seed|weather|repeat）——相近的 0.01 级差异会多产一整套三张贴图，
 * 这正是「25 张」的成因之一。故一律先量化再取族。
 */
const FAMILY_WEATHER: Record<StoneKind, number> = {
  ashlar: 0.35,
  wall: 0.5,
  floor: 0.4,
  rock: 0.35,
  gold: 0.3,
  roof: 0.35,
  wood: 0.55,
  glass: 0.35,
  marble: 0.35
};

/** R31 weather 归并档位（≤3 档）：0.35 = 常规 / 0.5 = 较旧 / 0.65 = 重风化 */
const WEATHER_STEPS = [0.35, 0.5, 0.65] as const;

/** 把任意 weather 吸到最近的档位（两档等距时取小值，保持常规档优先） */
export function quantizeWeather(weather: number): number {
  let best: number = WEATHER_STEPS[0];
  let bestD = Math.abs(weather - best);
  for (const s of WEATHER_STEPS) {
    const d = Math.abs(weather - s);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * R31 贴图数量治理②：次要族**共享主角族的族实例**（kind → 实际取贴图的族）。
 * wall 与 ashlar 在参考图里是**同一种白石砌体**（差别只在抛光与远近），共享一套
 * 3 张贴图，再用 `FAMILY_COLOR` 把 wall 压回 R29 实测的灰白色阶（wall L 175.7 vs
 * ashlar 198.7 ⇒ 线性 ×0.72）。⇒ 净省 3 张贴图，且远景剪影带与近景墙的缝节奏一致。
 */
const FAMILY_ALIAS: Partial<Record<StoneKind, StoneKind>> = { wall: 'ashlar' };

/**
 * 共享族的分色乘子（THREE 的 color 是线性乘子，这里的十六进制是 sRGB 写法）。
 * 只给共享族用；自有族一律 0xffffff，避免把 R29 吸色的色阶再改一道。
 */
const FAMILY_COLOR: Partial<Record<StoneKind, number>> = { wall: 0xdddddd };

/**
 * R31 贴图数量治理③：各族的**通道预算**（按**贴图族** texKind 取，使 wall 别名 ashlar 后
 * 自动继承 ashlar 的 'full' 三张，零额外开销）。
 *   'full'      ：ashlar / gold（主体砌体 + 鎏金，roughMap 承载粗糙度分布）
 *   'noRough'   ：roof / marble / floor（rough 由 material 直接给定，贴图只管 albedo+normal）
 *   'albedoOnly'：wood / glass（只留 albedo，法线/粗糙由各自观感通道承载；玻璃靠 envMap 反射、
 *                 木门靠 albedo 木纹 + 均匀粗糙，不再单独挂图以免超 castleTexCount）
 * 净效果（稳态，含 wall 共享 ashlar）：ashlar3 + gold3 + roof2 + marble2 + floor2 + wood1 + glass1 = 14 张。
 */
const STONE_CHANNELS: Record<StoneKind, StoneChannels> = {
  ashlar: 'full',
  wall: 'full',
  floor: 'noRough',
  rock: 'full',
  gold: 'full',
  roof: 'noRough',
  // R33：wood/glass 从 albedoOnly 升 noRough —— 院落木檐/木梁与深腔暖窗进入
  // 近中景后，单靠 albedo 读不出木纹起伏/玻璃铅条厚度。贴图张数 14→16，
  // 仍 < castleTexCount 20；roughness 继续由材质常数承载（不新增 roughMap）。
  wood: 'noRough',
  glass: 'noRough',
  marble: 'noRough'
};

/**
 * R31 自辉（只有真的需要「自发光」的族才给；自辉会吃 bloom 的阈值判定）。
 * glass：微发光彩窗 —— 逆光下窗是唯一能自己亮的建筑元素，配合 bloom 出光晕。
 * 绝不给 marble/roof/wood 加自辉（会糊掉各自的材质身份）。
 */
const FAMILY_EMISSIVE: Partial<Record<StoneKind, { color: number; intensity: number }>> = {
  gold: { color: 0xb8902f, intensity: 0.22 },
  glass: { color: 0xffd39a, intensity: 0.16 }
};

/**
 * 按 1/ḡ 反算 material.roughness（铁律 34）。
 * ḡ 是生成实测值（`StoneStats.roughMean`）—— 同步代用 256² 的 ḡ、热替换后改用
 * **目标尺寸**的 ḡ，两者都让 effective ≈ target，视觉不漂（见 swapFamily 注释）。
 */
function inverseRoughness(target: number, roughMean: number): number {
  if (!Number.isFinite(roughMean) || roughMean <= 0.01) return target;
  return Math.min(1, Math.max(0.05, target / roughMean));
}

/** 近黑门洞/暗龛：不进石材族，否则会变成"亮洞"（刻意纯色，不贴图） */
function tunnelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x141110, roughness: 1.0, metalness: 0 });
}

/** 火盆焰：MeshBasic 不吃光，靠 bloom 出光晕。
 * R32 落地审查：×1.6 在 250m 外读不出光晕（参考图火盆是显眼暖光源）⇒ ×2.4
 * 让 bloom 阈值稳定触发；颜色本身不变（暖橙 0xffc27a）。 */
function flameMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(2.4) });
}

/** 一个材质在热升级时要更新的槽位（同族多材质共享同一套目标贴图） */
interface FamilySlot {
  mat: THREE.MeshStandardMaterial;
  /** 该材质的有效粗糙度目标（stone 族 = TARGET_ROUGH；pavement/walk = 固定值） */
  targetRough: number;
  /** 是否挂 roughnessMap（stone 族挂；pavement/walk 不挂、roughness 恒定） */
  usesRoughMap: boolean;
}

/** 一个石材族（kind+weather）的两代贴图 + 受影响的材质槽 + 异步句柄 */
interface StoneFamily {
  kind: StoneKind;
  weather: number;
  /** R31 贴图数量治理③：该族产哪些通道（'full'/'noRough'/'albedoOnly'） */
  channels: StoneChannels;
  syncSize: number;
  targetSize: number;
  syncMaps: StoneMaps;
  slots: FamilySlot[];
  handle?: StoneBakeHandle;
  targetMaps?: StoneMaps;
}

export class Castle {
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly matCache = new Map<string, THREE.Material>();
  /** 静态几何桶（世界坐标），最后每族 merge 成 1 mesh */
  private readonly statics: StoneBuckets = { ashlar: [], wall: [], gold: [], dark: [], flame: [] };
  /** R29 可选桶（castleKit 补桶后自动生效；见 EXTRA_BUCKETS 注释） */
  private readonly extras = new Map<ExtraBucket, THREE.BufferGeometry[]>();
  /** R30 石材族注册表（kind|weather → 两代贴图 + 材质槽），热升级的账本 */
  private readonly families = new Map<string, StoneFamily>();
  /** 目标代贴图（异步产物，非同步 cache 管辖 ⇒ 由 Castle.dispose 显式释放） */
  private readonly ownedTargets = new Set<StoneMaps>();
  private tris = 0;
  private dc = 0;
  /**
   * R32 C-5：分区 mesh + 各区世界 z 中心 + 近/远两档几何（addMergedByZone 登记）。
   * `lo` 为空 = 该区无远档变体（如 wall 桶 low=high 零收益、dark 某区 low 为空），
   * 恒用近档；`tier` 是当前挂载档（mesh.geometry 与之一致）。
   */
  private readonly zoneViews: Array<{
    mesh: THREE.Mesh;
    cz: number;
    hi: THREE.BufferGeometry;
    lo?: THREE.BufferGeometry;
    tier: 'hi' | 'lo';
  }> = [];
  /** R32 C-5：远档变体暂存（buildFarTier 产 → addMergedByZone 消费式取用 → 余量释放） */
  private readonly farTier = new Map<string, THREE.BufferGeometry>();
  /** 上次显隐重算的观看者 z（NaN = 未算过；滞回带内不重算） */
  private lastViewerZ = Number.NaN;
  private readonly syncTexSize: number;
  private readonly tier: QualitySettings['tier'];
  private disposed = false;

  constructor(scene: THREE.Scene, quality: QualitySettings) {
    this.syncTexSize = quality.castleTexSyncSize;
    this.tier = quality.tier;
    // 低配只降装饰密度，**不改任何几何长度**（铁律 33）
    setDetailLevel(quality.tier === 'low');
    this.group.name = 'castle';
    this.absorb(makeViaduct());
    this.absorb(makeParapet());
    this.absorb(makeLamps());
    this.absorb(makeGate());
    this.absorb(makeTowerGroup());
    this.absorb(makeInnerCity());
    this.absorb(makeMainHall());
    const pave = makePaving();
    this.addMesh(pave.road, this.special('pave-road', () => this.pavementMaterial()), 'castle-pave-road');
    this.addMesh(pave.walk, this.special('pave-walk', () => this.walkPavingMaterial()), 'castle-pave-walk');
    // R32 C-5：远档 LOD 变体必须先于 commitStatics 建好（分区配对按 族-zN 键消费）
    this.buildFarTier();
    this.commitStatics();
    scene.add(this.group);
    // R30：上架后才发起 idle 分片重烘（requestIdleCallback 首帧后自然排到，不占同步段）
    this.scheduleUpgrades();
  }

  /** QA 读数：tri 为已装配口径，dc 为整帧 draw call 增量（不含阴影 pass） */
  getCastleStats(): CastleStats {
    return { tris: this.tris, dc: this.dc };
  }

  dispose(): void {
    this.disposed = true;
    // 取消在飞的重烘（未到 finish 不产生 GPU 纹理；已 resolve 未 swap 的由 then 分支处置）
    for (const f of this.families.values()) f.handle?.cancel();
    // 释放目标代（热替换后材质引用的就是这批）
    for (const t of this.ownedTargets) disposeMaps(t);
    this.ownedTargets.clear();
    for (const g of this.geometries) g.dispose();
    for (const m of this.matCache.values()) m.dispose();
    this.matCache.clear();
    this.group.removeFromParent();
    // 释放同步代 + 清模块缓存（stoneTexture 仅 castle 使用 ⇒ 此处收尾安全）
    disposeStoneCache();
    // R32 C-5：构造期异常路径下未被消费的远档（正常态 commitStatics 已清空）
    for (const g of this.farTier.values()) g.dispose();
    this.farTier.clear();
  }

  /* ─────────────────────── R30 热升级 ─────────────────────── */

  /** 取/建一个石材族：同步代 256² + 记目标尺寸 + 收集材质槽 */
  private familyFor(kind: StoneKind, weather: number, channels: StoneChannels): StoneFamily {
    const key = `${kind}|${weather.toFixed(3)}|${channels}`;
    let f = this.families.get(key);
    if (!f) {
      const syncMaps = makeStoneMaps(kind, { repeat: [1, 1], weather, size: this.syncTexSize, channels });
      f = {
        kind,
        weather,
        channels,
        syncSize: this.syncTexSize,
        targetSize: stoneTextureSize(kind, this.tier),
        syncMaps,
        slots: []
      };
      this.families.set(key, f);
    }
    return f;
  }

  /** 目标尺寸 > 同步尺寸才升级（low 档 256=256 ⇒ 不升，零异步开销） */
  private scheduleUpgrades(): void {
    for (const f of this.families.values()) {
      if (f.targetSize <= f.syncSize) continue;
      const handle = bakeStoneMapsAsync(f.kind, { size: f.targetSize, weather: f.weather, repeat: [1, 1], channels: f.channels });
      f.handle = handle;
      handle.maps
        .then((target) => {
          if (this.disposed) {
            disposeMaps(target);
            return;
          }
          this.swapFamily(f, target);
        })
        .catch(() => {
          /* 取消/异常：同步代仍在位，无视觉损失 */
        });
    }
  }

  /**
   * 热替换：材质对象 / mesh / DC 全不变，只换 map/normalMap(/roughnessMap) 引用 + needsUpdate。
   * 一致性铁律：roughness 用**目标尺寸**的 roughMean 重算 —— 256² 与 512/1024² 的 roughMean
   * 不同（如 glass 0.136→0.096、floor 0.431→0.375），只有按目标尺寸反算才能让
   * `effective = material.roughness × ḡ_target ≈ TARGET_ROUGH`，与同步代表观一致（不漂）。
   * 若继续用同步代 ḡ，effective 会漂移 (ḡ_target/ḡ_sync − 1)×target 整个会话。
   */
  private swapFamily(f: StoneFamily, target: StoneMaps): void {
    f.targetMaps = target;
    this.ownedTargets.add(target);
    for (const slot of f.slots) {
      slot.mat.map = target.map;
      slot.mat.normalMap = target.normalMap;
      if (slot.usesRoughMap && target.roughnessMap) {
        slot.mat.roughnessMap = target.roughnessMap;
        slot.mat.roughness = inverseRoughness(slot.targetRough, target.stats.roughMean);
      }
      slot.mat.needsUpdate = true;
    }
    // R31 贴图数量治理①：**目标代接手后立刻退役同步代**。
    // 改前两代同时挂在 cache 里且都不释放（石材族 12+12=24 张常驻），
    // 退役后石材族稳态就是 14 张 —— 这是「25 → ≤14」里最大的一笔。
    // 安全性：此刻 f.slots 已全部指向目标代，同步代零引用；
    // 且 retireStoneMaps 会把条目从模块缓存里摘掉（避免 disposeStoneCache 二次 dispose）。
    retireStoneMaps(f.kind, f.syncSize, f.weather, f.channels);
    const dev = typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;
    if (dev) {
      console.info(
        `[castle] ${f.kind} 热升级 ${f.syncSize}²→${f.targetSize}² roughMean ${target.stats.roughMean.toFixed(3)}` +
          ` n|xy| ${target.stats.normalMag.toFixed(3)}`
      );
    }
  }

  /* ─────────────────────── 装配工具 ─────────────────────── */

  /**
   * 石材族通用材质（ashlar/wall/gold/roof/wood/glass/marble），登记热升级槽。
   *
   * R31 取族路径：`kind` 只定**视觉**（rough/metal/env/emissive/color），
   * 贴图走 `FAMILY_ALIAS` 后的族 + 量化后的 weather —— 这是「14 张」账目的执行点。
   * 铁律 34 在族没有 roughnessMap 时自动退化：material.roughness 直接 = target（有效值）。
   */
  private stoneMaterial(kind: StoneKind): THREE.MeshStandardMaterial {
    const texKind = FAMILY_ALIAS[kind] ?? kind;
    // R31 贴图数量治理②：weather 取**贴图族** texKind 的档（wall 别名 ashlar ⇒ 与 ashlar 同
    // weather 0.35 ⇒ 真正共享同一套三张贴图，而非另产一套 ashlar|0.5）。
    const weather = quantizeWeather(FAMILY_WEATHER[texKind]);
    const channels = STONE_CHANNELS[texKind];
    const family = this.familyFor(texKind, weather, channels);
    const maps = family.syncMaps;
    const ns = FAMILY_NORMAL_SCALE[kind];
    const glow = FAMILY_EMISSIVE[kind];
    const mat = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      normalScale: new THREE.Vector2(ns, ns),
      color: FAMILY_COLOR[kind] ?? 0xffffff,
      metalness: FAMILY_METAL[kind],
      // 铁律 34：贴图写的是绝对粗糙度 ⇒ 挂图时必须 1/ḡ 反算；不挂图时 target 就是有效值
      roughness: maps.roughnessMap
        ? inverseRoughness(TARGET_ROUGH[kind], maps.stats.roughMean)
        : TARGET_ROUGH[kind],
      envMapIntensity: FAMILY_ENV[kind],
      ...(glow ? { emissive: glow.color, emissiveIntensity: glow.intensity } : {})
    });
    family.slots.push({
      mat,
      targetRough: TARGET_ROUGH[kind],
      usesRoughMap: maps.roughnessMap !== null
    });
    return mat;
  }

  /**
   * 车行带铺装：floor 族**乱石板（crazy-paving）** + vertexColor 分档（深带 0.62 / 浅边带 1.28）。
   *
   * **刻意不挂 roughnessMap、给均匀 0.9**（R30 决策，承 R29 先例，二选一说明理由）：
   * 铁律 34 下若挂 roughnessMap，effective = material.roughness × ḡ（floor ḡ≈0.47），
   * 400m 级水平路面在掠射角会被菲涅耳镜成「湿沥青」（R29 双重实证）—— 挂图非但不能更真实，
   * 反而更容易镜。故给**均匀 0.9 干面**：乱石板的「干/磨损」观感由 albedo 块间色差（crazy-paving）
   * + normalMap 凹凸承载，不靠 roughness 变化。基色 #413f3d（R29 吸色硬数据）不变；
   * 深色缝 ≈#222、块间 #3A3A3A–#606060 由 stoneTexture.prepFloor 生成（.qa/r29_vision.md §2-D）。
   */
  private pavementMaterial(): THREE.MeshStandardMaterial {
    // R31：weather 走量化档（0.4 → 0.35），与石材族同规则，避免多产一套贴图
    const channels: StoneChannels = 'noRough';
    const maps = this.familyFor('floor', quantizeWeather(FAMILY_WEATHER.floor), channels).syncMaps;
    const mat = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      // 不挂 roughnessMap：全国统一 0.8 的干面（R31：族里已不生成 rough 图）
      normalScale: new THREE.Vector2(0.8, 0.8),
      color: 0xffffff,
      metalness: 0,
      // 不挂 roughnessMap ⇒ 这里是**有效粗糙度**本身，不需要 1/ḡ 反算
      roughness: 0.9,
      envMapIntensity: 0.15,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    this.familyFor('floor', quantizeWeather(FAMILY_WEATHER.floor), channels).slots.push({
      mat,
      targetRough: 0.9,
      usesRoughMap: false
    });
    return mat;
  }

  /** 步道铺装：ashlar 族白石。同样不挂 roughnessMap（水平面掠射会镜，均匀 0.95 全哑光） */
  private walkPavingMaterial(): THREE.MeshStandardMaterial {
    const channels: StoneChannels = 'full';
    const maps = this.familyFor('ashlar', 0.35, channels).syncMaps;
    const mat = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      color: 0xffffff,
      metalness: 0,
      roughness: 0.95,
      envMapIntensity: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    this.familyFor('ashlar', quantizeWeather(FAMILY_WEATHER.ashlar), channels).slots.push({
      mat,
      targetRough: 0.95,
      usesRoughMap: false
    });
    return mat;
  }

  private stone(kind: StoneKind): THREE.MeshStandardMaterial {
    const key = `stone:${kind}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const mat = this.stoneMaterial(kind);
    this.matCache.set(key, mat);
    return mat;
  }

  private special(key: string, make: () => THREE.Material): THREE.Material {
    const hit = this.matCache.get(key);
    if (hit) return hit;
    const mat = make();
    this.matCache.set(key, mat);
    return mat;
  }

  /** 单几何 → 1 mesh（静态：关自动矩阵、不投影不接收） */
  private addMesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.geometries.push(geo);
    this.tris += triCount(geo);
    this.dc += 1;
    return mesh;
  }

  /** 把一个构件集按材质族摊进静态桶（含 R29 可选桶的防御式读取） */
  private absorb(set: StoneBuckets): void {
    this.statics.ashlar.push(...set.ashlar);
    this.statics.wall.push(...set.wall);
    this.statics.gold.push(...set.gold);
    this.statics.dark.push(...set.dark);
    this.statics.flame.push(...set.flame);
    for (const key of EXTRA_BUCKETS) {
      const maybe = (set as unknown as Partial<Record<ExtraBucket, THREE.BufferGeometry[]>>)[key];
      if (!Array.isArray(maybe) || maybe.length === 0) continue;
      const bucket = this.extras.get(key) ?? [];
      bucket.push(...maybe);
      this.extras.set(key, bucket);
    }
  }

  /** 静态 mesh 一次性提交（空桶不建 mesh、不占 DC） */
  private commitStatics(): void {
    // R31：只有两个大桶分区（ashlar 6 区 / wall 3 区）；量小的桶保持全局 1 个，
    // 分了也不见得被剔除，白增 DC。
    this.addMergedByZone(this.statics.ashlar, this.stone('ashlar'), 'castle-ashlar', ZONE_EDGES_6);
    this.addMergedByZone(this.statics.wall, this.stone('wall'), 'castle-wall', ZONE_EDGES_3);
    // R31 运行时治理①延伸：gold（135k）/ dark（34k）体量远非「量小」，且沿整条御桥+城门+内城
    // 铺开（bbox 跨整个 z 走廊），若保持全局 1 个 mesh，行车时永不被视锥剔除 ⇒ 每帧全量提交。
    // 改为按 z 分区（与 ashlar 同 6 区），越过车后的区被剔除（视野前方仍可见，但已过的段不再提交）。
    // 共享同一材质（stone/dark 各自按 key 缓存）⇒ 贴图张数与 tri 不变，仅 DC 由 1→≤6（仍 < castleDc 32）。
    this.addMergedByZone(this.statics.gold, this.stone('gold'), 'castle-gold', ZONE_EDGES_6);
    this.addMergedByZone(this.statics.dark, this.special('dark', () => tunnelMaterial()), 'castle-dark', ZONE_EDGES_6);
    this.addMerged(this.statics.flame, this.special('flame', () => flameMaterial()), 'castle-flame');
    // R29 新族：桶非空才建 mesh（castleKit 未补桶时这里全部跳过 ⇒ DC 不变）
    for (const key of EXTRA_BUCKETS) {
      const parts = this.extras.get(key);
      if (!parts || parts.length === 0) continue;
      this.addMerged(parts, this.stone(key), `castle-${key}`);
    }
    // R32 C-5：没被任何高端区配上的远档（A 线几何漂移致某族 low 区空/high 区非空的
    // 防御态）⇒ 释放，不占常驻。正常态下这里为空（每个 lo 都被同族同区 high 消费）。
    for (const g of this.farTier.values()) g.dispose();
    this.farTier.clear();
  }

  /**
   * R32 C-5：远档 LOD 变体几何（铁律 33 合规：low 档只降装饰密度，几何长度不变）。
   *
   * 为什么重跑一遍工厂：castleKit 的密度开关是**模块级全局**（setDetailLevel /
   * isLowDetail），远档「只主体」几何只能以 low 档整体重产一次，再按同一套
   * ZONE_EDGES_6 分区 merge。工厂无模块级累积状态（grep 实证：castleKit 只有
   * LOW_DETAIL 一个可变全局，DEEP_FAR 由各工厂自置自复）⇒ 重跑安全。
   * 成本 = 一倍几何生成（high 档 warm ≈850ms ⇒ 首建 ≈1.7s；用户令「首建时长不限」
   * 明确豁免）。stoneTexture 缓存键不变（kind|size|weather|repeat 与档无关）⇒ 0 额外贴图。
   *
   * 覆盖族：ashlar / gold / dark（三个分区重族，low 档实测降幅 33~54%）。
   *   · wall 不建变体：剪影带本就极简，low=high（实测 0% 收益）；
   *   · flame / 四可选桶不建：全局单 mesh（非分区），按距离换档会同时影响全走廊；
   *   · z0 建但不吃亏：40k tri 常驻换「边界表将来的鲁棒性」（全显口径不计它）。
   * 仅 high 档构建：low 档城堡整体已是减密度几何，远档=近档，白占内存。
   */
  private buildFarTier(): void {
    if (this.tier !== 'high') return;
    setDetailLevel(true);
    const sets = [
      makeViaduct(),
      makeParapet(),
      makeLamps(),
      makeGate(),
      makeTowerGroup(),
      makeInnerCity(),
      makeMainHall()
    ];
    setDetailLevel(false); // 恢复 high：commitStatics 的材质/统计都按 high 口径
    const low: StoneBuckets = { ashlar: [], wall: [], gold: [], dark: [], flame: [] };
    for (const s of sets) {
      low.ashlar.push(...s.ashlar);
      low.gold.push(...s.gold);
      low.dark.push(...s.dark);
    }
    for (const [family, parts] of [
      ['ashlar', low.ashlar],
      ['gold', low.gold],
      ['dark', low.dark]
    ] as const) {
      const zones = splitByZone(parts, ZONE_EDGES_6);
      for (let i = 0; i < zones.length; i += 1) {
        if (zones[i].length === 0) continue;
        const merged = mergeSafe(zones[i]);
        // 预算法线盒/球：远档是运行中段换入的，不能把首次包围球计算留给换档那一帧
        merged.computeBoundingBox();
        merged.computeBoundingSphere();
        this.farTier.set(`${family}-z${i}`, merged);
      }
      for (const g of parts) g.dispose();
    }
    // sets 里本轮不用的族（wall/flame/extras）逐一释放，防首建期泄漏
    for (const s of sets) {
      for (const g of s.wall) g.dispose();
      for (const g of s.flame) g.dispose();
      for (const k of EXTRA_BUCKETS) {
        const arr = (s as unknown as Partial<Record<ExtraBucket, THREE.BufferGeometry[]>>)[k];
        if (arr) for (const g of arr) g.dispose();
      }
    }
  }

  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string): void {
    if (parts.length === 0) return;
    const merged = mergeSafe(parts);
    parts.forEach((p) => p.dispose());
    // R32 C-4：合并后零面 ⇒ 不建 mesh（见 isDrawable 注）
    if (!isDrawable(merged)) {
      merged.dispose();
      return;
    }
    this.addMesh(merged, mat, name);
  }

  /**
   * R31 分区合批：同材族的几何先按世界 z 摊进各区，每区各自 merge 成 1 mesh。
   * 收益：包围盒从 700m 长条变成 ≤300m 的块 ⇒ 行车时后方/侧后方的区整体被视锥剔除，
   * 顶点提交与 fill rate 同时下降（fill rate 是本场景的既有瓶颈）。
   * 空区不建 mesh（不占 DC）—— 所以加分项 DC 是「非空区数」而不是「区数」。
   *
   * R32 C-5：每区配对远档变体（farTier 按 `族-zN` 键消费式取用）——配对成功的区
   * 获得 lo 几何 + 初始 hi 档；取不到的（A 线几何漂移的防御态）留待在
   * commitStatics 末尾统一释放。
   */
  private addMergedByZone(
    parts: THREE.BufferGeometry[],
    mat: THREE.Material,
    namePrefix: string,
    edges: ZoneEdges
  ): void {
    if (parts.length === 0) return;
    const zones = splitByZone(parts, edges);
    const family = namePrefix.replace(/^castle-/, '');
    for (let i = 0; i < zones.length; i += 1) {
      // ① 空区（零个几何）不建 mesh —— R31 起就有，是当前 tree 里唯一实际发生的空区形态
      if (zones[i].length === 0) continue;
      const merged = mergeSafe(zones[i]);
      // ② R32 C-4 补强：**零面区**也不建 mesh。区里有至少一个几何、但 merge
      //    后无面（A 线某构件退化成空 BufferGeometry / 全被密度开关裁净时）会走到这，
      //    改前会白占 1 个静态 DC 且把「看不见的东西」算进 getCastleStats.dc。
      //    当前 tree 无此情形（dc_audit.md 逐 mesh 实测最小 tri = pave-walk 4 > 0），
      //    本行是防 A 线几何漂移的护栏：零面 mesh 一出现就静默吞掉，不进预算口径。
      if (!isDrawable(merged)) {
        merged.dispose();
        continue;
      }
      const mesh = this.addMesh(merged, mat, `${namePrefix}-z${i}`);
      // R31 距离显隐登记：区中心 z 用合并后 bbox（mergeSafe 已 computeBoundingBox）
      merged.computeBoundingBox();
      const bb = merged.boundingBox;
      const cz = bb ? (bb.min.z + bb.max.z) * 0.5 : 0;
      const lo = this.farTier.get(`${family}-z${i}`);
      if (lo) {
        this.farTier.delete(`${family}-z${i}`);
        this.geometries.push(lo); // 双档都进 dispose 账本
      }
      this.zoneViews.push({ mesh, cz, hi: merged, lo, tier: 'hi' });
    }
    parts.forEach((p) => p.dispose());
  }

  /**
   * R31 运行时治理② + R32 C-5 治理③：按观看者世界 z 开关各区 mesh + 换近/远档。
   * Game 帧循环每帧调用一次（内部滞回，多数帧直接返回）；
   * 首帧（lastViewerZ=NaN）必算一次 ⇒ 不存在「从未显隐」的窗口。
   * 同一遍遍历里：① 距离显隐（≥ZONE_VIEW_RANGE 整区 visible=false）；
   * ② 远档 LOD（>D+滞回 换 lo、<D−滞回 换 hi；同 mesh 换 geometry，DC 不变）。
   * 顺序保证弹入瞬间档位就是新的（先置 visible 再判档）⇒ 无「弹入时是旧档」帧。
   */
  updateViewerZ(z: number): void {
    if (Number.isFinite(this.lastViewerZ) && Math.abs(z - this.lastViewerZ) < ZONE_VIEW_HYSTERESIS) return;
    this.lastViewerZ = z;
    for (const zv of this.zoneViews) {
      const d = Math.abs(zv.cz - z);
      zv.mesh.visible = d < ZONE_VIEW_RANGE;
      if (!zv.lo) continue;
      if (zv.tier === 'hi' && d > LOD_NEAR_DIST + LOD_HYSTERESIS) this.setZoneTier(zv, 'lo');
      else if (zv.tier === 'lo' && d < LOD_NEAR_DIST - LOD_HYSTERESIS) this.setZoneTier(zv, 'hi');
    }
  }

  /** 换档：同 mesh 换 geometry 引用（不增 mesh/DC；两档几何都在 dispose 账本内） */
  private setZoneTier(
    zv: { mesh: THREE.Mesh; hi: THREE.BufferGeometry; lo?: THREE.BufferGeometry; tier: 'hi' | 'lo' },
    tier: 'hi' | 'lo'
  ): void {
    if (!zv.lo) return;
    zv.mesh.geometry = tier === 'hi' ? zv.hi : zv.lo;
    zv.tier = tier;
  }

  /**
   * QA 自由机位（__v800EnvShot）专用：临时全显 + 重置滞回态 + **全档回近档**。
   * 自由机位直渲绕过帧循环，不放开就会保留上一个行车机位的显隐态
   * ⇒ 环境验收截图缺远区件。R32 C-5 追加回近档：验收截图要的是**全装饰**几何，
   * 不能把行车态残留的远档（只主体）几何拍进去。
   * 下一次 updateViewerZ 按真实机位重算。
   */
  revealAllZones(): void {
    for (const zv of this.zoneViews) {
      zv.mesh.visible = true;
      if (zv.tier !== 'hi') this.setZoneTier(zv, 'hi');
    }
    this.lastViewerZ = Number.NaN;
  }
}
