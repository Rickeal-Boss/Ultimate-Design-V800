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
import { makeStoneMaps, stoneTextureSize, bakeStoneMapsAsync, disposeStoneCache, retireStoneMaps, makeStoneVariantMaterial, STONE_VARIANTS } from './stoneTexture';
import type { StoneKind, StoneMaps, StoneBakeHandle, StoneChannels, StoneVariantId } from './stoneTexture';
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
import { ACTIVE_ENV } from '../../config/environment';

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

/* ─────────────────────── R38-P0-2 B1：巨型三角形按 z 细分 / 按 z 平面切割 ─────────────────────── */

/**
 * 逐三角形 **z 向跨度**上限（m）：单个三角形若跨得比它宽，就按 z 切成 ≤该值的若干段。
 *
 * 取 100m 的依据（实测 + 预算双约束，工具 `tools/r38_longtri.mjs`）：
 *   · 全场景**只有 114 个三角形（0.11%）自身 z 跨度 >200m** —— `ashlar-z0` 72 个
 *     （最长 419m）、`gold-z0` 32 个（419m）、`pave-road` 6 个（1560m）、
 *     `pave-walk` 4 个（949m），其余 101,098 个全部 ≤48m。
 *   · 正是这 114 个把 z0 / pave 的**包围球钉死在整条 mesh 的尺度**（诊断实证：
 *     把 ashlar-z0 按 z 切成 60m 桶后，含巨型三角形的两个桶球半径仍是 212m
 *     = 整条 mesh 的球半径）⇒ 这就是「历次按 z 切细分区削峰都是 0」的根因。
 *   · 100m 是「tri 增量 ≤ +1.5k」与「slab 球显著缩小」的交点：
 *     419m → 5 段、1560m → 16 段，合计新增 ≈+1,198 tri（实测，见交付报告）；
 *     再细（50m）增量翻倍到 ≈+2.4k，超出主理人给的 +1.5k 上限。
 * ⚠ 本值**只在巨型三角形上生效**（≤100m 的三角形原样拷贝）⇒ 对 99.9% 的几何零改动。
 */
const MAX_TRI_Z_SPAN = 150;

/**
 * R38-P0-2 B1：z0 的切割平面（世界 z）。
 * −150 = z0 实测 bbox `[−359, 61]` 的中点 ⇒ 切成 `[−359,−150]` / `[−150,61]` 两段，
 * 各 ≈210m（长度均衡，两段的包围球都能显著小于原 212m 的整条球）。
 * ⚠ 该平面**同时**作用于近档与远档（splitGeometryByZ 对两档用同一平面）
 * ⇒ 两档的 a/b 段一一对应，换档时不会出现「半段错位」。
 */
const Z0_SPLIT_PLANE = -150;

/** 顶点属性镜像（名字 + itemSize + 源数组），插值时按 stride 逐分量线性插值 */
interface AttrMirror {
  name: string;
  item: number;
  src: ArrayLike<number>;
}

/**
 * 沿 z 平面**裁剪**一个三角形/多边形（Sutherland–Hodgman 单边裁剪）。
 * @param poly 顶点数组，每个顶点是「所有属性按 stride 串联」的 number[]
 * @param stride 单顶点属性总长
 * @param zIndex z 分量在顶点里的下标（position 的 itemSize=3 且排在最前 ⇒ 恒为 2）
 */
function clipPolyZ(poly: number[][], plane: number, keepBelow: boolean, stride: number, zIndex: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const A = poly[i];
    const B = poly[(i + 1) % poly.length];
    const inA = keepBelow ? A[zIndex] <= plane : A[zIndex] >= plane;
    const inB = keepBelow ? B[zIndex] <= plane : B[zIndex] >= plane;
    if (inA) out.push(A);
    if (inA !== inB) {
      const dz = B[zIndex] - A[zIndex];
      const t = Math.abs(dz) < 1e-12 ? 0 : (plane - A[zIndex]) / dz;
      const v = new Array<number>(stride);
      for (let k = 0; k < stride; k += 1) v[k] = A[k] + (B[k] - A[k]) * t;
      out.push(v);
    }
  }
  return out;
}

/** 多边形扇形三角化（保持绕序；Sutherland–Hodgman 输出恒凸） */
function fanTriangulate(poly: number[][]): number[][][] {
  const tris: number[][][] = [];
  for (let i = 1; i + 1 < poly.length; i += 1) tris.push([poly[0], poly[i], poly[i + 1]]);
  return tris;
}

/** 取几何的属性镜像 + 顶点总数（mergeSafe 的产物恒为**非索引**，本函数按非索引处理） */
function mirrorAttrs(geo: THREE.BufferGeometry): { attrs: AttrMirror[]; stride: number; count: number } {
  const attrs: AttrMirror[] = [];
  let stride = 0;
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.getAttribute(name) as THREE.BufferAttribute;
    attrs.push({ name, item: a.itemSize, src: a.array as ArrayLike<number> });
    stride += a.itemSize;
  }
  const count = geo.getAttribute('position').count;
  return { attrs, stride, count };
}

