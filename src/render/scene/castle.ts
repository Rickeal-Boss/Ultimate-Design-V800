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
 *
 * ── 为什么不投阴影 ─────────────────────────────────────────────────────
 * 主光是超低角（逆光 12°），55m 高的城门尖塔会投出几百米长的影子，而阴影正交框
 * 只有 ±28m —— 会被裁成一条随车移动的硬边，比不投影难看。整族 castShadow=false，
 * 形体塑造交给 normalMap 掠射光 + 环境贴图，也省掉每帧阴影 pass 的重绘。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { makeStoneMaps } from './stoneTexture';
import type { QualitySettings } from '../../config/quality';
import {
  setDetailLevel,
  makeViaduct,
  makeParapet,
  makePaving,
  makeLamps,
  makeGate,
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
 * 石材族。ashlar 白石 roughness 0.86 / metalness 0；wall 0.9（更糙，用在连墙等
 * 次级面）；gold metalness 0.85 / roughness 0.42 / envMapIntensity 1.4（唯一金属族，
 * 形体全靠环境反射）。石头 envMapIntensity 压到 0.85/0.75：PMREM 是为车漆做的柔光箱
 * （含 3.6 倍过曝顶板），吃满会把砌缝洗平。配光是逆光暴风天光（sun 12°/2.2、
 * hemi 0.42、fill 0.55），白石受光面主要靠 hemi + 掠射 —— 若游戏页偏暗，
 * 先调这三个 envMapIntensity，**不要**动贴图基色（吸色硬数据）。
 */
function stoneMaterial(kind: 'ashlar' | 'wall' | 'gold'): THREE.MeshStandardMaterial {
  const weather = kind === 'wall' ? 0.5 : kind === 'gold' ? 0.3 : 0.35;
  const maps = makeStoneMaps(kind, { repeat: [1, 1], weather });
  const base: THREE.MeshStandardMaterialParameters = {
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    normalScale: new THREE.Vector2(1, 1),
    color: 0xffffff,
    metalness: 0
  };
  if (kind === 'gold') {
    // 做旧黄铜的「发光感」：逆光暴云天下金属只有环境反射一条路（metalness 0.85
    // ⇒ 漫反射 ≈ 0），背光面与朝下面无光可吃 —— 城门拱脚带朝下面在车视机位
    // 实测读到 L=25 近黑（r27_final tunnel_drive 像素探针）。加一层金色自辉
    // （≈授权金基色 #a7843c 的 0.3）把暗面托到 L≈90，亮面仍走 env 反射，
    // 对应参考图金饰「明度中高 + 强烈金属光泽和发光感」的读法。
    return new THREE.MeshStandardMaterial({
      ...base,
      metalness: 0.85,
      roughness: 0.42,
      envMapIntensity: 1.4,
      emissive: 0xa7843c,
      emissiveIntensity: 0.3
    });
  }
  const secondary = kind === 'wall';
  return new THREE.MeshStandardMaterial({
    ...base,
    roughness: secondary ? 0.9 : 0.86,
    envMapIntensity: secondary ? 0.75 : 0.85
  });
}

/** 近黑门洞/暗龛/窗背板：不进石材族，否则会变成"亮洞"，深门层次全丢 */
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
 * **刻意不用 roughnessMap**：floor 族石面 roughness 只有 ~0.44，乘上任何
 * material.roughness 都 ≤0.44 —— 400m 长的水平面在 2.2 强度平行光 + 黄昏环境贴图下
 * 会被菲涅耳镜成一条"刚下过雨的湿沥青"（r26c 实拍两轮实证）。干脆不用
 * roughnessMap、给均匀 0.9，让石板哑下来；色、法线、vertexColor 全部照旧。
 * color 0x6a6660 把 floor 贴图的浅灰基色压到参考图实测的深炭灰（#393431 一档），
 * 浅边带的相对提亮关系不变。envMapIntensity 0.15 同理由（压掉掠射镜反射）。
 */
function pavementMaterial(): THREE.MeshStandardMaterial {
  const maps = makeStoneMaps('floor', { repeat: [1, 1], weather: 0.4 });
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(1, 1),
    color: 0x6a6660,
    metalness: 0,
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
 * 同样不挂 roughnessMap：ashlar 的 g≈0.8，0.95×0.8 的水平面在掠射角下仍会镜；
 * 均匀 0.95 全哑光。polygonOffset 与路面条石双保险（步道 14mm / 路面 12mm 已在
 * 几何上分层，这里是防 GPU 深度精度抖动的兜底）。
 */
function walkPavingMaterial(): THREE.MeshStandardMaterial {
  const maps = makeStoneMaps('ashlar', { repeat: [1, 1], weather: 0.35 });
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(1, 1),
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
  private tris = 0;
  private dc = 0;

  constructor(scene: THREE.Scene, quality: QualitySettings) {
    // 低配只降装饰密度（尖塔 8→4 面、火焰段数降），**不改任何几何长度**（铁律 33）
    setDetailLevel(quality.tier === 'low');
    this.group.name = 'castle';
    this.absorb(makeViaduct());
    this.absorb(makeParapet());
    this.absorb(makeLamps());
    this.absorb(makeGate());
    this.absorb(makeInnerCity());
    const pave = makePaving();
    this.addMesh(pave.road, this.special('pave-road', pavementMaterial), 'castle-pave-road');
    this.addMesh(pave.walk, this.special('pave-walk', walkPavingMaterial), 'castle-pave-walk');
    this.commitStatics();
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

  private stone(kind: 'ashlar' | 'wall' | 'gold'): THREE.MeshStandardMaterial {
    const key = `stone:${kind}`;
    const hit = this.matCache.get(key);
    if (hit) return hit as THREE.MeshStandardMaterial;
    const mat = stoneMaterial(kind);
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

  /** 把一个构件集按材质族摊进静态桶 */
  private absorb(set: StoneBuckets): void {
    this.statics.ashlar.push(...set.ashlar);
    this.statics.wall.push(...set.wall);
    this.statics.gold.push(...set.gold);
    this.statics.dark.push(...set.dark);
    this.statics.flame.push(...set.flame);
  }

  /** 5 个静态 mesh 一次性提交（空桶不建 mesh、不占 DC） */
  private commitStatics(): void {
    this.addMerged(this.statics.ashlar, this.stone('ashlar'), 'castle-ashlar');
    this.addMerged(this.statics.wall, this.stone('wall'), 'castle-wall');
    this.addMerged(this.statics.gold, this.stone('gold'), 'castle-gold');
    this.addMerged(this.statics.dark, this.special('dark', tunnelMaterial), 'castle-dark');
    this.addMerged(this.statics.flame, this.special('flame', flameMaterial), 'castle-flame');
  }

  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string): void {
    if (parts.length === 0) return;
    const merged = mergeSafe(parts);
    parts.forEach((p) => p.dispose());
    this.addMesh(merged, mat, name);
  }
}
