/**
 * R31 区域距离剔除回归（B 线运行时治理②）：
 * `Castle.updateViewerZ / revealAllZones` 的显隐契约必须被单测钉住——
 * 口径与 `.qa/r31_test/r31_b_runtime_probe.mjs` 的 visibleTriAt 一致：
 *   行车机位推进 ⇒ 后方/远方 z 区 mesh 整体隐藏，可见 tri 下降；
 *   滞回带内微抖不重算；越带必重算；revealAllZones 全显并重置滞回态。
 *
 * 拦什么改动：
 *   · 滞回常量被改大/改小导致显隐抖动或永不算 —— 本测试红；
 *   · revealAllZones 忘了重置 lastViewerZ ⇒ 自由机位截图缺远区（R27 类缺陷复燃）；
 *   · getCastleStats 被显隐态污染（装配期口径被运行时态改写）⇒ 预算测试失去意义。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { Castle } from '../src/render/scene/castle';
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
  (globalThis as { document: unknown }).document = REAL_DOC;
});

const QUALITY = {
  tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
  shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
  carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
} as unknown as QualitySettings;

function triOf(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx) return idx.count / 3;
  const pos = g.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/** 遍历场景里 name='castle' 子树：可见 mesh 签名 + 可见 tri（与运行时探针同口径） */
function readVisible(scene: THREE.Scene): { sig: string[]; tri: number } {
  const root = scene.getObjectByName('castle');
  const sig: string[] = [];
  let tri = 0;
  root?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.visible) {
      sig.push(m.name);
      tri += triOf(m.geometry);
    }
  });
  sig.sort();
  return { sig, tri };
}

function buildCastle(): { scene: THREE.Scene; castle: Castle; totalTri: number } {
  setDetailLevel(false);
  disposeStoneCache();
  const scene = new THREE.Scene();
  const castle = new Castle(scene, QUALITY);
  let totalTri = 0;
  scene.getObjectByName('castle')?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) totalTri += triOf(m.geometry);
  });
  return { scene, castle, totalTri };
}

describe('R31 区域距离剔除（updateViewerZ / revealAllZones）', () => {
  it('入口机位：远区被隐藏、可见 tri 显著下降，且 getCastleStats 不变', () => {
    const { scene, castle, totalTri } = buildCastle();
    const stats = castle.getCastleStats();
    const all = readVisible(scene);
    expect(all.sig.length).toBeGreaterThan(10); // 分区合批确实产出多区 mesh
    expect(all.sig.some((n) => /-z\d+$/.test(n))).toBe(true); // 存在 -zN 分区 mesh

    castle.updateViewerZ(30); // 御桥起点（行车入口）
    const near = readVisible(scene);
    expect(near.sig.length).toBeLessThan(all.sig.length); // 有区被隐藏
    expect(near.tri).toBeLessThan(totalTri * 0.9); // 实测 −44%，留 10% 余量防几何漂移误红
    // 装配期口径必须与显隐态解耦
    expect(castle.getCastleStats()).toEqual(stats);
    expect(stats.tris).toBeLessThanOrEqual(R31_BUDGET.castleTriHigh);
    expect(stats.dc).toBeLessThanOrEqual(R31_BUDGET.castleDc);
    castle.dispose();
  }, 30000);

  it('滞回：带内微抖不重算，越带必重算', () => {
    const { scene, castle } = buildCastle();
    castle.updateViewerZ(30);
    const a = readVisible(scene).sig;
    castle.updateViewerZ(45); // Δ15 < 20 ⇒ 直接返回，显隐集不变
    expect(readVisible(scene).sig).toEqual(a);
    castle.updateViewerZ(-1300); // 深区内城 ⇒ 必重算，近区改藏
    const deep = readVisible(scene).sig;
    expect(deep).not.toEqual(a);
    /* R39-P9：`-z0` 不再代表「入口区」—— wall 合并成 1 区后 `castle-wall-z0` 覆盖全域
     * （cz≈−906，z=−1300 时 d≈394 ⇒ 仍在 550m 闸门内，本就该可见）。
     * 入口区按**族 + z0 段**点名：ashlar/gold 的 z0a/z0b（实测 z=−1300 时 0 个可见）。 */
    expect(deep.filter((n) => /^castle-(ashlar|gold)-z0[ab]$/.test(n))).toEqual([]);
    castle.dispose();
  }, 30000);

  it('revealAllZones：全显 + 重置滞回态（小位移也重算）', () => {
    const { scene, castle } = buildCastle();
    const all = readVisible(scene).sig;
    castle.updateViewerZ(-1300);
    expect(readVisible(scene).sig.length).toBeLessThan(all.length);
    castle.revealAllZones();
    expect(readVisible(scene).sig).toEqual(all); // 自由机位直渲前全显
    // 重置后 lastViewerZ=NaN ⇒ 即使 |Δ|<20 也重算
    castle.updateViewerZ(-1295);
    expect(readVisible(scene).sig.length).toBeLessThan(all.length);
    castle.dispose();
  }, 30000);
});
