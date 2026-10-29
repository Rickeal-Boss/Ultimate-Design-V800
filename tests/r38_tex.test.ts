/**
 * R38 / P0-8：石材纹理显存红线护栏。
 *
 * ── 口径（与 `_tmp_texmem.mjs` 及 `r31Budget.castleTexMB` 完全一致）──────────────
 *   GPU 常驻显存（字节）= Σ 每族 [ size² × 4 通道 × heroTex数  +  aux² × 4 通道 × roughTex数 ]
 *                      然后 × (4/3) 算 mip（r31Budget 口径），再 / 1048576 得 MB。
 *   - 每族贴图张数由 `STONE_CHANNELS`（castle.ts:587）决定：
 *       'full'    ⇒ albedo + normal + roughness（3 张，其中 roughness 走 aux 尺寸）
 *       'noRough' ⇒ albedo + normal（2 张）
 *   - `FAMILY_ALIAS`（castle.ts:570）使 wall 共享 ashlar 图集 ⇒ 去重（稳态 14 张）。
 *   - 各贴图 byteLength 与 `makeStonePixelSet` 生成的原始数组长度**完全一致**
 *     （CanvasTexture 按 size×size 上传），故算术即真实 byteLength，无需真实生成贴图。
 *
 * ⚠ `STONE_CHANNELS` / `FAMILY_ALIAS` 在 castle.ts **未导出**，此处按行号镜像。
 *   若 castle.ts 改了这两张表，本测试必须同步（注释已标行号），否则护栏会静默失效。
 *   尺寸口径走**真实函数** `stoneTextureSize`（stoneTexture.ts:828）/
 *   `stoneTextureAuxSize`（stoneTexture.ts:842）—— 改尺寸函数本测试必红。
 *
 * ── 意义 ────────────────────────────────────────────────────────────────────
 *   R38 之前 high 档 floor 也被列为 hero（1024²）且 roughness 不封顶（也 1024²），
 *   投影显存 41.33 MB > 38 目标（红线 40 也已超）。本轮把 hero 集收窄为仅 ashlar
 *   + roughness 通道封顶 512²，投影降到 33.33 MB。本测试锁死三道护栏：
 *     ① actual ≤ 38（目标）  ② actual ≤ 预算红线 castleTexMB(40) 且余量 ≥ 4MB
 *     ③ 旧口径（floor 进 hero + rough 不封顶）会越过 38 ⇒ 护栏非形式化（真能拦回退）。
 *   任何回退（floor 重新进 hero / 解除 roughness 封顶 / ashlar 升档）都会让 ① 或 ② 红。
 */
import { describe, expect, it } from 'vitest';
import { stoneTextureSize, stoneTextureAuxSize } from '../src/render/scene/stoneTexture';
import { R31_BUDGET } from '../src/render/scene/r31Budget';

type Kind = Parameters<typeof stoneTextureSize>[0];
type Tier = Parameters<typeof stoneTextureSize>[1];
type StoneChannels = 'full' | 'noRough' | 'albedoOnly';

// —— 镜像 castle.ts（未导出，按行号同步）——
// FAMILY_ALIAS（castle.ts:570）：wall 共享 ashlar 图集
const FAMILY_ALIAS: Partial<Record<Kind, Kind>> = { wall: 'ashlar' as Kind };
// STONE_CHANNELS（castle.ts:587–599）：R33 把 wood/glass 从 albedoOnly 升 noRough（14→16 张，仍 < 20）
const STONE_CHANNELS: Record<Kind, StoneChannels> = {
  ashlar: 'full', wall: 'full', floor: 'noRough', rock: 'full', gold: 'full',
  roof: 'noRough', wood: 'noRough', glass: 'noRough', marble: 'noRough'
};
const KINDS = Object.keys(STONE_CHANNELS) as Kind[];

const MIP = 4 / 3;
const TARGET_MB = 38;

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
 * 复刻 R38 之前的尺寸口径（floor 也是 hero、roughness 不封顶），用于证明护栏非形式化：
 * 旧规则下投影会越过 38，故 ① 的护栏确实能拦住回退。
 */
function footprintBefore(tier: Tier): number {
  const oldSize = (kind: Kind, t: Tier): number => {
    const hero = kind === 'ashlar' || kind === 'floor';   // 旧：floor 是 hero
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

describe('R38 P0-8 · 石材纹理显存红线护栏', () => {
  it('★ high 档投影显存 ≤ 38 MB（R38 目标上限）', () => {
    const mb = footprintAfter('high');
    console.log(`R38_TEXMEM_HIGH ${JSON.stringify({ mb: Number(mb.toFixed(2)), target: TARGET_MB })}`);
    expect(mb).toBeLessThanOrEqual(TARGET_MB);
  });

  it('high 档投影显存 ≤ 预算红线 castleTexMB(40) 且余量 ≥ 4MB', () => {
    const mb = footprintAfter('high');
    expect(mb).toBeLessThanOrEqual(R31_BUDGET.castleTexMB);
    expect(R31_BUDGET.castleTexMB - mb).toBeGreaterThanOrEqual(4);
  });

  it('★ 旧口径（floor 进 hero + rough 不封顶）会越过 38 ⇒ 护栏非形式化', () => {
    const before = footprintBefore('high');
    console.log(`R38_TEXMEM_BEFORE ${JSON.stringify({ mb: Number(before.toFixed(2)), target: TARGET_MB })}`);
    expect(before).toBeGreaterThan(TARGET_MB); // 41.33 > 38，证明改前确超，护栏能拦回退
  });

  it('medium / low 档投影显存同样 ≤ 38（不随降档反升）', () => {
    expect(footprintAfter('medium')).toBeLessThanOrEqual(TARGET_MB);
    expect(footprintAfter('low')).toBeLessThanOrEqual(TARGET_MB);
  });
});
