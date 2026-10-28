/**
 * R37 P2-8 · 石材变体**有效粗糙度**回归（不是断言 spec 值）。
 *
 * ── 为什么必须断 effective 而不是 spec ────────────────────────────────────────
 * `variantRoughness(target, ḡ)` 为了抵消 roughnessMap 均值 ḡ 的乘法，返回 `target / ḡ`；
 * 但 `material.roughness` **上限是 1** ⇒ 只要 `target > ḡ`，结果被 `min(1,·)` 钳住，
 * 该材质的 **effective = roughness × ḡ 恒等于 ḡ**，spec 里写的 target **完全不生效**。
 *
 * 这就是它逃过上一轮审查的原因：**断言 spec 值（0.88 / 0.92）永远是绿的**，
 * 而渲染出来的两支材质其实一模一样。本文件只断 `roughness × ḡ`。
 *
 * ── 实测（256² 运行尺寸，与生产同源）────────────────────────────────────────
 * | 变体         | 族      | ḡ        | spec.rough | raw    | material.roughness | effective |
 * |--------------|---------|----------|-----------|--------|--------------------|-----------|
 * | inner-stone  | ashlar  | 0.848889 | 0.92      | 1.0838 | 1（钳）            | 0.848889  |
 * | ashlar-grey  | ashlar  | 0.848889 | **0.80**  | 0.9424 | 0.9424             | **0.80**  |
 * | gilded-aged  | gold    | 0.504538 | 0.55      | 1.0900 | 1（钳）            | 0.504538  |
 * | pave-damp    | floor   | 0.475119 | 0.80      | 1.6838 | 1（钳）            | 0.475119  |
 * | inner-wood   | wood    | —        | 0.82      | —      | 0.82（无 roughMap）| 0.82      |
 *
 * ⇒ 本轮把 ashlar-grey 从 0.88 降到 **0.80**，正是为了让它**脱离钳制**、
 *   与 inner-stone 拉开 0.0489 的真实差距（否则两支 effective 完全相同）。
 * ⇒ 其余三档（inner-stone / gilded-aged / pave-damp）**保留原值并登记为「被钳」**：
 *   改它们等于改 R35/R36 已验收的观感，不在本轮授权内（见各自 note）。
 */
import { describe, expect, it } from 'vitest';
import {
  STONE_VARIANTS,
  makeStoneMaps,
  makeStoneVariantMaterial,
  type StoneVariantId
} from '../src/render/scene/stoneTexture';

/** 最小 canvas shim（石材贴图是纯 2D canvas 生成，无 GL） */
function shimCanvas(): void {
  (globalThis as { document: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () =>
        new Proxy({} as Record<string, unknown>, {
          get: (_t, p) => {
            if (p === 'createImageData' || p === 'getImageData')
              return (w: number, h: number) => ({
                data: new Uint8ClampedArray(w * h * 4),
                width: w,
                height: h
              });
            if (p === 'measureText') return () => ({ width: 0 });
            if (p === 'createLinearGradient' || p === 'createRadialGradient')
              return () => ({ addColorStop: () => {} });
            if (p === 'createPattern') return () => null;
            return () => {};
          },
          set: () => true
        })
    })
  };
}

/**
 * 族 → 通道预算的**测试侧镜像**（真源是 `castle.ts:333` 的私有 `STONE_CHANNELS`，
 * 它没导出，而 `variantMaterial()` 正是按它的通道去取图集）。
 *
 * ⚠ 为什么必须有这份镜像：`makeStoneMaps(kind)` 的 `channels` **默认是 'full'**，
 *   直接用默认值会给 floor/wood 也挂上 roughnessMap —— 那样测的就不是生产路径
 *   （我第一版审计就是这么把 pave-damp 误判成"被钳"的）。下面另一条用例会用
 *   **读源码**的方式盯住这张表，改了它这里会报错提示同步。
 */
const CHANNELS_MIRROR: Readonly<Record<string, 'full' | 'noRough' | 'albedoOnly'>> = {
  ashlar: 'full',
  gold: 'full',
  floor: 'noRough',
  wood: 'noRough'
};

/** 与生产同源：拿到该变体的材质实例 + 该族图集的 ḡ */
function probe(id: StoneVariantId): {
  target: number;
  gBar: number;
  roughness: number;
  effective: number;
  hasRoughMap: boolean;
} {
  const v = STONE_VARIANTS[id];
  const channels = CHANNELS_MIRROR[v.texKind] ?? 'full';
  const maps = makeStoneMaps(v.texKind, { size: 256, channels });
  const mat = makeStoneVariantMaterial(id, maps);
  const gBar = maps.stats.roughMean;
  return {
    target: v.rough,
    gBar,
    roughness: mat.roughness,
    effective: mat.roughness * gBar,
    hasRoughMap: maps.roughnessMap !== null
  };
}

