/**
 * R31 FBX 构件库程序化复刻 —— 环境几何线 A（耿键码，2026-10-24）
 *
 * ── R31 相对 R30 的口径变化（用户令）──────────────────────────────────────
 * ① 「构建时长无限制，运行时必须流畅」：单件 tri 上限放宽（单件 ≤ R30 ×2），
 *    但铺量纪律不变 —— 几何密度靠**复用形体 + 合批**（castle.ts 每桶 merge 成
 *    1 mesh），不靠大面片叠加（fill rate 才是核显瓶颈，R27/R29 closeout 实证）。
 * ② 构件从「示意级」升「FBX 级雕刻」：所有形体参数不再目视估，全部来自
 *    `.qa/r31_fbx/shape_*.json` 顶点实测（tools/r31_fbx_shape.py，立面切片法）。
 *
 * ── R31 FBX 实测参数表（复刻依据，出处 .qa/r31_fbx/shape_sm_det/gat.json）────
 * · 飞扶壁 Contrforce_1（1.79×6.64×2.19）：**实心弧撑**——顶缘近直线自墙面
 *   斜落至墩顶，底缘（soffit）为向下凸的拱弧（立面切片 spring=0.04，rise=6.41）；
 *   Contrforce3_Full_2（1.68×18.21×0.73）：高细墩，收分曲线 [1,0.87,0.83,0.74…0.48]
 *   （上部收 26%），底部独立基座。⇒ 复刻 = 高细墩 + 双弧撑（主撑 + 下层副拱肋）
 *   + 墩顶小尖塔（Decor_9 语汇）。
 * · 窗 Window 全系：Window2_4（1.45×1.94×0.14）立面 = **大尖拱内含 2 子尖拱光**
 *   （中段成员数 4 = 双子拱 + 双边框）；Window1_Full（1.05×7.01）成员 3 =
 *   双边框 + 单中央棂；棂宽实测 0.17~0.22（maxRun），窗宽 0.81~1.45 ⇒
 *   **棂宽 ≈ 窗宽 0.18~0.21**；厚 0.14（浮雕 2 层）/ Window3 0.34（4 层）。
 *   ⇒ 复刻 = 大尖拱框 + 2 子尖拱 + 中央棂 + 头部圆光 + 玻璃底板（glass 桶）。
 * · 盲拱 Arch_3.001（6.11×14.65×1.16）：龛口宽 5.42 = 模块宽 0.887（taper 恒定
 *   0.8868），尖拱头，**龛深 1.16m** ⇒ 盲拱列必须有真实凹深（dark 内壁）。
 * · 雕像龛 Decor：Decor_4（1.70×4.45×0.44，spring 0.42 = 龛楣分叉）/Decor_6
 *   （2.06×5.62， relief 2 层）——龛体薄（0.32~0.57），顶部分叉出尖拱楣。
 *   ⇒ 复刻 = 凹龛（dark 内壁 + 侧壁 + 拱头）+ 金框 + 龛楣卷叶 + 4 段雕像。
 * · 小尖塔 Decor_9（1.44×2.83×1.25）：方座 → 退台 → 八棱鼓 → 锥顶（relief 7）。
 *   ⇒ pinnacleCluster = 主尖塔（Decor_9 全形）+ 4 角副尖塔（退台 + 锥）。
 * · 檐口 Cornice_2_Full（18.30×1.41×0.68）：4 层退台（relief 4）——corniceBand
 *   的 2 层石 + 1 金线即此语汇，层数不动。
 * · 柱 Collumn8_Full（1.42×15.25×1.60）：柱身细长 1:10.7，顶 6% 为柱头
 *   （spring 0.94）；Collumn1_Full 1:6.8。⇒ capitalCollar 的 0.5h 柱头 + 收分托石。
 * · 宝瓶柱 Baluster_1（1.59×4.45×1.59）：taper [1,0.80,0.64,0.43…0.43,0.60,0.76,0.87]
 *   —— 上宽 → 细腰 → 鼓腹 → 撇脚。balusterPost 三段收分保持。
 * · 钟 WCBell_1（4.95×4.83×3.21，含吊梁）：钟体宽/高 ≈ 0.77，唇缘外撇。
 *   ⇒ 钟楼钟体 = 三段收分金钟（碗身 + 束腰 + 顶冠）+ 钟唇横杆。
 *
 * ── 坐标 / UV 口径（与 castleKit 完全一致，不发明新方案）──────────────────
 * 一切形体先按**局部坐标**产，再由调用方（castleKit）一次性镜像/平移到世界：
 *   · 墙面在 x=0、墙体向 +x 延伸（朝街面 = −x）；沿街排列轴 = z，块心 z=0；
 *   · 尖拱件默认**无法线**，finishArch / planarUV 收尾（进口 castleKit，禁本地另写）；
 *   · 米制 UV：金件统一按 STONE_TILE_METERS.gold（1.2m）——archBand 自带的是
 *     ashlar 6.4m 口径，金环金线这类小件必须覆写，否则金饰纹理被放大 5 倍。
 *
 * ── 低配档（铁律 33：只降装饰密度，不改几何长度）──────────────────────────
 * isLowDetail() 时：卷叶 crocket 整族跳过（与 castleKit R29 同规矩）、窗棂/子拱/
 * 圆光跳过（窗的"尖拱+玻璃"识别度保留）、栏板瓶柱密度减半；飞扶壁/盲拱/连廊/
 * 角塔/钟楼/后殿等**结构件一律保留**。
 *
 * ── 可选桶（roof/wood/glass/marble）────────────────────────────────────
 * castle.ts 的 EXTRA_BUCKETS 防御式读取：DetailParts 增加可选键，pour() 摊进
 * castleKit 桶对象的同名键（castleKit.ts 侧 `extra()` 懒建数组）。**不新增其它
 * 桶类型**。
 *
 * ⚠ **R32-A2 实测更正（原注释「静态 DC ≤ 18」已过期，勿再引用）**：
 *   castle 静态 **DC = 27**（high/low 两档同，`.qa/r32_tmp_castle/r32_visible_probe.json`）：
 *     ashlar 6 区 + gold 6 区 + wall 3 区 + dark 5 区（z0 空）+ flame 1
 *     + roof 1 + wood 1 + glass 1 + marble 1 + pave-road 1 + pave-walk 1 = 27
 *   设计上限 28 ≤ R31_BUDGET.castleDc 32。
 *
 * ⚠ **可选桶的剔除口径（R32-A2 visibleTri 越线教训，务必记住）**：
 *   **五个桶各是 1 个 mesh 跨全街**（roof z−361..−1451 / glass −351..−1330 /
 *   wood −352..−1328 / marble −363..−1305 / flame +38..−1315），**既不参与
 *   z-zone 分区剔除，也不享受 `updateViewerZ` 的距离摘除 + LOD 换档** ⇒ 往这些桶
 *   每加 1 tri，六点采样的**每个**机位都按 1 tri **全额**计入 visibleTri。
 *   而 ashlar/gold/dark/wall 是分区桶，远区 tri 只按 0~0.5 计。
 *   ⇒ 加材料丰富度前先算「m² 增益 / 不可剔除 tri 成本」；把大面积低 tri 的形体
 *     （如远景塔尖披顶）放进来最划算，小面积高 tri 的（如 crookedSpire 锥顶
 *     0.86 m²/tri）最亏。
 *
 * ── 预算（R31：单件 ≤ R30×2；铺量账见 castleKit 挂载点注释）────────────────
 * 单件 tri 上限：飞扶壁 ≤170 / 盲拱龛 ≤110 / 花格窗 ≤150 / 卷叶 ≤20 / 雕像龛 ≤170 /
 * 檐口 ≤36 / 柱头 ≤20 / 瓶柱 ≤36 / 连廊段 ≤340 / gothicBay ≤300 / 后殿 ≤140 /
 * 钟楼 ≤320 / 回廊柱列(每 8 开间) ≤340。总账见 .qa/r31_a_report.md。
 *
 * ── R32 增量（用户令：构件与环境做到与参考图近乎一致）────────────────────
 * ① flyingButtress：+coping（墩顶尖拱覆盆）/ +goldStrips（墩身竖金条）/
 *    +pairGap（扶壁对——参考图 B 主塔两侧 3 对递减扶壁）；
 * ② traceryWindow：+recess（窗洞凹龛侧壁，dark，参考图 A/B 窗洞阴影深度）；
 * ③ balusterPost：+collar（柱顶金箍环）/ +coping（小型尖拱覆盆，参考图 B 桥栏杆）；
 * ④ corniceBand：金饰 2→3 道（参考图 B 第 2/4 层间横向金带）；
 * ⑤ gildedScreen：+strips（屏面竖向金条间距节拍）；
 * ⑥ finialOrnament：+flankDiamonds（两侧金菱形，参考图 A 城门楣）；
 * ⑦ bellTower：钟楼层圆形钟表（金面 + 罗马字刻度环 + 双针，直径 = 塔宽 1/6）
 *    + 钟摆；钟/摆改挂双拱开口前缘（原在塔心被实心墩挡住，街面不可见）。
 *    以上新增项默认全关/保守，由 castleKit 近区挂载点显式开启（预算纪律）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { STONE_TILE_METERS } from './stoneTexture';
import {
  archBand,
  archPlate,
  box,
  boxRot,
  finishArch,
  isLowDetail,
  pierColumn,
  planarUV,
  pointedArch,
  spire
} from './castleKit';
import type { StoneBuckets } from './castleKit';

/**
 * 远区（最深 z 区）装饰减法标志（铁律 33 合规 · 第 7 项）。
 * 由 castleKit 在「最远 1/3 街区」构建前 setDeepFar(true)：跳过卷叶 / 子拱 /
 * 窗棂 / 壁龛立像 / 瓶柱加密等纯装饰密度，几何长度不变、结构件（尖塔身 / 飞扶壁
 * 墩拱 / 檐口）一律保留。低配档（isLowDetail）原本就裁这些，DEEP_FAR 对其无额外作用。
 */
let DEEP_FAR = false;

export function setDeepFar(far: boolean): void {
  DEEP_FAR = far;
}

/** 金件 UV 口径（archBand/archPlate 自带的是 ashlar 6.4m，金饰必须覆写成 1.2m） */
const GOLD_TILE = STONE_TILE_METERS.gold;

/** castle.ts EXTRA_BUCKETS 的镜像键（casteDetail 只产这四个可选桶，不新增其它） */
export type ExtraBucketKey = 'roof' | 'wood' | 'glass' | 'marble';
const EXTRA_KEYS: readonly ExtraBucketKey[] = ['roof', 'wood', 'glass', 'marble'];

/* ═══════════════════ 分桶容器（与 StoneBuckets 同构的小件包 + 可选桶） ═══════════════════ */

/** 构件族产出的分桶几何（wall/flame 多数族为空，但保持同构方便 pour） */
export interface DetailParts {
  ashlar: THREE.BufferGeometry[];
  wall: THREE.BufferGeometry[];
  gold: THREE.BufferGeometry[];
  dark: THREE.BufferGeometry[];
  flame: THREE.BufferGeometry[];
  /** R31 可选桶（castle.ts EXTRA_BUCKETS 防御式读取；空数组等价于未提供） */
  roof?: THREE.BufferGeometry[];
  wood?: THREE.BufferGeometry[];
  glass?: THREE.BufferGeometry[];
  marble?: THREE.BufferGeometry[];
}

function parts(): DetailParts {
  return { ashlar: [], wall: [], gold: [], dark: [], flame: [] };
}

/** 把构件族产出整体摊进 castleKit 的桶（含 R31 可选桶：懒建同名数组） */
export function pour(b: StoneBuckets, p: DetailParts): void {
  b.ashlar.push(...p.ashlar);
  b.wall.push(...p.wall);
  b.gold.push(...p.gold);
  b.dark.push(...p.dark);
  b.flame.push(...p.flame);
  const dst = b as unknown as Record<string, THREE.BufferGeometry[] | undefined>;
  for (const k of EXTRA_KEYS) {
    const arr = p[k];
    if (arr && arr.length > 0) {
      if (!dst[k]) dst[k] = [];
      dst[k].push(...arr);
    }
  }
}

/**
 * 对构件族产出的**每一条**几何施加同一变换（ castleKit 的 put() 镜像 / 挂载平移）。
 * 调用方典型用法：
 *   pour(b, mapParts(traceryWindowX({...}), (g) => put(g.translate(0, 8.5, wz))));
 */
