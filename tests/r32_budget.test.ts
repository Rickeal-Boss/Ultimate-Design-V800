/**
 * R32 C-7 · 预算键真消费 + 三口径台账断言（B 线 P0「预算键零消费」的 R32 收口）。
 *
 * 与 `tests/r31_budget.test.ts` 的分工：r31 那份建两档 Castle 断言 tri/DC；
 * 本文件补三件 r31 没覆盖的事：
 *   ① **真消费 visibleTri**（r31 明确跳过它）—— 建 high 档 Castle，按 Game/CameraRig
 *      同机位模型（chase 相机 far=12000）在六个行车采样点做「分区距离显隐 + LOD +
 *      Frustum」剔除，断言峰值 ≤ R31_BUDGET.visibleTri（口径②，见 r31Budget 台账）；
 *   ② **键完整性**：8 键齐全为正 + 档位序关系（low < high）；
 *   ③ **三口径台账存在性**：r31Budget.ts 必须写清「全显 / zone-visible /渲染」三口径
 *      定义与「累计 vs 每帧 DC」判读警告（第八轮 N12），防注释被后人删掉后口径漂移。
 *
 * 波次末提醒：A 线（castleKit/castleDetail）并行铺量中，tri 快照会漂移 ——
 * visibleTri 断言按 200k（治理后实测峰值 180,626 ×1.10）设了 ~10% 余量；
 * 波次末由严把关按届时实测复测收紧（主理人令）。
 * ⚠ C2 线 2026-10-25 二次 fresh 读数：A 线又把城堡从 384,470 铺到 **393,630 tri**，
 *   六点新鲜值（z=+40/0/−200/−500/−900/−1300）：
 *     102,350 / 164,478 / 186,154 / **186,294** / 178,150 / 87,878
 *   ⇒ 本文件那条 ≤200,000 的断言余量已降到 **6.85%**（z=−500 峰值处）。
 *   A2 线再往中段可见区铺 ≈14k tri 就会红 —— 那是护栏在响，不是误报。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
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
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

const QUALITY_HIGH = {
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

/** 六点行车采样（口径②）：距离显隐 + LOD + Frustum，与 .qa/r32_tmp_audit/r32_probe.mjs 同模型 */
const DRIVE_SAMPLES = [40, 0, -200, -500, -900, -1300] as const;

function visibleTriAt(scene: THREE.Scene, castle: Castle, carZ: number): { tri: number; dc: number } {
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 12000);
  cam.position.set(1.6, 2.2, carZ + 8.2);
  cam.lookAt(0, 1, carZ - 6);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  castle.updateViewerZ(cam.position.z);
  let tri = 0;
  let dc = 0;
  scene.getObjectByName('castle')?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    if (m.geometry.boundingBox && frustum.intersectsBox(m.geometry.boundingBox)) {
      tri += triOf(m.geometry);
      dc += 1;
    }
  });
  return { tri, dc };
}

describe('R31_BUDGET 键完整性（R32 C-2 台账维护态）', () => {
  it('8 键齐全且均为正', () => {
    const keys: (keyof typeof R31_BUDGET)[] = [
      'castleTriHigh', 'castleTriLow', 'castleDc', 'frameTri', 'frameDc', 'castleTexCount', 'castleTexMB', 'visibleTri'
    ];
    for (const k of keys) {
      expect(R31_BUDGET[k], `R31_BUDGET.${k} 缺失`).toBeDefined();
      expect(R31_BUDGET[k], `R31_BUDGET.${k} 非正`).toBeGreaterThan(0);
    }
  });

  it('档位序关系：low < high；DC/帧红线量级 sanity', () => {
    expect(R31_BUDGET.castleTriLow).toBeLessThan(R31_BUDGET.castleTriHigh);
    // frameTri 必须容得下「车 + zone-visible castle + terrain + road」粗估（口径②不是①）
    expect(R31_BUDGET.frameTri).toBeGreaterThan(R31_BUDGET.visibleTri + R31_BUDGET.castleTriLow * 0.5);
    expect(R31_BUDGET.castleDc).toBeGreaterThanOrEqual(20); // 分区合批后的设计值 28 的量级
    expect(R31_BUDGET.frameDc).toBeGreaterThan(0);
  });
});

