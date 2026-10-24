/**
 * R30 FBX 构件库程序化复刻 —— 环境几何线 A（耿键码，2026-10-24）
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────────────
 * R29 的 castleKit 只有「box / spire / 双心尖拱 / lancetWindow」四种形体词汇，
 * FBX 构件库（SM_Gat 28 件 / SM_Det 79 件，`.qa/r30_fbx/*.json` 实测）里最核心的
 * 装饰语汇全部缺失（r30_plan §2 差距清单 P0）。本文件按**实测尺寸 + 参考图双重
 * 像素析结论**复刻七族构件 + 连廊：
 *   ① 飞扶壁族     flyingButtress    Contrforce 家族 14 件（SM_Gat 4 + SM_Det 10）
 *   ② 尖拱凹龛盲拱列 blindArcadeRow   参考图构件 2 的 identity（Wall_1/2/3 为依据）
 *   ③ 窗花格分格尖拱窗 traceryWindowX/Z  Window 全系（换掉 lancetWindow 俭朴版）
 *   ④ 卷叶金饰     crocketRun        沿尖拱斜边等距小卷叶（参考图门楼/塔冠）
 *   ⑤ 纹章顶饰     finialOrnament    中部上方金色放射/花瓣纹章（参考图构件 3）
 *   ⑥ 雕像凹龛     statueNiche       Decor_1~9 家族（冠顶/转角）
 *   ⑦ 檐口/柱头/瓶柱 corniceBand / capitalCollar / balusterPost
 *       Cornice_2_Full 18.30×1.41×0.68 / Collumn 全系 / Baluster_1 1.59×4.45
 *   ⑧ 高架连廊     corridorRun / corridorCrossing / corridorGallery
 *       Beam_1~4 长梁 6.21~7.47m + Arch 组合的街面拱廊 / 跨街封闭拱顶廊 / 墙顶敞廊
 *       （R30 用户令「检查城堡内部：建筑少且矮、无连廊」）
 *
 * ── 坐标 / UV 口径（与 castleKit 完全一致，不发明新方案）───────────────────
 * 一切形体先按**局部坐标**产，再由调用方（castleKit）一次性镜像/平移到世界：
 *   · 墙面在 x=0、墙体向 +x 延伸（朝街面 = −x）；沿街排列轴 = z，块心 z=0；
 *   · 尖拱件默认**无法线**，finishArch / planarUV 收尾（进口 castleKit，禁本地另写）；
 *   · 米制 UV：金件统一按 STONE_TILE_METERS.gold（1.2m）——archBand 自带的是
 *     ashlar 6.4m 口径，金环金线这类小件必须覆写，否则金饰纹理被放大 5 倍。
 *
 * ── 低配档（铁律 33：只降装饰密度，不改几何长度）──────────────────────────
 * isLowDetail() 时：卷叶 crocket 整族跳过（与 castleKit R29 同规矩）、栏板瓶柱
 * 密度减半；飞扶壁/盲拱/花格窗/连廊/角塔等**结构件一律保留**。
 *
 * ── 预算（r30_plan §4：castle high 260k / frame 360k；R29 基线 181,342）─────
 * 单件 tri 上限：飞扶壁 ≤80 / 盲拱龛 ≤80 / 花格窗 ≤120 / 卷叶 ≤20 / 雕像龛 ≤76 /
 * 檐口 ≤36 / 柱头 ≤20 / 瓶柱 ≤36 / 连廊段 ≤300。铺量账见 castleKit 挂载点注释。
 * 所有产出只进 castleKit 既有 5 桶（ashlar/wall/gold/dark/flame），**不新增桶类型**
 * （castle.ts 不在本轮白名单，新桶不会被合并 ⇒ DC 必爆）。
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

/** 金件 UV 口径（archBand/archPlate 自带的是 ashlar 6.4m，金饰必须覆写成 1.2m） */
const GOLD_TILE = STONE_TILE_METERS.gold;

/* ═══════════════════ 分桶容器（与 StoneBuckets 同构的小件包） ═══════════════════ */

/** 构件族产出的分桶几何（wall/flame 多数族为空，但保持同构方便 pour） */
export interface DetailParts {
  ashlar: THREE.BufferGeometry[];
  wall: THREE.BufferGeometry[];
  gold: THREE.BufferGeometry[];
  dark: THREE.BufferGeometry[];
  flame: THREE.BufferGeometry[];
}