export function mapParts(
  p: DetailParts,
  f: (g: THREE.BufferGeometry) => THREE.BufferGeometry
): DetailParts {
  const out: DetailParts = {
    ashlar: p.ashlar.map(f),
    wall: p.wall.map(f),
    gold: p.gold.map(f),
    dark: p.dark.map(f),
    flame: p.flame.map(f)
  };
  for (const k of EXTRA_KEYS) {
    const arr = p[k];
    if (arr && arr.length > 0) out[k] = arr.map(f);
  }
  return out;
}

/* ═══════════════════ 私有基元 ═══════════════════ */

/**
 * 沿点列的等厚条带（x-y 剖面，沿 −z 挤出 depth）——飞扶壁拱肋 / 拱廊拱带。
 * 法线取中心差分（端点单侧），条带 = 外偏 +band/2 与内偏 −band/2 两条点列闭合。
 * tri = 4×(2N)−4 = 8N−4（N = 中心线点数；N=6 ⇒ 44 tri）。
 */
function thickStrip(
  pts: readonly (readonly [number, number])[],
  band: number,
  depth: number
): THREE.BufferGeometry {
  const n = pts.length;
  const outer: [number, number][] = [];
  const inner: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const q = pts[Math.max(0, i - 1)];
    const r = pts[Math.min(n - 1, i + 1)];
    let tx = r[0] - q[0];
    let ty = r[1] - q[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const nx = -ty;
    const ny = tx;
    outer.push([pts[i][0] + (nx * band) / 2, pts[i][1] + (ny * band) / 2]);
    inner.push([pts[i][0] - (nx * band) / 2, pts[i][1] - (ny * band) / 2]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < n; i += 1) shape.lineTo(outer[i][0], outer[i][1]);
  for (let i = n - 1; i >= 0; i -= 1) shape.lineTo(inner[i][0], inner[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.translate(0, 0, -depth);
  return finishArch(geo, STONE_TILE_METERS.ashlar);
}

/** 把「拱形 + 沿 z 挤出」的几何转成「沿 −x 挤出（x∈[−depth,0]，挑出墙面）」 */
function archToFaceX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateY(Math.PI / 2); // z∈[−depth,0] → x∈[−depth,0]；拱跨映射到 z（对称，符号无关）
  return g;
}

/** 把「拱形 + 沿 z 挤出」的几何转成「沿 +x 挤出（x∈[0,depth]，嵌进墙体）」 */
function archIntoWallX(g: THREE.BufferGeometry, depth: number): THREE.BufferGeometry {
  g.rotateY(Math.PI / 2);
  g.translate(depth, 0, 0);
  return g;
}

/** 金件 UV 覆写（小件必须走 1.2m 金口径，见文件头） */
function goldUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  planarUV(g, GOLD_TILE);
  return g;
}

/**
 * **真实凹龛内壁**（R31 核心件）：回填 = 后背拱板 + 两侧壁 + 拱头腹板，
 * 全部 dark 桶、按 `recess` 深度嵌进墙体 ⇒ 近黑腔体产生真实凹陷阴影
 * （R30 只有 flush 拱板，龛"平贴"墙面读不出深度）。
 * 局部：墙面 x=0、龛体嵌 +x（深 recess+back）、拱跨沿 z、龛底 y=0。
 * tri = 板 12 + 侧壁 24 + 拱头 24 ≈ 60。
 */
function nicheCavity(
  halfW: number,
  rise: number,
  recess: number,
  back: number,
  cusp: number
): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = [];
  // ① 后背拱板（龛底，最深处）
  const plate = archPlate(halfW, 0, rise, back, 2, cusp);
  g.push(archIntoWallX(plate, back).translate(recess, 0, 0));
  // ② 两侧壁（从墙面 x=0 到龛底 x=recess）
  for (const s of [-1, 1] as const) {
    g.push(box('dark', recess + back, rise * 0.72, 0.14, (recess + back) / 2, rise * 0.36, s * (halfW - 0.07)));
  }
  // ③ 拱头腹板（拱外廓与墙面之间的斜面，读作龛楣厚度）
  const hood = archPlate(halfW + 0.3, 0, rise * 1.12, recess * 0.8, 2, cusp);
  g.push(archIntoWallX(hood, recess * 0.8).translate(-0.02, 0, 0));
  return g;
}

/* ═══════════════════ ① 飞扶壁族（Contrforce：墩 + 双弧撑 + 小尖塔） ═══════════════════ */

/**
 * FBX 实测（见文件头参数表）：R31 升级为**真哥特剖面**——
 *   ① 外墩：高细收分柱（Contrforce3_Full_2 taper 1→0.74）+ 两级基座；
 *   ② 主弧撑：6 点中心线等厚条带（44 tri），顶缘近直、底缘（soffit）下凸拱弧；
 *   ③ 副拱肋：第二道更细的飞拱（双飞扶壁语汇，主殿/连墙上带最显著）；
 *   ④ 墩顶小尖塔：Decor_9 语汇（方座退台 + 八棱鼓 + 锥顶，金尖）。
 *
 * ── R32 参考图 B 精化（A 线）────────────────────────────────────────────
 * 参考图全景正面：**主塔/殿立面两侧各 3 对递减扶壁**，墩顶为**尖拱覆盆**
 * （coping：小尖拱压顶石）+ 墩身**竖向金条**。本轮新增三选项（默认关闭，
 * 由 castleKit 近区挂载点显式开）：
 *   · `coping`：墩顶尖拱覆盆（archBand 2 段 ≈20 tri）——「扶壁顶收口」读法；
 *   · `goldStrips`：墩身两dz 面各一道竖向金条（2×12 tri）；
 *   · `pairGap`：**扶壁对**——同位置双墩（z ±gap/2），参考图「3 对递减」的
 *     「对」即此；主殿正立面每侧 3 对（reach/springY 递减）。
 *
 * 局部约定：墙面 x=0、扶壁向 +x 伸出、z 居中（depth 沿 z）。单件 ≈150 tri
 * （墩 16 + 基座 24 + 主撑 44 + 副肋 36 + 尖塔 44；低配档：副肋/尖塔金件保留
 * 结构、卷叶跳过——副肋属结构件不裁，铁律 33 只裁装饰密度）。
 *
 * @param springY 起拱 y（墩顶）
 * @param topY    落点 y（墙面受荷点）
 * @param reach   水平跨距（墙面 → 墩心）
 */
export interface ButtressOpts {
  baseY?: number;
  springY: number;
  topY: number;
  reach: number;
  depth?: number;
  band?: number;
  pierW?: number;
  pinnacle?: boolean;
  /** 副拱肋（双飞扶壁）：默认 true（R31 起，参考图最显著语汇） */
  secondArch?: boolean;
  /** 墩顶尖拱覆盆（R32：参考图 B 扶壁顶收口；默认 false，近区挂载点开） */
  coping?: boolean;
  /** 墩身竖向金条 ×2（R32：参考图 B 扶壁墩金饰；默认 false） */
  goldStrips?: boolean;
  /** 扶壁对：双墩 z 间距（>0 时同位置起双墩；参考图「3 对递减扶壁」；默认 0 单墩） */
  pairGap?: number;
}

export function flyingButtress(o: ButtressOpts): DetailParts {
  const p = parts();
  const baseY = o.baseY ?? 0;
  const depth = o.depth ?? 0.9;
  const band = o.band ?? 0.66;
  const pierW = o.pierW ?? 1.7;
  const rise = o.topY - o.springY;
  const pierX = o.reach - pierW * 0.5;
  const pairGap = o.pairGap ?? 0;
  const pierZs: readonly number[] = pairGap > 0 ? [-pairGap / 2, pairGap / 2] : [0];
  const pierH = o.springY - baseY - 1.0;

  // ① 外墩（pairGap>0 时为扶壁对）：两级基座 + 收分柱（Contrforce3_Full_2：底宽 1 → 顶宽 0.74）
  for (const pz of pierZs) {
    p.ashlar.push(box('ashlar', pierW + 1.1, 0.5, depth + 1.1, pierX, baseY + 0.25, pz));
    p.ashlar.push(box('ashlar', pierW + 0.6, 0.45, depth + 0.6, pierX, baseY + 0.72, pz));
    p.ashlar.push(pierColumn(pierW, pierW * 0.74, pierH, pierX, baseY + 0.95, pz));
    // ①b 墩顶尖拱覆盆（R32：archBand 2 段小尖拱坐在墩收分柱顶，读作压顶石）
    if (o.coping) {
      const cp = archBand(pierW * 0.44, o.springY + 0.02, pierW * 0.55, 0.24, depth * 0.96, 2, 0.5, 0.45);
      cp.translate(0, 0, pz);
      p.ashlar.push(cp);
    }
    // ①c 墩身竖向金条 ×2（R32：贴在墩的 ±z 面，参考图扶壁墩金饰）
    if (o.goldStrips) {
      for (const sz of [-1, 1] as const) {
        p.gold.push(goldUV(box('gold', pierW * 0.5, pierH * 0.82, 0.14, pierX, baseY + 0.95 + pierH * 0.45, pz + sz * (depth / 2 + 0.02))));
      }
    }
  }
  // ② 主弧撑：6 点中心线（顶缘近直 + 底缘下凸由条带自然给出）；两端各留咬合
  const cl: readonly (readonly [number, number])[] = [
    [pierX + pierW * 0.28, o.springY + 0.10],
    [o.reach * 0.82, o.springY + rise * 0.22],
    [o.reach * 0.60, o.springY + rise * 0.46],
    [o.reach * 0.36, o.springY + rise * 0.70],
    [o.reach * 0.16, o.springY + rise * 0.90],
    [0.12, o.topY - 0.10]
  ];
  p.ashlar.push(thickStrip(cl, band, depth));
  // ③ 副拱肋（双飞扶壁）：更低更细的第二道飞拱，落点在墙面 topY − rise·0.3
  if (o.secondArch !== false && rise > 2.5) {
    const cl2: readonly (readonly [number, number])[] = [
      [pierX + pierW * 0.3, o.springY - rise * 0.16],
      [o.reach * 0.72, o.springY + rise * 0.02],
      [o.reach * 0.44, o.springY + rise * 0.18],
      [0.12, o.topY - rise * 0.3]
    ];
    p.ashlar.push(thickStrip(cl2, band * 0.62, depth * 0.8));
  }
  // ④ 墩顶小尖塔（Decor_9：方座退台 + 八棱鼓 + 金锥；hero 档，低配保留结构件）
  if (o.pinnacle) {
    const px = pierX;
    const py = o.springY;
    p.ashlar.push(box('ashlar', pierW * 1.25, 0.42, depth * 1.2, px, py + 0.21, 0));
    p.ashlar.push(spire('ashlar', pierW * 0.52, pierW * 0.4, pierW * 0.9, 6, px, py + 0.42, 0));
    const cone = new THREE.ConeGeometry(pierW * 0.3, 1.3, 4, 1);
    cone.translate(px, py + 0.42 + pierW * 0.9 + 0.65, 0);
    p.gold.push(goldUV(cone));
    const bead = new THREE.CylinderGeometry(0.2, 0.2, 0.3, 6, 1, true);
    bead.translate(px, py + 0.42 + pierW * 0.55, 0);
    p.gold.push(goldUV(bead));
  }
  return p;
}

/* ═══════════════════ ② 尖拱凹龛盲拱列（Arch_3.001：龛口 0.887×模块 / 深龛） ═══════════════════ */

/**
 * R31 升级：龛从 flush 拱板升为**真实凹腔**（nicheCavity：后背板 + 侧壁 + 楣腹，
 * 深 plateBack×2）⇒ 近黑腔体阴影。金框/间柱/通长金线不变。
 * FBX 依据 Arch_3.001：龛口 = 模块宽 0.887、龛深 1.16m（模块深）——本件默认
 * plateBack 0.9（龛总深 ≈1.35m，按街墙比例缩放）。
 *
 * 局部约定：墙面 x=0、龛内衬嵌进 +x、金框挑出 −x、沿 z 排列（块心 z=0）、龛底 y=0。
 * 单龛 ≈100 tri（凹腔 60 + 金框 32 + 间柱 12），另每行 2 条通长金线。
 *
 * @param count 龛数
 * @param halfW 龛净宽（尖拱半宽）
 * @param rise  龛拱高（springY=0 起）
 * @param pitch 龛心距（默认 2×halfW + 1.0）
 */
export interface ArcadeOpts {
  count: number;
  halfW: number;
  rise: number;
  pitch?: number;
  plateBack?: number;
  frameOut?: number;
  pierW?: number;
  cusp?: number;
}

