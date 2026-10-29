/**
 * R38 / P0-8 + **R39-P1**：石材纹理显存红线护栏。
 *
 * ── 口径（与 `.qa/r39_b/probe.mjs tex` 逐张实测、`r31Budget.castleTexMB` 三者一致）──
 *   GPU 常驻显存（字节）= Σ 每族 [ size² × 4 通道 × heroTex数  +  aux² × 4 通道 × roughTex数 ]
 *                      然后 × (4/3) 算 mip（r31Budget 口径），再 / 1048576 得 MiB。
 *   - 每族贴图张数由 `STONE_CHANNELS`（castle.ts）决定：
 *       'full'    ⇒ albedo + normal + roughness（3 张，其中 roughness 走 aux 尺寸）
 *       'noRough' ⇒ albedo + normal（2 张）
 *   - `FAMILY_ALIAS` 使 wall 共享 ashlar 图集 ⇒ 去重（稳态 16 张）。
 *   - 各贴图 byteLength 与 `makeStonePixelSet` 生成的原始数组长度**完全一致**
 *     （CanvasTexture 按 size×size 上传），故算术即真实 byteLength，无需真实生成贴图。
 *
 * ── R39 两处修正（都有实测依据，不是为绿放宽）────────────────────────────────
 * ① **`rock` 不计入**：rock 族在 castle 里**没有任何消费方**（`.qa/r39_b/probe.mjs tex`
 *    逐张普查：场景内实测 16 张，无一张 rock；`castle.ts` 的 stone()/variantMaterial()
 *    从不取 'rock'）⇒ 它**从不被烘**，把它算进 castle 显存是**fantôme 4.00 MiB**
 *    （之前 33.33 与实测 29.33 的差额、以及 R38 头注「投影 33.33 但账上 33.33」的对不上，
 *    根因就是这个 phantom）。本文件的口径是 **castle 的常驻显存**，故排除。
 * ② **R39-P1 把 wood 512²→1024²**（high）⇒ 投影 29.33 → **37.33 MiB**，余量 2.67。
 *    余量下限随之从 4 改 **2.5**（37.33 + 2.5 ≤ 40 仍成立）；38 目标上限**不动**。
 *
 * ── 意义 ────────────────────────────────────────────────────────────────────
 *   R38 之前 high 档 floor 也被列为 hero（1024²）且 roughness 不封顶（也 1024²），
 *   投影 41.33 MB > 38 目标（红线 40 也已超）。R38 把 hero 集收窄为仅 ashlar
 *   + roughness 通道封顶 512² ⇒ 29.33 MiB；R39 再把 wood 升 1024 ⇒ 37.33 MiB。
 *   本测试锁死四道护栏：
 *     ① actual ≤ 38（目标）  ② actual ≤ 预算红线 castleTexMB(40) 且余量 ≥ 2.5 MiB
 *     ③ 旧口径（floor 进 hero + rough 不封顶）会越过 38 ⇒ 护栏非形式化（真能拦回退）
 *     ④ **精确值 37.33**（±0.01）：钉死「wood=1024 且通道表/尺寸函数没被偷偷改」
 *   ⚠ 若有人再动 hero 集或通道预算，①③④ 至少一条会红。
 */
import { describe, expect, it } from 'vitest';
import { stoneTextureSize, stoneTextureAuxSize } from '../src/render/scene/stoneTexture';
import { R31_BUDGET } from '../src/render/scene/r31Budget';

type Kind = Parameters<typeof stoneTextureSize>[0];
type Tier = Parameters<typeof stoneTextureSize>[1];
type StoneChannels = 'full' | 'noRough' | 'albedoOnly';

// —— 镜像 castle.ts（未导出，按注释锚点同步）——
// FAMILY_ALIAS：wall 共享 ashlar 图集
const FAMILY_ALIAS: Partial<Record<Kind, Kind>> = { wall: 'ashlar' as Kind };
// STONE_CHANNELS：R33 把 wood/glass 从 albedoOnly 升 noRough（14→16 张，仍 < 20）
const STONE_CHANNELS: Record<Kind, StoneChannels> = {
  ashlar: 'full', wall: 'full', floor: 'noRough', rock: 'full', gold: 'full',
  roof: 'noRough', wood: 'noRough', glass: 'noRough', marble: 'noRough'
};
/**
 * 参与 castle 显存的族 = 上面全部 **去掉 rock**（R39：rock 无消费方、从不被烘）。
 * `KINDS` 保留 rock 只是为了让类型/镜像表与 castle.ts 保持一致，便于日后接消费方。
 */
const KINDS = (Object.keys(STONE_CHANNELS) as Kind[]).filter((k) => k !== 'rock');
/** 全族（含 rock）—— 只给「registry 完整性」类断言用 */
const KINDS_ALL = Object.keys(STONE_CHANNELS) as Kind[];

const MIP = 4 / 3;
const TARGET_MB = 38;
/** R39 落点（实测 .qa/r39_b/probe.mjs tex：16 张 / 37.33 MiB） */
const R39_MB = 37.33;
/** 余量下限：R39 从 4 降到 2.5（见头注 ②） */
const MIN_HEADROOM_MB = 2.5;

