/**
 * R102 远景环加层次 —— 数值断言（不依赖 WebGL）。
 *
 * 治什么：用户截图反馈「渲染距离不足」，远景山脉呈扁平低模纸片。R102 在
 * `Terrain.buildRing` 里给远景环加了几何层次（SEG 260→400 + 每列 2 顶点→4 行 +
 * 周期 fbm 节理起伏）。本测试把三条铁律钉死，防后人改回去：
 *
 *  ① **tri 预算**：远景环两圈合计 ≤ R31_BUDGET.frameTri 的 2%（现 4800 / 465000 ≈ 1.03%）。
 *     超了就说明有人把 SEG/ROWS 又调大了，得先对账整帧红线。
 *  ② **明度红线**（vision §02）：岩石顶点色一律以 base（rockCliff / rockWarm）为顶，
 *     **只向下扰动，不向上抬**（雾色插值除外）。本测试对除环顶行外的每个顶点逐通道断言
 *     `col ≤ base × 1.06`（rockTint 上界 k=1.06）—— 上抬即红。
 *  ③ **确定性**：同一个 Terrain 实例的几何是纯函数（makeLcg / noise2 / fbm2，禁
 *     Math.random）⇒ 连续构造两次，position / color 逐位相等。破了就是有人在环里
 *     混了非确定性随机，会打碎像素断言。
 *
 * 附带断言：接缝闭合（i=0 与 i=SEG 两列顶点重合）—— 周期噪声 + heights[SEG]=heights[0]
 * 必须让环首尾咬合，否则侧看有一条裂缝直抵天空。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { Terrain } from '../src/render/scene/Terrain';
import { R27_PALETTE } from '../src/render/scene/r28Layout';
import { R31_BUDGET } from '../src/render/scene/r31Budget';

// rockStrataTexture 需 document.createElement('canvas')，本测试构造 Terrain 时会触发。
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

/** 取 terrain-skyline（远景环）几何 */
function ringGeometry(): THREE.BufferGeometry {
  const scene = new THREE.Scene();
  new Terrain(scene);
  const mesh = scene.getObjectByName('terrain-skyline');
  if (!mesh) throw new Error('terrain-skyline mesh 缺失');
  return (mesh as THREE.Mesh).geometry;
}

/** 逐通道明度上限（rockTint 上界 k=1.06；雾色插值仅作用于环顶行，此处不放宽） */
const TINT_CEIL = 1.06;

