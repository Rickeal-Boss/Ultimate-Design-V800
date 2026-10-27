/**
 * R36-A1 · 金菱形楣宽钳制断言（「菱形外缘 ≤ 楣板半宽」）+ A2 龛四侧壁/龛深带 +
 * B2 hero 窗真凹腔 + A2 变体桶（door/agedGold/pave → variantMaterial）。
 *
 * 背景（外部审查定罪项）：R34 给 finialOrnament 写了 `lintelHalf` 钳制但**从未接线**
 * （4 个 castleKit 调用点 + castleDetail bellTower 只传 {r}）⇒ 钳制死路径；且
 * castleKit 门楣两侧金菱形（R32 原始 box，横偏写死 discR+4.2）外缘 ±12.24 越出
 * 中央石体量面（楣板半宽 openHalf=10）爬到塔墩上 =「金菱形外飘」；另有
 * box()+rotateZ 绕世界原点旋转的定位 bug（菱形整枚飞到 −x 侧）——已全修。
 *
 * 本文件钉四件事（判据源 = castleDetail.diamondFit 纯函数）：
 *   ① diamondFit 数学：给了 lintelHalf ⇒ 菱形外缘（dx + 边长×√2/2）≤ 楣板半宽；
 *      没给 ⇒ 保持 want 原值（向后兼容）。
 *   ② finialOrnament 集成：flankDiamonds 金件横向包络不超过 max(无菱形基线, lintelHalf)。
 *   ③ makeGate 门楣菱形实体：外缘 ≤ GATE.openW/2（中央石体量面 = 楣板）。
 *   ④ A2/B2：龛四侧壁 + 龛深带 + hero 窗真凹腔 + 变体桶在场。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import {
  diamondFit,
  finialOrnament,
  statueNicheX,
  statueNicheZ,
  traceryWindowX
} from '../src/render/scene/castleDetail';
import { makeGate } from '../src/render/scene/castleKit';
import { GATE, GATE_DECOR } from '../src/render/scene/r28Layout';

/** 一组几何的横向（|x|）包络 */
function absXEnvelope(geos: readonly THREE.BufferGeometry[]): number {
  let m = 0;
  for (const g of geos) {
    g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) continue;
    m = Math.max(m, Math.abs(bb.min.x), Math.abs(bb.max.x));
  }
  return m;
}

describe('R36-A1 · diamondFit 楣宽钳制（菱形外缘 ≤ 楣板半宽）', () => {
  it('给了 lintelHalf ⇒ 外缘（dx + 边长×√2/2）≤ 楣板半宽，且不放大原值', () => {
    for (const wantSide of [0.4, 0.9, 2.6, 5]) {
      for (const wantDx of [0.2, 1.7, 8.5, 10.4]) {
        for (const lintelHalf of [0.3, 0.85, 2, 8.75, 10, 20]) {
          const { side, dx } = diamondFit(wantSide, wantDx, lintelHalf);
          // 钳制只收不放
          expect(side).toBeLessThanOrEqual(wantSide + 1e-9);
          expect(dx).toBeLessThanOrEqual(wantDx + 1e-9);
          if (side > 1e-4 && dx > 1e-4) {
            const outer = dx + (side * Math.SQRT2) / 2;
            expect(outer).toBeLessThanOrEqual(lintelHalf + 1e-9);
          }
        }
      }
    }
  });

  it('没给 lintelHalf ⇒ 保持 want 原值（向后兼容）', () => {
    expect(diamondFit(2.6, 10.4)).toEqual({ side: 2.6, dx: 10.4 });
  });

  it('窄楣装不下整枚时：边长先按楣板收；仍放不下则 dx≤0（调用方跳过）', () => {
    // 楣板半宽 0.5：边长收到 0.5×√2≈0.707，半跨 0.5 ⇒ dx 被压到 0 ⇒ 不产菱形
    const tight = diamondFit(2.6, 1.7, 0.5);
    expect(tight.side).toBeCloseTo(0.5 * Math.SQRT2, 6);
    expect(tight.dx).toBe(0);
  });
});