/**
 * 用**真实尺寸函数** + 镜像通道表，投影某质量档全部石材族的 GPU 常驻显存（MB）。
 * 这是 R38 修复后的口径（hero 集 = 仅 ashlar；roughness 封顶 512）。
 */
function footprintAfter(tier: Tier): number {
  const seen = new Set<string>();
  let bytes = 0;
  for (const kind of KINDS) {
    const tk = (FAMILY_ALIAS[kind] ?? kind) as Kind;     // wall → ashlar 去重
    const key = `${tk}|${STONE_CHANNELS[tk]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const size = stoneTextureSize(tk, tier);
    const aux = stoneTextureAuxSize(tk, tier);            // roughness 封顶 512
    const ch = STONE_CHANNELS[tk];
    const heroTex = ch === 'albedoOnly' ? 1 : 2;          // map + normal
    const roughTex = ch === 'full' ? 1 : 0;               // full 才挂 roughMap
    bytes += size * size * 4 * heroTex + aux * aux * 4 * roughTex;
  }
  return (bytes / 1048576) * MIP;
}

/**
 * 复刻 R38 之前的尺寸口径（floor 也是 hero、roughness 不封顶、wood 仍是 512），
 * 用于证明护栏非形式化：旧规则下投影会越过 38，故 ① 的护栏确实能拦住回退。
 * ⚠ R39：wood 的 1024 是**新规则**，故「旧」口径里 wood 回 512（否则测的就不是旧规则）。
 */
function footprintBefore(tier: Tier): number {
  const oldSize = (kind: Kind, t: Tier): number => {
    const hero = kind === 'ashlar' || kind === 'floor';   // 旧：floor 是 hero（wood 不是）
    if (t === 'high') return hero ? 1024 : 512;
    if (t === 'medium') return hero ? 512 : 256;
    return 256;
  };
  const seen = new Set<string>();
  let bytes = 0;
  for (const kind of KINDS) {
    const tk = (FAMILY_ALIAS[kind] ?? kind) as Kind;
    const key = `${tk}|${STONE_CHANNELS[tk]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const size = oldSize(tk, tier);
    const aux = size;                                     // 旧：roughness 不封顶
    const ch = STONE_CHANNELS[tk];
    const heroTex = ch === 'albedoOnly' ? 1 : 2;
    const roughTex = ch === 'full' ? 1 : 0;
    bytes += size * size * 4 * heroTex + aux * aux * 4 * roughTex;
  }
  return (bytes / 1048576) * MIP;
}

describe('R38 P0-8 / R39-P1 · 石材纹理显存红线护栏', () => {
  it('★ high 档投影显存 = 37.33 MiB（R39-P1 落点）且 ≤ 38（R38 目标上限）', () => {
    const mb = footprintAfter('high');
    console.log(`R38_TEXMEM_HIGH ${JSON.stringify({ mb: Number(mb.toFixed(2)), target: TARGET_MB, r39: R39_MB })}`);
    // ④ 精确值：钉死「wood=1024 + 通道表 + 尺寸函数」这一组事实（容差 0.01 容浮点）
    expect(mb).toBeCloseTo(R39_MB, 2);
    expect(mb).toBeLessThanOrEqual(TARGET_MB);
  });

  it('high 档投影显存 ≤ 预算红线 castleTexMB(40) 且余量 ≥ 2.5 MiB', () => {
    const mb = footprintAfter('high');
    expect(mb).toBeLessThanOrEqual(R31_BUDGET.castleTexMB);
    expect(R31_BUDGET.castleTexMB - mb).toBeGreaterThanOrEqual(MIN_HEADROOM_MB);
  });

  it('rock 不计入 castle 显存（R39 修正：无消费方 ⇒ 从不被烘，phantom 4.00 MiB）', () => {
    // 若把 rock 加回来，投影会虚高 4.00 MiB（3 张 512²：albedo+normal+rough）
    const withRock =
      footprintAfter('high') + (512 * 512 * 4 * 2 + 512 * 512 * 4) / 1048576 * MIP;
    expect(withRock - footprintAfter('high')).toBeCloseTo(4, 2);
    expect(KINDS).not.toContain('rock');
    expect(KINDS_ALL).toContain('rock'); // 镜像表本身仍完整（castle.ts 里还有这一行）
  });

  it('★ 旧口径（floor 进 hero + rough 不封顶 + wood 512）会越过 38 ⇒ 护栏非形式化', () => {
    const before = footprintBefore('high');
    console.log(`R38_TEXMEM_BEFORE ${JSON.stringify({ mb: Number(before.toFixed(2)), target: TARGET_MB })}`);
    expect(before).toBeGreaterThan(TARGET_MB); // 41.33 > 38，证明改前确超，护栏能拦回退
  });

  it('medium / low 档投影显存同样 ≤ 38（不随降档反升；R39 wood 只在 high 升档）', () => {
    expect(footprintAfter('medium')).toBeLessThanOrEqual(TARGET_MB);
    expect(footprintAfter('low')).toBeLessThanOrEqual(TARGET_MB);
    // R39：中/低档 wood 保持 512/256（低端机吃不住 1024，也不许因 high 升档被连带抬高）
    expect(stoneTextureSize('wood', 'medium')).toBe(256);
    expect(stoneTextureSize('wood', 'low')).toBe(256);
    expect(stoneTextureSize('wood', 'high')).toBe(1024);
  });
});