describe('R102 远景环加层次', () => {
  it('tri 预算：远景环两圈 ≤ frameTri 的 2%', () => {
    const geo = ringGeometry();
    const tris = geo.index ? geo.index.count / 3 : 0;
    // 现 4800（400 SEG × 3 行对 × 2 tri × 2 圈）
    expect(tris).toBeGreaterThan(0);
    expect(tris, `远景环 tri=${tris} 超整帧红线 2%`).toBeLessThanOrEqual(R31_BUDGET.frameTri * 0.02);
  });

  it('每列 4 行：中间行有节理起伏，不是底+顶两点线性插值', () => {
    const geo = ringGeometry();
    const pos = geo.getAttribute('position');
    // i=0 列的 4 个顶点 y：v=0/0.3/0.65/1
    const ys = [0, 1, 2, 3].map((j) => pos.getY(j));
    // 崖脚 y=-10、环顶 y=heights[0]>0
    expect(ys[0]).toBeCloseTo(-10, 5);
    expect(ys[3]).toBeGreaterThan(0);
    // 中间两行若仍是线性插值，y 会严格落在 -10..top 的直线上；R102 加了高度错位，
    // 至少一行要偏离线性插值 ±0.5m 以上（噪声幅度 9m，取保守阈值）
    const top = ys[3];
    const dev1 = Math.abs(ys[1] - (-10 + (top + 10) * 0.3));
    const dev2 = Math.abs(ys[2] - (-10 + (top + 10) * 0.65));
    expect(Math.max(dev1, dev2), '中间行无节理起伏 ⇒ 退回扁平纸片').toBeGreaterThan(0.5);
  });

  it('明度红线：非环顶顶点逐通道 ≤ base×1.06（只向下扰动）', () => {
    const geo = ringGeometry();
    const col = geo.getAttribute('color');
    const NV = 4;
    const SEG = 400;
    const count = col.count;
    // 两个环（远 2600 + 近 2000）拼在同一个 Patch：2 × (SEG+1) × NV
    expect(count).toBe(2 * (SEG + 1) * NV);
    const near = new THREE.Color(R27_PALETTE.rockCliff);
    const far = new THREE.Color(R27_PALETTE.rockWarm);
    // 前半是远环（ROCK_FAR，先 buildRing），后半是近环（ROCK_NEAR）
    const half = (SEG + 1) * NV;
    for (let i = 0; i < count; i += 1) {
      const vRow = i % NV;
      if (vRow === NV - 1) continue; // 环顶行：雾色插值例外（混向的是雾不是亮部）
      const base = i < half ? far : near;
      const r = col.getX(i);
      const g = col.getY(i);
      const b = col.getZ(i);
      const ceilR = base.r * TINT_CEIL + 1e-6;
      const ceilG = base.g * TINT_CEIL + 1e-6;
      const ceilB = base.b * TINT_CEIL + 1e-6;
      expect(r, `顶点 ${i} R=${r.toFixed(4)} 上抬过明度红线`).toBeLessThanOrEqual(ceilR);
      expect(g, `顶点 ${i} G=${g.toFixed(4)} 上抬过明度红线`).toBeLessThanOrEqual(ceilG);
      expect(b, `顶点 ${i} B=${b.toFixed(4)} 上抬过明度红线`).toBeLessThanOrEqual(ceilB);
    }
  });

  it('确定性：连续构造两次 position/color 逐位相等（禁 Math.random）', () => {
    const a = ringGeometry();
    const b = ringGeometry();
    const pa = a.getAttribute('position');
    const pb = b.getAttribute('position');
    const ca = a.getAttribute('color');
    const cb = b.getAttribute('color');
    expect(pa.count).toBe(pb.count);
    for (let i = 0; i < pa.count; i += 1) {
      expect(pa.getX(i)).toBe(pb.getX(i));
      expect(pa.getY(i)).toBe(pb.getY(i));
      expect(pa.getZ(i)).toBe(pb.getZ(i));
      expect(ca.getX(i)).toBe(cb.getX(i));
      expect(ca.getY(i)).toBe(cb.getY(i));
      expect(ca.getZ(i)).toBe(cb.getZ(i));
    }
  });

  it('接缝闭合：i=0 与 i=SEG 两列顶点重合（周期噪声 + heights[SEG]=heights[0]）', () => {
    const geo = ringGeometry();
    const pos = geo.getAttribute('position');
    const NV = 4;
    const SEG = 400;
    // 只断言远环（前 (SEG+1)×NV 个顶点）；近环 i=SEG 列紧接远环 i=0 列，同样闭合
    for (let j = 0; j < NV; j += 1) {
      const a = j;
      const b = SEG * NV + j;
      expect(pos.getX(a), `远环接缝 x 不闭合（行 ${j}）`).toBeCloseTo(pos.getX(b), 3);
      expect(pos.getY(a), `远环接缝 y 不闭合（行 ${j}）`).toBeCloseTo(pos.getY(b), 3);
      expect(pos.getZ(a), `远环接缝 z 不闭合（行 ${j}）`).toBeCloseTo(pos.getZ(b), 3);
    }
    const near0 = (SEG + 1) * NV;
    for (let j = 0; j < NV; j += 1) {
      const a = near0 + j;
      const b = near0 + SEG * NV + j;
      expect(pos.getX(a), `近环接缝 x 不闭合（行 ${j}）`).toBeCloseTo(pos.getX(b), 3);
      expect(pos.getY(a), `近环接缝 y 不闭合（行 ${j}）`).toBeCloseTo(pos.getY(b), 3);
      expect(pos.getZ(a), `近环接缝 z 不闭合（行 ${j}）`).toBeCloseTo(pos.getZ(b), 3);
    }
  });
});