export function blindArcadeRow(o: ArcadeOpts): DetailParts {
  const p = parts();
  const count = Math.max(1, o.count);
  const pitch = o.pitch ?? o.halfW * 2 + 1.0;
  const plateBack = o.plateBack ?? 0.9;
  const frameOut = o.frameOut ?? 0.35;
  const pierW = o.pierW ?? Math.max(0.5, o.halfW * 0.5);
  const cusp = o.cusp ?? 0.5;
  const darks: THREE.BufferGeometry[] = [];
  const rings: THREE.BufferGeometry[] = [];
  const stones: THREE.BufferGeometry[] = [];
  const golds: THREE.BufferGeometry[] = [];

  const pilaster = (pz: number): void => {
    stones.push(
      box('ashlar', frameOut + 0.55, o.rise * 1.16, pierW, -(frameOut + 0.55) / 2 + 0.1, o.rise * 0.58, pz)
    );
    golds.push(box('gold', 0.14, o.rise * 1.0, 0.16, -frameOut - 0.05, o.rise * 0.5, pz));
  };

  for (let i = 0; i < count; i += 1) {
    const zc = (i - (count - 1) / 2) * pitch;
    // 低配档隔龛布置（铁律 33）：龛腔 + 金环 ≈92 tri/龛，隔龛省半 —— 隔柱节奏不变
    if (isLowDetail() && i % 2 === 1) continue;
    // ① 真实凹腔（后背板 + 侧壁 + 楣腹，全 dark）
    for (const g of nicheCavity(o.halfW - 0.05, o.rise, plateBack * 0.55, plateBack * 0.45, cusp)) {
      darks.push(g.translate(0, 0, zc));
    }
    // ①b 壁龛立像（简化 3 段：袍座 + 躯干 + 头珠；低配 / 远区跳过——铁律 33 只裁密度）
    //     坐在凹腔底（x = 腔深中段），读作"真人尺度的供奉立像"，补全参考图盲拱列语汇。
    if (!isLowDetail() && !DEEP_FAR) {
      const bodyR = o.halfW * 0.3;
      const sb = plateBack * 0.32;
      p.ashlar.push(spire('ashlar', bodyR * 1.3, bodyR * 0.9, o.rise * 0.22, 5, sb, 0.02, zc));
      p.ashlar.push(spire('ashlar', bodyR * 0.9, bodyR * 0.6, o.rise * 0.3, 5, sb, o.rise * 0.22, zc));
      const head = new THREE.CylinderGeometry(o.halfW * 0.13, o.halfW * 0.13, o.halfW * 0.3, 6, 1, true);
      head.translate(sb, o.rise * 0.54 + bodyR * 0.7, zc);
      p.ashlar.push(head);
    }
    // ② 金框（尖拱环，挑出墙面 −x）
    const ring = archBand(o.halfW, 0, o.rise, 0.16, frameOut, 2, cusp, 0.45);
    rings.push(goldUV(archToFaceX(ring)).translate(0, 0, zc));
    // ③ 龛间隔柱（左边界；右边界由下一龛/行末柱承担）
    pilaster(zc - pitch / 2);
  }
  pilaster(((count - 1) / 2) * pitch + pitch / 2);

  // ④ 龛顶 / 龛底通长金线
  const rowLen = (count - 1) * pitch + o.halfW * 2 + pierW;
  golds.push(box('gold', 0.2, 0.14, rowLen, -0.1, o.rise * 1.04, 0));
  golds.push(box('gold', 0.2, 0.14, rowLen, -0.1, 0.06, 0));

  p.dark.push(mergeSafe(darks));
  p.gold.push(mergeSafe(rings), mergeSafe(golds));
  p.ashlar.push(mergeSafe(stones));
  darks.forEach((g) => g.dispose());
  rings.forEach((g) => g.dispose());
  golds.forEach((g) => g.dispose());
  stones.forEach((g) => g.dispose());
  return p;
}

/* ═══════════════════ ③ 窗花格分格尖拱窗（Window2_4：大尖拱 + 2 子尖拱 + 圆光） ═══════════════════ */

/**
 * FBX Window 全系（参数表见文件头）。R31 升级三件：
 *   ① **子尖拱光**（subArches）：大尖拱内 2 道小尖拱（Window2_4 立面成员 4 实证），
 *      由中央棂分隔；subW = halfW×0.62 / subRise = rise×0.52。
 *   ② **头部圆光**（lights 升级）：6 面开口薄筒环（16 tri）替代原拱肩小圆光，
 *      位置 = 拱头（子拱顶之上）。
 *   ③ **玻璃底板**（glass 桶）：2 tri 薄板嵌在背板前 0.06m —— 四桶点亮 + 窗读
 *      "实心彩窗"（glass 材质 rough 0.12 / env 1.7 ⇒ 反射暗面）。
 * 棂宽按实测 0.18×窗宽；竖棂保留（低配跳过）。
 *
 * 局部约定（与 lancetWindowX/Z 一致）：
 *   face 'x'：墙面 x=0、墙体向 +x；券框挑出 −x（x∈[−frameOut,0]）、背板嵌 +x；
 *             拱沿 z 跨（窗洞水平轴 = z）。
 *   face 'z'：墙面 z=0、墙体向 −z；券框挑出 +z（z∈[0,frameOut]）、背板嵌 −z；
 *             拱沿 x 跨。
 * 单件：基础（券框+背板+玻璃）72 tri；+棂 24 / +子拱 52 / +圆光 20 ⇒ 全开 ≤168。
 */
export interface TraceryOpts {
  halfW: number;
  rise: number;
  cusp?: number;
  band?: number;
  frameOut?: number;
  plateBack?: number;
  /**
   * 竖棂枝数。**R34**：允许显式 `0` —— 近中区回砍要求「窗棂 + 子拱光」这组
   * <0.3m 的重复细饰在非 hero 街区整体关闭（原本只有 low / DEEP_FAR 会关），
   * 由调用方按街区密度档传入；`0` 与 low 档内部自裁同一语义（mullions=0）。
   */
  mullions?: 0 | 2 | 3;
  lights?: boolean;
  /** 子尖拱光（Window2_4 语汇）；默认窗宽 ≥1.6 时自动开启 */
  subArches?: boolean;
  /** 玻璃底板（glass 桶）；默认 true */
  glass?: boolean;
  /** 窗洞凹龛侧壁（R32：参考图 A/B 窗洞的阴影深度——洞口内壁而非平背板）；
   *  true 时在背板前缘两侧补 dark 侧壁（2×12 tri），近景窗读作真实凹洞 */
  recess?: boolean;
  /**
   * R32-A2 · **券框桶位**（gold 桶收敛，主理人 T1）：
   * true（默认）= 金券框（参考图 B「狭长尖拱窗（金线框）」/ 图 A「金色十字格内芯」，
   *   仅**近景主立面**（城门 / 塔群 / 主殿 / 近区街面）应为 true）；
   * false = 券框落 **ashlar**（石券）—— 参考图远景/背景建筑是「白石为主」，
   *   480 扇内城窗全金框会把金饰读成"金城"，与本波次定案（金色仅点缀）冲突。
   * 只换桶位，**tri 与形体零变化**（UV 口径：gold 走 GOLD_TILE，ashlar 走 ashlar）。
   */
  goldFrame?: boolean;
  /**
   * R32-A2 · **窗内花格（子尖拱光 / 圆光）桶位**：默认 false = **ashlar**（石作）。
   * 依据：FBX Window 全系实测（本文件头）「双边框 + 单中央棂」为**石作分格**，
   *   金只在**外框券线**；参考图 A 的「金色十字格内芯」是**主塔主窗**（hero，
   *   由 makeTowerGroup / makeGate 显式开 true），不是 480 扇背景窗的通用读法。
   */
  goldTracery?: boolean;
}

function traceryWindow(o: TraceryOpts & { face: 'x' | 'z' }): DetailParts {
  const p = parts();
  const halfW = o.halfW;
  const rise = o.rise;
  const cusp = o.cusp ?? 0.7;
  const band = o.band ?? 0.22;
  const frameOut = o.frameOut ?? 0.45;
  const plateBack = o.plateBack ?? 0.3;
  const low = isLowDetail();
  // 低配档（铁律 33 装饰密度）：棂 / 子拱 / 圆光整组跳过；券框 3 段→2 段；
  // 玻璃板保留（2 tri，窗的实心读法）。实测省 ≈96 tri/扇。
  const mullions = low || DEEP_FAR ? 0 : (o.mullions ?? 2);
  const subs = low || DEEP_FAR ? false : (o.subArches ?? halfW * 2 >= 1.6);
  const faceX = o.face === 'x';
  // R32-A2 券框桶位：goldFrame=false ⇒ 石券（ashlar），见 TraceryOpts.goldFrame
  const goldRing = o.goldFrame !== false;
  const goldTrac = o.goldTracery === true;

  // ① 券框（尖拱环；底边即窗台线）
  const ring = archBand(halfW, 0, rise, band, frameOut, low ? 2 : 3, cusp, 0.45);
  if (faceX) archToFaceX(ring);
  else ring.rotateY(Math.PI); // z∈[0, frameOut]
  if (goldRing) p.gold.push(goldUV(ring));
  else p.ashlar.push(ring);
  // ② 近黑背板（2 段尖拱板）
  /**
   * R34 埋件修复：**窗洞内腔必须探出墙外皮**。
   * 局部约定里「墙体向 +x（face 'x'）/ 向 −z（face 'z'）」⇒ `archIntoWallX` 把板
   * 放到 **墙里**（x∈[0,plateBack]），而墙是**实心盒**（殿身/塔身没有任何开洞），
   * 改前背板 + 玻璃整块埋在墙内 ⇒ 476 扇窗在街面只读到「白墙 + 一圈券框」，
   * 既没有「窗洞深 2–3 倍窗宽」的凹腔读法、又白占 ~8.6k tri（glass 桶实测世界
   * |x| ≥ 15.56 > 墙外皮 15.50，`.qa/r34_castle/bury.ts` 取证）。
   * 修法：**沿视线反方向抬出墙外皮** —— 背板前脸抬到 −0.06，玻璃抬到 −0.14
   * （= 背板前缘再前 0.08），都仍在券框外脸（−frameOut ≈ −0.45）之内 ⇒ 读作
   * 「券框里嵌一块深色窗腔 + 一层玻璃」，零 tri 变化。
   */
  const PROUD_PLATE = 0.06; // 背板前脸探出墙外皮的米数
  const PROUD_GLASS = 0.14; // 玻璃探出墙外皮的米数（> 背板 ⇒ 玻璃压在腔前）
  const plate = archPlate(halfW - band * 0.55, 0, rise, plateBack, 2, cusp);
  if (faceX) archIntoWallX(plate, plateBack).translate(-PROUD_PLATE, 0, 0);
  else plate.translate(0, 0, PROUD_PLATE);
  p.dark.push(plate);
  // ②b 凹龛侧壁（R32：洞口左右两侧的 dark 内壁，读作"窗洞凹进墙里"的阴影深度；
  //      nicheCavity 同款语汇的窗用版——只在近景挂载点显式开启，控 tri）
  if (o.recess && !low) {
    const sideH = rise * 0.9;
    const sideD = plateBack * 1.1;
    for (const s of [-1, 1] as const) {
      const wall =
        faceX
          ? box('dark', sideD, sideH, 0.14, sideD / 2, sideH / 2 + 0.04, s * (halfW - band * 0.55 - 0.07))
          : box('dark', 0.14, sideH, sideD, s * (halfW - band * 0.55 - 0.07), sideH / 2 + 0.04, -sideD / 2);
      p.dark.push(wall);
    }
  }
  // ③ 玻璃底板（glass 桶；压在背板前缘 **外侧**，不与背板/棂共面 ⇒ 无 z-fighting）
  //    ⚠ R34：原写法把玻璃推成 x∈[+0.06,+0.11]（**更深处**）—— 符号反了（+x 是墙里），
  //    整块埋进实心墙。现改为探出墙外皮 0.14m，见上方「R34 埋件修复」注释。
  if (o.glass !== false) {
    const gp = archPlate(halfW - band * 0.9, 0, rise * 0.995, 0.05, 2, cusp);
    if (faceX) archIntoWallX(gp, 0.05).translate(-PROUD_GLASS, 0, 0);
    else gp.translate(0, 0, PROUD_GLASS);
    (p.glass ??= []).push(gp);
  }
  // ④ 竖棂（石，2~3 枝；顶没入拱环即"棂冠合拱"）；低配档整组跳过
  const mullW = Math.max(0.1, halfW * 0.18); // 实测棂宽 ≈0.18×窗宽
  const mullH = rise * 0.74;
  const offs = mullions >= 3 ? [-halfW * 0.52, 0, halfW * 0.52] : mullions === 2 ? [-halfW * 0.36, halfW * 0.36] : [];
  const mullionsGeo: THREE.BufferGeometry[] = [];
  for (const off of offs) {
    if (faceX) {
      mullionsGeo.push(
        box('ashlar', frameOut + plateBack * 0.55, mullH, mullW, (plateBack * 0.55 - frameOut) / 2, mullH / 2 + 0.12, off)
      );
    } else {
      mullionsGeo.push(
        box('ashlar', mullW, mullH, frameOut + plateBack * 0.55, off, mullH / 2 + 0.12, (frameOut - plateBack * 0.55) / 2)
      );
    }
  }
  // ⚠ mergeSafe([]) 会让 mergeGeometries 炸 undefined.index —— 低配档棂全跳时数组为空
  if (mullionsGeo.length) p.ashlar.push(mergeSafe(mullionsGeo));
  mullionsGeo.forEach((g) => g.dispose());
  // ⑤ 子尖拱光（Window2_4：大尖拱内 2 道小尖拱，中央棂分隔）；低配跳过。
  //   face 'x'：拱跨沿 z ⇒ 子拱偏移沿 z；face 'z'：拱跨沿 x ⇒ 偏移沿 x。
  if (subs) {
    const subW = halfW * 0.62;
    const subRise = rise * 0.52;
    const subOff = halfW * 0.33;
    const subGeo: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1] as const) {
      const ring2 = archBand(subW, 0, subRise, band * 0.7, frameOut * 0.6, 2, cusp * 0.7, 0.45);
      if (faceX) {
        archToFaceX(ring2);
        ring2.translate(0, 0, s * subOff);
      } else {
        ring2.rotateY(Math.PI);
        ring2.translate(s * subOff, 0, 0);
      }
      subGeo.push(goldTrac ? goldUV(ring2) : ring2);
    }
    // R32-A2：默认石作花格（ashlar）；仅 hero 窗显式 goldTracery:true 才鎏金
    if (goldTrac) p.gold.push(mergeSafe(subGeo));
    else p.ashlar.push(mergeSafe(subGeo));
    subGeo.forEach((g) => g.dispose());
  }
  // ⑥ 头部圆光（金环 6 面，拱头处）；低配跳过
  if (o.lights && !low) {
    const lr = Math.min(0.2, halfW * 0.22);
    const disc = new THREE.CylinderGeometry(lr, lr, 0.12, 6, 1, true);
    if (faceX) {
      disc.rotateZ(Math.PI / 2);
      disc.translate(-frameOut * 0.55, rise * 0.82, 0);
    } else {
      disc.rotateX(Math.PI / 2);
      disc.translate(0, rise * 0.82, frameOut * 0.55);
    }
    if (goldTrac) p.gold.push(goldUV(disc));
    else p.ashlar.push(disc);
  }
  return p;
}

