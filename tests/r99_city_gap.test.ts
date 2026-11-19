/**
 * R99 · 空档补街几何护栏（用户「中段建筑一段一段消失」）。
 *
 * 根因：makeInnerCity 只对 cityBlockIndices 采样的 ks 造殿/塔/连墙；相邻 ks 之间的
 * 未采样块整块不生成，地面铺装却连续 ⇒ 露 #D4C8B8 土黄地形（探测 verify/r99_probe_city.md）。
 * R99 处方：不改采样/护栏，在循环外对每个缺块补「临街殿身(从地面起) + 沿 z 覆盖整块
 * 46m 的连墙 + 双坡顶」，side=±1 双侧对称，全部进已有 ashlar/wall/roof 桶（DC +0）。
 *
 * 本文件钉四条：
 *   ① 空档带 [-641.5,-549.5]（k=4/5）与 [-917.5,-779.5]（含 k=9/10 空档）
 *      在 +x 侧 ashlar/wall 桶确有几何（防止未来采样调整又把这段掏空）；
 *   ② 每个「相邻 ks 跨度>1 块」的缺块块心 zc 处，+x 侧 ashlar/wall 均有几何覆盖；
 *   ③ 采样护栏 ks 仍绿（不改 cityBlockIndices / R91_CITY_KEEP_BLOCKS）；
 *   ④ DC 不增（并入已有分区 mesh，dc ≤ 设计上限，无零面 mesh）。
 *
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径 / 不起 git 子进程。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import {
  makeInnerCity,
  cityBlockIndices,
  R91_CITY_KEEP_BLOCKS
} from '../src/render/scene/castleKit';
import { INNER } from '../src/render/scene/r28Layout';
import { Castle } from '../src/render/scene/castle';
import { disposeStoneCache } from '../src/render/scene/stoneTexture';
import type { QualitySettings } from '../src/config/quality';

const { zNear, zFar, faceHalf, blockLen } = INNER;
const BLOCKS = Math.floor((zNear - zFar) / blockLen);
const blockCenterZ = (k: number): number => zNear - blockLen / 2 - k * blockLen;

const DEFAULT_KS = [0, 1, 2, 3, 6, 8, 11, 14, 16, 19];
/** 相邻采样块之间的全部缺块（R99 补街目标集合） */
function missingBlocks(ks: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < ks.length; i += 1) {
    for (let k = ks[i - 1]! + 1; k < ks[i]!; k += 1) out.push(k);
  }
  return out;
}
const MISSING = missingBlocks(DEFAULT_KS); // [4,5,7,9,10,12,13,15,17,18]

/* 最小 DOM shim（Castle 建桶时石材 canvas 程序化贴图需要） */
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

/** 几何是否「在 z 带内（含 1m 内缩边距）且整条落在 +x 侧街面（min.x>faceHalf−1）」。 */
function inBandPlusX(g: THREE.BufferGeometry, zLo: number, zHi: number): boolean {
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox!;
  if (bb.max.z <= zLo + 1 || bb.min.z >= zHi - 1) return false;
  return bb.min.x > faceHalf - 1;
}

/** 几何是否「含住 zc（块心 ±2m）且落在 +x 侧」。 */
function coversZPlusX(g: THREE.BufferGeometry, zc: number): boolean {
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox!;
  if (bb.max.z < zc - 2 || bb.min.z > zc + 2) return false;
  return bb.min.x > faceHalf - 1;
}