function parts(): DetailParts {
  return { ashlar: [], wall: [], gold: [], dark: [], flame: [] };
}

/** 把构件族产出整体摊进 castleKit 的桶（含 R29 可选桶不需要——本文件不产新桶） */
export function pour(b: StoneBuckets, p: DetailParts): void {
  b.ashlar.push(...p.ashlar);
  b.wall.push(...p.wall);
  b.gold.push(...p.gold);
  b.dark.push(...p.dark);
  b.flame.push(...p.flame);
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
  return {
    ashlar: p.ashlar.map(f),
    wall: p.wall.map(f),
    gold: p.gold.map(f),
    dark: p.dark.map(f),
    flame: p.flame.map(f)
  };
}

/* ═══════════════════ 私有基元 ═══════════════════ */

/**
 * 沿点列的等厚条带（x-y 剖面，沿 −z 挤出 depth）——飞扶壁拱肋 / 拱廊拱带。
 * 法线取中心差分（端点单侧），条带 = 外偏 +band/2 与内偏 −band/2 两条点列闭合。
 * tri = 4×(2N)−4 = 8N−4（N = 中心线点数；N=4 ⇒ 28 tri）。
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

/* ═══════════════════ ① 飞扶壁族（Contrforce：墩 + 半拱 + 坡顶 + 金尖顶） ═══════════════════ */

/**
 * FBX 实测（SM_Gat Contrforce3_Full 1.68×18.21×0.73 / Contrforce3_Full_1 2.02×12.65×0.78；
 * SM_Det Contrforce_1 1.79×6.64×2.19 / Contrforce2_1 1.88×6.80×0.74）：高薄件，
 * 形体 = 外墩（BeamVertical 通天柱语汇）+ 墩顶起拱的曲面飞拱 + 坡顶盖板 + 落点金尖顶。
 * 参考图门楼双墩两侧的浅拱即此族（`.qa/r30_fbx/png/sm_gat/SM_Gat_front.png` 实证）。
 *
 * 局部约定：墙面 x=0、扶壁向 +x 伸出、z 居中（depth 沿 z）。单件 ≈80 tri。
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
}

export function flyingButtress(o: ButtressOpts): DetailParts {
  const p = parts();
  const baseY = o.baseY ?? 0;
  const depth = o.depth ?? 0.9;
  const band = o.band ?? 0.66;
  const pierW = o.pierW ?? 1.7;
  const rise = o.topY - o.springY;
  const pierX = o.reach - pierW * 0.5;

  // ① 外墩：收分方柱（8 tri）+ 墩脚托石
  p.ashlar.push(pierColumn(pierW, pierW * 0.84, o.springY - baseY, pierX, baseY, 0));
  p.ashlar.push(box('ashlar', pierW + 0.8, 0.5, depth + 0.8, pierX, baseY + 0.25, 0));
  // ② 飞拱肋：4 点中心线等厚条带（28 tri），自墩顶凹曲升至墙面
  const cl: readonly (readonly [number, number])[] = [
    [pierX + pierW * 0.3, o.springY + 0.12],
    [o.reach * 0.68, o.springY + rise * 0.3],
    [o.reach * 0.36, o.springY + rise * 0.68],
    [0.1, o.topY - 0.06]
  ];
  p.ashlar.push(thickStrip(cl, band, depth));
  // ③ 坡顶盖板（拱肋上缘斜板，读作"有瓦顶的扶壁"）
  {
    const ax = o.reach * 0.6;
    const ay = o.springY + rise * 0.4;
    const bx = 0.12;
    const by = o.topY;
    const len = Math.hypot(ax - bx, by - ay);
    const ang = Math.atan2(by - ay, ax - bx);
    p.ashlar.push(boxRot('ashlar', len, 0.42, depth * 0.92, (ax + bx) / 2, (ay + by) / 2, 0, ang));
  }
  // ④ 落点金尖顶 + 金珠（hero 档；参考图门楼/塔冠的收口）
  if (o.pinnacle) {
    const cone = new THREE.ConeGeometry(0.22, 1.1, 4, 1);
    cone.translate(0.1, o.topY + 0.55, 0);
    p.gold.push(goldUV(cone));
    const bead = new THREE.CylinderGeometry(0.26, 0.26, 0.34, 6, 1, true);
    bead.translate(0.1, o.topY + 0.17, 0);
    p.gold.push(goldUV(bead));
  }
  return p;
}

/* ═══════════════════ ② 尖拱凹龛盲拱列（参考图构件 2 的 identity） ═══════════════════ */

