/**
 * R167 · 全局环境光线：fill/rim 人工光进一步收敛 + 物理天空环境托底 + exposure 补偿。
 *
 * 背景：R163 重平衡直射（sun 2.6→1.5 / hemi 0.34→0.55 / fill 0.7→0.5 / rim 1.05→0.6），
 * R164 重平衡 PMREM 柔光板，R166 软阴影边。最后残留的「人工」元素是 fill/rim 两盏
 * DirectionalLight —— 真实暴风没有独立 fill/rim，天空散射本身就是 fill。
 * R167 收敛：fill 0.5→0.42 / rim 0.6→0.5 / hemi 0.55→0.6（托住阴影侧防掉黑），
 * exposure 0.85→0.88 补偿（R163→R164 实测暗 ~2.5%，目标拉回 R163 物理亮度，mean L≈112-118）。
 *
 * 形态：environment.ts 无 window/DOM（纯常量，node 可直导，同 r163）；Renderer.ts 是
 * 源码结构契约（readFileSync，同 r162/r166）。
 *
 * 判据：
 *   ① ACTIVE_ENV：fill 0.42 / rim 0.5 / hemi 0.6（R167 收敛值）；
 *   ② Renderer 源码 exposure 0.88（R167 补偿值）；
 *   ③ environment.ts 带 R167 注释（fill/rim 收敛 + hemi 托底 rationale）；
 *   ④ 红线零改：sun 1.5 / 柔光板 R164 增益（0.95 / 0.8）/ 云量 0.85 / fog 密度不变；
 *   ⑤ 平衡合理性：hemi/fill/rim ∈ (0,1)，hemi 0.6 > fill 0.42（物理环境主导）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIVE_ENV } from '../src/config/environment';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const envSrc = src('src/config/environment.ts');
const rendererSrc = src('src/render/Renderer.ts');

describe('R167 ① · fill/rim/hemi 收敛值', () => {
  it('fill 0.5→0.42 / rim 0.6→0.5 / hemi 0.55→0.6', () => {
    expect(ACTIVE_ENV.fill.intensity).toBe(0.42);
    expect(ACTIVE_ENV.rim.intensity).toBe(0.5);
    expect(ACTIVE_ENV.hemi.intensity).toBe(0.6);
  });
});

describe('R167 ② · exposure 补偿', () => {
  it('Renderer 源码 exposure = 0.88（补偿 fill/rim 收敛）', () => {
    expect(rendererSrc).toContain('renderer.toneMappingExposure = 0.88;');
  });
});

describe('R167 ③ · R167 注释（fill/rim 收敛 + hemi 托底）', () => {
  it('environment.ts 带 R167 注释', () => {
    expect(envSrc).toMatch(/R167/);
  });

  it('注释含 fill/rim 收敛 rationale', () => {
    expect(envSrc).toContain('fill 进一步收敛');
    expect(envSrc).toContain('rim 进一步收敛');
  });

  it('注释含 hemi 托底（防 fill/rim 退场后暗部掉黑）', () => {
    expect(envSrc).toContain('托底');
  });
});

describe('R167 ④ · 红线零改：sun / 柔光板 / 云量 / fog', () => {
  it('sun.intensity 仍 1.5（R163 主光收敛值不动）', () => {
    expect(ACTIVE_ENV.sun.intensity).toBe(1.5);
  });

  it('柔光板 R164 增益不变（softbox[0]=0.95 顶板 / softbox[3]=0.8 地面反弹）', () => {
    expect(ACTIVE_ENV.softbox[0].gain).toBe(0.95);
    expect(ACTIVE_ENV.softbox[3].gain).toBe(0.8);
  });

  it('sky.cloudAmount 仍 0.85（暴风云量）', () => {
    expect(ACTIVE_ENV.sky.cloudAmount).toBe(0.85);
  });

  it('fog.density 不变（12e-5）', () => {
    expect(ACTIVE_ENV.fog.density).toBe(12e-5);
  });
});

describe('R167 ⑤ · 平衡合理性（物理环境主导）', () => {
  it('hemi/fill/rim 全部在 (0,1) 内', () => {
    const vals = [ACTIVE_ENV.hemi.intensity, ACTIVE_ENV.fill.intensity, ACTIVE_ENV.rim.intensity];
    for (const v of vals) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('hemi 0.6 > fill 0.42（物理天空环境占主导，fill 只是微抬）', () => {
    expect(ACTIVE_ENV.hemi.intensity).toBeGreaterThan(ACTIVE_ENV.fill.intensity);
  });
});
