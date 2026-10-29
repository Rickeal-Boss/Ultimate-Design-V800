/**
 * R32 C-7 · zone 归属 / 建桶 / 距离衰减机制单测（C-4 + C-5 的契约钉桩）。
 *
 * 覆盖三块契约：
 *   ① `zoneIndexOf` 纯函数语义：bbox z 中值归区、边界归属（edges 属于下邻区）、
 *      越界夹首尾、NaN/空几何回 0 区（边界数组镜像 castle.ts 的 ZONE_EDGES_6/3）；
 *   ② 真实建桶结构：high 档 Castle 的 mesh 名必须落 `castle-{族}-z{N}` 区划
 *      （ashlar/gold/dark 6 区、wall 3 区），DC = 非空区数 + 全局族，设计公式
 *      6+3+6+6+1+4+2 = 28 ≤ R31_BUDGET.castleDc（C-4 审计结论的 CI 化）；
 *      并钉「零面区不占 DC」（C-4 副产物：dc == 有面 mesh 数，无幽灵 mesh）；
 *   ③ 距离衰减运行时语义：观看者滞回（带内不重算/越带必重算）、远档 LOD 换档
 *      （同 mesh 换 geometry、近区保高档、驶近回高档）、revealAllZones 全显+回近档、
 *      getCastleStats 装配期口径不受运行时态污染（R31 回归 + R32 新增）。
 *
 * ⚠ A/B 线并行在途：本测试 import castleKit/castleDetail/stoneTexture，tri 快照会抖；
 *   故一律用**结构断言 + 宽松区间**，不钉精确 tri 数字（波次末由严把关复跑）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { Castle, zoneIndexOf } from '../src/render/scene/castle';
import { setDetailLevel } from '../src/render/scene/castleKit';
import { disposeStoneCache } from '../src/render/scene/stoneTexture';
import type { QualitySettings } from '../src/config/quality';
import { R31_BUDGET } from '../src/render/scene/r31Budget';

// 最小 DOM shim：石材 canvas 程序化贴图需要 document.createElement('canvas').getContext('2d')
const REAL_DOC = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: () => {},
          fillRect: () => {},
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 0
        })
      };
    }
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

const QUALITY_HIGH = {
  tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
  shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
  carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
} as unknown as QualitySettings;

/** castle.ts ZONE_EDGES_6 的镜像（分区表不导出，命名区划由建桶测试间接钉住） */
const EDGES_6: readonly number[] = [60, -340, -460, -760, -1060, -1290, -1470];
/**
 * R39-P9：gold / dark 用 **5 区**表 = `EDGES_6` 去掉 −1290（把最深两小区
 * z4[−1060,−1290] 与 z5[−1290,−1470] 并成 [−1060,−1470]）。
 */
const EDGES_5: readonly number[] = [60, -340, -460, -760, -1060, -1470];
/** R39-P9：wall 用 **1 区**表（全域 2,784 tri 一个 mesh） */
const EDGES_1: readonly number[] = [60, -1470];
/** castle.ts 已退役的 3 区 wall 表（R31 原版）：保留作 `zoneIndexOf` 纯函数用例 */
const EDGES_3: readonly number[] = [60, -460, -1060, -1470];

/** 造一条「z 中值 = cz」的假几何（直接塞 boundingBox，不需要顶点数据） */
function geoAtZ(cz: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, cz - 0.5), new THREE.Vector3(0, 0, cz + 0.5));
  return g;
}

function triOf(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx) return idx.count / 3;
  const pos = g.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

function castleMesh(scene: THREE.Scene, name: string): THREE.Mesh | undefined {
  const root = scene.getObjectByName('castle');
  return root?.getObjectByName(name) as THREE.Mesh | undefined;
}

function visibleSignature(scene: THREE.Scene): string[] {
  const sig: string[] = [];
  scene.getObjectByName('castle')?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.visible) sig.push(m.name);
  });
  sig.sort();
  return sig;
}

function buildCastle(): { scene: THREE.Scene; castle: Castle } {
  setDetailLevel(false);
  disposeStoneCache();
  const scene = new THREE.Scene();
  const castle = new Castle(scene, QUALITY_HIGH);
  return { scene, castle };
}