/** 从镜像里读出第 i 个顶点的串联属性向量 */
function readVertex(attrs: AttrMirror[], stride: number, i: number): number[] {
  const v = new Array<number>(stride);
  let o = 0;
  for (const a of attrs) {
    for (let k = 0; k < a.item; k += 1) v[o + k] = a.src[i * a.item + k];
    o += a.item;
  }
  return v;
}

/** 把一批三角形写回 BufferGeometry（非索引） */
function buildGeometry(attrs: AttrMirror[], tris: number[][][]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const n = tris.length * 3;
  for (const a of attrs) {
    const arr = new Float32Array(n * a.item);
    let w = 0;
    for (const t of tris) {
      for (const v of t) {
        // 顶点向量里该属性的起始偏移
        let off = 0;
        for (const b of attrs) {
          if (b === a) break;
          off += b.item;
        }
        for (let k = 0; k < a.item; k += 1) arr[w++] = v[off + k];
      }
    }
    out.setAttribute(a.name, new THREE.BufferAttribute(arr, a.item));
  }
  return out;
}

/**
 * **只切三角形、不改任何几何的尺寸与位置**：把 z 向跨度 > `maxSpan` 的三角形
 * 按 z 切成若干段（新顶点在**原三角形平面内线性插值** ⇒ 外形逐位复现，仅顶点数增加）。
 *
 * 为什么必须走这一步：three 的视锥剔除读 `geometry.boundingSphere`，而包围球由
 * **顶点**决定 —— 一个自身跨 419m 的三角形会把任何包含它的 slab 的球撑回整条 mesh
 * 的尺度 ⇒ 不先切三角形，后面「按 z 切段」在数值上完全无效（同树仿真实证 0 收益）。
 */
export function subdivideLongTriangles(geo: THREE.BufferGeometry, maxSpan: number): THREE.BufferGeometry {
  const { attrs, stride, count } = mirrorAttrs(geo);
  if (count < 3) return geo;
  const zIndex = 2; // position 排在最前且 itemSize=3
  const tris: number[][][] = [];
  let touched = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const v0 = readVertex(attrs, stride, t);
    const v1 = readVertex(attrs, stride, t + 1);
    const v2 = readVertex(attrs, stride, t + 2);
    const zmin = Math.min(v0[zIndex], v1[zIndex], v2[zIndex]);
    const zmax = Math.max(v0[zIndex], v1[zIndex], v2[zIndex]);
    const span = zmax - zmin;
    if (span <= maxSpan || !Number.isFinite(span)) {
      tris.push([v0, v1, v2]);
      continue;
    }
    touched += 1;
    const n = Math.max(2, Math.ceil(span / maxSpan));
    const seg = span / n;
    let poly = [v0, v1, v2];
    for (let k = 0; k < n; k += 1) {
      const lo = zmin + k * seg;
      const hi = zmin + (k + 1) * seg;
      // 先裁掉 z>hi（保留下方），再裁掉 z<lo（保留上方）⇒ 得到 slab [lo,hi] 内的多边形
      let slab = clipPolyZ(poly, hi, true, stride, zIndex);
      if (slab.length >= 3) slab = clipPolyZ(slab, lo, false, stride, zIndex);
      if (slab.length >= 3) {
        for (const ft of fanTriangulate(slab)) tris.push(ft);
      }
      // 下一轮从**原始**三角形重新裁（poly 不变），避免累计误差
    }
  }
  if (touched === 0) return geo;
  const out = buildGeometry(attrs, tris);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * 按 z 平面**切割**几何（精确裁剪，不按重心近似）：
 * 返回 [z ≤ plane 的部分, z > plane 的部分]；任一侧为空则该侧返回 null。
 * 用途：把超宽的 z0 区（420m 长的合批条）一分为二，让车后那一半能被视锥整块剔除。
 */