/** 花格窗 · **±x 朝向墙**（城内街立面 / 翼墙内壁用） */
export function traceryWindowX(o: TraceryOpts): DetailParts {
  return traceryWindow({ ...o, face: 'x' });
}

/** 花格窗 · **±z 朝向墙**（城门塔楼前脸 / 主殿正立面用） */
export function traceryWindowZ(o: TraceryOpts): DetailParts {
  return traceryWindow({ ...o, face: 'z' });
}

/* ═══════════════════ ④ 卷叶金饰（crocket：沿尖拱斜边等距小卷叶） ═══════════════════ */

/**
 * 参考图门楼/塔冠的 crocket 语汇：沿尖拱斜边等距小卷叶（金锥 + 金珠），锥轴对齐
 * 拱面外法线 ⇒ 读作"沿拱边卷出的金叶"。FBX 无同名件（Decor_1 的凹弧托架即其
 * 单体语汇），形制取参考图构件 3/4 塔冠。
 *
 * 局部约定：拱（或显式点列）在 x-y 平面、z=0（外挑量由调用方平移决定）；
 * 锥轴 = 点列外法线。单件 ≈20 tri（4 面锥 8 + 6 面珠 12），每 run 合并为 2 条几何。
 * 低配档整族跳过（R29 同规矩：只降装饰密度）。
 *
 * @param halfW/rise 拱参数（与 pts 二选一）
 * @param pts        显式点列（塔尖斜棱 / 山墙斜边用）
 * @param count      每侧（或全线）卷叶数
 * @param side       拱模式下 'both' | 'left' | 'right'
 */
export interface CrocketOpts {
  halfW?: number;
  rise?: number;
  pts?: readonly (readonly [number, number])[];
  count?: number;
  size?: number;
  cusp?: number;
  side?: 'both' | 'left' | 'right';
}

export function crocketRun(o: CrocketOpts): DetailParts {
  const p = parts();
  if (isLowDetail() || DEEP_FAR) return p; // 低配 / 远区跳过卷叶（铁律 33：装饰密度）
  const count = Math.max(1, o.count ?? 3);
  const size = o.size ?? 0.17;
  const spots: { x: number; y: number; ang: number }[] = [];

  if (o.pts && o.pts.length >= 2) {
    // ① 显式点列：按弧长均匀布 count 片（不含端点）
    const q = o.pts;
    const segLen: number[] = [];
    let total = 0;
    for (let i = 1; i < q.length; i += 1) {
      const l = Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
      segLen.push(l);
      total += l;
    }
    for (let k = 1; k <= count; k += 1) {
      const target = (total * k) / (count + 1);
      let acc = 0;
      let i = 0;
      while (i < segLen.length - 1 && acc + segLen[i] < target) {
        acc += segLen[i];
        i += 1;
      }
      const t = segLen[i] > 0 ? (target - acc) / segLen[i] : 0;
      spots.push({
        x: q[i][0] + (q[i + 1][0] - q[i][0]) * t,
        y: q[i][1] + (q[i + 1][1] - q[i][1]) * t,
        ang: Math.atan2(q[i + 1][1] - q[i][1], q[i + 1][0] - q[i][0]) + Math.PI / 2
      });
    }
  } else {
    // ② 尖拱模式：每侧 count 片（跳过起拱点与顶点）
    const halfW = o.halfW ?? 1;
    const rise = o.rise ?? 3;
    const cusp = o.cusp ?? 0.7;
    const seg = count + 1;
    const arch = pointedArch(halfW, 0, rise, seg, cusp, 0.45);
    const idx: number[] = [];
    if (o.side !== 'right') for (let i = 1; i <= count; i += 1) idx.push(i);
    if (o.side !== 'left') for (let i = count; i >= 1; i -= 1) idx.push(seg + i);
    for (const i of idx) {
      const a = arch[Math.max(0, i - 1)];
      const b = arch[Math.min(arch.length - 1, i + 1)];
      spots.push({
        x: arch[i][0],
        y: arch[i][1],
        ang: Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2
      });
    }
  }

  const cones: THREE.BufferGeometry[] = [];
  const beads: THREE.BufferGeometry[] = [];
  for (const s of spots) {
    const cone = new THREE.ConeGeometry(size, size * 2.6, 4, 1);
    cone.rotateZ(s.ang);
    cone.translate(s.x, s.y + size * 0.5, 0);
    cones.push(goldUV(cone));
    const bead = new THREE.CylinderGeometry(size * 0.52, size * 0.52, size * 0.66, 6, 1, true);
    bead.translate(s.x, s.y + size * 0.33, 0);
    beads.push(goldUV(bead));
  }
  p.gold.push(mergeSafe(cones), mergeSafe(beads));
  cones.forEach((g) => g.dispose());
  beads.forEach((g) => g.dispose());
  return p;
}

/* ═══════════════════ ⑤ 纹章顶饰（中部上方金色放射/花瓣纹章 + 四芒星） ═══════════════════ */

/**
 * 参考图构件 3（门楼）正中上方的**金色放射/花瓣纹章**：金盘 + 放射金刺 +
 * 芯珠 + 顶尖 + **四芒星**（Decor_6 立面顶部的四尖星实证）。竖直安装于
 * 塔冠/主殿冠顶。单件 ≈108 tri。
 *
 * R32（参考图 A 城门楣「中央对称卷叶 + 两侧金菱形」）：`flankDiamonds` 在纹章
 * 左右各加一枚金菱形（方板转 45°，2×12 tri）—— 门楣金饰的对称收口语汇。
 *
 * R34 修复（主理人 P2）：菱形横偏原本**写死 ±1.7r，不受楣板宽度约束** ⇒ 窄楣上
 * 菱形整枚越出墙体两侧（"金菱形外飘"）。菱形转 45° 后横向半跨 = 边长×√2/2，
 * 原写法外缘到 ±(1.7r + 0.64r) = ±2.34r —— 只要楣板半宽 < 2.34r 就飘出墙外。
 * 现加 `lintelHalf`（楣板半宽）钳制：① 菱形边长先按楣板收（外缘不越楣板）；
 * ② 横偏再按「外缘贴楣板内」取 min。给了 `lintelHalf` 就钳死，没给则保持原值
 * （向后兼容既有调用点）。
 */
export interface FinialOpts {
  r: number;
  petals?: number;
  flankDiamonds?: boolean;
  /** 楣板半宽（世界米）。给了 ⇒ 菱形边长与横偏都按它钳制，外缘不越楣板 */
  lintelHalf?: number;
}

export function finialOrnament(o: FinialOpts): DetailParts {
  const p = parts();
  const r = o.r;
  const petals = o.petals ?? 6;
  // 金盘（8 面开口筒，12 tri）
  const disc = spire('gold', r, r, r * 0.42, 8, 0, 0, 0);
  p.gold.push(goldUV(disc));
  // 放射金刺（4 面锥，8 tri/枝）
  const spikes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < petals; i += 1) {
    const a = (i / petals) * Math.PI * 2;
    const cone = new THREE.ConeGeometry(r * 0.16, r * 0.72, 4, 1);
    cone.rotateZ(a - Math.PI / 2);
    cone.translate(Math.cos(a) * r * 0.62, r * 0.42 + Math.sin(a) * r * 0.62, 0);
    spikes.push(goldUV(cone));
  }
  // 四芒星（Decor_6：两枚交叉拉长八面体 = 十字菱星）
  const star1 = boxRot('gold', r * 1.5, r * 0.3, r * 0.3, 0, r * 1.35, 0, Math.PI / 4);
  const star2 = boxRot('gold', r * 1.5, r * 0.3, r * 0.3, 0, r * 1.35, 0, -Math.PI / 4);
  p.gold.push(mergeSafe([...spikes.map(goldUV), star1, star2]));
  spikes.forEach((g) => g.dispose());
  // 芯珠 + 顶尖
  const bead = new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 0.4, 6, 1, true);
  bead.translate(0, r * 0.42 + r * 0.2, 0);
  p.gold.push(goldUV(bead));
  const tip = new THREE.ConeGeometry(r * 0.14, r * 0.9, 4, 1);
  tip.translate(0, r * 0.62 + r * 0.45, 0);
  p.gold.push(goldUV(tip));
  // R32 两侧金菱形（门楣对称收口；参考图 A 城门楣楣饰两侧）
  //   R34：横偏与边长都过一遍楣宽钳制（见文件头 FinialOpts.lintelHalf 注释）。
  if (o.flankDiamonds) {
    const want = r * 0.9; // 期望边长
    // 菱形绕 z 转 45° 后的横向半跨 = 边长 × √2 / 2
    const side = o.lintelHalf !== undefined ? Math.min(want, o.lintelHalf * Math.SQRT2) : want;
    const halfSpan = (side * Math.SQRT2) / 2;
    const dx =
      o.lintelHalf !== undefined
        ? Math.min(r * 1.7, Math.max(0, o.lintelHalf - halfSpan))
        : r * 1.7;
    if (side > 1e-4 && dx > 1e-4) {
      for (const s of [-1, 1] as const) {
        const dm = box('gold', side, side, r * 0.3, s * dx, r * 0.42, 0);
        dm.rotateZ(Math.PI / 4);
        p.gold.push(goldUV(dm));
      }
    }
  }
  return p;
}

/* ═══════════════════ ⑥ 小尖塔簇（Decor_9：方座退台 + 八棱鼓 + 锥顶） ═══════════════════ */

/**
 * FBX Decor_9（1.44×2.83×1.25，relief 7）的塔化复刻：单尊 = 方座(12) + 退台(12)
 * + 八棱鼓(16) + 锥顶(8)。簇 = 主尖塔（全形，×1.5 尺度）+ 4 角副尖塔（退台+锥）。
 * 单簇 ≈144 tri。低配档副尖塔减为 2 座（对角；只降密度，主塔不动）。
 *
 * 局部：x/z 以簇心为 0、y=0 在座底。
 */