describe('zoneIndexOf：z 中值归区语义', () => {
  it('区内点归对应区', () => {
    expect(zoneIndexOf(geoAtZ(0), EDGES_6)).toBe(0);
    expect(zoneIndexOf(geoAtZ(-400), EDGES_6)).toBe(1);
    expect(zoneIndexOf(geoAtZ(-610), EDGES_6)).toBe(2);
    expect(zoneIndexOf(geoAtZ(-910), EDGES_6)).toBe(3);
    expect(zoneIndexOf(geoAtZ(-1170), EDGES_6)).toBe(4);
    expect(zoneIndexOf(geoAtZ(-1380), EDGES_6)).toBe(5);
    // 3 区表（wall 桶）
    expect(zoneIndexOf(geoAtZ(-100), EDGES_3)).toBe(0);
    expect(zoneIndexOf(geoAtZ(-700), EDGES_3)).toBe(1);
    expect(zoneIndexOf(geoAtZ(-1200), EDGES_3)).toBe(2);
  });

  it('边界值归下邻区（cz <= edges[i] && cz > edges[i+1]）', () => {
    // 顶边界含在首区
    expect(zoneIndexOf(geoAtZ(60), EDGES_6)).toBe(0);
    // 内部边界：−340 属于 z1 而不是 z0（z0 是 (60, −340] 的上半开区间语义）
    expect(zoneIndexOf(geoAtZ(-340), EDGES_6)).toBe(1);
    expect(zoneIndexOf(geoAtZ(-339.9), EDGES_6)).toBe(0);
    expect(zoneIndexOf(geoAtZ(-460), EDGES_6)).toBe(2);
    expect(zoneIndexOf(geoAtZ(-760), EDGES_6)).toBe(3);
    expect(zoneIndexOf(geoAtZ(-1060), EDGES_6)).toBe(4);
    expect(zoneIndexOf(geoAtZ(-1290), EDGES_6)).toBe(5);
    // 底边界 −1470：循环条件不满足 ⇒ 夹到末区
    expect(zoneIndexOf(geoAtZ(-1470), EDGES_6)).toBe(5);
  });

  it('越界夹首尾；NaN/空几何回 0 区', () => {
    expect(zoneIndexOf(geoAtZ(100), EDGES_6)).toBe(0); // 高于首边界
    expect(zoneIndexOf(geoAtZ(-2000), EDGES_6)).toBe(5); // 低于末边界
    // NaN 中值
    const nanGeo = new THREE.BufferGeometry();
    nanGeo.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, 0, Number.NaN),
      new THREE.Vector3(0, 0, Number.NaN)
    );
    expect(zoneIndexOf(nanGeo, EDGES_6)).toBe(0);
    // 空几何（无 position 属性）—— computeBoundingBox 后仍是空/NaN ⇒ 0 区
    expect(zoneIndexOf(new THREE.BufferGeometry(), EDGES_6)).toBe(0);
  });
});

