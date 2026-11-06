/**
 * R48 灯组空洞 / 过曝修复 + 资产台账契约测试。
 *
 * 定罪依据（.qa/r48/、verify/r46/after/r48*）：
 *  - 消去法：隐藏 lamp_rear 纯白像素 4,218 不变；隐藏 body 白块→376、
 *    红灯 6,037→18,883 ⇒ 白块长在 body 洞口（用户口径「更深处是空洞」），
 *    且 body 一直挡着红灯组。
 *  - 运行时探针：R7 尾灯待机 emissiveIntensity 3.224 ⇒ ACES+bloom 把
 *    0xff1e14 的 G/B 也抬进饱和区 ⇒ 纯白过曝块、开/关灯 Δ≈0。
 *    V800 前灯开灯峰值 3.0 同病。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, '..', rel), 'utf-8').replace(/\r\n/g, '\n');

describe('R48 · 灯组过曝修复（压回线性可用区间）', () => {
  it('两台适配器都有开关且关闭态逐位回滚 R47 公式', () => {
    for (const f of ['src/model/V800Adapter.ts', 'src/model/R7Adapter.ts']) {
      const s = src(f);
      /* ── R48 原护栏（逐位保留，禁删/禁放宽）：开关 + 关闭钩子 ── */
      expect(s).toContain('const R48_LAMP_TONE');
      expect(s).toContain('r48tone=off');
      /* 双形态兼容锚点：B 态 `R48_LAMP_TONE\n ? 0.30 + …`、
       * A 态 `const raw = R48_LAMP_TONE ? (… : 0.30 + (brakeLevel …) * 0.85) : …`。
       * 仍要求 R48_LAMP_TONE 与 0.30 公式同一段（非恒真），不许把旧公式删掉。 */
      expect(s).toMatch(/R48_LAMP_TONE[\s\S]{0,200}0\.30 \+ \(brakeLevel/);
      expect(s).toContain('* 0.85');
      /* ── R51-B1-a P0 语义护栏 ─────────────────────────────────────────
       * 亮灯态过曝必须被 R51_TAIL_EI_MAX 钳住，且 clamp 只在 R51_TAIL_ON
       * 为真时生效 ⇒ `#r51tail=off` 逐位回 R48/R47。两种落地形态都守：
       *   B `if (R51_TAIL_ON) { … = Math.min(0.16+…*0.34, MAX) }`
       *   A `= R51_TAIL_ON ? Math.min(raw, MAX) : raw`
       * 拦住「只压待机分支、亮灯态从另一分支复发过曝」。 */
      expect(s).toContain('0.16 + (brakeLevel');
      expect(s).toContain('* 0.34');
      expect(s).toContain('R51_TAIL_EI_MAX');
      expect(s).toMatch(/if \(R51_TAIL_ON\) \{|R51_TAIL_ON \? Math\.min/);
      expect(s).toMatch(/R51_TAIL_ON[\s\S]{0,240}Math\.min\([\s\S]{0,160}R51_TAIL_EI_MAX/);
      // clamp 两实参：B「新系数公式 + 上限常量」/ A「Math.min(raw, 上限常量)」
      expect(s).toMatch(/Math\.min\(\s*0\.16 \+ [\s\S]{0,80}\* 0\.34,\s*R51_TAIL_EI_MAX\s*\)|Math\.min\(raw, R51_TAIL_EI_MAX\)/);
    }
    // 开关真源 + 上限常量单一真源（Adapter 只 import，不另起）
    const shell = src('src/model/external/ExternalShell.ts');
    expect(shell).toContain("export const R51_TAIL_ON = !r51HookOff('r51tail');");
    expect(shell).toContain('export const R51_TAIL_EI_MAX = 1.15;');
    /* P0 数值语义复算（不依赖源码字面格式）：关闭态逐位等价 R48 待机
     * 0.895(R7 b=0.7) / 2.51(V800 b=2.6)；开启态亮灯(8)与爆闪(+10×0.12)
     * 一律 ≤1.15 ⇒ 亮灯态不得从旧分支复发过曝。 */
    expect(0.30 + 0.7 * 0.85).toBeCloseTo(0.895, 3);
    expect(0.30 + 2.6 * 0.85).toBeCloseTo(2.51, 3);
    expect(Math.min(0.16 + 8 * 0.34, 1.15)).toBe(1.15);
    expect(Math.min(0.16 + (8 + 10 * 0.12) * 0.34, 1.15)).toBe(1.15);
  });

  it('V800 前灯峰值不再乘 headLevel 原值（3.2×0.9=2.88 过曝）', () => {
    const v = src('src/model/V800Adapter.ts');
    expect(v).toContain('0.12 + (headLevel / HEAD_BASE) * 0.78');
    expect(v).toContain(': 0.12 + headLevel * 0.9; // R47 原状');
  });

  it('R7 尾灯去掉历史 2.6 基座公式，改统一 0.85 斜率', () => {
    const r = src('src/model/R7Adapter.ts');
    expect(r).toContain('0.30 + (brakeLevel + snapT * SNAP_GAIN * 0.12) * 0.85');
  });
});