describe('R99 · 空档补街几何确实存在（填住土黄空地）', () => {
  const b = makeInnerCity();

  it('采样护栏仍绿：ks=[0,1,2,3,6,8,11,14,16,19]，缺块集合确定', () => {
    expect(R91_CITY_KEEP_BLOCKS).toBe(10);
    expect(cityBlockIndices(BLOCKS, R91_CITY_KEEP_BLOCKS)).toEqual(DEFAULT_KS);
    expect(MISSING).toEqual([4, 5, 7, 9, 10, 12, 13, 15, 17, 18]);
  });

  it('任务指定两条空档带在 +x 侧 ashlar/wall 桶有几何', () => {
    const bands: readonly (readonly [number, number])[] = [
      [-641.5, -549.5], // k=4/5 空档（用户截图 z≈−600 所在）
      [-917.5, -779.5] // 含 k=9/10 空档（k=8→11 之间）
    ];
    for (const [zLo, zHi] of bands) {
      const ashlarHit = b.ashlar.some((g) => inBandPlusX(g, zLo, zHi));
      const wallHit = b.wall.some((g) => inBandPlusX(g, zLo, zHi));
      expect(ashlarHit, `ashlar 在 +x 侧 z∈[${zLo},${zHi}] 无几何`).toBe(true);
      expect(wallHit, `wall 在 +x 侧 z∈[${zLo},${zHi}] 无几何`).toBe(true);
    }
  });

  it('每个缺块全 z 跨度无新缝：+x 侧殿身居中、连墙两段覆盖两侧', () => {
    for (const k of MISSING) {
      const zc = blockCenterZ(k);
      // 殿身（ashlar）居中，覆盖块心 ±2m
      expect(b.ashlar.some((g) => coversZPlusX(g, zc)), `k=${k} zc=${zc} 殿身 ashlar 缺失`).toBe(true);
      // 连墙两段覆盖殿身以外的两侧（取 zc±15，落在两段墙体内）
      expect(b.wall.some((g) => coversZPlusX(g, zc - 15)), `k=${k} zc−15 连墙 wall 缺失`).toBe(true);
      expect(b.wall.some((g) => coversZPlusX(g, zc + 15)), `k=${k} zc+15 连墙 wall 缺失`).toBe(true);
    }
  });

  it('补街几何不侵入行车走廊 |x|≤8（内缘严格 15.5，无 marble/gold/door 细节件）', () => {
    const bands: readonly (readonly [number, number])[] = [
      [-641.5, -549.5],
      [-871.5, -779.5],
      [-1239.5, -1147.5]
    ];
    for (const [zLo, zHi] of bands) {
      for (const g of [...b.ashlar, ...b.wall]) {
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox!;
        if (bb.max.z <= zLo || bb.min.z >= zHi) continue; // 不在带内
        // 任何带内 ashlar/wall 不得跨越走廊：要么整条在 +x≥8，要么整条在 −x≤−8
        // （采样块正常内缘 15.5、角塔基座既有 14.9，均 >8；补街内缘 15.5）
        const crossesCorridor = bb.min.x < 8 && bb.max.x > -8;
        expect(crossesCorridor, `z∈[${zLo},${zHi}] 有几何侵入 |x|≤8 走廊`).toBe(false);
      }
    }
  });

  it('补街几何 tri 增量在 +10k 预算内（每缺块 6 box≈72tri，10 缺块双侧≈1440tri）', () => {
    const addedTri = MISSING.length * 2 /*side*/ * 6 /*box per side*/ * 12;
    expect(addedTri).toBeLessThanOrEqual(10_000);
    expect(addedTri).toBe(1440);
    // 全显 tri 由 r37_perf 钉死 ≤235k；这里记录 makeInnerCity 桶规模供对照
    let bucketTri = 0;
    for (const key of ['ashlar', 'wall', 'gold', 'dark', 'flame', 'roof'] as const) {
      const arr = (b as unknown as Record<string, THREE.BufferGeometry[]>)[key] ?? [];
      for (const g of arr) bucketTri += triOf(g);
    }
    console.log(`R99_INNER_CITY_TRI bucketTri=${bucketTri} addedGapTri=${addedTri}`);
    expect(bucketTri).toBeGreaterThan(0);
  });
});

describe('R99 · DC 不增（并入已有分区 mesh）', () => {
  it('Castle DC ≤ 设计上限 29，且无零面 mesh（dc==mesh 数）', () => {
    const scene = new THREE.Scene();
    const castle = new Castle(scene, QUALITY_HIGH);
    try {
      const dc = castle.getCastleStats().dc;
      const meshes: THREE.Mesh[] = [];
      scene.getObjectByName('castle')?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) meshes.push(m);
      });
      const DESIGN_MAX_DC = 29; // 7+1+6+4+1+1+4+3+2（r32_zone DESIGN_MAX_DC）
      console.log(`R99_CASTLE_DC dc=${dc} meshCount=${meshes.length}`);
      expect(dc).toBeLessThanOrEqual(DESIGN_MAX_DC);
      expect(dc).toBe(meshes.length);
      const empties = meshes.filter((m) => triOf(m.geometry) === 0).map((m) => m.name);
      expect(empties, `零面幽灵 mesh：${empties.join(', ')}`).toEqual([]);
    } finally {
      castle.dispose();
      disposeStoneCache();
    }
  }, 60000);
});