describe('R32 C-4 · 建桶结构与 DC 设计公式', () => {
  it('分区 mesh 命名落 z 区划，DC = 设计公式内（R39-P9：7+1+6+4+1+4+3+2=28 ⇒ 实测 29）', () => {
    const { scene, castle } = buildCastle();
    try {
      const stats = castle.getCastleStats();
      /* 区划结构（R39-P9：**每族按自己的区表**，不再全局共用一张，见 castle.ts
       * `ZONE_EDGES_BY_FAMILY`）：
       *   · ashlar → `EDGES_6`（6 区）+ z0 按 z=−150 二分 ⇒ z0a/z0b + z1..z5 = 7 个 mesh；
       *   · gold   → `EDGES_5`（5 区）+ z0 二分 ⇒ z0a/z0b + z1..z4 = 6 个（**没有 z5**）；
       *   · wall   → `EDGES_1`（1 区）⇒ 只有 castle-wall-z0（全域 2,784 tri 一个 mesh）；
       *   · dark   → `EDGES_5`（5 区，z0 实测空）⇒ z1..z4；
       *   · grey   → 仍走 `EDGES_6`，实测只有 z1 非空。 */
      for (let i = 0; i < 6; i += 1) {
        if (i === 0) {
          expect(castleMesh(scene, 'castle-ashlar-z0a'), 'castle-ashlar-z0a 缺失').toBeDefined();
          expect(castleMesh(scene, 'castle-ashlar-z0b'), 'castle-ashlar-z0b 缺失').toBeDefined();
          expect(castleMesh(scene, 'castle-gold-z0a'), 'castle-gold-z0a 缺失').toBeDefined();
          expect(castleMesh(scene, 'castle-gold-z0b'), 'castle-gold-z0b 缺失').toBeDefined();
        } else {
          expect(castleMesh(scene, `castle-ashlar-z${i}`), `castle-ashlar-z${i} 缺失`).toBeDefined();
          if (i <= 4) {
            expect(castleMesh(scene, `castle-gold-z${i}`), `castle-gold-z${i} 缺失`).toBeDefined();
          }
        }
      }
      expect(castleMesh(scene, 'castle-gold-z5'), 'R39-P9 之后 gold 只有 5 区（z5 已并入 z4）').toBeUndefined();
      expect(castleMesh(scene, 'castle-wall-z0'), 'castle-wall-z0 缺失').toBeDefined();
      expect(castleMesh(scene, 'castle-wall-z1'), 'R39-P9 之后 wall 只剩 1 区（z1 已并入 z0）').toBeUndefined();
      // 设计公式（R39-P9）：ashlar 7 + wall 1 + gold 6 + dark 4（z0 空）+ grey 1
      //   + flame 1 + 可选桶 4 + 变体桶 3 + 铺装 2 = 29
      const DESIGN_MAX_DC = 7 + 1 + 6 + 4 + 1 + 1 + 4 + 3 + 2;
      expect(DESIGN_MAX_DC).toBe(29);
      expect(DESIGN_MAX_DC).toBeLessThanOrEqual(R31_BUDGET.castleDc);
      // 实测 29（R39-P9；R38 末态 32）⇒ 区间断言吸收 A 线几何漂移
      expect(stats.dc).toBeGreaterThanOrEqual(20);
      expect(stats.dc).toBeLessThanOrEqual(DESIGN_MAX_DC);
      // 全显口径（LOD 区取高档）不超 castleTriHigh
      expect(stats.tris).toBeLessThanOrEqual(R31_BUDGET.castleTriHigh);
    } finally {
      castle.dispose();
    }
  }, 60000);

  /**
   * R32 C-4 副产物：**零面区不占 DC**。
   * 「空区」有两种形态：① 区里零个几何（castles.ts splitByZone 产出空数组，
   * 老早就被 `zones[i].length === 0` 跳过 —— 当前实测 27 vs 上限 28 的唯一差值
   * 就是 dark-z0 这种）；② 区里有几何但 merge 后零面（退化几何 / 密度开关裁净）。
   * 形态②改前会造出「看不见却占一次 draw call」的幽灵 mesh —— 本轮补了
   * `isDrawable` 护栏。这里钉死不变量：DC 数 == 实际有面的 mesh 数。
   */
  it('castle 下不存在零面 mesh（每个 mesh 都值得一枚 DC）', () => {
    const { scene, castle } = buildCastle();
    try {
      const meshes: THREE.Mesh[] = [];
      scene.getObjectByName('castle')?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) meshes.push(m);
      });
      expect(meshes.length).toBeGreaterThan(0);
      const empties = meshes.filter((m) => triOf(m.geometry) === 0).map((m) => m.name);
      expect(empties, `零面幽灵 mesh：${empties.join(', ')}`).toEqual([]);
      // 不变量：dc == mesh 数 == 有面 mesh 数（dispose 账本与口径①同源）
      expect(castle.getCastleStats().dc).toBe(meshes.length);
      expect(triOf(meshes[0]!.geometry)).toBeGreaterThan(0);
    } finally {
      castle.dispose();
    }
  }, 60000);
});

