/**
 * R136：perfhud 文本格式化（纯函数）。
 * 钉死「质量档行 = R133-R135 修复的落地可见证据」——用户本机若显示
 * `GPU integrated | msaa 2 | bloom 0.375 | shadow 768 | floor 0.8` 即核显预算生效；
 * 旧逻辑（R132 前）会错误显示 `GPU discrete | msaa 4 | bloom 1`。
 * 本模块只 import type（编译期擦除）⇒ node 下无需 stub window，直接可测。
 */
import { describe, it, expect } from 'vitest';
import { formatPerfHudText, type PerfHudStats } from '../src/ui/perfHud';
import type { QualitySettings } from '../src/config/quality';

/** 构造最小 QualitySettings 夹具（R136 只消费 gpuClass/tier/msaa/bloom/shadow/floor） */
function q(over: Partial<QualitySettings>): QualitySettings {
  return {
    tier: 'high',
    pixelRatio: 1.25,
    minPixelRatio: 0.8,
    antialias: false,
    shadowMapSize: 768,
    shadowOrtho: 10,
    msaaSamples: 2,
    bloom: true,
    bloomScale: 0.375,
    envMapSize: 256,
    carTextureSize: 1024,
    castleTexSyncSize: 256,
    isMobile: false,
    gpuClass: 'integrated',
    ...over
  };
}

const stats: PerfHudStats = { fps: 59, dpr: 0.9, calls: 45, tris: 185042, t: 123.456 };

describe('R136 perfhud 文本格式化', () => {
  it('输出两行：行 1 = 运行时实测，行 2 = 质量档', () => {
    const text = formatPerfHudText(q({}), stats);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    // 行 1：FPS / DPR(2位) / calls / tris / t(1位)
    expect(lines[0]).toContain('FPS 59');
    expect(lines[0]).toContain('DPR 0.90');
    expect(lines[0]).toContain('calls(frame) 45');
    expect(lines[0]).toContain('tris(frame) 185042');
    expect(lines[0]).toContain('t=123.5s');
    // 行 2：质量档
    expect(lines[1]).toContain('GPU integrated');
    expect(lines[1]).toContain('tier high');
    expect(lines[1]).toContain('msaa 2');
    expect(lines[1]).toContain('bloom 0.375');
    expect(lines[1]).toContain('shadow 768');
    expect(lines[1]).toContain('floor 0.8');
  });

  it('R133 核显档（本机 Arc iGPU）显示集成预算，非旧逻辑 discrete/high', () => {
    // 用户本机：Arc 核显 + R133 修复 ⇒ gpuClass=integrated + applyIntegratedBudget 预算
    const text = formatPerfHudText(q({ gpuClass: 'integrated' }), stats);
    expect(text).toContain('GPU integrated');
    expect(text).toContain('msaa 2');
    expect(text).toContain('bloom 0.375');
    expect(text).toContain('shadow 768');
    expect(text).toContain('floor 0.8');
    // 旧逻辑（R132 前）的错值绝不出现在行 2
    expect(text).not.toContain('GPU discrete');
    expect(text).not.toContain('msaa 4');
    expect(text).not.toContain('bloom 1');
  });

  it('离散档（真独显）显示高几何档，不被核显分支污染', () => {
    const text = formatPerfHudText(
      q({ gpuClass: 'discrete', msaaSamples: 4, bloomScale: 1, shadowMapSize: 1024, minPixelRatio: 1 }),
      stats
    );
    expect(text).toContain('GPU discrete');
    expect(text).toContain('msaa 4');
    expect(text).toContain('bloom 1');
    expect(text).toContain('shadow 1024');
    expect(text).toContain('floor 1');
  });

  it('数值边界：DPR/t 格式稳健（0 与负值不崩）', () => {
    const text = formatPerfHudText(q({}), { fps: 0, dpr: 0, calls: 0, tris: 0, t: 0 });
    expect(text).toContain('FPS 0');
    expect(text).toContain('DPR 0.00');
    expect(text).toContain('t=0.0s');
  });
});