export function pinnacleCluster(o: { w: number; h: number }): DetailParts {
  const p = parts();
  const w = o.w;
  const h = o.h;
  // 主尖塔（Decor_9 全形）
  p.ashlar.push(box('ashlar', w, h * 0.14, w, 0, h * 0.07, 0));
  p.ashlar.push(box('ashlar', w * 0.74, h * 0.16, w * 0.74, 0, h * 0.22, 0));
  p.ashlar.push(spire('ashlar', w * 0.4, w * 0.3, h * 0.3, 8, 0, h * 0.3, 0));
  // R32-A2：主尖塔锥顶同 crookedSpire ② —— gold 刷数撤销，回 **ashlar**
  const cone = new THREE.ConeGeometry(w * 0.3, h * 0.42, 4, 1);
  cone.translate(0, h * 0.6 + h * 0.21, 0);
  p.ashlar.push(finishArch(cone, STONE_TILE_METERS.ashlar));
  // 4 角副尖塔（低配 2 座对角）
  const corners: readonly [number, number][] = isLowDetail()
    ? [
        [-1, -1],
        [1, 1]
      ]
    : [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1]
      ];
  for (const [sx, sz] of corners) {
    const cx = sx * w * 0.62;
    const cz = sz * w * 0.62;
    p.ashlar.push(box('ashlar', w * 0.36, h * 0.1, w * 0.36, cx, h * 0.05, cz));
    const c = new THREE.ConeGeometry(w * 0.15, h * 0.22, 4, 1);
    c.translate(cx, h * 0.1 + h * 0.11, cz);
    p.ashlar.push(c);
  }
  return p;
}

/* ═══════════════════ ⑥b 卷叶尖塔（crockedSpire：八棱鼓 + 锥顶 + 锥面卷叶金饰 + 金尖） ═══════════════════ */

/**
 * 参考图哥特尖塔冠（门楼/塔顶冠饰）：**锥面等距小金卷叶（crocket）** 是"哥特尖塔"
 * 识别度最高的语汇——参考图门楼/塔群天际线密布这类卷叶尖塔。本件 = 白石八棱鼓座
 * + 八棱锥顶 + **沿锥面 3 高 × 4 向 = 12 片金卷叶**（外挑微翘，hero 档）+ 金尖。
 * 局部：座底 y=0、顶 y=h、x/z 以塔心为 0。
 * 单件 ≈128 tri（hero：金卷叶 96 + 石身 32）/ ≈32 tri（低配 / 远区：仅石身 + 金尖，
 * 卷叶跳过——铁律 33 只裁装饰密度）。全场景铺 ~60 座 ⇒ 约 +7~8k tri（high）。
 *
 * ── R32-A2 桶位更正（主理人 T1「金色仅点缀」）──────────────────────────────
 * ② 锥顶 **由 gold 改回 ashlar**。原注释自述「由 ashlar 改为 gold ⇒
 * tri 零成本提升金饰占比」——那是**刷金饰占比数字**，与参考图冲突：
 *   图 A 左高塔「尖顶 1/6：阶梯式 3 层收缩平台 + **金尖饰** + 顶端**金色尖**」
 *   ⇒ 披顶本体非金，金的只有**尖饰**。故锥顶（连同 pinnacleCluster 锥顶）回
 *   **ashlar**（= 撤销 R32 的刷数改动，回到 R31 白石材披顶）。
 * ③ 金尖保留 gold（参考图「金尖饰 / 顶端金色尖」）。
 *
 * ⚠ **为什么不是 roof**（R32-A2 visibleTri 越线教训）：castle.ts 的 roof/wood/
 *   glass/marble 四个可选桶是**单个 mesh 跨全街（z −351..−1451）**，既不参与
 *   z-zone 分区剔除、也享受不到 `updateViewerZ` 的距离摘除 ⇒ 往里每加 1 tri，
 *   六点采样的**每个**机位都按 1 tri 全额计入。本锥顶 282 座 × 22 tri = 6,204 tri
 *   却只换 5,333 m² 表面积（0.86 m²/tri，全表最差），放进不可剔除桶是纯亏。
 *   ⇒ 塔尖瓦顶只留"近中景真被读到"的几族（见 castleKit R32-A2 桶位纪律）。
 * ④ 新增 `leaves`：锥面卷叶显式开关（默认 true）；由 castleKit 近区挂载点显式开，
 *   中区（near ≤ k < DEEP_FAR 界）关 —— 只降装饰密度，塔身/披顶长度不变（铁律 33）。
 */
export function crookedSpire(o: { w: number; h: number; leaves?: boolean }): DetailParts {
  const p = parts();
  const w = o.w;
  const h = o.h;
  const rb = w * 0.42;
  // ① 八棱鼓座（stone）
  p.ashlar.push(spire('ashlar', w * 0.6, w * 0.46, h * 0.4, 8, 0, 0, 0));
  // ② 锥顶（回 **ashlar**：撤销 R32 的 gold 刷数；不进 roof 的理由见上方注释）
  const cone = new THREE.ConeGeometry(rb, h * 0.6, 8, 1);
  cone.translate(0, h * 0.4 + h * 0.3, 0);
  p.ashlar.push(finishArch(cone, STONE_TILE_METERS.ashlar));
  // ③ 金尖
  const tip = new THREE.ConeGeometry(w * 0.15, h * 0.42, 4, 1);
  tip.translate(0, h * 0.4 + h * 0.6 + h * 0.21, 0);
  p.gold.push(goldUV(tip));
  // ④ 卷叶金饰（沿锥面 3 高 × 4 向；低配 / 远区 / 中区（leaves:false）跳过）
  if (o.leaves !== false && !isLowDetail() && !DEEP_FAR) {
    const leafLen = h * 0.17;
    const leafR = w * 0.12;
    const ts = [0.28, 0.55, 0.82];
    for (const t of ts) {
      const y = h * 0.4 + h * 0.6 * t;
      const r = rb * (1 - t) + w * 0.05;
      for (let k = 0; k < 4; k += 1) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const lx = Math.cos(a) * r;
        const lz = Math.sin(a) * r;
        const leaf = new THREE.ConeGeometry(leafR, leafLen, 4, 1);
        leaf.rotateZ(Math.PI * 0.32); // 外挑微翘（读成卷叶）
        leaf.rotateY(-a);
        leaf.translate(lx, y, lz);
        p.gold.push(goldUV(leaf));
      }
    }
  }
  return p;
}

/* ═══════════════════ ⑥c 白色垂幔浮雕（draperyRelief：墙体悬挂垂幔 + 金系带） ═══════════════════ */

/**
 * 参考图构件 6（Decor_6 立面）与正殿墙面的**悬挂垂幔浮雕**：自檐口垂下的折叠白
 * 石垂幔（竖向折页 + 背板），顶/底以金系带收口——"白色"即白石/石材桶（ashlar），
 * 金仅作系带点缀（不与金饰比例提升冲突）。局部：墙面 x=0、垂幔嵌 +x（贴墙）、
 * 沿 z 宽 w、自顶 y=h 垂下。单件 ≈(folds+2)×12 + 2×12 tri。
 * 低配 / 远区：金系带保留（结构感）、折页减半（只降密度）。
 */
export function draperyRelief(o: { w: number; h: number; folds?: number }): DetailParts {
  const p = parts();
  const w = o.w;
  const h = o.h;
  const folds = o.folds ?? 5;
  // ① 背板（薄白石材，贴墙）
  p.ashlar.push(box('ashlar', 0.18, h * 0.96, w, -0.09, h * 0.48, 0));
  // ② 竖向折页（白石材，外凸；远区/低配减半）
  const step = DEEP_FAR || isLowDetail() ? 2 : 1;
  for (let i = 0; i <= folds; i += step) {
    const zc = -w / 2 + (w * i) / folds;
    p.ashlar.push(box('ashlar', 0.34, h * 0.94, 0.22, -0.18, h * 0.47, zc));
    // 折页顶系带扣：R32-A2 改 **ashlar**（原 gold）。0.12m 方扣 ×280 个 ⇒ 3,360 tri
    // 但表面积仅 ~0.1 m²/个（占比 0.006%）—— 典型"tri 高、读感为零"的无效金饰
    // （主理人 T1 收敛 gold-tri 占比的优先清除对象）。顶/底**通长金系带**保留 gold。
    p.ashlar.push(box('ashlar', 0.12, 0.12, 0.26, -0.2, h * 0.94, zc));
  }
  // ③ 顶/底金系带（横贯）
  p.gold.push(box('gold', 0.26, 0.28, w, -0.2, h * 0.97, 0));
  p.gold.push(box('gold', 0.2, 0.22, w, -0.2, h * 0.03, 0));
  return p;
}

/* ═══════════════════ ⑦ 雕像凹龛（凹腔 + 龛楣卷叶 + 4 段雕像） ═══════════════════ */

/**
 * FBX Decor_4（spring 0.42 龛楣分叉）/Decor_6（2.06×5.62）语汇。R31 升级：
 *   ① 真实凹腔（nicheCavity：recess 默认 0.55，dark 内壁阴影）；
 *   ② 龛楣卷叶 ×2（crocketRun 沿拱斜边，hero 档）；
 *   ③ 龛内雕像 4 段（袍座 16 + 躯干 16 + 肩/头 24 ≈ 56 tri；低配跳过像、龛保留）。
 * 单件 ≈170 tri。
 *
 * R32 实测口径：雕像龛为**薄体**（FBX Decor_6 厚 0.324 / Decor_8 厚 0.57 ⇒
 * 本族 plateBack 默认 0.55，总腔深 = recess 0.33 + back 0.22 = 0.55，落在
 * 0.32~0.57 实测带内）；**深龛 1.16m 是盲拱模块 Arch_3.001 的口径**（归
 * blindArcadeRow），两者不可混用——壁龛与盲拱交替形成立面明暗节奏（参考图 A）。
 *
 * 局部约定同花格窗（face 'x' 挑 −x / face 'z' 挑 +z），龛底 y=0。
 */
export function statueNiche(o: {
  halfW: number;
  rise: number;
  face?: 'x' | 'z';
  frameOut?: number;
  plateBack?: number;
  cusp?: number;
  /**
   * R32-A2 · 龛楣卷叶开关（默认 true）。castleKit 中区挂载点传 false —— 参考图
   * 「卷叶饰模块」只在近景可读，中/远区纯 tri 负担（tri 高、面积近乎为零 ⇒
   * 只抬 gold-tri 占比不抬读感）。只降装饰密度，龛体/楣长度不变（铁律 33）。
   */
  crocket?: boolean;
}): DetailParts {
  const p = parts();
  const faceX = (o.face ?? 'x') === 'x';
  const frameOut = o.frameOut ?? 0.4;
  const plateBack = o.plateBack ?? 0.55;
  const cusp = o.cusp ?? 0.5;
  const low = isLowDetail();
  // ① 真实凹腔（后背板 + 侧壁 + 楣腹）。
  //   nicheCavity 默认嵌 +x（墙面 x=0）；face 'z' 需嵌 −z：rotateY(π/2) 把
  //   x∈[0,depth] 映射为 z∈[−depth,0]、拱跨映射到 x（rotateY: x'=z, z'=−x）。
  for (const g of nicheCavity(o.halfW - 0.05, o.rise, plateBack * 0.6, plateBack * 0.4, cusp)) {
    if (!faceX) g.rotateY(Math.PI / 2);
    p.dark.push(g);
  }
  // ② 金框
  const ring = archBand(o.halfW, 0, o.rise, 0.18, frameOut, 2, cusp, 0.45);
  if (faceX) archToFaceX(ring);
  else ring.rotateY(Math.PI);
  p.gold.push(goldUV(ring));
  // ②b 鎏金基座（壁龛立像下的金台座；近/中景才铺，远区经 DEEP_FAR 跳过 —— 铁律 33）
  if (!DEEP_FAR) {
    const baseR = o.halfW * 0.42;
    const bx = faceX ? plateBack * 0.4 : 0;
    const bz = faceX ? 0 : -plateBack * 0.4;
    p.gold.push(goldUV(box('gold', baseR * 1.4, 0.34, baseR * 1.4, bx, 0.17, bz)));
  }
  // ③ 龛楣卷叶 ×2（低配跳过；R32-A2：中区由挂载点显式关）
  if (o.crocket !== false && !low) {
    pour(
      p,
      mapParts(
        crocketRun({ halfW: o.halfW * 0.92, rise: o.rise * 0.9, count: 2, size: 0.13, cusp }),
        (g) => (faceX ? g.translate(-frameOut * 0.8, 0, 0) : g.translate(0, 0, frameOut * 0.8))
      )
    );
  }
  // ④ 龛内雕像（4 段：袍座撇脚 + 收分躯干 + 肩台 + 头珠）；低配档龛保留、像跳过
  if (!low) {
    const bodyR = o.halfW * 0.3;
    const dx = faceX ? plateBack * 0.55 : 0;
    const dz = faceX ? 0 : -plateBack * 0.55;
    const robe = spire('ashlar', bodyR * 1.35, bodyR * 0.9, o.rise * 0.2, 5, dx, 0.02, dz);
    const torso = spire('ashlar', bodyR * 0.9, bodyR * 0.6, o.rise * 0.32, 5, dx, o.rise * 0.22, dz);
    p.ashlar.push(robe, torso);
    const shoulders = box('ashlar', bodyR * 1.9, bodyR * 0.9, bodyR * 1.1, dx, o.rise * 0.56, dz);
    p.ashlar.push(shoulders);
    const head = new THREE.CylinderGeometry(o.halfW * 0.14, o.halfW * 0.14, o.halfW * 0.3, 6, 1, true);
    head.translate(dx, o.rise * 0.56 + bodyR * 0.75, dz);
    p.ashlar.push(head);
  }
  return p;
}

