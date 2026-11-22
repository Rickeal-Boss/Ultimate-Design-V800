import { beforeAll, describe, expect, it, vi } from 'vitest';

type GpuClass = 'discrete' | 'integrated' | 'software' | 'unknown';
let classifyGpuByName: (raw: string) => GpuClass;
let detectGpuClass: () => GpuClass;

/**
 * R133 · Intel Arc 核显误判为独显的修复（承 R43 像素预算）。
 *
 * 病根（本机实锤）：`Intel(R) Arc(TM) Graphics`（Core Ultra 5 125H 核显）被旧式
 * `intel && !arc` 排除 ⇒ 落回 'discrete' ⇒ 核显跑 high 档（MSAA4 + bloom1 +
 * shadow1024 + 画布 antialias），填充率必然越 vsync 预算。用户机型正是此配置，
 * 「性能优化」的真实杠杆就在这——修好后核显走 `applyIntegratedBudget`
 * （msaa2 / bloom0.5 / shadow768 / pixelRatio≤1.25 / 下限0.85）。
 *
 * 纯函数 `classifyGpuByName` 不依赖 DOM，可逐串钉死分类表；`detectGpuClass`
 * 只做 WebGL 上下文读取后委托给它。quality.ts 顶层 `TIERS` 读 `window.devicePixelRatio`
 * ⇒ node 环境须先 stub `window` 再动态导入（静态 import 会因 window 未定义抛错）。
 */
beforeAll(async () => {
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1920 });
  vi.stubGlobal('navigator', { userAgent: '', hardwareConcurrency: 4 });
  const mod = await import('../src/config/quality');
  classifyGpuByName = mod.classifyGpuByName;
  detectGpuClass = mod.detectGpuClass;
});

describe('R133 · GPU 分类（classifyGpuByName 纯函数）', () => {
  it('用户本机串：Intel(R) Arc(TM) Graphics → integrated（R133 修复的核心）', () => {
    // Core Ultra（Meteor Lake）核显 GL 串：Intel(R) Arc(TM) Graphics，无型号
    expect(classifyGpuByName('Intel(R) Arc(TM) Graphics')).toBe('integrated');
  });

  it('Lunar Lake Arc iGPU（V 后缀型号）→ integrated（非 A###/B### 离散型号）', () => {
    expect(classifyGpuByName('Intel(R) Arc(TM) 140V Graphics')).toBe('integrated');
    expect(classifyGpuByName('Intel(R) Arc(TM) 130V Graphics')).toBe('integrated');
  });

  it('Arrow Lake / 新代 Arc iGPU（无型号）→ integrated', () => {
    expect(classifyGpuByName('Intel(R) Arc Graphics')).toBe('integrated');
  });

  it('Arc 真独显（A###/B### 型号）→ discrete，仍走 high 档（不误降）', () => {
    expect(classifyGpuByName('Intel(R) Arc(TM) A770 Graphics')).toBe('discrete');
    expect(classifyGpuByName('Intel(R) Arc(TM) A580 Graphics')).toBe('discrete');
    expect(classifyGpuByName('Intel(R) Arc(TM) B580 Graphics')).toBe('discrete');
  });

  it('Intel 非 Arc 核显（Iris/UHD/HD）→ integrated（旧逻辑逐位保留）', () => {
    expect(classifyGpuByName('Intel(R) Iris(R) Xe Graphics')).toBe('integrated');
    expect(classifyGpuByName('Intel(R) UHD Graphics 770')).toBe('integrated');
    expect(classifyGpuByName('Intel(R) HD Graphics 620')).toBe('integrated');
  });

  it('AMD APU → integrated（RX/Navi/Pro 独显除外，旧逻辑保留）', () => {
    expect(classifyGpuByName('AMD Radeon(TM) 780M')).toBe('integrated');
    expect(classifyGpuByName('AMD Radeon(TM) Graphics')).toBe('integrated');
    expect(classifyGpuByName('AMD Radeon(TM) RX 6800')).toBe('discrete');
    expect(classifyGpuByName('AMD Radeon(TM) RX 6700 XT')).toBe('discrete');
    expect(classifyGpuByName('AMD Radeon(TM) Pro W6800')).toBe('discrete');
  });

  it('NVIDIA 独显 → discrete（未识别为核显/软渲）', () => {
    expect(classifyGpuByName('NVIDIA GeForce RTX 4060')).toBe('discrete');
    expect(classifyGpuByName('NVIDIA GeForce RTX 3080')).toBe('discrete');
  });

  it('软件渲染 → software（SwiftShader/llvmpipe/基本渲染）', () => {
    expect(classifyGpuByName('Google SwiftShader')).toBe('software');
    expect(classifyGpuByName('llvmpipe (LLVM 15.0.6, 256 bits)')).toBe('software');
    expect(classifyGpuByName('Microsoft Basic Render Driver')).toBe('software');
  });

  it('空串 → unknown（取不到渲染器名，不改档）', () => {
    expect(classifyGpuByName('')).toBe('unknown');
    expect(classifyGpuByName('   ')).toBe('unknown');
  });

  it('detectGpuClass 在 node（无 document）下返回 unknown，不抛异常（DOM 路径兜底）', () => {
    // node 测试环境无 document.createElement ⇒ 走 catch 分支返回 unknown。
    // 这是「不改档」的安全兜底，不是分类正确性——分类正确性由上方纯函数钉死。
    expect(detectGpuClass()).toBe('unknown');
  });
});
