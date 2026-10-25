/**
 * R31 预算断言（B 线 P0 收口）：真正消费 `R31_BUDGET`，城堡 tri / DC 超红线即红。
 *
 * 口径与 `.qa/r31_test/r31_geo_probe.mjs` 完全一致：
 *   构建 `Castle` 两档（high / low）→ `getCastleStats()` → 断言 tri / DC ≤ 上限。
 *
 * 意义：R30 审查 P0「预算键零消费」⇒ CI 拦不住超标。本测试让 `R31_BUDGET`
 * 成为硬护栏：任何让城堡几何失控的改动都会在 `npm test` 阶段红掉。
 *
 * 注：`frameTri / frameDc / castleTexCount / visibleTri` 需 WebGL 渲染或运行时探针
 * 读数，本单测不覆盖，由 `.qa/r31_test/r31_perf*.mjs` 把关；本测试另做预算键完整性
 * 声明（7 键齐全且为正），确保预算键不被静默删改。
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
  high: {
    tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
    shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
    carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
  },
  low: {
    tier: 'low', pixelRatio: 1, minPixelRatio: 0.75, antialias: false, shadowMapSize: 1024,
    shadowOrtho: 28, msaaSamples: 0, bloom: false, bloomScale: 0.5, envMapSize: 256,
    carTextureSize: 256, castleTexSyncSize: 256, isMobile: false, gpuClass: 'software'
  }
} as const;

function castleStats(tier: 'high' | 'low') {
  setDetailLevel(tier === 'low');
  disposeStoneCache();
  const c = new Castle(new THREE.Scene(), QUALITY[tier] as unknown as QualitySettings);
  const s = c.getCastleStats();
  c.dispose();
  return s;
}

describe('R31_BUDGET 对象完整性', () => {
  it('7 个键齐全且均为正', () => {
    const keys: (keyof typeof R31_BUDGET)[] = [
      'castleTriHigh', 'castleTriLow', 'castleDc', 'frameTri', 'frameDc', 'castleTexCount', 'castleTexMB', 'visibleTri'
    ];
    for (const k of keys) {
      expect(R31_BUDGET[k], `R31_BUDGET.${k} 缺失`).toBeDefined();
      expect(R31_BUDGET[k], `R31_BUDGET.${k} 非正`).toBeGreaterThan(0);
    }
  });
});

describe('R31 城堡几何预算（getCastleStats 官方口径）', () => {
  it('high 档：tris 与 dc 均在 R31_BUDGET 内', () => {
    const s = castleStats('high');
    expect(s.tris).toBeLessThanOrEqual(R31_BUDGET.castleTriHigh);
    expect(s.dc).toBeLessThanOrEqual(R31_BUDGET.castleDc);
  }, 30000);

  it('low 档：tris 与 dc 均在 R31_BUDGET 内', () => {
    const s = castleStats('low');
    expect(s.tris).toBeLessThanOrEqual(R31_BUDGET.castleTriLow);
    expect(s.dc).toBeLessThanOrEqual(R31_BUDGET.castleDc);
  }, 30000);
});