/** 雕像凹龛 · ±x 朝向墙 */
export function statueNicheX(o: {
  halfW: number;
  rise: number;
  frameOut?: number;
  plateBack?: number;
  cusp?: number;
  crocket?: boolean;
}): DetailParts {
  return statueNiche({ ...o, face: 'x' });
}

/** 雕像凹龛 · ±z 朝向墙 */
export function statueNicheZ(o: {
  halfW: number;
  rise: number;
  frameOut?: number;
  plateBack?: number;
  cusp?: number;
  crocket?: boolean;
}): DetailParts {
  return statueNiche({ ...o, face: 'z' });
}

/* ═══════════════════ ⑧ 檐口带 / 柱头环 / 瓶柱 ═══════════════════ */

/**
 * 檐口带（FBX Cornice_2_Full 18.30×1.41×0.68 / relief 4 层退台）：
 * 分层檐口 = 身托石 + 冠石 + 金压顶线。局部：贴墙面 x=0、向 −x 挑出 proj、
 * 沿 z 长 len、总高 ≈ h×1.18。单件 36 tri。
 *
 * R32（参考图 B 第 2/4 层间横向金饰带）：金饰由 2 道加到 3 道
 * （冠顶压顶 + 檐下描金带 + 中腹金线），同 12 面 box 成本 ⇒ 层间金带节奏更密。
 */
export function corniceBand(o: { len: number; proj?: number; h?: number }): DetailParts {
  const p = parts();
  const proj = o.proj ?? 0.68;
  const h = o.h ?? 1.41;
  p.ashlar.push(box('ashlar', proj * 0.75, h * 0.4, o.len, -proj * 0.375, h * 0.2, 0));
  p.ashlar.push(box('ashlar', proj, h * 0.6, o.len, -proj * 0.5, h * 0.7, 0));
  // A 线 ① 檐口描金加高：顶冠金压顶（h×0.34）+ 檐下描金带（h×0.16）——
  // 参考图檐口/腰线普遍金饰，提升金饰表面积而不增多少 tri（同 12 面 box）。
  p.gold.push(box('gold', proj + 0.14, h * 0.34, o.len, -proj * 0.5 - 0.07, h * 1.12, 0));
  p.gold.push(box('gold', proj * 0.62, h * 0.16, o.len, -proj * 0.31, h * 0.74, 0));
  // R32 中腹金线（第 2/4 层间横向金饰带的檐口版）
  p.gold.push(box('gold', proj * 0.5, h * 0.1, o.len, -proj * 0.25, h * 0.42, 0));
  return p;
}

/**
 * 鎏金屏板 / 山花镶金（reredos / tympanum screen）：薄金板（双面 = 高效表面积）+ 镶金
 * 外框 + 可选金十字 —— 参考图门楼/主殿正立面的**金屏/金山花**语汇（祭坛背屏、门龛
 * 山花）。局部：板面在 y=0..h、z=−d/2..d/2（贴墙朝 −x 外挑）、x=0 为墙。
 * 单件 ≈ 5×12 = 60 tri，但金表面积 ≈ 2×w×h（薄板双面）⇒ 高效鎏金手段。
 *
 * R32（参考图竖向金条间距节拍 18–25px）：`strips` > 0 时屏板上按节拍铺竖向金条
 * （每条 12 tri；屏宽 w 上均匀布 strips 条，跳过中轴 1 条防与十字叠字）。
 */
export function gildedScreen(o: {
  w: number;
  h: number;
  d?: number;
  cross?: boolean;
  strips?: number;
  /**
   * R33 `hall_front`：把「实心金板」改为**透空金屏**。
   * 外框 + 竖棂 + 尖拱分格，板芯完全不产金几何；后方由调用方补 dark 深龛。
   * 默认 false 保持城门山花屏（平实心）的原观感。
   */
  openwork?: boolean;
  /** 透空屏的尖拱开间数（默认 3；仅 openwork=true 生效） */
  bays?: number;
}): DetailParts {
  const p = parts();
  const d = o.d ?? 0.22;
  if (!o.openwork) {
    p.gold.push(box('gold', d, o.h, o.w, 0, o.h / 2, 0)); // 金板（双面）
  }
  // 镶金外框（四边加厚，读作金镶边屏）
  p.gold.push(box('gold', d + 0.08, o.h + 0.6, 0.8, 0, o.h / 2, o.w / 2));
  p.gold.push(box('gold', d + 0.08, o.h + 0.6, 0.8, 0, o.h / 2, -o.w / 2));
  // R33 修正：原实现把顶框写成「厚 0.5 × 高 h+0.6 × 宽 w+0.6」的**整幅面板**
  // （实为 second full plate，压掉透空屏的所有开口）。顶框应只有 0.9m 高。
  // 并按 hall_front 实拍把外框/竖棂加粗一档（85m 机位下 0.2m 棂仅 ~3px，读不出）。
  p.gold.push(box('gold', 0.62, 0.9, o.w + 0.8, 0, o.h + 0.3, 0));
  p.gold.push(box('gold', 0.62, 0.8, o.w + 0.8, 0, 0, 0));
  if (o.openwork) {
    /* ── R33 透空屏：竖棂 + 三/多尖拱分格 ──────────────────────────────
     * 局部与实心版完全同系（厚度 x、宽 z、高 y），因此调用方的
     * rotateY(π/2)/translate 接线零改动。金量从「整面 2×w×h 双面板」
     * 降为「框 + 棂 + 券线」，透过去看到后方 dark 龛 = 门/屏的空间层次。
     * 尖拱券线由 archBand 生成后 rotateY(π/2) 转进 y-z 立面。
     */
    const bays = Math.max(1, o.bays ?? 3);
    const bayW = o.w / bays;
    const half = bayW * 0.5 - 0.18;
    const spring = o.h * 0.52;
    const rise = Math.min(o.h * 0.24, bayW * 0.42);
    // 中腰横档（把立面分成「窗下墙 / 透空尖拱区」两段）
    p.gold.push(box('gold', d + 0.04, 0.52, o.w - 0.4, 0, spring, 0));
    for (let i = 0; i < bays; i += 1) {
      const zc = -o.w / 2 + bayW * (i + 0.5);
      // 竖向分格棂（每开间一根）
      p.gold.push(box('gold', d * 0.8, spring - 0.4, 0.38, 0, spring * 0.5, zc));
      // 尖拱券线：archBand 在 x-y 平面沿 -z 挤出 → rotateY(π/2) 后跨 z、厚度 x
      const ring = archBand(half, spring, rise, 0.42, d * 0.75, 3, 0.6, 0.45);
      ring.rotateY(Math.PI / 2);
      ring.translate(0, 0, zc);
      p.gold.push(goldUV(ring));
      // 拱顶小尖饰（3 片金卷叶合成一个十字尖，tri 低、远距仍可读）
      if (!isLowDetail() && !DEEP_FAR) {
        for (const dz of [-0.3, 0, 0.3]) {
          const tip = box('gold', d * 0.7, 0.7, 0.14, 0, spring + rise + 0.28, zc + dz);
          tip.rotateZ(Math.PI / 4);
          p.gold.push(goldUV(tip));
        }
      }
    }
    // 在拱肩之间补两道短竖棂，形成 2×bays 细密节奏（参考图金屏的竖棂感）
    for (let i = 1; i < bays; i += 1) {
      const zc = -o.w / 2 + bayW * i;
      p.gold.push(box('gold', d * 0.75, o.h * 0.3, 0.3, 0, o.h * 0.72, zc));
    }
    // 两道通长横枋（下枋 + 上枋）：把透空区分成三段，远距也能读出「屏」而不是空洞
    p.gold.push(box('gold', d * 0.8, 0.34, o.w - 0.3, 0, o.h * 0.16, 0));
    p.gold.push(box('gold', d * 0.8, 0.34, o.w - 0.3, 0, o.h * 0.82, 0));
    if (o.cross) {
      // 透空版十字只在顶部保留短十字，避免重新变成整面板
      p.gold.push(box('gold', d * 0.9, o.h * 0.2, 0.26, 0, o.h * 0.88, 0));
      p.gold.push(box('gold', d * 0.9, 0.22, o.w * 0.2, 0, o.h * 0.9, 0));
    }
  }
  if (!o.openwork && o.cross) {
    p.gold.push(box('gold', 0.5, o.h * 0.66, 0.3, 0, o.h * 0.52, 0)); // 竖
    p.gold.push(box('gold', o.w * 0.46, 0.5, 0.3, 0, o.h * 0.6, 0)); // 横
  }
  // R32 竖向金条（实心屏的屏面节拍；透空版已自带竖棂，不重复铺）
  const strips = o.openwork ? 0 : (o.strips ?? 0);
  if (strips > 0) {
    for (let i = 1; i <= strips; i += 1) {
      const pz = -o.w / 2 + (o.w * i) / (strips + 1);
      if (Math.abs(pz) < o.w * 0.08) continue;
      p.gold.push(box('gold', d + 0.06, o.h * 0.86, 0.22, 0, o.h * 0.5, pz));
    }
  }
  return p;
}

/**
 * 柱头环（FBX Collumn 全系的柱头语汇）：收分托石 + 金箍。局部：y 0..h、
 * x/z 以柱心为 0。单件 20 tri。
 */
export function capitalCollar(o: { r: number; h?: number }): DetailParts {
  const p = parts();
  const h = o.h ?? 0.5;
  p.ashlar.push(spire('ashlar', o.r * 1.3, o.r * 0.95, h, 6, 0, 0, 0));
  p.gold.push(goldUV(spire('gold', o.r * 1.05, o.r * 1.05, h * 0.24, 6, 0, h * 0.76, 0)));
  return p;
}

/**
 * 建筑用宝瓶柱（FBX Baluster_1 1.59×4.45×1.59 / taper [1,0.80,0.64,0.43…0.87]）：
 * 宝瓶收分三段（座 / 腰 / 颈）。局部：y 0..h、x/z 以柱心为 0。单件 36 tri。
 *
 * R32（参考图 B 桥栏杆）：柱顶**金箍环**（collar）+ **小型尖拱覆盆**（coping）——
 * 默认关闭（全场景瓶柱 ≈1000 根，全开 ≈+12k tri），由桥栏/廊栏近区挂载点显式开。
 */
export function balusterPost(o: { h: number; r?: number; collar?: boolean; coping?: boolean }): DetailParts {
  const p = parts();
  const r = o.r ?? 0.16;
  p.ashlar.push(spire('ashlar', r * 1.35, r * 1.2, o.h * 0.14, 6, 0, 0, 0));
  p.ashlar.push(spire('ashlar', r * 0.8, r * 0.62, o.h * 0.52, 6, 0, o.h * 0.14, 0));
  p.ashlar.push(spire('ashlar', r * 0.5, r * 0.42, o.h * 0.34, 6, 0, o.h * 0.66, 0));
  // 柱顶金箍环（6 面开口筒，12 tri）—— 参考图桥栏杆柱顶的"金箍"读法
  if (o.collar) {
    p.gold.push(goldUV(spire('gold', r * 0.62, r * 0.62, r * 0.5, 6, 0, o.h, 0)));
  }
  // 柱顶小型尖拱覆盆（archBand 2 段，≈20 tri）—— 哥特栏柱的收口语汇
  if (o.coping) {
    const cp = archBand(r * 0.62, o.h + r * 0.5, r * 0.55, r * 0.22, r * 1.1, 2, 0.5, 0.45);
    p.ashlar.push(cp);
  }
  return p;
}

/* ═══════════════════ ⑨ 高架连廊（街面拱廊 / 跨街封闭拱顶廊 / 墙顶敞廊） ═══════════════════ */

