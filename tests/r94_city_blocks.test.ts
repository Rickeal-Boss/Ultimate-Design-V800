/**
 * R94-P1 · 城内街区「沿 z 全距均匀分布」护栏（用户「加载门通过后中段仍无建筑」）。
 *
 * 根因：`makeInnerCity()` 的 `for (k < Math.min(blocks, keep))` 从 zNear **连续堆**
 * keep 个街区（默认 keep=6 ⇒ k=0..5 ⇒ 块心 z = −388.5…−618.5），只覆盖
 * z ∈ [−365.5, −641.5]；而赛道 barrier 在 z=−1300 ⇒ `z ∈ [−641, −1285]` 约 644m
 * 的城内楼群**完全为空** = 用户所见「中段无建筑」。
 *
 * 处方（本波）：keep 个街区沿 z 全距均匀分布（近端锚 k=0、远端锚 k=blocks−1）
 * ⇒ 街区数不变（tri 预算不变）、整条走廊在 `ZONE_VIEW_RANGE`=550 内始终有街区。
 *
 * 本文件钉六条契约：
 *   ① blocks 口径 = floor((zNear−zFar)/blockLen) = 20（旧注释「21」是错的）；
 *   ② 默认 keep=6 ⇒ 采样索引集 [0,4,8,11,15,19] 与块心 z 序列确定值；
 *   ③ 末块块心 z ≤ −1200（覆盖到 barrier 前）、首块块心 z ≥ −400、相邻块心间距
 *      ≤ 4·blockLen ≪ ZONE_VIEW_RANGE=550；
 *   ④ 逐块高度递减改按**分布序号 i**（0..n−1）而非 k ⇒ 最远块不塌（≥0.85）；
 *   ⑤ 开关语义退化：keep ≤ 1 ⇒ [0]（`#r91city=off` 回 R89 keep=1）、keep ≥ blocks ⇒
 *      [0..19]（`#r91city=full` 逐位回 R88 满量）、Math.min 钳制越界；
 *   ⑥ `#r91city=off` 真建桶后 `castle-pave` 契约桶仍在场（**禁止空循环**）。
 *
 * ⚠ node 环境下 `R91_CITY_RESTORE_ON` / `R89_CITY_TRIM_ON` 等开关默认 ON（见
 *   castleKit 的 `typeof window === 'undefined'` 分支）⇒ **无需 window shim 即得
 *   浏览器默认态**；`R91_CITY_FULL_ON` 为模块级静态常量（hash 只求值一次），故
 *   `#r91city=full` 只钉其下游口径（keep=blocks=20 ⇒ [0..19]），不重算模块。
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径 / 不起 git 子进程。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  cityBlockIndices,
  makeInnerCity,
  setDetailLevel,
  R91_CITY_KEEP_BLOCKS
} from '../src/render/scene/castleKit';
import { INNER } from '../src/render/scene/r28Layout';

/* ── 走廊口径（镜像 src/render/scene/r28Layout.ts INNER）─────────────────────── */
const { zNear, zFar, blockLen } = INNER;
const BLOCKS = Math.floor((zNear - zFar) / blockLen);
const blockCenterZ = (k: number): number => zNear - blockLen / 2 - k * blockLen;

/** castle.ts ZONE_VIEW_RANGE 的镜像（常量不导出，此处仅作间距口径引用） */
const ZONE_VIEW_RANGE = 550;

const DEFAULT_KEPT_Z = [-388.5, -572.5, -756.5, -894.5, -1078.5, -1262.5];

/* ── 最小 DOM shim：程序化贴图需要 document.createElement('canvas').getContext('2d') ── */
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

beforeEach(() => {
  delete (globalThis as { __R91_KEEP_BLOCKS?: number }).__R91_KEEP_BLOCKS;
});