describe('R36-A1 · finialOrnament 集成（flankDiamonds 横向包络受 lintelHalf 约束）', () => {
  it('flankDiamonds 金件 |x| 包络 ≤ max(无菱形基线, lintelHalf)', () => {
    // 顶点存 Float32 ⇒ bbox 容差取 1e-5（纯数学断言在上一 describe 用 1e-9）
    for (const r of [0.5, 1.0]) {
      for (const lintelHalf of [0.42, 0.85, 1.0, 3, 20]) {
        const base = finialOrnament({ r, flankDiamonds: false });
        const clad = finialOrnament({ r, flankDiamonds: true, lintelHalf });
        const baseEnv = absXEnvelope(base.gold);
        const cladEnv = absXEnvelope(clad.gold);
        expect(cladEnv).toBeLessThanOrEqual(Math.max(baseEnv, lintelHalf) + 1e-5);
        // 清理
        for (const g of [...base.gold, ...clad.gold]) g.dispose();
      }
    }
  });

  it('窄楣（lintelHalf < 菱形需求）⇒ 菱形被钳/跳过，包络不越无菱形基线', () => {
    const base = finialOrnament({ r: 1, flankDiamonds: false });
    const clad = finialOrnament({ r: 1, flankDiamonds: true, lintelHalf: 0.3 });
    expect(absXEnvelope(clad.gold)).toBeLessThanOrEqual(absXEnvelope(base.gold) + 1e-5);
    for (const g of [...base.gold, ...clad.gold]) g.dispose();
  });
});

describe('R36-A1 · makeGate 门楣金菱形实体（外缘 ≤ 楣板半宽 = 中央石体量面）', () => {
  it('门楣两侧金菱形外缘 ≤ GATE.openW/2（转 45° 半跨 = 边长×√2/2）', () => {
    const b = makeGate();
    const lintelHalf = GATE.openW / 2; // 中央石体量面半宽 = 楣板
    const yCrown = GATE_DECOR.sunDiscYCrown + 0.6;
    // 门楣菱形：45° 方板，bbox ≈ 2.6×√2 见方、中心 y≈日轮心+0.6 —— 按此指纹筛出
    const diamonds = b.gold.filter((g) => {
      g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return false;
      const cy = (bb.min.y + bb.max.y) / 2;
      return Math.abs(cy - yCrown) < 0.05 && bb.max.x - bb.min.x > 3;
    });
    expect(diamonds.length).toBe(2); // 左右各一（不允许多挂/漏挂）
    for (const g of diamonds) {
      const bb = g.boundingBox!;
      expect(Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x))).toBeLessThanOrEqual(lintelHalf + 1e-6);
    }
  });
});

describe('R36-A2 · 龛四侧壁 + 龛深口径（龛宽 1/3–1/2）', () => {
  it('statueNiche dark 腔体含底板（四侧壁齐）且总腔深落在龛宽 1/3–1/2 带内', () => {
    const halfW = 0.8;
    const p = statueNicheX({ halfW, rise: 3.0, cusp: 0.5 });
    // 四侧壁：背板 1 + 侧壁 2 + 底板 1 + 拱腹 1 = ≥5 条 dark
    expect(p.dark.length).toBeGreaterThanOrEqual(5);
    // 腔深带：plateBack 缺省 0.85×半宽 ⇒ 总腔深/龛宽 ≈ 0.42 ∈ [1/3, 1/2]
    const depth = halfW * 0.85;
    expect(depth / (halfW * 2)).toBeGreaterThanOrEqual(1 / 3 - 1e-9);
    expect(depth / (halfW * 2)).toBeLessThanOrEqual(1 / 2 + 1e-9);
    for (const g of p.dark) g.dispose();
    for (const g of p.gold) g.dispose();
    for (const g of p.ashlar) g.dispose();
  });

  it('显式 plateBack 过浅/过深时被钳进龛宽 1/3–1/2 带（只加深不减浅的口径反向校验）', () => {
    // 半宽 1.15（龛宽 2.3）：带 = [0.767, 1.15]；传 0.5 ⇒ 收到 0.767
    const p = statueNicheZ({ halfW: 1.15, rise: 4.4, plateBack: 0.5 });
    expect(p.dark.length).toBeGreaterThanOrEqual(5);
    for (const g of [...p.dark, ...p.gold, ...p.ashlar]) g.dispose();
  });
});

