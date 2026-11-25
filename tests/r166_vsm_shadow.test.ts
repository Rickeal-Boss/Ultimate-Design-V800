/**
 * R166 · VSM 软阴影边（云量 0.85 暴风天光下主光阴影边缘应柔）。
 * three r186 移除 PCFSoftShadowMap（无 radius 支持），软边唯一路径 = VSMShadowMap
 * （radius 模糊 + blurSamples）；VSM 已知风险 = 薄遮挡物漏光 ⇒ 小正 bias 抑制。
 *
 * 本护栏钉**源码结构**（readFileSync 源码契约风格同 r162）：
 *  ① Renderer 显式 VSMShadowMap（非 PCFShadowMap）。
 *  ② Lighting 太阳阴影 VSM 参数（radius 6 / blurSamples 12 / bias 0.0002）。
 *  ③ 两文件均带 R166 注释（VSM 软阴影 rationale）。
 *  ④ 红线零改：光强仍 preset 驱动；mapSize / ortho / autoUpdate 不变。
 *  ⑤ 全库无 PCFSoftShadowMap 残留（r186 警告 + 强制回退）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rendererSrc = src('src/render/Renderer.ts');
const lightingSrc = src('src/render/scene/Lighting.ts');

describe('R166 ① · Renderer 用 VSMShadowMap（软边，非 PCF）', () => {
  it('shadowMap.type = THREE.VSMShadowMap', () => {
    expect(rendererSrc).toContain('renderer.shadowMap.type = THREE.VSMShadowMap;');
  });

  it('红线：不再使用 PCFShadowMap', () => {
    expect(rendererSrc).not.toContain('THREE.PCFShadowMap');
  });
});

describe('R166 ② · Lighting 太阳阴影 VSM 参数', () => {
  it('radius = 6（软边模糊幅度）', () => {
    expect(lightingSrc).toContain('sun.shadow.radius = 6;');
  });

  it('blurSamples = 12（VSM 模糊采样数）', () => {
    expect(lightingSrc).toContain('sun.shadow.blurSamples = 12;');
  });

  it('bias = 0.0002（小正 bias 抑制薄遮挡物漏光，非 PCF 的 -4e-4）', () => {
    expect(lightingSrc).toContain('sun.shadow.bias = 0.0002;');
    expect(lightingSrc).not.toContain('sun.shadow.bias = -4e-4;');
  });
});

describe('R166 ③ · R166 注释（VSM 软阴影 rationale）', () => {
  it('Renderer 带 R166 注释', () => {
    expect(rendererSrc).toMatch(/\/\*[\s\S]*?VSM 阴影（R166 软边）[\s\S]*?\*\//);
  });

  it('Lighting 带 R166 注释', () => {
    expect(lightingSrc).toMatch(/R166 · VSM 软阴影：云量 0\.85 暴风天光下主光阴影边缘应柔/);
  });
});

describe('R166 ④ · 红线零改：光强 / mapSize / ortho / autoUpdate', () => {
  it('主光强度仍 preset 驱动（无硬编码强度变更）', () => {
    expect(lightingSrc).toContain('preset.sun.intensity');
    // 不得出现对 sun.intensity 的直接硬编码赋值（除构造行外）
    expect(lightingSrc).not.toMatch(/sun\.intensity\s*=\s*\d/);
  });

  it('mapSize / ortho 仍来自 quality（preset 驱动，非硬编码）', () => {
    expect(lightingSrc).toContain('this.mapSize = quality.shadowMapSize;');
    expect(lightingSrc).toContain('this.ortho = quality.shadowOrtho;');
  });

  it('autoUpdate = true 保留（R39 每帧重绘契约）', () => {
    expect(lightingSrc).toContain('sun.shadow.autoUpdate = true;');
  });
});

describe('R166 ⑤ · 全库无 PCFSoftShadowMap 残留', () => {
  it('Renderer 无 PCFSoftShadowMap（r186 警告 + 强制回退）', () => {
    expect(rendererSrc).not.toContain('PCFSoftShadowMap');
  });
});
