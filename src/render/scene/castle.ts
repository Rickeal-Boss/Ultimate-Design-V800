/**
 * 白城堡（哥特式白石大教堂）+ **可行驶御桥** 场景装配层 —— 材质 + 安放 + 预算统计。
 *
 * ── R27 架构（2026-10-23，依据 FBX 实测 `.qa/r27_measure.md` + 三张官方渲染图）──────
 * R26 版是「尖拱拱廊长廊 + 双侧大教堂 + 远景塔尖」的旧设想，与外包交付参考图
 * （7cd7329c 车视正桥 / 2497fab5 桥侧全景 / 2a302891 近景）完全不同。R27 按实测重建：
 *   ① 御桥：24 跨双心尖拱（中央主券 + 侧区两层券廊 + 4 束柱墩）+ 2.2m 金顶栏板
 *      + 火盆灯柱 + 三带铺装（深车行带 + 两侧浅边带 + 白步道）；
 *   ② 城门楼：20×30 尖拱门洞（14m 隧道）+ 双塔墩 + 三层金券 + 金饰圆盘；
 *   ③ 城内大街：殿 / 塔 / 连墙 / 尖拱窗 / 垛口 / 金线 / 火盆，夹道至路障。
 * 全部构件在 castleKit.ts 里**直接产世界坐标几何**，本类只做：按材质族归桶 →
 * 每族 merge 成 1 mesh → 统计。没有任何 InstancedMesh（R26 的 8 个实例族全部
 * 随旧设计删除），也没有逐件 transform。
 *
 * ── DC 策略 ───────────────────────────────────────────────────────────────
 *   ashlar 静态（桥体拱墩 + 栏板条石 + 城门主体 + 城内建筑）  = 1 DC
 *   wall   静态（城内连墙）                                  = 1 DC
 *   gold   静态（栏板金顶徽章 + 城门金饰 + 城内金线火盆）      = 1 DC
 *   dark   静态（门洞隧道内衬 + 所有尖拱窗背板）              = 1 DC
 *   flame  静态（火盆焰，MeshBasic 靠 bloom）                = 1 DC
 *   pave-road / pave-walk（铺装两片，vertexColor 分档）       = 2 DC
 * ⇒ 合计 7 DC（R27_BUDGET.castleDc = 20，余量留给后续装饰）。
 *   R29 追加 roof / wood / glass / marble 四个**可选桶**（见 EXTRA_BUCKETS）：
 *   空桶不建 mesh、不占 DC ⇒ 在 castleKit 补桶之前 DC 仍是 7；补桶后每族 +1 DC（≤11）。
 *
 * ── 为什么不投阴影 ─────────────────────────────────────────────────────
 * 主光是超低角（逆光 12°），55m 高的城门尖塔会投出几百米长的影子，而阴影正交框
 * 只有 ±28m —— 会被裁成一条随车移动的硬边，比不投影难看。整族 castShadow=false，
 * 形体塑造交给 normalMap 掠射光 + 环境贴图，也省掉每帧阴影 pass 的重绘。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { makeStoneMaps, stoneTextureSize } from './stoneTexture';
import type { StoneKind } from './stoneTexture';
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

/* ─────────────────────── 材质 ─────────────────────── */

/**
 * R29 新族桶（roof / wood / glass / marble）。
 *
 * ── 为什么要走「防御式读取」而不是直接在 StoneBuckets 上加字段 ────────────
 * `castleKit.ts` 归环境线（本轮白名单外，只读）。本文件不能改它的 `StoneBuckets`
 * 接口，于是这里按**可选键**去读：castleKit 一旦补上 `b.roof.push(...)`，下一帧
 * 就自动点亮，无需再改本文件；在补桶之前桶是空的 ⇒ 不建 mesh、不占 DC、零回归。
 * `absorb` 里的 as 转换只碰这几个可选键，5 个既有桶走正常类型路径。
 */
const EXTRA_BUCKETS = ['roof', 'wood', 'glass', 'marble'] as const;
type ExtraBucket = (typeof EXTRA_BUCKETS)[number];

/**
 * 各族的**目标有效粗糙度**（effective = material.roughness × roughnessMap.g）。
 * ⚠ 铁律 34：贴图里写的是绝对粗糙度，material.roughness 必须按 `target / ḡ` 反算，
 *   直接把 target 填进 material.roughness 会让有效值变成 target×ḡ（金饰旧代码就这样
 *   变成 0.42×0.32 = 0.135 的镜面）。反算值 >1 会被 three 钳到 1，所以贴图的目标值
 *   必须 ≥ 这里的 target，否则达不到（stoneTexture 的各族 faceRough 已按此对齐）。
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
  // 玻璃给一点点 metalness：只为了把掠射角的菲涅耳抬起来（读成"有反射的玻璃"），
  // 绝不走 transmission/transparent —— R12 铁律⑤：透射会让整场景重绘（DC 244 根因）
  glass: 0.06,
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
 * 按 1/ḡ 反算 material.roughness（铁律 34）。
 * ḡ 是生成实测值（`StoneStats.roughMean`），不是拍脑袋的常量 —— 改贴图参数后
 * 这里会自动跟着走，不会出现"改了贴图、粗糙度悄悄漂了"的事故。
 */
