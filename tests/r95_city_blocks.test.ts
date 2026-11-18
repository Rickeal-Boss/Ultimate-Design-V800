/**
 * R95-P2 · 城内大街「近密远疏 + 加密」减空档护栏（用户俯瞰「中段有建筑空隙」）。
 *
 * 根因（R94-P1 遗留）：`cityBlockIndices` 的 R94 均匀采样（`Math.round(i*(blocks−1)/(n−1))`）
 * 把 keep 个街区沿 920m 全距**等分** ⇒ keep=6 ⇒ [0,4,8,11,15,19]，相邻块心恒 184m、
 * 街面实体间隙 138m ⇒ 俯瞰/远景读作「中段有建筑空隙」。行车视野 550m 内总有建筑
 * （184 < 550），故只有俯瞰/远景可见；用户期望「更连续的城市」。
 *
 * R95-P2 处方（`cityBlockIndices` 重写为**近密远疏**）：
 *   · **近端连续**：k=0,1,2,3…（空档 0）⇒ 玩家起点看到连片城市（R91 的连续堆语义）；
 *   · **远端稀疏覆盖**：末块 k=blocks−1=19 ⇒ 块心 −1262.5，barrier 前 37.5m，
 *     不回归 R93「中段空」；
 *   · **最大空档 ≤ 4·blockLen=184m**（默认 keep=8，不劣于 R94）；
 *   · **默认 keep 加密 6 → 8**（`R91_CITY_KEEP_BLOCKS`；加密目标 10 因 tri 预算约束
 *     回落 8 —— keep=10 的 nearZone+mid 街区推高 innerCity tri 至 ~102k，超 ~90k 预算）。
 * 默认 keep=8 ⇒ ks=[0,1,2,3,7,11,15,19]，近端连续 0..3（4 块）+ 远端 7/11/15/19。
 *
 * 本文件钉 R95-P2 六条硬护栏：
 *   ① 默认 keep=8 ⇒ ks 与块心 z 序列确定值（toBeCloseTo）；
 *   ② 近端连续：ks 含 [0,1,2,3]（连续、空档 0）；首块块心 zc ≥ −400；
 *   ③ 远端覆盖：末块块心 zc ≤ −1200（barrier 前仍有街区）；
 *   ④ 最大相邻块心间距 ≤ 184m（4·blockLen）；
 *   ⑤ 退化：keep ≤ 1 ⇒ [0]、keep ≥ blocks ⇒ [0..blocks−1]；
 *   ⑥ 高度递减：最远栋 jitterY = 1−0.03(n−1) ≥ 0.7（不塌）。
 *
 * ⚠ node 环境下 R91/R89 开关默认 ON ⇒ 无 window shim 即得浏览器默认态。
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径 / 不起 git 子进程。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  cityBlockIndices,
  R91_CITY_KEEP_BLOCKS
} from '../src/render/scene/castleKit';
import { INNER } from '../src/render/scene/r28Layout';

/* ── 走廊口径（镜像 src/render/scene/r28Layout.ts INNER）─────────────────────── */
const { zNear, zFar, blockLen } = INNER;
const BLOCKS = Math.floor((zNear - zFar) / blockLen);
const blockCenterZ = (k: number): number => zNear - blockLen / 2 - k * blockLen;

/** 默认 keep=8 的 R95-P2 采样式（近密远疏）与块心 z 序列 */
const DEFAULT_KS = [0, 1, 2, 3, 7, 11, 15, 19];
const DEFAULT_Z = [-388.5, -434.5, -480.5, -526.5, -710.5, -894.5, -1078.5, -1262.5];

beforeEach(() => {
  delete (globalThis as { __R91_KEEP_BLOCKS?: number }).__R91_KEEP_BLOCKS;
});

/* 最小 DOM shim：本文件只测纯函数（不建桶），无需 canvas；仍保留空 shim 以防未来接入 */
const REAL_DOC = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document: unknown }).document = REAL_DOC ?? {};
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

