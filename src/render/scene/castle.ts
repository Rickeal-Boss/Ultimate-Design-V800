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
 * ── DC 策略 ───────────────────────────────────────────────────────────────
 *   ashlar / wall / gold / dark / flame 各 1 DC；pave-road / pave-walk 2 DC ⇒ 7 DC。
 *   R29 追加 roof / wood / glass / marble 四个**可选桶**（见 EXTRA_BUCKETS）：补桶后每族 +1 DC（≤11）。
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
import { makeStoneMaps, stoneTextureSize, bakeStoneMapsAsync, disposeStoneCache } from './stoneTexture';
import type { StoneKind, StoneMaps, StoneBakeHandle } from './stoneTexture';
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

/** 释放一套三张贴图（热升级退役代 / 取消代共用） */
function disposeMaps(maps: StoneMaps): void {
  maps.map.dispose();
  maps.normalMap.dispose();
  maps.roughnessMap.dispose();
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
  // 玻璃给一点点 metalness：只为了把掠射角的菲涅耳抬起来，绝不走 transmission（R12 铁律⑤）
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

/** 火盆焰：MeshBasic 不吃光，靠 bloom 出光晕 */
function flameMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(1.6) });
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
  }

  /* ─────────────────────── R30 热升级 ─────────────────────── */

  /** 取/建一个石材族：同步代 256² + 记目标尺寸 + 收集材质槽 */
  private familyFor(kind: StoneKind, weather: number): StoneFamily {
    const key = `${kind}|${weather.toFixed(3)}`;
    let f = this.families.get(key);
    if (!f) {
      const syncMaps = makeStoneMaps(kind, { repeat: [1, 1], weather, size: this.syncTexSize });
      f = {
        kind,
        weather,
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
      const handle = bakeStoneMapsAsync(f.kind, { size: f.targetSize, weather: f.weather, repeat: [1, 1] });
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
      if (slot.usesRoughMap) {
        slot.mat.roughnessMap = target.roughnessMap;
        slot.mat.roughness = inverseRoughness(slot.targetRough, target.stats.roughMean);
      }
      slot.mat.needsUpdate = true;
    }
    const dev = typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;
    if (dev) {
      console.info(
        `[castle] ${f.kind} 热升级 ${f.syncSize}²→${f.targetSize}² roughMean ${target.stats.roughMean.toFixed(3)}` +
          ` n|xy| ${target.stats.normalMag.toFixed(3)}`
      );
    }
  }

  /* ─────────────────────── 装配工具 ─────────────────────── */

  /** 石材族通用材质（ashlar/wall/gold/roof/wood/glass/marble），登记热升级槽 */
  private stoneMaterial(kind: StoneKind, weather: number): THREE.MeshStandardMaterial {
    const maps = this.familyFor(kind, weather).syncMaps;
    const mat = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      // R29：1 → 0.55 —— 砌缝法线强度减半（实测 1.0 时读成"深雕砖墙"，参考图是弱缝大板块）
      normalScale: new THREE.Vector2(0.55, 0.55),
      color: 0xffffff,
      metalness: FAMILY_METAL[kind],
      // 铁律 34：贴图写的是绝对粗糙度 ⇒ 这里必须是 1/ḡ 反算
      roughness: inverseRoughness(TARGET_ROUGH[kind], maps.stats.roughMean),
      envMapIntensity: FAMILY_ENV[kind],
      // 金饰自辉：逆光暴云天下金属只有环境反射一条路，自辉只把暗面托离死黑
      ...(kind === 'gold' ? { emissive: 0xb8902f, emissiveIntensity: 0.22 } : {})
    });
    this.familyFor(kind, weather).slots.push({ mat, targetRough: TARGET_ROUGH[kind], usesRoughMap: true });
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
    const maps = this.familyFor('floor', 0.4).syncMaps;
    const mat = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
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
    this.familyFor('floor', 0.4).slots.push({ mat, targetRough: 0.9, usesRoughMap: false });
    return mat;
  }

  /** 步道铺装：ashlar 族白石。同样不挂 roughnessMap（水平面掠射会镜，均匀 0.95 全哑光） */
  private walkPavingMaterial(): THREE.MeshStandardMaterial {
    const maps = this.familyFor('ashlar', 0.35).syncMaps;
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
    this.familyFor('ashlar', 0.35).slots.push({ mat, targetRough: 0.95, usesRoughMap: false });
    return mat;
  }

  private stone(kind: StoneKind): THREE.MeshStandardMaterial {
    const key = `stone:${kind}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const weather = kind === 'wall' ? 0.5 : kind === 'gold' ? 0.3 : kind === 'wood' ? 0.55 : 0.35;
    const mat = this.stoneMaterial(kind, weather);
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
  private commitStatics(): void {
    this.addMerged(this.statics.ashlar, this.stone('ashlar'), 'castle-ashlar');
    this.addMerged(this.statics.wall, this.stone('wall'), 'castle-wall');
    this.addMerged(this.statics.gold, this.stone('gold'), 'castle-gold');
    this.addMerged(this.statics.dark, this.special('dark', () => tunnelMaterial()), 'castle-dark');
    this.addMerged(this.statics.flame, this.special('flame', () => flameMaterial()), 'castle-flame');
    // R29 新族：桶非空才建 mesh（castleKit 未补桶时这里全部跳过 ⇒ DC 不变）
    for (const key of EXTRA_BUCKETS) {
      const parts = this.extras.get(key);
      if (!parts || parts.length === 0) continue;
      this.addMerged(parts, this.stone(key), `castle-${key}`);
    }
  }

  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string): void {
    if (parts.length === 0) return;
    const merged = mergeSafe(parts);
    parts.forEach((p) => p.dispose());
    this.addMesh(merged, mat, name);
  }
}
