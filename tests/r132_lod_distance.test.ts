/**
 * R132 · 建筑渲染距离延伸（用户「继续改善建筑渲染距离及性能优化」）。
 *
 * 背景：LOD_NEAR_DIST 400 → **550**（= ZONE_VIEW_RANGE，与淡入/显隐闸门同参）。
 * 高档（近 FBX 级全装饰）档位的覆盖距离 +150m，中段建筑保持细节的行程变长；
 * 换档点更远 ⇒ 高低档差异更亚像素（550m 处 0.3m 物 ≈0.31px，比 400m 的 0.43px
 * 更不可辨）⇒ 换档不会因推远而变得可见。
 *
 * 本测试钉死四件事（门禁 D，与 r97 的 getZoneFade/getZoneZMin 同治法）：
 * ⓪ `getZoneTier` 机读接口必须存在（缺失显式 fail，禁止 skip）；
 * ① 换档边界 = 550（滞回：>570 换远档、<530 换近档、[530,570] 死区保持原档）——
 *    测试夹具与实现同判据，**不得各自用距离推断档位**；
 * ② **渲染距离延伸**：z2（cz≈−617.9）在 carZ=−100 处距 518m —— 旧 400 档必换 LO，
 *    新 550 档保持 HI ⇒ 直接证明「518m 处仍近 FBX 级」这一延伸；
 * ③ 峰值可见 tri ≤ visibleTri（240,000）：延伸只 +2.8%（180k→185k），护栏仍绿。
 *
 * 读数口径与 r32_budget 完全一致（sphere + intersectsSphere，渲染器同源）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { Castle } from '../src/render/scene/castle';
import { setDetailLevel } from '../src/render/scene/castleKit';
import { disposeStoneCache } from '../src/render/scene/stoneTexture';
import { R31_BUDGET } from '../src/render/scene/r31Budget';
import type { QualitySettings } from '../src/config/quality';

// ── DOM stub（castleKit 的 canvas 贴图生成需要 document；r97 同款夹具）──────────
const REAL_DOC = globalThis.document;
beforeAll(() => {
  if (!globalThis.document) {
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({
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
      })
    };
  }
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

const QUALITY_HIGH = {
  tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
  shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
  carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
} as unknown as QualitySettings;

type ZoneRef = { mesh: THREE.Mesh; cz: number; zMin: number };

function buildCastle(): { scene: THREE.Scene; castle: Castle } {
  setDetailLevel(false);
  disposeStoneCache();
  const scene = new THREE.Scene();
  const castle = new Castle(scene, QUALITY_HIGH);
  return { scene, castle };
}

function zoneNamesOf(castle: Castle): string[] {
  return (castle as unknown as { zoneViews: ZoneRef[] }).zoneViews.map((zv) => zv.mesh.name);
}

/** 机读 cz（区心）；NaN 即显式失败 */
function czOf(castle: Castle, name: string): number {
  const zv = (castle as unknown as { zoneViews: ZoneRef[] }).zoneViews.find((v) => v.mesh.name === name);
  expect(zv, `${name} 的 zoneViews 条目不存在`).toBeDefined();
  return zv!.cz;
}

/** sphere 口径可见 tri（与 r32_budget.visibleTriAt 同源） */
function sphereVisibleTri(scene: THREE.Scene, castle: Castle, carZ: number): number {
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 12000);
  cam.position.set(1.6, 2.2, carZ + 8.2);
  cam.lookAt(0, 1, carZ - 6);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  );
  castle.updateViewerZ(cam.position.z);
  let tri = 0;
  scene.getObjectByName('castle')?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const geo = m.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    if (geo.boundingSphere && frustum.intersectsSphere(geo.boundingSphere)) {
      const g = geo.index ? (geo.index.count / 3) | 0 : (geo.attributes.position.count / 3) | 0;
      tri += g;
    }
  });
  return tri;
}