/**
 * 参考图构件 2（矮墙）的 identity：**一排尖拱凹龛盲拱**——龛内嵌近黑内衬桶 +
 * 金线勾边 + 龛间隔柱 + 龛顶/龛底通长金线 + 龛间金竖条。FBX 依据 Wall_1/2/3
 * （2.49×3.79×0.72 / 0.50×2.48×0.16）与参考图像素析。
 *
 * 局部约定：墙面 x=0、龛内衬嵌进 +x、金框挑出 −x、沿 z 排列（块心 z=0）、龛底 y=0。
 * 单龛 ≈80 tri（内衬 24 + 金框 32 + 间柱 12 + 金竖条 12），另每行 2 条通长金线。
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
  const plateBack = o.plateBack ?? 0.5;
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
    // ① 近黑内衬桶（嵌进墙体 +x）
    const plate = archPlate(o.halfW - 0.05, 0, o.rise, plateBack, 2, cusp);
    darks.push(archIntoWallX(plate, plateBack).translate(0, 0, zc));
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

/* ═══════════════════ ③ 窗花格分格尖拱窗（换掉 lancetWindow 的俭朴版） ═══════════════════ */

/**
 * FBX Window1/2/3 全系（0.81~1.45 宽 × 1.26~8.62 高，SM_Gat Window3_Full 1.24×8.62；
 * SM_Det Window1_3 0.811×2.041 / Window2_4 1.453×1.94 等）：**尖拱轮廓 + 内 2~3 枝
 * 竖棂 + 拱肩小圆光 + 金框**（dark 背板 + gold 框线 + 石棂）。
 *
 * 与 lancetWindow 的口径差（R30 换装）：lancet ≈182 tri/扇（券框 archBand 7 段 +
 * 背板 6 段 + 窗台），花格窗 ≈96~120 tri/扇（券框 3 段 + 背板 2 段 + 2 竖棂 +
 * 2 拱肩光）——**铺量前先算账**：城内 360 扇全换装净省 ≈66 tri/扇。
 *
 * 局部约定（与 lancetWindowX/Z 一致）：
 *   face 'x'：墙面 x=0、墙体向 +x；券框挑出 −x（x∈[−frameOut,0]）、背板嵌 +x；
 *             拱沿 z 跨（窗洞水平轴 = z）。
 *   face 'z'：墙面 z=0、墙体向 −z；券框挑出 +z（z∈[0,frameOut]）、背板嵌 −z；
 *             拱沿 x 跨。
 * 单件：无圆光 96 tri / 带圆光 120 tri（含 3 棂版 108/132——调用方按窗宽选）。
 */
export interface TraceryOpts {
  halfW: number;
  rise: number;
  cusp?: number;
  band?: number;
  frameOut?: number;
  plateBack?: number;
  mullions?: 2 | 3;
  lights?: boolean;
}

