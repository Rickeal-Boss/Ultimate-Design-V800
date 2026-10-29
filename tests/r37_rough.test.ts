/**
 * R37 P2-8 + **R39 P1** · 石材变体**有效粗糙度**回归（不是断言 spec 值）。
 *
 * ── 为什么必须断 effective 而不是 spec ────────────────────────────────────────
 * `variantRoughness(target, ḡ)` 为了抵消 roughnessMap 均值 ḡ 的乘法，返回 `target / ḡ`；
 * 但 `material.roughness` **上限是 1** ⇒ 只要 `target > ḡ`，结果被 `min(1,·)` 钳住，
 * 该材质的 **effective = roughness × ḡ 恒等于 ḡ**，spec 里写的 target **完全不生效**。
 *
 * ── R39 现状：**5 档全部真生效**（旧「被钳登记表」已作废）─────────────────────
 * | 变体         | 族      | ḡ(1024 运行尺寸) | spec.rough | raw=target/ḡ | material.roughness | effective |
 * |--------------|---------|------------------|------------|--------------|--------------------|-----------|
 * | inner-stone  | ashlar  | 0.834367         | **0.83**   | 0.9948       | 0.994766           | **0.83**  |
 * | ashlar-grey  | ashlar  | 0.834367         | 0.80       | 0.9588       | 0.958811           | **0.80**  |
 * | gilded-aged  | gold    | 0.503534         | **0.45**   | 0.8937       | 0.893684           | **0.45**  |
 * | pave-damp    | floor   | 0.475118         | 0.80       | —（无 roughMap）| 0.8             | **0.80**  |
 * | inner-wood   | wood    | 0.832993         | 0.82       | —（无 roughMap）| 0.82            | **0.82**  |
 * （ḡ 为 1024² 运行尺寸实测；本文件用 256² 口径，ashlar ḡ=0.848889，结论同向。）
 *
 * R39 改的两档：inner-stone 0.92→**0.83**、gilded-aged 0.55→**0.45**（都降到 ≤ḡ ⇒ 脱离钳制）。
 * ⚠ inner-stone 为什么不是 0.80：0.80 恰好等于 ashlar-grey ⇒ 两支 effective **再次归一**，
 *   正是 R37 修掉的那个 bug；0.83 与 0.80 差 **0.030**，保住本文件的核心判据（≥0.03）。
 * ⚠ floor / wood 两族是 'noRough' 通道 ⇒ **没有 roughnessMap** ⇒ 既不反算也不钳，
 *   spec.rough 直接生效（pave-damp 0.8 / inner-wood 0.82 一直是真生效的；
 *   R37 台账里「pave-damp 被钳成 0.4751」是误用 `makeStoneMaps` 默认 channels='full' 的旧读）。
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

/**
 * 与生产同源：拿到该变体的材质实例 + 该族图集的 ḡ。
 *
 * ⚠⚠ **R39 修正（这个 helper 原来算错了，是「pave-damp 被钳」这条假账的第二个来源）**：
 *   `effective = material.roughness × ḡ` 只在**挂了 roughnessMap** 时成立；
 *   而 `noRough` 通道的族（floor / wood）**没有 roughnessMap** ⇒ 渲染时
 *   `effective = material.roughness`（不乘 ḡ）。
 *   改前这里无条件乘 ḡ ⇒ pave-damp（0.8，floor 无图）被算成 0.8×0.4751 = **0.380**，
 *   于是「effective 0.4751 ≠ 0.8 ⇒ 被钳」这个结论其实是**量法错**，不是真被钳。
 *   （R37 台账的「pave-damp 被钳」= ①误用 makeStoneMaps 默认 channels='full' +
 *     ②这个 helper 无条件乘 ḡ，双重错；生产侧一直是 0.8 真生效。）
 */
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
  const hasRoughMap = maps.roughnessMap !== null;
  return {
    target: v.rough,
    gBar,
    roughness: mat.roughness,
    // 铁律 34：只有挂图的才乘 ḡ；无图 ⇒ effective 就是 material.roughness
    effective: hasRoughMap ? mat.roughness * gBar : mat.roughness,
    hasRoughMap
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
    // ② 两支的 effective 都必须落在 spec 目标 ±1e-3（这条才真正反映"生效"）
    expect(grey.effective).toBeCloseTo(grey.target, 3);
    expect(inner.effective).toBeCloseTo(inner.target, 3);
    // ③ 两支都**未**被钳：material.roughness < 1（R39：inner 0.92→0.83 后脱离钳制）
    expect(grey.roughness).toBeLessThan(1);
    expect(inner.roughness).toBeLessThan(1);
    // ④ 真生效的充要条件：target/ḡ ≤ 1（被钳时 raw > 1 ⇒ material.roughness 卡 1）
    expect(grey.target / grey.gBar).toBeLessThanOrEqual(1);
    expect(inner.target / inner.gBar).toBeLessThanOrEqual(1);
    // ⑤ ★核心：两支 effective **必须不同**，差值 ≥0.03
    //   （R37 修前两支都是 0.848889、差 0 ⇒ 这条会红，正是它逃过审查的原因；
    //     R39 若把 inner 也设成 0.80 会再次归一 ⇒ 同样会红，故 inner 取 0.83）
    //   实测差 0.030。用 0.029 吸收浮点（0.83−0.80 = 0.030000000000000027）
    expect(Math.abs(inner.effective - grey.effective)).toBeGreaterThanOrEqual(0.029);
  });

  it('全族逐档状态与登记一致（R39：**5/5 真生效，无任何一档靠"被钳"活着**）', () => {
    shimCanvas();
    /* 只有**挂了 roughnessMap 且 target > ḡ** 的才被钳。
     * ⚠ floor / wood 两族是 'noRough' 通道 ⇒ **没有 roughnessMap** ⇒ 既不反算也不钳，
     *   spec.rough 直接生效（pave-damp 0.8 / inner-wood 0.82 一直是真生效的；
     *   R37 台账里「pave-damp 被钳成 0.4751」是误用 makeStoneMaps 默认 channels='full' 的旧读）。 */
    const EXPECTED: Record<StoneVariantId, { hasRoughMap: boolean; target: number }> = {
      'inner-stone': { hasRoughMap: true, target: 0.83 },
      'ashlar-grey': { hasRoughMap: true, target: 0.8 },
      'gilded-aged': { hasRoughMap: true, target: 0.45 },
      'pave-damp': { hasRoughMap: false, target: 0.8 },
      'inner-wood': { hasRoughMap: false, target: 0.82 }
    };
    for (const [id, exp] of Object.entries(EXPECTED) as [
      StoneVariantId,
      { hasRoughMap: boolean; target: number }
    ][]) {
      const p = probe(id);
      expect(p.hasRoughMap, `${id} 的通道挂载与登记不符`).toBe(exp.hasRoughMap);
      expect(p.target, `${id} 的 spec 目标变了（要改就同步这张登记表）`).toBeCloseTo(exp.target, 6);
      if (p.hasRoughMap) {
        // target 必须 ≤ ḡ —— 这是"真生效"的充要条件（> ḡ 会退化成 ḡ）
        expect(p.target, `${id} 的 target 应 ≤ ḡ（否则退化成 ḡ）`).toBeLessThanOrEqual(p.gBar + 1e-9);
        expect(p.roughness, `${id} 不应被钳到 1`).toBeLessThan(1);
      }
      expect(p.effective, `${id} 的 effective 应等于 target（真生效）`).toBeCloseTo(p.target, 3);
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

  it('R39：无钳制 ⇒ 全 5 档造材质都不 warn（日志零噪声，真信号不会被淹）', () => {
    shimCanvas();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '));
    try {
      // R37 时 inner-stone / gilded-aged 各会打一条（target > ḡ）；R39 两档降到 ≤ḡ 后应彻底静默。
      // ⚠ 必须按**生产通道**取图（CHANNELS_MIRROR）：默认 channels='full' 会给 floor/wood
      //   也挂上 roughMap，那样测的就不是生产路径（pave-damp 会因 0.8 > ḡ 0.4751 假 warn）。
      for (const id of Object.keys(STONE_VARIANTS) as StoneVariantId[]) {
        const texKind = STONE_VARIANTS[id].texKind;
        makeStoneVariantMaterial(id, makeStoneMaps(texKind, { size: 256, channels: CHANNELS_MIRROR[texKind] ?? 'full' }));
      }
    } finally {
      console.warn = orig;
    }
    // ⚠ 这条红了 ⇒ 有人把某档 target 抬回 >ḡ（该档会静默失效）。别把 warn 当噪声删。
    expect(warns.filter((w) => w.includes('变体粗糙度被钳'))).toEqual([]);
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