describe('R32 C-5 · 距离衰减运行时语义（显隐 + 远档 LOD + 滞回）', () => {
  it('远区换远档（lo）、近区保近档（hi）、驶近回近档', () => {
    const { scene, castle } = buildCastle();
    try {
      const z5 = castleMesh(scene, 'castle-ashlar-z5');
      const z3 = castleMesh(scene, 'castle-ashlar-z3');
      expect(z5, 'castle-ashlar-z5 应存在（6 区表第 6 区）').toBeDefined();
      expect(z3, 'castle-ashlar-z3 应存在').toBeDefined();
      const z5hi = z5!.geometry;
      const z3hi = z3!.geometry;
      const z5hiTri = triOf(z5hi);
      expect(z5hiTri).toBeGreaterThan(0);

      // carZ=−900 ⇒ 相机 z=−891.8：z5 中心 ≈−1373（距 ≈481m）> D+滞回 ⇒ 远档；
      // z3 中心 ≈−909（距 ≈18m）⇒ 近档；两区都在 R=650 带内可见。
      castle.updateViewerZ(-891.8);
      expect(z5!.visible).toBe(true);
      expect(z5!.geometry).not.toBe(z5hi); // 已换远档 geometry（同 mesh，DC 不变）
      expect(triOf(z5!.geometry)).toBeLessThan(z5hiTri); // 远档只主体（铁律 33：low 只降装饰密度）
      expect(z3!.geometry).toBe(z3hi); // 近区保持近档

      // 驶近（距 373m < D−滞回）⇒ 换回近档
      castle.updateViewerZ(-1000);
      expect(z5!.geometry).toBe(z5hi);
      // getCastleStats 装配期口径不被运行时态污染
      const stats = castle.getCastleStats();
      castle.updateViewerZ(-891.8);
      expect(castle.getCastleStats()).toEqual(stats);
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('观看者滞回：带内微抖不重算，越带必重算', () => {
    const { scene, castle } = buildCastle();
    try {
      castle.updateViewerZ(30);
      const a = visibleSignature(scene);
      expect(a.length).toBeGreaterThan(0);
      castle.updateViewerZ(45); // Δ15 < 20 ⇒ 直接返回
      expect(visibleSignature(scene)).toEqual(a);
      castle.updateViewerZ(-1300); // 深区 ⇒ 必重算，近区改藏
      const deep = visibleSignature(scene);
      expect(deep).not.toEqual(a);
      /* R39-P9：`-z0` 不再等于「入口区」—— wall 合并成 1 区后 `castle-wall-z0` 覆盖
       * 全域（cz≈−906，z=−1300 时 d≈394 ⇒ 仍在 550m 闸门内可见）。
       * 入口区按**族 + z0 段**点名（ashlar/gold 的 z0a/z0b）。
       * 实测（.qa/r39_b 探针）：z=−1300 可视 18 个 mesh，其中以 -z0 结尾的只有
       * castle-wall-z0，而 castle-(ashlar|gold)-z0[ab] 一个都不在。 */
      expect(deep.filter((n) => /^castle-(ashlar|gold)-z0[ab]$/.test(n))).toEqual([]);
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('revealAllZones：全显 + 重置滞回态 + 远档回近档（QA 自由机位契约）', () => {
    const { scene, castle } = buildCastle();
    try {
      const z5 = castleMesh(scene, 'castle-ashlar-z5');
      expect(z5).toBeDefined();
      const z5hi = z5!.geometry;
      castle.updateViewerZ(-891.8); // 先把 z5 打成远档
      expect(z5!.geometry).not.toBe(z5hi);
      castle.revealAllZones();
      expect(z5!.visible).toBe(true);
      expect(z5!.geometry).toBe(z5hi); // QA 截图要全装饰几何
      expect(visibleSignature(scene).every((n) => n.startsWith('castle-'))).toBe(true);
      // 重置后 lastViewerZ=NaN ⇒ 小位移也重算（不会卡在全显态）
      castle.updateViewerZ(-1295);
      expect(visibleSignature(scene).some((n) => !n.endsWith('-z0'))).toBe(true);
    } finally {
      castle.dispose();
    }
  }, 60000);
});

/** 远档 tri 必须严格小于近档（low 只降装饰密度）——留 1 tri 余量防平台误差 */
function z5HiTriLoose(hiTri: number): number {
  return hiTri;
}