function traceryWindow(o: TraceryOpts & { face: 'x' | 'z' }): DetailParts {
  const p = parts();
  const halfW = o.halfW;
  const rise = o.rise;
  const cusp = o.cusp ?? 0.7;
  const band = o.band ?? 0.22;
  const frameOut = o.frameOut ?? 0.45;
  const plateBack = o.plateBack ?? 0.3;
  const mullions = o.mullions ?? 2;
  const faceX = o.face === 'x';

  // ① 金券框（尖拱环 3 段；底边即窗台线）
  const ring = archBand(halfW, 0, rise, band, frameOut, 3, cusp, 0.45);
  if (faceX) archToFaceX(ring);
  else ring.rotateY(Math.PI); // z∈[0, frameOut]
  p.gold.push(goldUV(ring));
  // ② 近黑背板（2 段尖拱板）
  const plate = archPlate(halfW - band * 0.55, 0, rise, plateBack, 2, cusp);
  if (faceX) archIntoWallX(plate, plateBack);
  p.dark.push(plate);
  // ③ 竖棂（石，2~3 枝；顶没入拱环即"棂冠合拱"）
  const mullW = Math.max(0.1, halfW * 0.13);
  const mullH = rise * 0.74;
  const offs = mullions >= 3 ? [-halfW * 0.52, 0, halfW * 0.52] : [-halfW * 0.36, halfW * 0.36];
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
  p.ashlar.push(mergeSafe(mullionsGeo));
  mullionsGeo.forEach((g) => g.dispose());
  // ④ 拱肩小圆光（金，hero 档；6 面开口薄筒 = 12 tri/枚）
  if (o.lights) {
    const lr = Math.min(0.17, halfW * 0.2);
    const lightsGeo: THREE.BufferGeometry[] = [];
    for (const off of [-halfW * 0.6, halfW * 0.6]) {
      const disc = new THREE.CylinderGeometry(lr, lr, 0.12, 6, 1, true);
      if (faceX) {
        disc.rotateZ(Math.PI / 2);
        disc.translate(-frameOut * 0.55, rise * 0.46, off);
      } else {
        disc.rotateX(Math.PI / 2);
        disc.translate(off, rise * 0.46, frameOut * 0.55);
      }
      lightsGeo.push(goldUV(disc));
    }
    p.gold.push(mergeSafe(lightsGeo));
    lightsGeo.forEach((g) => g.dispose());
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
 * 拱面外法线 ⇒ 读作"沿拱边卷出的金叶"。FBX 无同名件（SM_Gat/Det 的塔冠斜边即此），
 * 形制取参考图构件 3/4 塔冠。
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
  if (isLowDetail()) return p; // 低配跳过卷叶（铁律 33：装饰密度）
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

/* ═══════════════════ ⑤ 纹章顶饰（中部上方金色放射/花瓣纹章） ═══════════════════ */

/**
 * 参考图构件 3（门楼）正中上方的**金色放射/花瓣纹章**：金盘 + 6 枝放射金刺 +
 * 芯珠 + 顶尖。竖直安装于塔冠/主殿冠顶（门楼墙面的金日轮归 makeGate 既有件，
 * 本族只管"冠顶"这一档）。单件 ≈84 tri。
 */
export function finialOrnament(o: { r: number; petals?: number }): DetailParts {
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
  p.gold.push(mergeSafe(spikes));
  spikes.forEach((g) => g.dispose());
  // 芯珠 + 顶尖
  const bead = new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 0.4, 6, 1, true);
  bead.translate(0, r * 0.42 + r * 0.2, 0);
  p.gold.push(goldUV(bead));
  const tip = new THREE.ConeGeometry(r * 0.14, r * 0.9, 4, 1);
  tip.translate(0, r * 0.62 + r * 0.45, 0);
  p.gold.push(goldUV(tip));
  return p;
}

/* ═══════════════════ ⑥ 雕像凹龛（Decor 家族：凹龛 + 内立简化雕像） ═══════════════════ */

/**
 * FBX Decor_1~9 家族（1.0~2.24 × 2.84~5.81）的通用语汇：ashlar 凹龛 + dark 底 +
 * 金框 + 龛内简化雕像（收分身 + 头）。用于冠顶/转角（城门塔顶、铃塔侧壁、
 * 主殿正立面、城内角塔）。单件 ≈76 tri。
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
}): DetailParts {
  const p = parts();
  const faceX = (o.face ?? 'x') === 'x';
  const frameOut = o.frameOut ?? 0.4;
  const plateBack = o.plateBack ?? 0.3;
  const cusp = o.cusp ?? 0.5;
  // ① 近黑龛底
  const plate = archPlate(o.halfW - 0.05, 0, o.rise, plateBack, 2, cusp);
  if (faceX) archIntoWallX(plate, plateBack);
  p.dark.push(plate);
  // ② 金框
  const ring = archBand(o.halfW, 0, o.rise, 0.18, frameOut, 2, cusp, 0.45);
  if (faceX) archToFaceX(ring);
  else ring.rotateY(Math.PI);
  p.gold.push(goldUV(ring));
  // ③ 简化雕像（收分身 4 面棱柱 8 tri + 头珠 12 tri）
  const bodyR = o.halfW * 0.3;
  const bodyH = o.rise * 0.52;
  const body = spire('ashlar', bodyR, bodyR * 0.72, bodyH, 4, 0, 0.12, 0);
  if (faceX) {
    body.rotateY(Math.PI / 4);
    body.translate(plateBack * 0.32, 0, 0);
  } else {
    body.rotateY(Math.PI / 4);
    body.translate(0, 0, -plateBack * 0.32);
  }
  p.ashlar.push(body);
  const head = new THREE.CylinderGeometry(o.halfW * 0.16, o.halfW * 0.16, o.halfW * 0.3, 6, 1, true);
  head.translate(faceX ? plateBack * 0.32 : 0, 0.12 + bodyH + o.halfW * 0.15, faceX ? 0 : -plateBack * 0.32);
  p.ashlar.push(head);
  return p;
}

/** 雕像凹龛 · ±x 朝向墙 */
export function statueNicheX(o: {
  halfW: number;
  rise: number;
  frameOut?: number;
  plateBack?: number;
  cusp?: number;
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
}): DetailParts {
  return statueNiche({ ...o, face: 'z' });
}

/* ═══════════════════ ⑦ 檐口带 / 柱头环 / 瓶柱 ═══════════════════ */

/**
 * 檐口带（FBX Cornice_2_Full 18.30×1.41×0.68 / Cornice_2 2.16×2.82×0.93）：
 * 分层檐口 = 身托石 + 冠石 + 金压顶线。局部：贴墙面 x=0、向 −x 挑出 proj、
 * 沿 z 长 len、总高 ≈ h×1.18。单件 36 tri。
 */
export function corniceBand(o: { len: number; proj?: number; h?: number }): DetailParts {
  const p = parts();
  const proj = o.proj ?? 0.68;
  const h = o.h ?? 1.41;
  p.ashlar.push(box('ashlar', proj * 0.75, h * 0.4, o.len, -proj * 0.375, h * 0.2, 0));
  p.ashlar.push(box('ashlar', proj, h * 0.6, o.len, -proj * 0.5, h * 0.7, 0));
  p.gold.push(box('gold', proj + 0.12, h * 0.18, o.len, -proj * 0.5 - 0.06, h * 1.09, 0));
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
 * 建筑用宝瓶柱（FBX Baluster_1 1.59×4.45×1.59 / Baluster_2 1.28×4.48）：
 * 宝瓶收分三段（座 / 腰 / 颈）。局部：y 0..h、x/z 以柱心为 0。单件 36 tri。
 */
export function balusterPost(o: { h: number; r?: number }): DetailParts {
  const p = parts();
  const r = o.r ?? 0.16;
  p.ashlar.push(spire('ashlar', r * 1.35, r * 1.2, o.h * 0.14, 6, 0, 0, 0));
  p.ashlar.push(spire('ashlar', r * 0.8, r * 0.62, o.h * 0.52, 6, 0, o.h * 0.14, 0));
  p.ashlar.push(spire('ashlar', r * 0.5, r * 0.42, o.h * 0.34, 6, 0, o.h * 0.66, 0));
  return p;
}

/* ═══════════════════ ⑧ 高架连廊（街面拱廊 / 跨街封闭拱顶廊 / 墙顶敞廊） ═══════════════════ */

/**
 * 街面低拱廊（连廊主体，R30 用户令「建筑间高架拱廊……沿街连接各建筑」）：
 * 楼面 + 外侧柱列（带柱头环）+ 柱间尖拱 + 檐口金线 + 外侧栏板。
 * FBX 依据 Beam_1~4 长梁（6.21~7.47m）+ Arch_1~6 拱的组合读法。
 *
 * 局部约定：贴墙面 x=0、向 −x 挑出 width、沿 z 长 len（块心 z=0）、楼面 y=floorY。
 * 单段（len≈44）≈300 tri：楼面 24 + 柱 32 + 柱头 40 + 拱 96 + 檐口 24 + 栏板 84。
 * ⚠ 楼面必须 > 4.5m（行车走廊上沿，r29_corridor_probe 判据）；柱列落在街面
 *   |x|≥11 区内，不占 |x|<8 走廊。
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
  // ① 楼面 + 外棱金线
  p.ashlar.push(box('ashlar', o.width, 0.45, o.len, -o.width / 2, o.floorY, 0));
  p.gold.push(box('gold', 0.14, 0.16, o.len, -o.width, o.floorY + 0.05, 0));
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
  for (const [za, zb] of gaps) {
    const half = (zb - za) / 2;
    const zc = (za + zb) / 2;
    const g = archBand(half, o.floorY, rise, band, o.width, 2, 0.35, 0.45);
    archToFaceX(g); // x∈[−width, 0]，拱跨 ±half 沿 z
    arches.push(g.translate(0, 0, zc));
  }
  p.ashlar.push(mergeSafe(arches));
  arches.forEach((g) => g.dispose());
  // ④ 檐口 + 金线
  p.ashlar.push(box('ashlar', o.width + 0.4, 0.4, o.len, -o.width / 2 - 0.2, o.floorY + rise + 0.2, 0));
  p.gold.push(box('gold', o.width + 0.5, 0.18, o.len, -o.width / 2 - 0.25, o.floorY + rise + 0.55, 0));
  // ⑤ 外侧栏板（金压顶 + 宝瓶柱；FBX Baluster 语汇。低配档隔根布置——铁律 33
  //   只降装饰密度，栏板金压顶与楼面长度不变）
  if (o.rail !== false) {
    p.gold.push(box('gold', 0.12, 0.9, o.len, -o.width - 0.06, o.floorY + 0.45, 0));
    const posts = Math.max(2, Math.floor(o.len / 4.6));
    for (let i = 0; i < posts; i += 1) {
      if (isLowDetail() && i % 2 === 1) continue;
      const cz = -o.len / 2 + (o.len * (i + 0.5)) / posts;
      pour(p, mapParts(balusterPost({ h: 0.85, r: 0.1 }), (g) => g.translate(-o.width - 0.06, o.floorY + 0.45, cz)));
    }
  }
  return p;
}

/**
 * 跨街封闭拱顶廊（连廊 · 跨路连接两侧）：楼面 + 两侧胸墙 + 筒形拱顶 +
 * 胸墙深色窗缝 + 拱脚金线。FBX「Beam 长梁 + Arch 组合的封闭/拱顶廊道」读法。
 * 局部：跨度 span 沿 x、宽 width 沿 z、楼面 y=floorY、x/z 居中。
 * 单件 ≈156 tri。楼面/胸墙/拱顶全部 y ≥ floorY−0.5（>4.5）⇒ 不进行车走廊。
 */
export function corridorCrossing(o: { span: number; width: number; floorY: number; rise?: number }): DetailParts {
  const p = parts();
  const rise = o.rise ?? 1.7;
  // ① 楼面
  p.ashlar.push(box('ashlar', o.span, 0.5, o.width, 0, o.floorY, 0));
  // ② 两侧胸墙
  for (const s of [-1, 1] as const) {
    p.ashlar.push(box('ashlar', o.span, 2.0, 0.35, 0, o.floorY + 1.25, s * (o.width / 2 - 0.175)));
  }
  // ③ 筒形拱顶（尖拱带沿 x 挤出 = 跨街筒拱）
  const vault = archBand(o.width / 2, o.floorY + 2.25, rise, 0.3, o.span, 3, 0.3, 0.45);
  vault.rotateY(Math.PI / 2); // 挤出方向 → x（x∈[−span,0]）
  vault.translate(o.span / 2, 0, 0); // x∈[−span/2, span/2]
  p.ashlar.push(vault);
  // ④ 拱脚金线 ×2 + 胸墙深色窗缝 ×4（窗缝按半跨的 62% 分布，不出跨度）
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
 * 墙顶敞廊（连廊 · 城门楼↔翼墙 / 主殿两翼之间）：楼面 + 双侧瓶柱栏板 +
 * 金压顶 + 金底线。局部：宽 width 沿 x、长 len 沿 z、楼面 y=floorY、x/z 居中。
 * 单件 ≈132 tri。
 */
export function corridorGallery(o: { len: number; width: number; floorY: number }): DetailParts {
  const p = parts();
  p.ashlar.push(box('ashlar', o.width, 0.5, o.len, 0, o.floorY, 0));
  p.gold.push(box('gold', 0.16, 0.14, o.len, 0, o.floorY + 0.3, 0));
  const posts = Math.max(2, Math.floor(o.len / 4.6));
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