describe('R132 · 建筑渲染距离延伸（LOD_NEAR_DIST 550）', () => {
  it('⓪ 机读接口 getZoneTier 存在；未知名返回 none（显式 fail 而非假绿）', () => {
    const { castle } = buildCastle();
    try {
      const api = castle as unknown as { getZoneTier?: (n: string) => string };
      expect(typeof api.getZoneTier, 'R132 门禁 D：Castle.getZoneTier 必须存在（禁止 skip）').toBe('function');
      expect(castle.getZoneTier('__no_such_zone__')).toBe('none');
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('① 换档边界 = 550（滞回：>570 远档、<530 近档、[530,570] 死区保持原档）', () => {
    const { castle } = buildCastle();
    try {
      const z2 = 'castle-ashlar-z2'; // cz≈−617.9（从 zoneViews 机读）
      const cz = czOf(castle, z2);
      // 起步置远档：d=600 > 570 ⇒ 换 LO（首帧 lastViewerZ=NaN 必算）
      castle.updateViewerZ(cz - 600);
      expect(castle.getZoneTier(z2), 'd=600 应换远档 LO').toBe('lo');
      // 跳近：d=500 < 530 ⇒ 换近档 HI（|Δz|=100 > 20，LOD 必重算）
      castle.updateViewerZ(cz - 500);
      expect(castle.getZoneTier(z2), 'd=500 应换近档 HI').toBe('hi');
      // 死区：d=540 ∈ [530,570]，从 HI 保持 HI（滞回不抖）
      castle.updateViewerZ(cz - 540);
      expect(castle.getZoneTier(z2), 'd=540 死区应保持 HI（不来回抖）').toBe('hi');
      // 推远：d=580 > 570 ⇒ 换 LO
      castle.updateViewerZ(cz - 580);
      expect(castle.getZoneTier(z2), 'd=580 应换远档 LO').toBe('lo');
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('② 渲染距离延伸：z2 在 carZ=−100 处距 518m，旧 400 档必 LO、新 550 档保持 HI', () => {
    const { castle } = buildCastle();
    try {
      const z2 = 'castle-ashlar-z2';
      const cz = czOf(castle, z2);
      castle.updateViewerZ(-100);
      const d = Math.abs(cz - -100);
      // 夹具口径：518m 落在 (400+20, 550−20) = (420, 530) ⇒ 旧 400 档 LO、新 550 档 HI。
      // 断言夹具与实现同判据：d 必须确实落在这个「新旧分歧带」内，否则夹具本身错。
      expect(d, `z2 距 carZ=-100 应 ≈518m（实得 ${d}），夹具必须落在分歧带 (420,530)`).toBeGreaterThan(420);
      expect(d).toBeLessThan(530);
      expect(castle.getZoneTier(z2), `518m 处应保持 HI（渲染距离延伸，实得 ${castle.getZoneTier(z2)}）`).toBe('hi');
    } finally {
      castle.dispose();
    }
  }, 60000);

  it('③ 峰值可见 tri ≤ visibleTri（延伸只 +2.8%，护栏仍绿）', () => {
    const { scene, castle } = buildCastle();
    try {
      // 覆盖峰值带 + 中段/深段（r32 六点 + 峰值带）
      const zs = [60, -40, -100, -160, -200, -500, -900, -1300];
      let peak = 0;
      for (const z of zs) peak = Math.max(peak, sphereVisibleTri(scene, castle, z));
      console.log(`R132_PEAK ${JSON.stringify({ peak, key: R31_BUDGET.visibleTri, zs })}`);
      expect(peak, `峰值可见 tri ${peak} 超 visibleTri ${R31_BUDGET.visibleTri}`).toBeLessThanOrEqual(
        R31_BUDGET.visibleTri
      );
      // 延伸后的峰值必须落在实测窗口 [170k, 210k]（180,042→185,042；防过度推远/回退）
      expect(peak).toBeGreaterThanOrEqual(170_000);
      expect(peak).toBeLessThanOrEqual(210_000);
    } finally {
      castle.dispose();
    }
  }, 60000);
});