function inverseRoughness(target: number, roughMean: number): number {
  if (!Number.isFinite(roughMean) || roughMean <= 0.01) return target;
  return Math.min(1, Math.max(0.05, target / roughMean));
}

/**
 * 石材/建材族通用材质。
 *
 * 白石 roughness 目标 0.86 / metalness 0；wall 0.9（更糙，用在连墙等次级面）；
 * gold metalness 0.85 / 目标 0.42 / envMapIntensity 1.4（唯一金属族，形体全靠环境反射）。
 * 石头 envMapIntensity 压到 0.85/0.75：PMREM 是为车漆做的柔光箱（含 3.6 倍过曝顶板），
 * 吃满会把砌缝洗平。配光是逆光暴风天光（sun 12°/2.2、hemi 0.42、fill 0.55），
 * 白石受光面主要靠 hemi + 掠射 —— 若游戏页偏暗，先调这三个 envMapIntensity，
 * **不要**动贴图基色（吸色硬数据）。
 */
function stoneMaterial(kind: StoneKind, size: number, weather: number): THREE.MeshStandardMaterial {
  const maps = makeStoneMaps(kind, { repeat: [1, 1], weather, size });
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    // R29：1 → 0.55 —— 砌缝法线强度减半（实测：1.0 时 0.8m 皮高的砌缝在 88m 立面上
    // 读成"深雕砖墙"，参考图是**弱缝大板块**，缝只在掠射光下淡淡现形）
    normalScale: new THREE.Vector2(0.55, 0.55),
    color: 0xffffff,
    metalness: FAMILY_METAL[kind],
    // 铁律 34：贴图写的是绝对粗糙度 ⇒ 这里必须是 1/ḡ 反算
    roughness: inverseRoughness(TARGET_ROUGH[kind], maps.stats.roughMean),
    envMapIntensity: FAMILY_ENV[kind],
    // 金饰「发光感」：逆光暴云天下金属只有环境反射一条路（metalness 0.85 ⇒ 漫反射 ≈ 0），
    // 背光面与朝下面无光可吃 —— 城门拱脚带朝下面在车视机位实测读到 L=25 近黑
    // （r27_final tunnel_drive 像素探针）。R28 视觉规格书定的金饰 albedo = #C9A227
    // （中调）/ #F0D45C（高光），比旧 #a7843c 旧黄铜更亮；自辉用**降饱和金**
    // 0xb8902f × 0.35：够把暗面托离死黑（L≈90），又不致在逆光下整片发「橙」
    // （qa 复拍复核：0xc9a227×0.42 时金饰偏橙、对比生硬，参考图要的是「柔和亮金」）。
    // R29：0.35 → **0.22**。0.35 时金饰在逆光下读成"自发光霓虹条"
    // （verify/r29_c2/gate_hero.png：竖向金线比白石亮 3 档、边缘发橙），
    // 参考图的金是**受光金属**（暗部有反射层次、只有极亮处才 bloom）。
    // 自辉只负责把暗面托离死黑，不负责提亮主色。
    ...(kind === 'gold' ? { emissive: 0xb8902f, emissiveIntensity: 0.22 } : {})
  });
}

/** 近黑门洞/暗龛：不进石材族，否则会变成"亮洞"，深门层次全丢（刻意纯色，不贴图） */
function tunnelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x141110, roughness: 1.0, metalness: 0 });
}

/**
 * 火盆焰：MeshBasic 不吃光，靠 bloom 出光晕。色 0xffc27a、亮度 ×1.6 是为了越过
 * Postfx 的 bloom 阈值。绝不加 PointLight：几十盏会打爆前向灯数上限。
 */
function flameMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(1.6) });
}

/**
 * 车行带铺装：floor 族石板 + vertexColor 分档（深带 0.62 / 浅边带 1.28）。
 *
 * **刻意不用 roughnessMap**：floor 族石面 roughness 只有 ~0.39，乘上任何
 * material.roughness 都 ≤0.39 —— 400m 长的水平面在 2.2 强度平行光 + 黄昏环境贴图下
 * 会被菲涅耳镜成一条"刚下过雨的湿沥青"（r26c 实拍两轮实证）。干脆不用
 * roughnessMap、给均匀 0.9，让石板哑下来；色、法线、vertexColor 全部照旧。
 *
 * R29 明度核对：floor 贴图基色已按参考包实测中位改成 **#413f3d（L≈63.7）**
 * （`.qa/r29_tex_stats.json`：StoneFloor_albedo 的中位色就是这个值，硬数据交点）。
 * `color: 0x6a6660` 是把贴图再压到参考图**受光后**的深炭灰档（#393431 一带），
 * 浅边带的相对提亮关系（×1.28）不变。envMapIntensity 0.15 同理由（压掉掠射镜反射）。
 */