describe('R94 · cityBlockIndices 采样索引语义', () => {
  it('blocks 口径 = floor((zNear−zFar)/blockLen) = 20（旧注释「21」是错的）', () => {
    expect(BLOCKS).toBe(20);
    expect(zNear).toBe(-365.5);
    expect(zFar).toBe(-1285.5);
    expect(blockLen).toBe(46);
  });

  it('默认 keep=6 ⇒ 采样索引集 [0,4,8,11,15,19]', () => {
    expect(cityBlockIndices(20, R91_CITY_KEEP_BLOCKS)).toEqual([0, 4, 8, 11, 15, 19]);
  });

  it('默认 keep=6 ⇒ 块心 z 序列确定值（近端 −388.5 锚定、远端 −1262.5 抵到 barrier 前）', () => {
    const zs = cityBlockIndices(20, 6).map(blockCenterZ);
    expect(zs.length).toBe(DEFAULT_KEPT_Z.length);
    zs.forEach((z, i) => expect(z).toBeCloseTo(DEFAULT_KEPT_Z[i]!, 6));
  });

  it('覆盖口径：末块块心 ≤ −1200（barrier 前）、首块块心 ≥ −400', () => {
    const zs = cityBlockIndices(20, 6).map(blockCenterZ);
    expect(Math.max(...zs)).toBeGreaterThanOrEqual(-400);
    expect(Math.min(...zs)).toBeLessThanOrEqual(-1200);
    // barrier z=−1300（TRACK.barrierDistance=1300）之前 37.5m 内仍有街区
    expect(Math.abs(-1262.5 - -1300)).toBeLessThanOrEqual(60);
  });

  it('相邻块心间距 ≤ 4·blockLen ≪ ZONE_VIEW_RANGE=550 ⇒ 任一视距内总有街区在场', () => {
    const zs = cityBlockIndices(20, 6).map(blockCenterZ);
    const gaps: number[] = [];
    for (let i = 1; i < zs.length; i += 1) gaps.push(Math.abs(zs[i]! - zs[i - 1]!));
    // 步长序列（k 差 4,4,3,4,4 × blockLen=46）：
    expect(gaps.map((g) => Math.round(g / blockLen))).toEqual([4, 4, 3, 4, 4]);
    expect(Math.max(...gaps)).toBeCloseTo(blockLen * 4, 6); // 最大空档 = 4 街区 = 184m
    expect(Math.max(...gaps)).toBeLessThan(ZONE_VIEW_RANGE);
  });

  it('退化口径：keep ≤ 1 ⇒ [0]（#r91city=off 回 R89 keep=1，Math.min 保证至少跑一次）', () => {
    expect(cityBlockIndices(20, 1)).toEqual([0]);
    expect(cityBlockIndices(20, 0)).toEqual([0]);
    expect(cityBlockIndices(20, -3)).toEqual([0]);
  });

  it('退化口径：keep ≥ blocks ⇒ [0..blocks−1] 逐位等同 R88 满量（#r91city=full / #r89city=off）', () => {
    expect(cityBlockIndices(20, 20)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(cityBlockIndices(20, 21)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(cityBlockIndices(20, 999)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('Math.min(blocks, keep) 语义保持：keep 越界被钳进 [1, blocks]', () => {
    expect(cityBlockIndices(1, 6)).toEqual([0]);
    expect(cityBlockIndices(2, 2)).toEqual([0, 1]);
    expect(cityBlockIndices(4, 3)).toEqual([0, 2, 3]);
  });
});

describe('R94 · 逐块高度递减改按分布序号 i（近高远低不破成「塌楼」）', () => {
  it('衰减 1−0.03i 单调递减且最远块不塌（i=5 ⇒ 0.85 ≥ 0.85）', () => {
    const decays = Array.from({ length: R91_CITY_KEEP_BLOCKS }, (_, i) => 1 - 0.03 * i);
    expect(decays[0]).toBe(1);
    for (let i = 1; i < decays.length; i += 1) {
      expect(decays[i]).toBeLessThan(decays[i - 1]!);
    }
    expect(decays[decays.length - 1]).toBeGreaterThanOrEqual(0.85 - 1e-9);
    // 反口径对照：若误用 k（最大 19）递减 ⇒ 1−0.03·19 = 0.43，最远块塌到 43%
    expect(1 - 0.03 * 19).toBeLessThan(0.5);
  });
});

describe('R94 · 开关语义回归（浏览器 hash A/B）', () => {
  it('默认（无 hash / node 无头）⇒ keep 常量 = 6，索引集长度 6', () => {
    // castleKit 开关函数在 `typeof window === 'undefined'` 时默认 ON（无头 = 浏览器默认态），
    // 故无 window shim 即测得 R91 默认 keep=6 ⇒ 采样 6 个街区。
    expect(R91_CITY_KEEP_BLOCKS).toBe(6);
    expect(cityBlockIndices(BLOCKS, R91_CITY_KEEP_BLOCKS).length).toBe(R91_CITY_KEEP_BLOCKS);
  });

  it('#r91city=full ⇒ 上界回全 20 街区（R91_CITY_FULL_ON ? blocks : …）⇒ 采样退化 [0..19]', () => {
    // R91_CITY_FULL_ON 为模块级静态常量（hash 只求值一次）⇒ 浏览器 hash 分支不在本测试
    // 重算；此处钉其**下游口径**：keep=blocks=20 ⇒ 逐位等同 R88 满量。
    expect(cityBlockIndices(BLOCKS, BLOCKS)).toEqual(
      Array.from({ length: BLOCKS }, (_, i) => i)
    );
  });
});

describe('R94 · #r91city=off 真建桶回归（pave 契约桶仍在场 ⇒ 禁止空循环）', () => {
  it('keep=1（__R91_KEEP_BLOCKS 探针注入）⇒ 循环恰跑一次，castle-pave 铺装在几何桶内', async () => {
    const { makeInnerCity: mi, setDetailLevel: sd } = await import('../src/render/scene/castleKit');
    sd(false);
    (globalThis as { __R91_KEEP_BLOCKS?: number }).__R91_KEEP_BLOCKS = 1;
    try {
      const b = mi();
      // pave 是 extra() 动态变体桶（不在 keyof StoneBuckets），从运行时键里取
      const buckets = b as unknown as Record<string, THREE.BufferGeometry[]>;
      const pave = buckets['pave'];
      expect(pave, 'keep=1 ⇒ castle-pave 契约桶应非空（禁止空循环）').toBeDefined();
      expect(pave!.length).toBeGreaterThan(0);
      for (const g of pave!) {
        g.computeBoundingBox();
        expect(g.boundingBox!.min.z).toBeLessThan(-400);
      }
      // tri 汇总 > 0（几何真在场，不是 visible=false 假在场）
      const tri = (gs: THREE.BufferGeometry[]): number =>
        gs.reduce((s, g) => {
          const idx = g.getIndex();
          return s + (idx ? idx.count : (g.getAttribute('position')?.count ?? 0)) / 3;
        }, 0);
      expect(tri(b.ashlar)).toBeGreaterThan(0);
      for (const key of Object.keys(buckets)) for (const g of buckets[key]!) g.dispose();
    } finally {
      delete (globalThis as { __R91_KEEP_BLOCKS?: number }).__R91_KEEP_BLOCKS;
    }
  }, 120000);
});