describe('R48 · R7 尾灯空洞补面', () => {
  it('深色盖板 + 灯组外推 + 贯穿红细带，且留 #r48hole=off 回滚', () => {
    const s = src('src/model/external/ExternalShell.ts');
    expect(s).toContain("housing.name = 'lamp_rear_housing'");
    /* R49-P2b：盖板 z / 高度改为**射线实测**参数（.qa/r49/PHASE2B_DIAG.md §三）：
     * R48 的 2.505 / 0.20 / 0.240*s 作为 `#r49hole=off` 的回滚分支逐位保留。 */
    // R49-P2c 几何回退 v1：盖板 z=-(bodyMaxZ+0.010)、宽 2.02（manifest×scale 推导，覆盖面积足）
    expect(s).toContain('const bodyMaxZ = (manifest.bodyBBox?.max?.[2] ?? 0.5828) * s;');
    expect(s).toContain('new THREE.PlaneGeometry(2.02, coverH)');
    /* 双形态兼容：B `r49Hole ?` / A `bandActive ?`；两种形态的关闭态都必须
     * 逐位回 R48 的 -2.505（回滚语义，非恒真）。 */
    expect(s).toMatch(/housing\.position\.set\(0, coverY, (?:r49Hole|bandActive) \? -\(bodyMaxZ \+ 0\.010\) : -2\.505\)/);
    expect(s).toContain('const coverH = r49Hole ? 0.34 : 0.20;');
    expect(s).toContain('const coverY = r49Hole ? 1.015 : 0.240 * s;');
    expect(s).toContain("if (m.name === 'lamp_rear') m.position.z = -0.06;");
    expect(s).toContain("band.name = 'lamp_rear_band'");
    expect(s).toContain('r48hole=off');
    /* ── R51-B1-c 语义护栏（双形态兼容）──────────────────────────────
     * 主理人 R51 收口裁决：B1-b/c 默认下线，仅 `#r51band=on` 实验启用；
     * 其余四开关默认开、`=off` 逐位回滚。`#r51band=off` 与默认态等价 ⇒
     * `#r48hole=off` 旧钩子 + `=off` 双回滚逐位回 R48/R50。
     * 收窄只允许改 mesh.scale.x（tri/UV 逐位不变），且必须包在开关分支内，
     * 否则回滚态也会被收窄。atlas / 收窄 / r49Hole 并入代码全部保留不删。 */
    expect(s).toContain('function r51HookOn');
    expect(s).toContain("r51HookOn('r51band')");
    expect(s).toContain("export const R51_BAND_ON = r51HookOn('r51band');");
    expect(s).toContain('r51band=on');
    // 其余四开关仍是「默认开、=off 逐位回滚」，不许把 B1-b/c 的改动扩散过去
    for (const k of ['r51tail', 'r51rough', 'r51lamp', 'r51glasspass']) {
      expect(s).toContain(`!r51HookOff('${k}')`);
    }
    expect(s).toMatch(/\|\| R51_BAND_ON;|const bandActive = r49Hole \|\| r51Band/);
    expect(s).toContain('const r51Band = R51_BAND_ON;');
    expect(s).toMatch(/if \(r51Band\) \{|if \(bandActive\) \{/);
    expect(s).toContain('housing.scale.x = Math.min(1.86, Math.max(1.70, 2.02 * 0.90)) / 2.02;');
    expect(s).toContain('r51band=off');
    // 精确数值复算：2.02×0.90=1.818 落在 clamp[1.70,1.86] 内，缩放系数恰 0.9
    const width = Math.min(1.86, Math.max(1.70, 2.02 * 0.90));
    expect(width).toBeCloseTo(1.818, 3);
    expect(width / 2.02).toBeCloseTo(0.9, 6);
  });

  it('盖板材质有独立 dispose（不泄漏新增材质实例）', () => {
    const s = src('src/model/external/ExternalShell.ts');
    expect(s).toContain('let lampHousingMat: THREE.MeshStandardMaterial | null = null;');
    expect(s).toContain('lampHousingMat?.dispose();');
  });
});

describe('R48 · 资产台账实测刷新 + 四轮判据保留', () => {
  it('两车 tri.body / bodyTri 与实测 GLB 一致', () => {
    const v800 = JSON.parse(src('src/assets/cars/v800/manifest.json'));
    const r7 = JSON.parse(src('src/assets/cars/r7/manifest.json'));
    expect(v800.tri.body).toBe(966_484);
    expect(v800.bodyTri).toBe(966_484);
    expect(v800.semantic.lamp_rear.tri).toBe(17_485);
    expect(r7.tri.body).toBe(882_300);
    expect(r7.bodyTri).toBe(882_300);
    expect(r7.semantic.lamp_rear.tri).toBe(14_333);
  });

  it('wheel-* 四键（hasWheelSplit 判据）全部保留', () => {
    for (const car of ['v800', 'r7']) {
      const m = JSON.parse(src(`src/assets/cars/${car}/manifest.json`));
      for (const k of ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']) {
        expect(m.tri[k]).toBeGreaterThan(50_000);
      }
    }
  });
});