export function splitGeometryByZ(
  geo: THREE.BufferGeometry,
  plane: number
): [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  const { attrs, stride, count } = mirrorAttrs(geo);
  const zIndex = 2;
  const below: number[][][] = [];
  const above: number[][][] = [];
  for (let t = 0; t + 2 < count; t += 3) {
    const poly = [
      readVertex(attrs, stride, t),
      readVertex(attrs, stride, t + 1),
      readVertex(attrs, stride, t + 2)
    ];
    const b = clipPolyZ(poly, plane, true, stride, zIndex);
    if (b.length >= 3) for (const ft of fanTriangulate(b)) below.push(ft);
    const a = clipPolyZ(poly, plane, false, stride, zIndex);
    if (a.length >= 3) for (const ft of fanTriangulate(a)) above.push(ft);
  }
  const mk = (tris: number[][][]): THREE.BufferGeometry | null => {
    if (tris.length === 0) return null;
    const g = buildGeometry(attrs, tris);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  };
  return [mk(below), mk(above)];
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

/**
 * R36-A2 变体桶（door / agedGold / pave）：材质走 `variantMaterial(id)` 热升级路径
 * （R35 wall→inner-stone 先例：材质替换而非新建贴图，0 新贴图）。
 *   door    → inner-wood （城门门扇/内庭门扇；wood 图集弦切弯纹）
 *   agedGold → gilded-aged（门钉/徽章/做旧金饰；gold 图集氧化做旧）
 *   pave    → pave-damp  （内庭地面潮斑铺装；floor 图集微湿低频斑）
 *   grey    → ashlar-grey（R37-A 灰石强调：门楼翼墙/外延墙身；ashlar 图集 + 冷灰提亮）
 * 每桶全局 1 mesh（量小不分区）⇒ +4 DC（27→31 ≤ castleDc 32）。
 * ⚠ 例外：`grey` 走**分区**提交（见 commitStatics），因为它承载的是沿 z 铺开的
 *   大面积墙身 —— 若做全局 1 mesh，包围球会横跨 z 走廊 ⇒ 行车时永不被视锥剔除，
 *   在 sphere 峰值点（z=−500）恒 +全额 tri。分区后只有有灰石的那个区建 mesh
 *   （实测 1 个）⇒ DC 同样 +1，但可被剔除。
 */
const VARIANT_BUCKETS = {
  door: 'inner-wood',
  agedGold: 'gilded-aged',
  pave: 'pave-damp',
  grey: 'ashlar-grey'
} as const;
type VariantBucket = keyof typeof VARIANT_BUCKETS;
/** R37-A：走**分区**提交的变体桶（体量大 / 沿 z 铺开 ⇒ 全局 mesh 会废掉剔除） */
const ZONED_VARIANT_BUCKETS: readonly VariantBucket[] = ['grey'];
/** absorb()/释放时要读取的全部可选桶键（基族 + 变体） */
const ALL_BUCKETS: readonly (ExtraBucket | VariantBucket)[] = [...EXTRA_BUCKETS, ...(Object.keys(VARIANT_BUCKETS) as VariantBucket[])];

/* ─────────────────── R31 z 分区合批 ─────────────────── */

/**
 * 分区边界（**降序**；n+1 个边界 ⇒ n 个区）。世界坐标，工厂车头 +Z。
 * 取值依据 R31 基线地形与建筑分布（.qa/r31_test/r31_geo_probe.json）：
 *   御桥/门楼 z≈+60..−340（桥 24 跨 + 门楼塔群）｜内城大街 −340..−1470（每街区 80m 一拍）
 * 6 区按「每区 ≈2~4 个街区」切，单区跨度 ≤300m ⇒ 行车时后方 2~3 个区可被剔除。
 */
const ZONE_EDGES_6 = [60, -340, -460, -760, -1060, -1290, -1470] as const;
/**
 * ══ R38-P0-2 B3：wall 桶 3 区 → **2 区**（为 B1 的 z0 切段腾出 1 格 DC）══════════
 * 改前 `[60,−460,−1060,−1470]`（3 区），改后 `[60,−460,−1470]`（2 区）。
 * 依据（实测，非估算）：
 *   · wall 全域仅 **2,544 tri**（wall-z0 264 + wall-z1 1,824 + wall-z2 720），
 *     占 castle 全显 312,022 的 0.82% —— 是**最不该占 DC 的一族**（3 个 DC 换 2.5k tri）；
 *   · 合并后 z1 变成 z∈[−1447,−458] 的 989m 长条、球 r≈257 ⇒ 剔除效率下降，
 *     但**同树 74 帧仿真只多递交 <1k tri**（`tools/r38_plan_sim.mjs` 的 B3 基线已含该代价）；
 *   · 收益 = **静态 DC 31 → 30**，正好补上 B1（z0 两段 = +2 格）里缺的那一格，
 *     使终态 **30+2 = 32** 压在 `castleDc` 键 32 的硬顶内（主理人裁决：不许超、不许抬键）。
 * ⚠ 「远景剪影带切太碎没收益」的旧判断仍成立（2 区不是 1 区，剪影带仍可整体剔除），
 *   本轮只是把「最贵的那格 DC」从 wall 身上收回来。
 */
const ZONE_EDGES_3 = [60, -460, -1470] as const;
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
 * ══ R38-P0-1：650 → **550**（**整段依据已重写，旧「650 制」表述全部作废**）══════════
 * 为什么改（外部逐帧审查 2026-10-28 + 本波复算，工具 `tools/r38_peak_scan.mjs`）：
 *   · 官方六点采样 `[40,0,−200,−500,−900,−1300]` 峰值只有 190,322，看似 ≤200,000 达标；
 *     但 **20m 步长逐帧扫描（74 帧）真实峰值 = 241,630 @ carZ∈[−360,−280]**
 *     （80m 长的峰值带，六点一个都不在带内）⇒ 超 visibleTri 红线 200,000 达 **+20.8%**。
 *     ⇒ 「六点绿」是**采样盲区**，不是达标；护栏口径已同步改为 74 帧全场扫描
 *     （`tests/r32_budget.test.ts`，与主裁决同批落地，否则断言先红）。
 *   · 峰值成因：峰值帧**同时有 4 个区在闸门内**（z3 区中心距 635.7m，卡在 650 制的
 *     14.3m 缝里刚好进带），且其中 z0（420m 长合批条、球 r=212、球心在车后 122m）
 *     的 49,220 tri 有 83.8%~100% 在视锥外 —— 逐三角形精确判定实测误递交
 *     54,609~88,680 tri（峰值帧的 22.6%~36.7%，工具 `tools/r38_pertri.mjs`）。
 *   · **550 制仿真（同树 74 帧，`tools/r38_policy_sim.mjs`）**：峰值 241,630 →
 *     **192,410 @ carZ=−380**（−20.4%），74 帧均值 152,808 → 141,698（−7.3%），
 *     峰值帧 castle DC 24 → 22。
 *
 * ⚠ **550 制的净成本（必须记住，别当免费午餐）**：
 *   · **弹入点从 486m 拉近到 385m**（区中心跨 550 时，该区近端到相机 ≈385m；
 *     486m 是 650 制的同口径读数，外部审查正是在 480–500m 处拍到 43,516 tri 一帧弹出）。
 *   · 雾仍不提供遮蔽：FogExp2 ρ=12e-5 ⇒ 385m 处雾浓度仅 **0.21%**（486m 处 0.34%）。
 *     ⇒ **该代价由 R38-P0-3 的「分区淡入（uFade）」补偿**：区中心距 550→450 线性淡入，
 *     与本闸门同参（`FADE_NEAR_DIST`），滞回 20m 落在淡入带起点之外，不打架。
 *   · 门楼（z≈−358.5）可见性**仍不受影响**：起步 cam≈+68 距 z0 中心 217m ≪ 550，
 *     驶过后由视锥剔除接管（z0 在峰值帧已被整块剔除，实测不在帧内）。
 *
 * ⚠ **已知上限（别再指望靠本常数继续削峰）**：(R × LOD D) 二维网格实测
 *     （`tools/r38_r_lod_grid.mjs`）⇒ R=550 峰值恒为 192,410（D 从 400 压到 250 都不动），
 *     即便把 D 压到 180（220m 就换远档）也只能到 **190,322** —— 峰值帧是
 *     「z1（车在城门楼里）+ z2（249m 前）+ z3（537m 前，已远档）+ 全局桶 32,374」，
 *     其 47,396 tri 误递交里 z1 独占 41,789 且是**横向/纵向**浪费（按 z 切段无效，
 *     七种切法同树仿真全部 0 收益，见 `tools/r38_plan_sim.mjs`）。
 */
const ZONE_VIEW_RANGE = 550;
/** 观看者 z 滞回带：少于该位移不重算显隐（机位微抖/环绕摆动不触发闪烁） */
const ZONE_VIEW_HYSTERESIS = 20;

/**
 * R38-P0-3 分区淡入：区中心距 ≥ 本值 ⇒ 完全淡入雾色；≤ FADE_NEAR_DIST ⇒ 完全不淡。
 * 淡入带 = [FADE_NEAR_DIST, ZONE_VIEW_RANGE] = 450 → 550（100m）。
 * 取值依据：
 *   · 起点必须 = `ZONE_VIEW_RANGE`（550）⇒ 区刚跨过显隐闸门那一帧 uFade=0，
 *     即「弹入瞬间是雾色、随后 100m 内渐显」，弹入事件被抹掉；
 *   · 终点 450 是「弹入点（385m）之外再留 65m 余量」——避免淡入还没走完车就开到跟前；
 *   · 250km/h（69 m/s）下 100m ≈1.45s 完成淡入；低速下更慢（按距离而非时间 ⇒ 不随帧率变）。
 * ⚠ 与滞回的关系：`ZONE_VIEW_HYSTERESIS=20` 只作用于**显隐/换档**判定（20m 一跳），
 *   淡入是**逐帧**按当前机位连续写 uniform（不进滞回分支），两者不打架。
 * ⚠ 代价（写在此处免得后人当免费）：淡入段材质被克隆成**按区实例**（21 vs 8），
 *   但共用同一个 program（`customProgramCacheKey` 默认取 `onBeforeCompile.toString()`，
 *   全同 ⇒ 1 个 shader 变体、0 额外编译）。
 */
const FADE_NEAR_DIST = 450;

/**
 * R38-P0-3：淡入的**目标色** = 雾色（`ACTIVE_ENV.fog.color`，与 three 的 `fogColor`
 * 同色源、同色彩空间）⇒ 淡到底时该区与背景雾同色，视觉上「还没出现」。
 * ⚠ 已知局限（写在此处免得后人误判）：FogExp2 ρ=12e-5 在 550m 处雾浓度只有 0.61%，
 *   即「雾色」≠ 550m 处真实的背景色（背景多半是天光/远山）。故淡入只能把弹入的
 *   **突变**抹成渐变，做不到「凭空隐形」；这是 0 DC / 0 tri 代价下的最优解，
 *   观感需验收线拍 A/B（弹入瞬间连拍 3 帧）确认。
 */
const FADE_COLOR_UNIFORM = { value: new THREE.Color(ACTIVE_ENV.fog.color) };

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
  /** R29 可选桶 + R36 变体桶（castleKit 补桶后自动生效；见 EXTRA_BUCKETS/VARIANT_BUCKETS 注释） */
  private readonly extras = new Map<ExtraBucket | VariantBucket, THREE.BufferGeometry[]>();
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
    /** R38-P0-3：本区淡入 uniform（1 = 完全不淡；0 = 完全雾色）。写它即生效，无需重编译。 */
    fade: { value: number };
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
    // R38-P0-2 B1：`pave-road`（6 tri，最长跨度 **1560m**）与 `pave-walk`（4 tri，949m）
    // 是「全场景最长的两个三角形」——它们把这两条 mesh 的包围球撑到 r=780/680
    // ⇒ 行车时**恒在视锥内**（74/74 帧）。按 z 切成 ≤100m 的段后球显著缩小。
    // 成本：+186/+76 tri（合计 +262，远低于 +1.5k 上限）。
    const roadGeo = subdivideLongTriangles(pave.road, MAX_TRI_Z_SPAN);
    if (roadGeo !== pave.road) pave.road.dispose();
    this.addMesh(roadGeo, this.special('pave-road', () => this.pavementMaterial()), 'castle-pave-road');
    const walkGeo = subdivideLongTriangles(pave.walk, MAX_TRI_Z_SPAN);
    if (walkGeo !== pave.walk) pave.walk.dispose();
    this.addMesh(walkGeo, this.special('pave-walk', () => this.walkPavingMaterial()), 'castle-pave-walk');
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

  /**
   * 取/建一个石材族：同步烘到**上架尺寸** + 记目标尺寸 + 收集材质槽。
   *
   * ══ R38-P0-4（C1）：上架尺寸 = `max(castleTexSyncSize, stoneTextureSize(kind,tier))` ══
   * 改前：同步烘 256² 上架，再 `requestIdleCallback` 分片重烘到目标尺寸并热替换。
   * 改后：**加载期一次性同步烘到目标尺寸**，后续 `scheduleUpgrades()` 因
   * `targetSize <= syncSize` 恒不成立 ⇒ 异步重烘与热替换**整条路径不再触发**。
   *
   * 依据（实测，工具 `tools/r38_frameload.mjs`）：旧路径的代价是
   *   **636ms CPU / 111 个分片 / 5 个分片 >16.7ms（最长 35.4ms = 2.1 帧）**
   *   + 7 次 `swapFamily` 的纹理上传 + mipmap hitch（1024²×3 ≈22MB/族）。
   *   `requestIdleCallback(…, { timeout: 2000 })` 保证连续动画下也会跑 ⇒ 这些分片
   *   会落进行车帧之间的 idle 缝里，其中 5 个单片就吃掉一整帧 ⇒ **必然掉帧**。
   * 代价：**首建 +636ms** —— 用户已明确放行（原话「首次构建时长没有限制，
   *   只是运行时要确保流畅」）⇒ 这是本波最该搬走的一项。
   * ⚠ low 档不动：`stoneTextureSize(kind,'low') = 256 = castleTexSyncSize` ⇒
   *   `max()` 仍是 256，**不会**给低端机加活（低端机本就吃不住 1024）。
   * ⚠ 两键不变：high 档仍是 ashlar/floor 1024²（hero）、gold/roof/wood/glass/marble
   *   512² ⇒ 稳态 14~16 张 `≤ castleTexCount 20`；显存估算 ~21MB `≤ castleTexMB 40`。
   */
  private familyFor(kind: StoneKind, weather: number, channels: StoneChannels): StoneFamily {
    const key = `${kind}|${weather.toFixed(3)}|${channels}`;
    let f = this.families.get(key);
    if (!f) {
      const targetSize = stoneTextureSize(kind, this.tier);
      // R38-P0-4：加载期一次性同步烘到目标尺寸（见上方 C1 注释）
      const bakeSize = Math.max(this.syncTexSize, targetSize);
      const syncMaps = makeStoneMaps(kind, { repeat: [1, 1], weather, size: bakeSize, channels });
      f = {
        kind,
        weather,
        channels,
        syncSize: bakeSize,
        targetSize,
        syncMaps,
        slots: []
      };
      this.families.set(key, f);
    }
    return f;
  }

  /**
   * 目标尺寸 > 上架尺寸才升级 —— **R38-P0-4 之后本方法恒为空转**：
   * `familyFor` 已把上架尺寸烘成 `max(syncTexSize, targetSize)` ⇒ 所有族的
   * `targetSize <= syncSize` 成立 ⇒ 循环体一次都不进、零异步开销。
   * 保留它是为了把「先上架后升级」这条**回退路径**留在代码里（万一将来首建时长
   * 重新变成硬约束，把 `familyFor` 的 `bakeSize` 改回 `syncTexSize` 即可复活），
   * 但**当前不会有任何一次 bakeStoneMapsAsync 被调用**。
   */
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

  /**
   * R35：石材变体材质（STONE_VARIANTS，复用基族图集 ⇒ 0 新贴图）。
   * 与 `stone()` 同享基族热升级路径：变体材质也 push 进 `family.slots`，
   * 基族同步代退役前先 swap 到目标代，避免引用被 dispose 的同步代纹理（否则渲染崩）。
   * 当前消费点：内庭围合墙 → inner-stone（暗冷做旧内壁）。
   */
  private variantMaterial(id: StoneVariantId): THREE.MeshStandardMaterial {
    const cacheKey = `variant:${id}`;
    const hit = this.matCache.get(cacheKey);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const v = STONE_VARIANTS[id];
    const texKind = v.texKind;
    const family = this.familyFor(texKind, quantizeWeather(FAMILY_WEATHER[texKind]), STONE_CHANNELS[texKind]);
    const mat = makeStoneVariantMaterial(id, family.syncMaps);
    family.slots.push({
      mat,
      targetRough: v.rough,
      usesRoughMap: family.syncMaps.roughnessMap !== null
    });
    this.matCache.set(cacheKey, mat);
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

  /** 把一个构件集按材质族摊进静态桶（含 R29 可选桶 + R36 变体桶的防御式读取） */
  private absorb(set: StoneBuckets): void {
    this.statics.ashlar.push(...set.ashlar);
    this.statics.wall.push(...set.wall);
    this.statics.gold.push(...set.gold);
    this.statics.dark.push(...set.dark);
    this.statics.flame.push(...set.flame);
    for (const key of ALL_BUCKETS) {
      const maybe = (set as unknown as Partial<Record<string, THREE.BufferGeometry[]>>)[key];
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
    // R38-P0-2 B1：z0 按 z=−150 一分为二（+1 DC/族）。−150 是 z0 实测 bbox [−359,61]
    // 的中点 ⇒ 两半各 ≈210m，长度均衡；切割走**精确裁剪**（splitGeometryByZ），
    // 不按重心近似 ⇒ 外形逐位复现。两族合计 +2 DC ⇒ 静态 30(B3 后) + 2 = **32**（硬顶）。
    this.addMergedByZone(this.statics.ashlar, this.stone('ashlar'), 'castle-ashlar', ZONE_EDGES_6, Z0_SPLIT_PLANE);
    // R35：内庭围合墙改走 inner-stone 变体（暗冷做旧内壁；复用 ashlar 图集 ⇒ 0 新贴图、0 新 DC）。
    this.addMergedByZone(this.statics.wall, this.variantMaterial('inner-stone'), 'castle-wall', ZONE_EDGES_3);
    // R31 运行时治理①延伸：gold（135k）/ dark（34k）体量远非「量小」，且沿整条御桥+城门+内城
    // 铺开（bbox 跨整个 z 走廊），若保持全局 1 个 mesh，行车时永不被视锥剔除 ⇒ 每帧全量提交。
    // 改为按 z 分区（与 ashlar 同 6 区），越过车后的区被剔除（视野前方仍可见，但已过的段不再提交）。
    // 共享同一材质（stone/dark 各自按 key 缓存）⇒ 贴图张数与 tri 不变，仅 DC 由 1→≤6（仍 < castleDc 32）。
    this.addMergedByZone(this.statics.gold, this.stone('gold'), 'castle-gold', ZONE_EDGES_6, Z0_SPLIT_PLANE);
    this.addMergedByZone(this.statics.dark, this.special('dark', () => tunnelMaterial()), 'castle-dark', ZONE_EDGES_6);
    this.addMerged(this.statics.flame, this.special('flame', () => flameMaterial()), 'castle-flame');
    // R29 新族：桶非空才建 mesh（castleKit 未补桶时这里全部跳过 ⇒ DC 不变）
    for (const key of EXTRA_BUCKETS) {
      const parts = this.extras.get(key);
      if (!parts || parts.length === 0) continue;
      this.addMerged(parts, this.stone(key), `castle-${key}`);
    }
    // R36-A2 变体桶：材质走 variantMaterial 热升级路径（0 新贴图），全局 1 mesh/桶
    for (const key of Object.keys(VARIANT_BUCKETS) as VariantBucket[]) {
      if (ZONED_VARIANT_BUCKETS.includes(key)) continue; // 分区桶在下面单独提交
      const parts = this.extras.get(key);
      if (!parts || parts.length === 0) continue;
      this.addMerged(parts, this.variantMaterial(VARIANT_BUCKETS[key]), `castle-${key}`);
    }
    // R37-A 灰石强调：走 6 区分区提交（理由见 VARIANT_BUCKETS.grey 注释）。
    // 空区不建 mesh ⇒ 只有真正铺了灰石的那个区占 1 DC（实测 1 个 ⇒ 30→31）。
    for (const key of ZONED_VARIANT_BUCKETS) {
      const parts = this.extras.get(key);
      if (!parts || parts.length === 0) continue;
      this.addMergedByZone(
        parts,
        this.variantMaterial(VARIANT_BUCKETS[key]),
        `castle-${key}`,
        ZONE_EDGES_6
      );
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
    // sets 里本轮不用的族（wall/flame/extras+变体桶）逐一释放，防首建期泄漏
    for (const s of sets) {
      for (const g of s.wall) g.dispose();
      for (const g of s.flame) g.dispose();
      for (const k of ALL_BUCKETS) {
        const arr = (s as unknown as Partial<Record<string, THREE.BufferGeometry[]>>)[k];
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
    edges: ZoneEdges,
    /**
     * R38-P0-2 B1：把 **0 区**按该 z 平面一分为二（`castle-*-z0a` / `-z0b`）。
     * 只对 ashlar / gold 传（它们各自 +1 静态 DC，总账 30 → 32，压在 castleDc 硬顶内）。
     * 依据：`ashlar-z0`+`gold-z0` 是 z 跨度 **420m** 的合批条（球 r≈212、球心在车后
     * 122m），逐三角形实测 **83.8%~100% 在视锥外**却整条递交；切成 2 段后车后那半
     * 能被整块剔除（同树仿真：R=650 峰值 241,630 → 222,406，−8.0%，且**峰值帧 DC
     * 24 → 21**，是唯一「DC 净收益」的切法，见 `tools/r38_split_sim.mjs`）。
     */
    splitZone0At?: number
  ): void {
    if (parts.length === 0) return;
    const zones = splitByZone(parts, edges);
    const family = namePrefix.replace(/^castle-/, '');
    for (let i = 0; i < zones.length; i += 1) {
      // ① 空区（零个几何）不建 mesh —— R31 起就有，是当前 tree 里唯一实际发生的空区形态
      if (zones[i].length === 0) continue;
      const raw = mergeSafe(zones[i]);
      // R38-P0-2 B1①：先按 z 细分巨型三角形（不细分 ⇒ 后面的切段在数值上 0 收益）
      const merged = subdivideLongTriangles(raw, MAX_TRI_Z_SPAN);
      if (merged !== raw) raw.dispose();
      // ② R32 C-4 补强：**零面区**也不建 mesh。区里有至少一个几何、但 merge
      //    后无面（A 线某构件退化成空 BufferGeometry / 全被密度开关裁净时）会走到这，
      //    改前会白占 1 个静态 DC 且把「看不见的东西」算进 getCastleStats.dc。
      //    当前 tree 无此情形（dc_audit.md 逐 mesh 实测最小 tri = pave-walk 4 > 0），
      //    本行是防 A 线几何漂移的护栏：零面 mesh 一出现就静默吞掉，不进预算口径。
      if (!isDrawable(merged)) {
        merged.dispose();
        continue;
      }
      // 远档同样要先细分巨型三角形（远档是行车中换入的，球不缩小 ⇒ 换档后照样误递交）
      let loRaw = this.farTier.get(`${family}-z${i}`);
      if (loRaw) {
        this.farTier.delete(`${family}-z${i}`);
        const tess = subdivideLongTriangles(loRaw, MAX_TRI_Z_SPAN);
        if (tess !== loRaw) {
          loRaw.dispose();
          loRaw = tess;
        }
      }

      if (splitZone0At !== undefined && i === 0) {
        // —— B1②：z0 一分为二（远档同平面同法切，保证两档的 a/b 段一一对应）——
        const [hiA, hiB] = splitGeometryByZ(merged, splitZone0At);
        const [loA, loB] = loRaw ? splitGeometryByZ(loRaw, splitZone0At) : [null, null];
        loRaw?.dispose();
        for (const [suffix, hiPart, loPart] of [
          ['a', hiA, loA],
          ['b', hiB, loB]
        ] as const) {
          if (!hiPart || !isDrawable(hiPart)) {
            hiPart?.dispose();
            loPart?.dispose();
            continue;
          }
          this.pushZoneMesh(hiPart, loPart ?? undefined, mat, `${namePrefix}-z0${suffix}`);
        }
        merged.dispose();
        continue;
      }

      this.pushZoneMesh(merged, loRaw, mat, `${namePrefix}-z${i}`);
    }
    parts.forEach((p) => p.dispose());
  }

  /**
   * 分区 mesh 落账：建 mesh + 按区克隆淡入材质 + 登记 zoneViews（距离显隐 / LOD / 淡入三态）。
   */
  private pushZoneMesh(
    hi: THREE.BufferGeometry,
    lo: THREE.BufferGeometry | undefined,
    base: THREE.Material,
    name: string
  ): void {
    // R38-P0-3：每个分区 mesh 独享一份**材质克隆**（淡入 uniform 必须按区独立写）。
    // 同一 program（三处注入代码全同 ⇒ `customProgramCacheKey` 一致）⇒ 0 新增 shader 变体。
    const zoneMat = this.zoneFadeMaterial(base);
    const mesh = this.addMesh(hi, zoneMat.mat, name);
    hi.computeBoundingBox();
    const bb = hi.boundingBox;
    const cz = bb ? (bb.min.z + bb.max.z) * 0.5 : 0;
    if (lo) this.geometries.push(lo); // 双档都进 dispose 账本
    this.zoneViews.push({ mesh, cz, hi, lo, tier: 'hi', fade: zoneMat.fade });
  }

  /**
   * R38-P0-3 分区淡入材质：`onBeforeCompile` 注入 `uFade` / `uFadeColor`，
   * 在 `#include <fog_fragment>` **之后**（与 three 自身雾同阶段、同色彩空间）
   * 把片元颜色向雾色 mix。
   * 🚫 **禁止改用 `transparent=true`**：那会把这些大件挪进透明队列、丢掉 early-Z，
   *    把 P0-1/P0-2 省下的填充率全赔回去（主理人死命令）。
   */
  private zoneFadeMaterial(base: THREE.Material): { mat: THREE.Material; fade: { value: number } } {
    const fade = { value: 1 };
    const mat = base.clone();
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFade = fade;
      shader.uniforms.uFadeColor = FADE_COLOR_UNIFORM;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uFade;\nuniform vec3 uFadeColor;'
        )
        .replace(
          '#include <fog_fragment>',
          '#include <fog_fragment>\n\tgl_FragColor.rgb = mix(uFadeColor, gl_FragColor.rgb, uFade);'
        );
    };
    return { mat, fade };
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
    // R38-P0-3：淡入**必须逐帧**更新（弹入那 100m 内要连续渐变），故放在滞回早退**之前**。
    // 成本：每区 1 次减法 + 1 次比较（绝大多数区在淡入带外直接跳过）⇒ 30 个区 < 1µs/帧。
    this.updateFades(z);
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

  /**
   * R38-P0-3 分区淡入：**按距离**线性淡入（`ZONE_VIEW_RANGE` → `FADE_NEAR_DIST`，
   * 即 550 → 450），把「整区一帧弹入」抹成 100m 行程的渐变。
   * 为什么按距离而不是按时间：淡入行程必须与机位位移同步，否则高速/低速下
   * 「淡入未完成就开到跟前」或「淡入过慢」都可能出现；按距离则与帧率无关。
   */
  private updateFades(z: number): void {
    const span = ZONE_VIEW_RANGE - FADE_NEAR_DIST;
    for (const zv of this.zoneViews) {
      const d = Math.abs(zv.cz - z);
      if (d <= FADE_NEAR_DIST) {
        if (zv.fade.value !== 1) zv.fade.value = 1;
        continue;
      }
      if (d >= ZONE_VIEW_RANGE) {
        // 已超出闸门 ⇒ 该帧就要被 visible=false 摘掉，淡到 0 保证「消失也是渐变」
        if (zv.fade.value !== 0) zv.fade.value = 0;
        continue;
      }
      const v = (ZONE_VIEW_RANGE - d) / span;
      if (Math.abs(v - zv.fade.value) > 0.002) zv.fade.value = v;
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
      // R38-P0-3：QA 自由机位要拍的是**不淡**的实体 ⇒ 淡入必须归 1，否则整片灰雾
      zv.fade.value = 1;
      if (zv.tier !== 'hi') this.setZoneTier(zv, 'hi');
    }
    this.lastViewerZ = Number.NaN;
  }
}