describe('R32 C-2 · 三口径台账注释存在性', () => {
  it('r31Budget.ts 写清三口径定义 + 累计/每帧 DC 判读警告', () => {
    const src = readFileSync(new URL('../src/render/scene/r31Budget.ts', import.meta.url), 'utf8');
    // 三个口径的定义锚点
    expect(src).toContain('全显');
    expect(src).toContain('zone-visible');
    expect(src).toContain('渲染（frame）');
    // 判读警告锚点（历次误判都源于混比，注释删了就会复发）
    expect(src).toContain('累计 vs 每帧 DC');
    expect(src).toContain('transmission');
    // 量法锚点
    expect(src).toContain('getCastleStats');
    expect(src).toContain('renderer.info.render');
  });
});

describe('R32 C-5 · zone-visible 治理（真消费 R31_BUDGET.visibleTri）', () => {
  it('六点采样峰值 ≤ visibleTri，且中段相对治理前基线降幅 ≥25%', () => {
    setDetailLevel(false);
    disposeStoneCache();
    const scene = new THREE.Scene();
    const castle = new Castle(scene, QUALITY_HIGH);
    try {
      const stats = castle.getCastleStats();
      // 装配期口径不受运行时态污染（三口径台账①的前提）
      expect(stats.tris).toBeLessThanOrEqual(R31_BUDGET.castleTriHigh);
      expect(stats.dc).toBeLessThanOrEqual(R31_BUDGET.castleDc);

      const samples = DRIVE_SAMPLES.map((z) => ({ z, ...visibleTriAt(scene, castle, z) }));
      for (const s of samples) {
        expect(s.tri, `carZ=${s.z} 可见 tri ${Math.round(s.tri)} 超 visibleTri ${R31_BUDGET.visibleTri}`)
          .toBeLessThanOrEqual(R31_BUDGET.visibleTri);
      }
      /**
       * 治理有效性基线（**同树治理前**：R=750 无 LOD，必须落在被测几何的同一棵树上，
       * 否则「降幅」里混进 A 线几何漂移就成了假账 —— 这是本项目反复栽过的口径坑）。
       * 本常量由 C2 线 2026-10-25 二次 fresh 读数登记（castle high 393,630 tri）：
       *   −200 = 325,106 / −500 = 273,446，见 .qa/r32_tmp_audit/r32_policy_probe_fresh.log
       * （上一次登记是 384,470 tri 树上的 317,566 / 265,634，已作废。）
       * 波次末由严把关按届时 A 线几何重跑 `r32_policy_probe.mjs` 复测更新。
       */
      const PRE_GOV_BASE = { '-200': 325_106, '-500': 273_446 } as const;
      const mid200 = samples.find((s) => s.z === -200)!;
      const mid500 = samples.find((s) => s.z === -500)!;
      expect(mid200.tri, `中段 −200 相对同树治理前降幅不足 25%（基线 ${PRE_GOV_BASE['-200']}）`)
        .toBeLessThanOrEqual(PRE_GOV_BASE['-200'] * 0.75);
      expect(mid500.tri, `中段 −500 相对同树治理前降幅不足 25%（基线 ${PRE_GOV_BASE['-500']}）`)
        .toBeLessThanOrEqual(PRE_GOV_BASE['-500'] * 0.75);
      // 交叉验证：相对 **R31 跨波次基线**（−200 283,550 / −500 290,378）同样需 ≥25%
      // —— 这条更严（−500 限 217,783），当前 fresh 186,154/186,294 双口径都通过；
      // 深段（−900/−1300）相对 R31 基线是**上升**的（A 线 +9,160 tri 落在深段永久可见
      // 区），故本文件只在含中段的点上卡采样，不在深段上卡。
      const R31_BASE = { '-200': 283_550, '-500': 290_378 } as const;
      expect(mid200.tri, '中段 −200 相对 R31 基线降幅不足 25%').toBeLessThanOrEqual(R31_BASE['-200'] * 0.75);
      expect(mid500.tri, '中段 −500 相对 R31 基线降幅不足 25%').toBeLessThanOrEqual(R31_BASE['-500'] * 0.75);
      // 入口/终点 sanity：起点被 R=650 摘掉远区 ⇒ 应显著低于中段
      expect(samples[0].tri).toBeLessThan(mid200.tri);
    } finally {
      castle.dispose();
    }
  }, 60000);
});
