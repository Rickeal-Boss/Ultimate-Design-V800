/**
 * R37 收尾 · **贴图细化（微风化斑 + 灰缝细化）的 mean-preserving 回归**。
 *
 * ── 为什么必须锁 `roughMean` ──────────────────────────────────────────────────
 * `roughMean` 不是"好看的统计量"，它是**材质参数的反算分母**：
 *   `stoneTexture.ts` 的 `variantRoughness(target, roughMean, hasRoughMap)`
 *     返回 `target / roughMean`（铁律 34 的 1/ḡ 反算）
 *   ⇒ 挂了 roughnessMap 的材质，其 **effective roughness = material.roughness × ḡ**
 *     只有在 `material.roughness = target / roughMean` 时才等于 target。
 *   一旦 roughMean 漂移，`inner-stone / ashlar-grey / pave-damp / gilded-aged`
 *   **四个变体的实际粗糙度全跟着漂** —— 这就是"改贴图 → 全城材质手感变了"的耦合链。
 *
 * ── 口径（先读代码确认过，勿按猜测量）─────────────────────────────────────────
 * `measureStats()` 里 `roughMean = roughSum / count / 255`，其中
 *   `roughSum += rough[o]`（o = i*4，即 **R 通道**），`count = size*size`
 * ⇒ **roughnessMap R 通道的全像素算术均值，归一到 0..1**。本测试直接用
 *   `makeStonePixelSet(kind).stats.roughMean`，与生产同源，不是另写一套量法。
 *
 * ── 本轮实现是怎么做到 Δ≈0 的 ────────────────────────────────────────────────
 * 三层细化（`weatherCloud` / `weatherSpeck` / `seamShade`）**只写 `tone`（albedo）**，
 * 一行都不碰 `roughness[]` 与 `height[]` ⇒ ΔroughMean **结构性为 0**，不是"改完再调回"。
 * 唯一经 `edge → bevel → rough` 传递的是 `edgeNick` 0.15→0.19（"啃边磨损加量"），
 * 实测只贡献 **+0.000012** —— 因为 nick 场是零均值抖动，对均值的贡献几乎自相抵消。
 * ⇒ 总 ΔroughMean = **+0.000012**，相对 ±0.015 判据有 ~1000× 余量。
 */
import { describe, expect, it } from 'vitest';
import { makeStonePixelSet } from '../src/render/scene/stoneTexture';

/** R36 基线（**实测留档**，取法：把 ashlar 的 edgeNick 回 0.15 + 三层 amp 归 0 后重跑本探针） */
const R36_BASE = {
  ashlar: { roughMean: 0.848877, lumMean: 201.817, lumStd: 24.946, contrast: 77, grain: 3.274 },
  gold: { roughMean: 0.504538, lumMean: 117.628 },
  wall: { roughMean: 0.90623, lumMean: 169.912 },
  floor: { roughMean: 0.475119, lumMean: 65.262 }
} as const;

/** 判据（主理人指定） */
const MAX_ROUGH_MEAN_DELTA = 0.015;

function statsOf(kind: Parameters<typeof makeStonePixelSet>[0]) {
  return makeStonePixelSet(kind, { size: 256 }).stats;
}

describe('R37 贴图细化 · mean-preserving 判据', () => {
  it('★ ashlar：|ΔroughMean| ≤ 0.015（1/ḡ 反算分母不许漂）', () => {
    const s = statsOf('ashlar');
    const d = Math.abs(s.roughMean - R36_BASE.ashlar.roughMean);
    console.log(
      `R37_ASHLAR_ROUGH ${JSON.stringify({ before: R36_BASE.ashlar.roughMean, after: Number(s.roughMean.toFixed(6)), delta: Number(d.toFixed(6)), key: MAX_ROUGH_MEAN_DELTA })}`
    );
    expect(d).toBeLessThanOrEqual(MAX_ROUGH_MEAN_DELTA);
  });

  it('其余三族 roughMean **逐位不变**（金做旧色相档 / wall / floor 零漂移）', () => {
    // 金做旧色相档未动的硬证据：gold 的 roughMean 与 lumMean 与 R36 完全一致
    const gold = statsOf('gold');
    expect(gold.roughMean).toBeCloseTo(R36_BASE.gold.roughMean, 6);
    expect(gold.lumMean).toBeCloseTo(R36_BASE.gold.lumMean, 3);
    // wall：本轮三层细化只开给 ashlar（amp=0 ⇒ makeField 返回 null ⇒ 零开销逐位不变）
    expect(statsOf('wall').roughMean).toBeCloseTo(R36_BASE.wall.roughMean, 6);
    expect(statsOf('wall').lumMean).toBeCloseTo(R36_BASE.wall.lumMean, 3);
    // floor：走另一条 prep（乱石板），本轮未碰
    expect(statsOf('floor').roughMean).toBeCloseTo(R36_BASE.floor.roughMean, 6);
  });

  it('明度只许微量漂移（细化是"变脏旧"，不是"把白石墙改暗"）', () => {
    const s = statsOf('ashlar');
    const d = s.lumMean - R36_BASE.ashlar.lumMean;
    console.log(
      `R37_ASHLAR_LUM ${JSON.stringify({ before: R36_BASE.ashlar.lumMean, after: Number(s.lumMean.toFixed(3)), delta: Number(d.toFixed(3)), contrast: s.contrast, lumStd: Number(s.lumStd.toFixed(3)) })}`
    );
    // ① 上限：整体明度不许掉超过 5（≈2.5%）⇒ 远看仍是同一堵白石墙
    expect(Math.abs(d)).toBeLessThanOrEqual(5);
    // ② 下限（**存活判据**）：细化必须真的落到像素上 —— 若有人把三层 amp 归 0，
    //    lumMean 会回到 201.817 ⇒ |Δ|≈0 ⇒ 这条转红，提示"细化被摘掉了"。
    expect(Math.abs(d)).toBeGreaterThanOrEqual(0.3);
    // ③ 对比度不许塌（缝的清晰度是 R31 判据，压坏即"缝糊了"）
    expect(s.contrast).toBeGreaterThanOrEqual(70);
  });

  it('细化确实增加了"不均匀"而不是加了均匀灰（lumStd 仍在同一量级）', () => {
    const s = statsOf('ashlar');
    // 云斑/麻点都是零均值 ⇒ 加的是**方差**（泛色不均）而不是**偏置**（整体变暗）。
    // lumStd 允许小幅变化（云斑会把局部方差略降），但必须仍在 20~30 的石材质感带内。
    expect(s.lumStd).toBeGreaterThan(20);
    expect(s.lumStd).toBeLessThan(30);
  });
});