/**
 * 街面低拱廊（连廊主体）：楼面（**wood 桶**，R31 材料丰富度）+ 外侧柱列
 * （带柱头环）+ 柱间尖拱 + 檐口金线 + 外侧栏板。
 * FBX 依据 Beam_1~4 长梁（6.21~7.47m）+ Arch 组合读法。
 *
 * 局部约定：贴墙面 x=0、向 −x 挑出 width、沿 z 长 len（块心 z=0）、楼面 y=floorY。
 * 单段（len≈44）≈330 tri。楼面必须 > 4.5m（行车走廊上沿）；柱列落在 |x|≥11 区内。
 */
export function corridorRun(o: {
  len: number;
  width: number;
  floorY: number;
  pitch?: number;
  archRise?: number;
  rail?: boolean;
}): DetailParts {
  const p = parts();
  const pitch = o.pitch ?? 8.8;
  const rise = o.archRise ?? 3.6;
  const band = 0.42;
  const colR = 0.3;
  // ① 楼面（wood）+ 外棱金线
  (p.wood ??= []).push(box('wood', o.width, 0.45, o.len, -o.width / 2, o.floorY, 0));
  p.gold.push(box('gold', 0.14, 0.16, o.len, -o.width, o.floorY + 0.05, 0));
  // ①b 楼面下双梁（wood，暴露的木构读法）
  for (const s of [-1, 1] as const) {
    (p.wood ??= []).push(box('wood', 0.34, 0.34, o.len, -o.width * 0.5 + s * o.width * 0.3, o.floorY - 0.38, 0));
  }
  // ② 外侧柱列（落在楼面处；隔根上柱头环）
  const n = Math.max(1, Math.floor(o.len / 2 / pitch));
  for (let i = 0; i < n; i += 1) {
    for (const s of [-1, 1] as const) {
      const cz = s * (i + 0.5) * pitch;
      const cx = -o.width + colR + 0.12;
      p.ashlar.push(pierColumn(colR * 2, colR * 1.7, o.floorY, cx, 0, cz));
      if (i % 2 === 0) pour(p, mapParts(capitalCollar({ r: colR, h: 0.5 }), (g) => g.translate(cx, o.floorY, cz)));
    }
  }
  // ③ 柱间尖拱（相邻柱心 + 中央；拱带沿廊宽挤出 ⇒ 内缘贴柱、外缘挑空）
  const gaps: readonly (readonly [number, number])[] = [
    [-0.5 * pitch, 0.5 * pitch],
    ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => [(i + 0.5) * pitch, (i + 1.5) * pitch] as const),
    ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => [-(i + 1.5) * pitch, -(i + 0.5) * pitch] as const)
  ];
  const arches: THREE.BufferGeometry[] = [];
  for (const [zi, [za, zb]] of gaps.entries()) {
    // 低配档隔拱布置（铁律 33）：柱列与檐口不变，只隔根省拱带
    if (isLowDetail() && zi % 2 === 1) continue;
    const half = (zb - za) / 2;
    const zc = (za + zb) / 2;
    const g = archBand(half, o.floorY, rise, band, o.width, 2, 0.35, 0.45);
    archToFaceX(g); // x∈[−width, 0]，拱跨 ±half 沿 z
    arches.push(g.translate(0, 0, zc));
  }
  p.ashlar.push(mergeSafe(arches));
  arches.forEach((g) => g.dispose());
  // ④ 檐口 + 顶面板
  p.ashlar.push(box('ashlar', o.width + 0.4, 0.4, o.len, -o.width / 2 - 0.2, o.floorY + rise + 0.2, 0));
  // R32-A2 桶位更正 + 材料丰富度：拱廊顶面板 = **瓦顶 ⇒ roof 桶**（原 gold；
  //   4×44m **水平**板 ×40 = 14,771 m²，街面只见 0.18m 侧边 ⇒ 属"体量件误投 gold"；
  //   改 roof 同时把廊顶读成瓦面，点亮 T2 四桶之一）
  (p.roof ??= []).push(box('roof', o.width + 0.5, 0.18, o.len, -o.width / 2 - 0.25, o.floorY + rise + 0.55, 0));
  // ⑤ 外侧栏板（金压顶 + 宝瓶柱；低配档隔根布置——铁律 33）
  if (o.rail !== false) {
    p.gold.push(box('gold', 0.12, 0.9, o.len, -o.width - 0.06, o.floorY + 0.45, 0));
    // 瓶柱密度提升（R31 A 线 ④）：沿栏板节拍由 /4.6 加密到 /3.4；
    // 远区（DEEP_FAR）回落到 /6.8（只降密度，几何长度不变——铁律 33）。
    const postPitch = DEEP_FAR ? 6.8 : 3.4;
    const posts = Math.max(2, Math.floor(o.len / postPitch));
    for (let i = 0; i < posts; i += 1) {
      if (isLowDetail() && i % 2 === 1) continue;
      const cz = -o.len / 2 + (o.len * (i + 0.5)) / posts;
      pour(p, mapParts(balusterPost({ h: 0.85, r: 0.1 }), (g) => g.translate(-o.width - 0.06, o.floorY + 0.45, cz)));
    }
  }
  return p;
}

/**
 * 跨街封闭拱顶廊（连廊 · 跨路连接两侧）：楼面（wood）+ 两侧胸墙 + 筒形拱顶 +
 * 胸墙深色窗缝 + 拱脚金线。局部：跨度 span 沿 x、宽 width 沿 z、楼面 y=floorY。
 * 单件 ≈160 tri。全部 y ≥ floorY−0.5（>4.5）⇒ 不进行车走廊。
 */
export function corridorCrossing(o: { span: number; width: number; floorY: number; rise?: number }): DetailParts {
  const p = parts();
  const rise = o.rise ?? 1.7;
  // ① 楼面（wood）
  (p.wood ??= []).push(box('wood', o.span, 0.5, o.width, 0, o.floorY, 0));
  // ② 两侧胸墙
  for (const s of [-1, 1] as const) {
    p.ashlar.push(box('ashlar', o.span, 2.0, 0.35, 0, o.floorY + 1.25, s * (o.width / 2 - 0.175)));
  }
  // ③ 筒形拱顶（尖拱带沿 x 挤出 = 跨街筒拱）
  const vault = archBand(o.width / 2, o.floorY + 2.25, rise, 0.3, o.span, 3, 0.3, 0.45);
  vault.rotateY(Math.PI / 2); // 挤出方向 → x（x∈[−span,0]）
  vault.translate(o.span / 2, 0, 0); // x∈[−span/2, span/2]
  p.ashlar.push(vault);
  // ④ 拱脚金线 ×2 + 胸墙深色窗缝 ×4
  for (const s of [-1, 1] as const) {
    p.gold.push(box('gold', 0.16, 0.2, o.width + 0.2, s * (o.span / 2 - 0.3), o.floorY + 2.3, 0));
  }
  const slits: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1] as const) {
    for (const sx of [-0.62, -0.2, 0.2, 0.62]) {
      slits.push(box('dark', 1.6, 0.9, 0.2, sx * o.span * 0.35, o.floorY + 1.2, s * (o.width / 2 - 0.05)));
    }
  }
  p.dark.push(mergeSafe(slits));
  slits.forEach((g) => g.dispose());
  return p;
}

/**
 * 墙顶敞廊（连廊 · 城门楼↔翼墙 / 主殿两翼之间）：楼面（wood）+ 双侧瓶柱栏板 +
 * 金压顶 + 金底线。局部：宽 width 沿 x、长 len 沿 z、楼面 y=floorY、x/z 居中。
 * 单件 ≈136 tri。
 */
export function corridorGallery(o: { len: number; width: number; floorY: number }): DetailParts {
  const p = parts();
  (p.wood ??= []).push(box('wood', o.width, 0.5, o.len, 0, o.floorY, 0));
  p.gold.push(box('gold', 0.16, 0.14, o.len, 0, o.floorY + 0.3, 0));
  // 瓶柱密度提升（R31 A 线 ④）：/4.6 → /3.4；远区回落 /6.8（铁律 33）
  const postPitch = DEEP_FAR ? 6.8 : 3.4;
  const posts = Math.max(2, Math.floor(o.len / postPitch));
  const postGeo: THREE.BufferGeometry[] = [];
  for (let i = 0; i < posts; i += 1) {
    const cz = -o.len / 2 + (o.len * (i + 0.5)) / posts;
    for (const s of [-1, 1] as const) {
      const bp = balusterPost({ h: 0.95, r: 0.12 });
      for (const g of bp.ashlar) postGeo.push(g.translate(s * (o.width / 2 - 0.12), o.floorY + 0.5, cz));
    }
  }
  p.ashlar.push(mergeSafe(postGeo));
  postGeo.forEach((g) => g.dispose());
  p.gold.push(box('gold', o.width + 0.2, 0.16, o.len, 0, o.floorY + 1.45, 0));
  return p;
}

/* ═══════════════════ ⑩ R31 新族：回廊柱列 / 后殿半圆室 / 钟楼 / 哥特开间 ═══════════════════ */

/**
 * 回廊柱列（第二进院落 cloister；marble 柱身 = 材料丰富度主力）：
 * 大理石柱（6 棱收分）+ 柱头环（隔根）+ 柱间尖拱（2 段）+ 顶檐口 + 金线。
 * 局部：柱列贴墙面 x=0、向 −x 出挑 depth、沿 z 长 len（块心 z=0）、地面 y=0。
 * 每 8 开间（pitch 默认 4.6）≈ 340 tri。低配档隔拱布置（柱列保留，铁律 33）。
 */
export function cloisterArcade(o: {
  len: number;
  depth?: number;
  colH?: number;
  colR?: number;
  pitch?: number;
  archRise?: number;
}): DetailParts {
  const p = parts();
  const depth = o.depth ?? 3.2;
  const colH = o.colH ?? 8.5;
  const colR = o.colR ?? 0.5;
  const pitch = o.pitch ?? 4.6;
  const rise = o.archRise ?? 3.4;
  const n = Math.max(1, Math.round(o.len / pitch));
  // ① 台座（通长）+ 大理石柱
  (p.marble ??= []).push(box('marble', depth, 0.5, o.len, -depth / 2, 0.25, 0));
  for (let i = 0; i <= n; i += 1) {
    const cz = -o.len / 2 + (o.len * i) / n;
    (p.marble ??= []).push(spire('marble', colR, colR * 0.82, colH, 6, -depth / 2, 0.5, cz));
    if (i % 2 === 0) {
      pour(p, mapParts(capitalCollar({ r: colR, h: 0.55 }), (g) => g.translate(-depth / 2, 0.5 + colH, cz)));
    }
  }
  // ② 柱间尖拱（拱带沿廊深挤出）
  const arches: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i += 1) {
    if (isLowDetail() && i % 2 === 1) continue;
    const za = -o.len / 2 + (o.len * i) / n;
    const g = archBand(pitch / 2 - colR * 0.4, 0.5 + colH * 0.15, rise, 0.36, depth, 2, 0.4, 0.45);
    archToFaceX(g);
    arches.push(g.translate(0, 0, za + pitch / 2));
  }
  p.ashlar.push(mergeSafe(arches));
  arches.forEach((g) => g.dispose());
  // ③ 顶檐口（连梁）+ 金线
  p.ashlar.push(box('ashlar', depth + 0.4, 0.5, o.len, -depth / 2, 0.5 + colH + 0.5, 0));
  p.gold.push(box('gold', depth + 0.55, 0.18, o.len, -depth / 2, 0.5 + colH + 0.88, 0));
  // ③b R32 回廊斜顶瓦（roof 桶：单坡斜顶自墙(x=0)向外棱下沉 0.9m —— 回廊的
  //     屋顶读法；材料丰富度四桶之一）+ 檐口暴露木梁（wood 桶）。+24 tri/列。
  {
    const eaveY = 0.5 + colH + 0.88;
    const drop = 0.9;
    const slopeLen = Math.hypot(depth, drop);
    (p.roof ??= []).push(
      boxRot('roof', slopeLen, 0.35, o.len, -depth / 2, eaveY + drop / 2, 0, Math.atan2(drop, depth))
    );
    (p.wood ??= []).push(box('wood', 0.42, 0.42, o.len, -depth * 0.78, eaveY - 0.05, 0));
    (p.wood ??= []).push(box('wood', 0.36, 0.36, o.len, -depth * 0.4, eaveY - 0.02, 0));
  }
  return p;
}

/**
 * 后殿半圆室（apse；弧形墙 12 段 + 半锥瓦顶（roof 桶）+ 竖条窗 + 金檐）。
 * FBX 依据：参考图后殿语汇 + Arch_3.001 模块拱。局部：圆心在 (0,0)、
 * 开口朝 −x（半圆向 +x 张开）、墙底 y=0。
 * 单座 ≈150 tri。低配档窗缝减半（墙/顶保留，铁律 33）。
 */