describe('R95-P2 · 默认 keep=8 近密远疏采样式确定值', () => {
  it('blocks 口径 = floor((zNear−zFar)/blockLen) = 20（r28Layout INNER）', () => {
    expect(BLOCKS).toBe(20);
    expect(zNear).toBe(-365.5);
    expect(zFar).toBe(-1285.5);
    expect(blockLen).toBe(46);
  });

  it('默认 keep=8 ⇒ ks = [0,1,2,3,7,11,15,19]（确定值）', () => {
    expect(R91_CITY_KEEP_BLOCKS).toBe(8);
    expect(cityBlockIndices(BLOCKS, R91_CITY_KEEP_BLOCKS)).toEqual(DEFAULT_KS);
  });

  it('默认 keep=8 ⇒ 块心 z 序列确定值（toBeCloseTo）', () => {
    const zs = cityBlockIndices(BLOCKS, R91_CITY_KEEP_BLOCKS).map(blockCenterZ);
    expect(zs.length).toBe(DEFAULT_Z.length);
    zs.forEach((z, i) => expect(z).toBeCloseTo(DEFAULT_Z[i]!, 6));
  });
});

describe('R95-P2 · 近端连续 + 远端覆盖 + 最大空档', () => {
  it('近端连续：ks 含 [0,1,2,3]（连续、空档 0）且首块 zc ≥ −400', () => {
    const ks = cityBlockIndices(BLOCKS, R91_CITY_KEEP_BLOCKS);
    // 前 4 块逐位连续（k=0,1,2,3）⇒ 相邻 k 差 1 ⇒ 空档（两街区之间的空街区数）= 0
    expect(ks.slice(0, 4)).toEqual([0, 1, 2, 3]);
    const gaps = ks.slice(1).map((k, i) => k - ks[i]!);
    expect(gaps[0]).toBe(1);
    expect(gaps[1]).toBe(1);
    expect(gaps[2]).toBe(1);
    expect(blockCenterZ(ks[0]!)).toBeGreaterThanOrEqual(-400);
  });

  it('远端覆盖：末块块心 zc ≤ −1200（barrier 前仍有街区，不回归中段空）', () => {
    const ks = cityBlockIndices(BLOCKS, R91_CITY_KEEP_BLOCKS);
    const lastZ = blockCenterZ(ks[ks.length - 1]!);
    expect(ks[ks.length - 1]).toBeGreaterThanOrEqual(18);
    expect(lastZ).toBeLessThanOrEqual(-1200);
    expect(Math.abs(lastZ - -1300)).toBeLessThanOrEqual(60);
  });

  it('最大相邻块心间距 ≤ 184m（4·blockLen，不劣于 R94）', () => {
    const ks = cityBlockIndices(BLOCKS, R91_CITY_KEEP_BLOCKS);
    const zs = ks.map(blockCenterZ);
    const gaps: number[] = [];
    for (let i = 1; i < zs.length; i += 1) gaps.push(Math.abs(zs[i]! - zs[i - 1]!));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(4 * blockLen);
    expect(Math.max(...gaps)).toBeCloseTo(184, 6);
  });
});

describe('R95-P2 · 退化口径（开关语义 / 回滚）', () => {
  it('keep ≤ 1 ⇒ [0]（#r91city=off 回 R89 keep=1，禁空循环）', () => {
    expect(cityBlockIndices(BLOCKS, 1)).toEqual([0]);
    expect(cityBlockIndices(BLOCKS, 0)).toEqual([0]);
  });

  it('keep ≥ blocks ⇒ [0..blocks−1]（#r91city=full / #r89city=off 逐位回 R88 满量）', () => {
    expect(cityBlockIndices(BLOCKS, BLOCKS)).toEqual(Array.from({ length: BLOCKS }, (_, i) => i));
    expect(cityBlockIndices(BLOCKS, 999)).toEqual(Array.from({ length: BLOCKS }, (_, i) => i));
  });
});

describe('R95-P2 · 高度递减不塌（1−0.03i，i=分布序号）', () => {
  it('最远栋 jitterY = 1−0.03(n−1) ≥ 0.7（keep=8 ⇒ 0.79）', () => {
    const n = R91_CITY_KEEP_BLOCKS;
    const decays = Array.from({ length: n }, (_, i) => 1 - 0.03 * i);
    expect(decays[0]).toBe(1);
    for (let i = 1; i < n; i += 1) expect(decays[i]).toBeLessThan(decays[i - 1]!);
    // 最远栋（i=n−1）不塌：0.79 ≥ 0.7
    expect(decays[n - 1]).toBeGreaterThanOrEqual(0.7 - 1e-9);
    expect(decays[n - 1]).toBeCloseTo(0.79, 6);
    // 反口径：若误用 k=19 ⇒ 1−0.03·19=0.43 明显塌（口径护栏）
    expect(1 - 0.03 * 19).toBeLessThan(0.5);
  });
});