function pavementMaterial(size: number): THREE.MeshStandardMaterial {
  const maps = makeStoneMaps('floor', { repeat: [1, 1], weather: 0.4, size });
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(0.8, 0.8),
    // R29：0x6a6660 → **0xffffff**。旧值是为了把 R27 那张偏亮的程序化 floor 贴图
    // 压到参考图的深炭灰档；R29 贴图基色已直接改成吸色实测 #413f3d（L≈62），
    // 再乘 0.42 就是**双重变暗**（实拍 verify/r29_c1/inner_street.png 路面读到 L≈30，
    // 参考图受光后 L≈53–64）⇒ 取消乘色，让贴图自己说话。
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
}

/**
 * 步道铺装：ashlar 族白石（贴图基色即参考图暖白 #e5dcd9 一档）。
 * 同样不挂 roughnessMap：ashlar 的 ḡ≈0.81，水平面在掠射角下仍会镜；
 * 均匀 0.95 全哑光。polygonOffset 与路面条石双保险（步道 14mm / 路面 12mm 已在
 * 几何上分层，这里是防 GPU 深度精度抖动的兜底）。
 */
function walkPavingMaterial(size: number): THREE.MeshStandardMaterial {
  const maps = makeStoneMaps('ashlar', { repeat: [1, 1], weather: 0.35, size });
  return new THREE.MeshStandardMaterial({
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
}

export class Castle {
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly matCache = new Map<string, THREE.Material>();
  /** 静态几何桶（世界坐标），最后每族 merge 成 1 mesh */
  private readonly statics: StoneBuckets = { ashlar: [], wall: [], gold: [], dark: [], flame: [] };
  /** R29 可选桶（castleKit 补桶后自动生效；见 EXTRA_BUCKETS 注释） */
  private readonly extras = new Map<ExtraBucket, THREE.BufferGeometry[]>();
  private tris = 0;
  private dc = 0;

  constructor(scene: THREE.Scene, quality: QualitySettings) {
    // 低配只降装饰密度（尖塔 8→4 面、火焰段数降），**不改任何几何长度**（铁律 33）
    setDetailLevel(quality.tier === 'low');
    // R29：贴图边长按质量档分尺寸（high 只给主角面 1024，见 stoneTextureSize 注释）
    const texSize = (kind: StoneKind): number => stoneTextureSize(kind, quality.tier);
    this.group.name = 'castle';
    this.absorb(makeViaduct());
    this.absorb(makeParapet());
    this.absorb(makeLamps());
    this.absorb(makeGate());
    // R28：塔群（中央钟楼+双铃塔+细尖塔+翼墙，G2 identity）与主殿（撞击目标）
    this.absorb(makeTowerGroup());
    this.absorb(makeInnerCity());
    this.absorb(makeMainHall());
    const pave = makePaving();
    this.addMesh(pave.road, this.special('pave-road', () => pavementMaterial(texSize('floor'))), 'castle-pave-road');
    this.addMesh(pave.walk, this.special('pave-walk', () => walkPavingMaterial(texSize('ashlar'))), 'castle-pave-walk');
    this.commitStatics(texSize);
    scene.add(this.group);
  }

  /** QA 读数：tri 为已装配口径，dc 为整帧 draw call 增量（不含阴影 pass） */
  getCastleStats(): CastleStats {
    return { tris: this.tris, dc: this.dc };
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.matCache.values()) m.dispose();
    this.matCache.clear();
    this.group.removeFromParent();
  }

  /* ─────────────────────── 装配工具 ─────────────────────── */

  private stone(kind: StoneKind, size: number): THREE.MeshStandardMaterial {
    const key = `stone:${kind}:${size}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const weather = kind === 'wall' ? 0.5 : kind === 'gold' ? 0.3 : kind === 'wood' ? 0.55 : 0.35;
    const mat = stoneMaterial(kind, size, weather);
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
  private addMesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.geometries.push(geo);
    this.tris += triCount(geo);
    this.dc += 1;
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
  private commitStatics(texSize: (kind: StoneKind) => number): void {
    this.addMerged(this.statics.ashlar, this.stone('ashlar', texSize('ashlar')), 'castle-ashlar');
    this.addMerged(this.statics.wall, this.stone('wall', texSize('wall')), 'castle-wall');
    this.addMerged(this.statics.gold, this.stone('gold', texSize('gold')), 'castle-gold');
    this.addMerged(this.statics.dark, this.special('dark', tunnelMaterial), 'castle-dark');
    this.addMerged(this.statics.flame, this.special('flame', flameMaterial), 'castle-flame');
    // R29 新族：桶非空才建 mesh（castleKit 未补桶时这里全部跳过 ⇒ DC 不变）
    for (const key of EXTRA_BUCKETS) {
      const parts = this.extras.get(key);
      if (!parts || parts.length === 0) continue;
      this.addMerged(parts, this.stone(key, texSize(key)), `castle-${key}`);
    }
  }

  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string): void {
    if (parts.length === 0) return;
    const merged = mergeSafe(parts);
    parts.forEach((p) => p.dispose());
    this.addMesh(merged, mat, name);
  }
}