export function apseDrum(o: { r: number; h: number; segs?: number; roofRise?: number }): DetailParts {
  const p = parts();
  const r = o.r;
  const h = o.h;
  const segs = o.segs ?? 12;
  const roofRise = o.roofRise ?? h * 0.28;
  // ① 弧形墙（**凸面朝街**：three 圆柱 x=r·sinθ ⇒ θ∈[π,2π] 覆盖 −x 半边，
  //    开口朝 +x 藏进院落深侧；从街面读到的是后殿的弧面本体）
  const wall = new THREE.CylinderGeometry(r, r, h, segs, 1, true, Math.PI, Math.PI);
  wall.translate(0, h / 2, 0);
  (p.ashlar ??= []).push(finishArch(wall, STONE_TILE_METERS.ashlar));
  // 开口封板（+x 直径面，避免看进空筒；落在墙体内侧防 z-fighting）
  p.ashlar.push(box('ashlar', 0.6, h, r * 2 + 0.6, 0.28, h / 2, 0));
  // ② 瓦顶（roof 桶；全锥 —— 从街面读是完整的锥顶，半鼓的平底面被锥盖住）
  const cone = new THREE.ConeGeometry(r * 1.12, roofRise, segs);
  cone.translate(0, h + roofRise / 2, 0);
  (p.roof ??= []).push(finishArch(cone, STONE_TILE_METERS.roof));
  // ③ 竖条窗（dark 窄板贴弧面外缘，绕 Y 轴切向对齐；角度确定性取模）
  const wins = isLowDetail() ? 3 : 5;
  for (let i = 0; i < wins; i += 1) {
    const a = Math.PI + (Math.PI * (i + 0.5)) / wins;
    const wx = Math.sin(a) * (r + 0.06);
    const wz = Math.cos(a) * (r + 0.06);
    const slit = box('dark', 0.5, h * 0.42, 0.5, wx, h * 0.45, wz);
    slit.rotateY(a);
    p.dark.push(slit);
  }
  // ④ 金檐（环带 = 全圆开口筒，包住弧墙顶与封板顶）
  const band = new THREE.CylinderGeometry(r + 0.35, r + 0.35, 0.3, segs, 1, true);
  band.translate(0, h + 0.15, 0);
  p.gold.push(goldUV(finishArch(band, GOLD_TILE)));
  return p;
}

/**
 * 钟楼（城内第三进天际线；WCBell_1 4.95×4.83×3.21 形制复刻）：
 * 收分塔身（3 段）+ 双拱钟室（dark 腔 + 金券 ×2）+ 金钟（三段收分，钟唇横杆）
 * + 四坡瓦顶（roof 桶）+ 顶饰。局部：塔心 (0,0)、地面 y=0。
 * 单座 ≈300 tri。低配档钟室拱券保留（结构件）、顶饰跳过。
 *
 * ── R32（参考图 B 钟楼层 + 用户令「加大内部建筑群」）────────────────────
 * 钟楼层 = **圆形钟表**（金面 + 罗马字刻度环 + 双针；直径 ≈ 塔宽 1/6）+ **钟摆**
 * （龛内左拱开口可见：吊杆 + 摆锤）。钟面坐在双拱之间的中央前脸（x=0），
 * 拱心外移到 ±w*0.32 防遮挡；钟与摆改挂**左拱开口前缘**（x=−w*0.32）——
 * 原实现钟在塔心 x=0，被两拱间的实心石墩挡住，街面根本看不见（R32 修正）。
 * 单座 R32 增量 ≈+260 tri（钟面 ~200 + 摆 ~60）。
 */
export function bellTower(o: { w: number; totalH: number; clock?: boolean; pendulum?: boolean }): DetailParts {
  const p = parts();
  const w = o.w;
  const h = o.totalH;
  const shaftTop = h * 0.78;
  const chamberH = h * 0.16;
  // ① 塔基 + 三段收分塔身
  p.ashlar.push(box('ashlar', w + 1.4, 1.0, w + 1.4, 0, 0.5, 0));
  p.ashlar.push(box('ashlar', w, shaftTop * 0.55, w, 0, 1.0 + shaftTop * 0.275, 0));
  p.ashlar.push(box('ashlar', w * 0.9, shaftTop * 0.45, w * 0.9, 0, 1.0 + shaftTop * 0.55 + shaftTop * 0.225, 0));
  // ② 钟室层：双拱腔（dark）+ 金券 ×2（拱跨沿 x、并排于 +z 前脸；R32 拱心外移）
  const cy = 1.0 + shaftTop;
  const archHalf = w * 0.26;
  const archRise = chamberH * 0.62;
  const archCx = w * 0.32;
  for (const s of [-1, 1] as const) {
    const cx = s * archCx;
    const plate = archPlate(archHalf, 0, archRise, 0.7, 2, 0.55);
    plate.translate(cx, cy, w * 0.46 - 0.7);
    p.dark.push(plate);
    const ring = archBand(archHalf, 0, archRise, 0.2, 0.4, 2, 0.55, 0.45);
    ring.translate(cx, cy, w * 0.46 - 0.4);
    p.gold.push(goldUV(ring));
  }
  // ③ 金钟（WCBell：宽/高 ≈0.77 → 钟宽 = chamberH×0.77；三段收分 + 唇杆）
  //   R32：钟挂到左拱开口前缘（x=−archCx、z=+w*0.18）—— 从拱开口看得见
  const bellH = chamberH * 0.6;
  const bellR = bellH * 0.36;
  const bx = -archCx;
  const bz = w * 0.18;
  const by = cy + chamberH * 0.14;
  p.gold.push(spire('gold', bellR, bellR * 0.62, bellH * 0.58, 8, bx, by, bz));
  p.gold.push(spire('gold', bellR * 0.62, bellR * 0.4, bellH * 0.28, 8, bx, by + bellH * 0.58, bz));
  p.gold.push(spire('gold', bellR * 0.4, 0, bellH * 0.14, 8, bx, by + bellH * 0.86, bz));
  p.gold.push(box('gold', bellR * 1.9, 0.16, 0.16, bx, by, bz)); // 钟唇
  p.gold.push(box('gold', 0.16, 0.16, bellR * 1.9, bx, by, bz));
  // ③b 钟摆（R32：吊梁 + 摆杆 + 摆锤，挂在**右拱开口**内（钟在左拱，互不穿插）；
  //     静态斜置读作摆动——几何不动画，避免运行时成本）
  if (o.pendulum !== false && !isLowDetail()) {
    const px = archCx;
    const beamY = cy + chamberH * 0.88;
    p.gold.push(box('gold', bellR * 2.4, 0.14, 0.14, px, beamY, bz)); // 吊梁
    const rodH = chamberH * 0.46;
    const rod = box('gold', 0.09, rodH, 0.09, px, beamY - rodH / 2, bz);
    rod.rotateZ(0.16); // 静态摆动角
    p.gold.push(rod);
    const bobR = bellR * 0.52;
    const bob = new THREE.CylinderGeometry(bobR, bobR, bobR * 1.7, 8, 1, false);
    bob.rotateZ(0.16);
    bob.translate(px + Math.sin(0.16) * rodH * 0.5, beamY - rodH - bobR * 0.7, bz);
    p.gold.push(goldUV(bob));
  }
  // ③c 圆形钟表（R32：金面 + 罗马字刻度环 + 双针；直径 = 塔宽 1/6，参考图 B）
  if (o.clock !== false) {
    const cd = w / 6;
    const ccy = cy + chamberH * 0.52;
    const ccz = w * 0.46 - 0.06;
    // 金圈（16 面开口筒，32 tri）
    const ring = new THREE.CylinderGeometry(cd / 2 + 0.1, cd / 2 + 0.1, 0.22, 16, 1, true);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, ccy, ccz);
    p.gold.push(goldUV(ring));
    // 近黑盘面（16 面，32 tri）
    const face = new THREE.CylinderGeometry(cd / 2, cd / 2, 0.3, 16, 1, false);
    face.rotateX(Math.PI / 2);
    face.translate(0, ccy, ccz - 0.02);
    p.dark.push(face);
    // 罗马字刻度环（12 颗金珠 = 钟点刻度；低配档减半）
    const ticks = isLowDetail() ? 6 : 12;
    for (let i = 0; i < ticks; i += 1) {
      const a = (i / ticks) * Math.PI * 2;
      const tk = new THREE.CylinderGeometry(cd * 0.045, cd * 0.045, 0.16, 6, 1, false);
      tk.rotateX(Math.PI / 2);
      tk.translate(Math.cos(a) * cd * 0.38, ccy + Math.sin(a) * cd * 0.38, ccz + 0.02);
      p.gold.push(goldUV(tk));
    }
    // 双针（金）
    p.gold.push(box('gold', 0.1, cd * 0.3, 0.1, 0, ccy + cd * 0.15, ccz - 0.12));
    p.gold.push(box('gold', cd * 0.22, 0.1, 0.1, cd * 0.11, ccy, ccz - 0.12));
  }
  // ④ 四坡瓦顶（roof 桶）
  const roofH = h - cy - chamberH;
  const roof = new THREE.ConeGeometry(w * 0.78, roofH, 4, 1);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, cy + chamberH + roofH / 2, 0);
  (p.roof ??= []).push(finishArch(roof, STONE_TILE_METERS.roof));
  // ⑤ 顶饰（低配跳过）
  if (!isLowDetail()) {
    pour(p, mapParts(finialOrnament({ r: w * 0.16 }), (g) => g.translate(0, h + 0.4, 0)));
  }
  // ⑥ 塔身金饰条 + 深色窗缝
  for (const s of [-1, 1] as const) {
    p.gold.push(box('gold', 0.22, shaftTop * 0.8, 0.14, s * (w / 2 - 0.12), 1.0 + shaftTop * 0.4, w / 2 - 0.1));
  }
  p.dark.push(box('dark', 0.5, w * 0.3, 1.2, 0, shaftTop * 0.55, w / 2 + 0.02));
  return p;
}

/**
 * 哥特开间复合体（gothicBay：壁柱 + 花格窗 + 盲拱 + 檐口线脚 + 小尖塔）——
 * **可复用单元**，供城内立面与主殿立面统一调用（语汇一致性）。
 * 局部：墙面 x=0、立面朝 −x、开间沿 z（块心 z=0）、地面 y=0。
 * 单间 ≈280 tri。低配档：窗棂/圆光/小尖塔细节由子件自带低配逻辑处理。
 */
export function gothicBay(o: {
  w: number;
  h: number;
  winRise?: number;
  winBaseY?: number;
  pinnacle?: boolean;
}): DetailParts {
  const p = parts();
  const w = o.w;
  const h = o.h;
  const winRise = o.winRise ?? h * 0.3;
  const winBaseY = o.winBaseY ?? h * 0.18;
  // ① 双壁柱（Wall_1 语汇：带柱础/柱头的收分方柱）
  for (const s of [-1, 1] as const) {
    const pz = s * (w / 2 - 0.55);
    p.ashlar.push(box('ashlar', 0.85, 0.5, 1.1, -0.2, 0.25, pz));
    p.ashlar.push(pierColumn(1.1, 0.85, h - 1.6, -0.2, 0.5, pz));
    p.ashlar.push(box('ashlar', 1.3, 0.45, 1.5, -0.3, h - 0.9, pz));
  }
  // ② 花格窗（宽窗自动带子尖拱）
  pour(
    p,
    mapParts(
      traceryWindowX({ halfW: w * 0.3, rise: winRise, cusp: 0.7, frameOut: 0.45, plateBack: 0.3, mullions: 2 }),
      (g) => g.translate(0, winBaseY, 0)
    )
  );
  // ③ 窗上盲拱（模块拱 Arch_3.001 语汇：龛口 0.887×开间）
  const blind = archBand(w * 0.44, winBaseY + winRise + 0.9, h * 0.14, 0.24, 0.4, 2, 0.5, 0.45);
  archToFaceX(blind);
  p.ashlar.push(blind);
  // ④ 檐口线脚
  pour(p, mapParts(corniceBand({ len: w + 0.6, proj: 0.6, h: 1.1 }), (g) => g.translate(-0.1, h - 1.2, 0)));
  // ⑤ 顶小尖塔
  if (o.pinnacle !== false && !isLowDetail()) {
    p.ashlar.push(spire('ashlar', w * 0.14, 0, 1.6, 4, -0.3, h + 0.1, 0, Math.PI / 4));
  }
  return p;
}