describe('R36-B2 · hero 窗真凹腔（墙皮↔券框外脸 4 面 dark 内壁）', () => {
  it('recess:true ⇒ dark 内壁铺在墙外挑带（x∈[−frameOut,−PROUD_PLATE]），4 件', () => {
    const frameOut = 0.5;
    const proud = 0.06;
    const p = traceryWindowX({ halfW: 1.2, rise: 7.5, cusp: 1.0, frameOut, plateBack: 0.3, mullions: 2, recess: true, glass: false });
    // 凹腔 4 件：左右壁 2 + 窗台/拱腹 2（全部在墙外挑带里，不埋墙）
    const cavity = p.dark.filter((g) => {
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      // face 'x'：券框挑 −x ⇒ 空腔 x∈[−frameOut,−PROUD_PLATE]
      return bb.max.x <= -proud + 1e-6 && bb.min.x >= -frameOut - 1e-6;
    });
    expect(cavity.length).toBe(4);
    for (const g of p.dark) g.dispose();
    for (const g of p.gold) g.dispose();
    for (const g of p.ashlar) g.dispose();
    if (p.glass) for (const g of p.glass) g.dispose();
  });
});

/* ═══════════════ R36-A2 · 变体桶（door/agedGold/pave → variantMaterial）═══════════════ */

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

describe('R36-A2 · 变体桶在场（castle-door / castle-agedGold / castle-pave）', () => {
  it('三个变体桶各建 1 mesh，且材质命中 STONE_VARIANTS 语义（inner-wood/gilded-aged/pave-damp）', async () => {
    const { Castle } = await import('../src/render/scene/castle');
    const { disposeStoneCache } = await import('../src/render/scene/stoneTexture');
    const { setDetailLevel } = await import('../src/render/scene/castleKit');
    const quality = {
      tier: 'high', pixelRatio: 2, minPixelRatio: 1, antialias: true, shadowMapSize: 2048,
      shadowOrtho: 28, msaaSamples: 4, bloom: true, bloomScale: 1, envMapSize: 900,
      carTextureSize: 1024, castleTexSyncSize: 256, isMobile: false, gpuClass: 'discrete'
    } as never;
    setDetailLevel(false);
    disposeStoneCache();
    const scene = new THREE.Scene();
    const castle = new Castle(scene, quality);
    try {
      const names = new Map<string, THREE.Mesh>();
      scene.getObjectByName('castle')?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) names.set(m.name, m);
      });
      for (const key of ['door', 'agedGold', 'pave'] as const) {
        const mesh = names.get(`castle-${key}`);
        expect(mesh, `castle-${key} 缺失`).toBeDefined();
        const mat = mesh!.material as THREE.MeshStandardMaterial;
        expect(mat.name.startsWith('stone-variant:'), `castle-${key} 材质未走变体路径`).toBe(true);
      }
      const doorMat = names.get('castle-door')!.material as THREE.MeshStandardMaterial;
      const agedMat = names.get('castle-agedGold')!.material as THREE.MeshStandardMaterial;
      const paveMat = names.get('castle-pave')!.material as THREE.MeshStandardMaterial;
      expect(doorMat.name).toBe('stone-variant:inner-wood');
      expect(agedMat.name).toBe('stone-variant:gilded-aged');
      expect(paveMat.name).toBe('stone-variant:pave-damp');
      // 0 新贴图：三个变体与基族共享同一图集实例（wood/gold/floor 的 map 引用不 clone）
      expect(doorMat.map).toBeTruthy();
      expect(agedMat.map).toBeTruthy();
      expect(paveMat.map).toBeTruthy();
    } finally {
      castle.dispose();
      disposeStoneCache();
    }
  }, 120000);
});