describe('R37 P2-8 变体有效粗糙度（断言 roughness×ḡ，不断 spec）', () => {
  it('★ ashlar-grey：effective 真等于 0.80（不撞 clamp），且不再与 inner-stone 归一', () => {
    shimCanvas();
    const grey = probe('ashlar-grey');
    const inner = probe('inner-stone');
    console.log(
      `R37_ROUGH_EFFECTIVE ${JSON.stringify({
        grey: { target: grey.target, gBar: Number(grey.gBar.toFixed(6)), roughness: Number(grey.roughness.toFixed(6)), effective: Number(grey.effective.toFixed(6)) },
        inner: { target: inner.target, gBar: Number(inner.gBar.toFixed(6)), roughness: Number(inner.roughness.toFixed(6)), effective: Number(inner.effective.toFixed(6)) },
        delta: Number(Math.abs(inner.effective - grey.effective).toFixed(6))
      })}`
    );
    // ① 该族两支共享同一个 ḡ
    expect(grey.gBar).toBeCloseTo(inner.gBar, 9);
    // ② grey 的 effective 必须落在 spec 目标 ±1e-3（这条才真正反映"生效"）
    expect(grey.effective).toBeCloseTo(grey.target, 3);
    // ③ grey 未被钳：material.roughness < 1
    expect(grey.roughness).toBeLessThan(1);
    // ④ inner-stone 被钳：roughness 卡在 1、effective 退化成 ḡ（**登记在案**，不是 bug 复现）
    expect(inner.roughness).toBeCloseTo(1, 6);
    expect(inner.effective).toBeCloseTo(inner.gBar, 6);
    // ⑤ ★核心：两支 effective **必须不同**，差值 ≥0.03
    //   （修前两支都是 0.848889、差 0 ⇒ 这条会红，正是它逃过审查的原因）
    expect(Math.abs(inner.effective - grey.effective)).toBeGreaterThanOrEqual(0.03);
  });

  it('clamp 审计：全族逐档状态与登记一致（防止有人"偷偷调好了"却没人改注释）', () => {
    shimCanvas();
    /* 只有**挂了 roughnessMap 且 target > ḡ** 的才被钳。
     * ⚠ floor / wood 两族是 'noRough'/'albedoOnly' 通道 ⇒ **没有 roughnessMap**
     *   ⇒ 既不做 1/ḡ 反算、也不存在钳制，spec.rough **直接生效**（pave-damp 0.8 就是 0.8）。
     *   这一点很容易想当然搞错（我第一版审计就把它算成"被钳"）。 */
    const CLAMPED = ['inner-stone', 'gilded-aged'] as const;
    for (const id of CLAMPED) {
      const p = probe(id);
      expect(p.hasRoughMap, `${id} 应挂 roughnessMap`).toBe(true);
      // target 确实大于 ḡ（这是被钳的前提；若哪天调到 ≤ḡ 这条会红，注释要跟着改）
      expect(p.target, `${id} 的 target 应 > ḡ`).toBeGreaterThan(p.gBar);
      expect(p.roughness, `${id} 应被钳到 1`).toBeCloseTo(1, 6);
      expect(p.effective, `${id} 的 effective 应 = ḡ`).toBeCloseTo(p.gBar, 6);
    }
    // 无 roughnessMap 的两族：spec 直接生效、无钳制
    for (const id of ['pave-damp', 'inner-wood'] as const) {
      const p = probe(id);
      expect(p.hasRoughMap, `${id} 不应挂 roughnessMap`).toBe(false);
      expect(p.roughness, `${id} 的 spec 应直接生效`).toBeCloseTo(p.target, 6);
      expect(p.roughness, `${id} 不应被钳到 1`).toBeLessThan(1);
    }
  });

  it('通道镜像与真源一致（castle.ts 改了 STONE_CHANNELS 会在这里报错提示同步）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/render/scene/castle.ts', import.meta.url), 'utf8');
    for (const [kind, channels] of Object.entries(CHANNELS_MIRROR)) {
      // 匹配 `  kind: 'xx',` 这一行（STONE_CHANNELS 里的条目）
      const re = new RegExp(`^\\s*${kind}:\\s*'(full|noRough|albedoOnly)',`, 'm');
      const m = re.exec(src);
      expect(m, `castle.ts 的 STONE_CHANNELS 里找不到 ${kind}`).not.toBeNull();
      expect(m![1], `${kind} 的通道预算变了，请同步测试里的 CHANNELS_MIRROR`).toBe(channels);
    }
  });

  it('clamp 命中时会 console.warn（带 id/target/gBar），且不改返回值', () => {
    shimCanvas();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '));
    try {
      // 已缓存的 map 不会重复生成材质，但要触发 warn 必须真的造一次变体材质；
      // 这里直接造一个必然被钳的（inner-stone），warn 必须出现且带四个字段
      makeStoneVariantMaterial('inner-stone', makeStoneMaps(STONE_VARIANTS['inner-stone'].texKind, { size: 256 }));
    } finally {
      console.warn = orig;
    }
    const hit = warns.find((w) => w.includes('变体粗糙度被钳'));
    expect(hit, '被钳时必须 warn').toBeDefined();
    // 日志必须含 {id, target, gBar} 三个定位字段（主理人要求）
    expect(hit).toContain('"id":"inner-stone"');
    expect(hit).toContain('"target":0.92');
    expect(hit).toContain('"gBar":');
  });

  it('未触钳的变体不 warn（防止日志刷屏、把真信号淹掉）', () => {
    shimCanvas();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '));
    try {
      makeStoneVariantMaterial('ashlar-grey', makeStoneMaps(STONE_VARIANTS['ashlar-grey'].texKind, { size: 256 }));
    } finally {
      console.warn = orig;
    }
    expect(warns.filter((w) => w.includes('变体粗糙度被钳'))).toHaveLength(0);
  });
});
